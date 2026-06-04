"""이미지/비디오 생성 흐름."""

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from .cli import run_cli
from .projects_ops import (
    resolve_media_path,
    download_to_project,
    write_sidecar,
    append_favorite,
    generate_id,
)
from . import jobs_log

PASSTHROUGH_KEYS = {
    "resolution", "quality", "mode", "batch_size",
    "duration", "sound", "genre",
}

MODEL_ALIAS_FLAGS = [
    ("flux_variant", "model"),
    ("veo_variant", "model"),
    ("minimax_variant", "model"),
]

METADATA_EXTRA_KEYS = (
    "resolution", "quality", "mode", "duration", "sound", "genre",
    "flux_variant", "veo_variant", "minimax_variant",
    "negative_prompt", "style",
)


def build_args(payload: dict) -> tuple[list[str], list[str]]:
    # NOTE: --wait 안 붙임. job_id 즉시 받고 별도 wait 단계에서 폴링.
    # 이전 흐름에서는 비디오 생성이 subprocess timeout(=5분) 으로 죽으면
    # job_id 조차 못 받아서 PV는 failed 처리되는데 Higgsfield 서버에서는
    # 결과가 만들어지는 사고가 났음. 두 단계로 쪼개면 1단계에서 job_id 가
    # jobs_log 에 저장되므로, 사고 시 수동 복구가 가능해짐.
    model = payload["model"]
    prompt = payload["prompt"]
    create = ["generate", "create", model, "--prompt", prompt]
    cost = ["generate", "cost", model, "--prompt", prompt]

    aspect_ratio = payload.get("aspect_ratio")
    if aspect_ratio:
        create += ["--aspect_ratio", aspect_ratio]
        cost += ["--aspect_ratio", aspect_ratio]

    for key in PASSTHROUGH_KEYS:
        val = payload.get(key)
        if val is not None:
            create += [f"--{key}", str(val)]
            cost += [f"--{key}", str(val)]

    for alias, flag in MODEL_ALIAS_FLAGS:
        val = payload.get(alias)
        if val:
            create += [f"--{flag}", val]
            cost += [f"--{flag}", val]

    for ref in payload.get("ref_urls", []) or []:
        # viewer 의 /media URL 또는 spotlight 의 /pv-media URL
        if ref.startswith("/media") or ref.startswith("/pv-media"):
            local = resolve_media_path(ref)
            if local:
                create += ["--image", str(local)]
        else:
            create += ["--image", ref]

    return create, cost


def _collect_one(data) -> tuple[list[str], list[dict], str | None]:
    """CLI 응답 1건에서 (job_ids, images, error_message) 추출.

    실패 케이스에서 Higgsfield 가 돌려주는 신호:
    - 최상위 `error`               → CLI 자체 오류 (네트워크/인증/잘못된 인자)
    - job dict 의 `fail_reason`    → 백엔드가 거부한 사유 (copyright/NSFW 등)
    - job dict 의 `reason`         → 보조 사유 필드 (모델별)
    - result_url 없음 + status 가 "completed" 가 아님 → 실패. fail_reason 합쳐서 노출.
    """
    jobs, images, err_parts = [], [], []

    def _scan(job: dict) -> None:
        jid = job.get("id", "")
        if jid:
            jobs.append(jid)
        url = job.get("result_url", "")
        if url:
            images.append({"url": url})
            return
        status = (job.get("status") or job.get("job_status") or "").lower()
        # result_url 없는데 completed 도 아닌 경우 — 실패로 간주
        if status and status != "completed":
            reason = (
                job.get("fail_reason")
                or job.get("reason")
                or job.get("error")
                or ""
            )
            if isinstance(reason, dict):
                reason = reason.get("message", json.dumps(reason, ensure_ascii=False))
            label = f"[{status}]"
            if reason:
                err_parts.append(f"{label} {reason}")
            else:
                err_parts.append(f"{label} 결과 없음")

    if isinstance(data, list):
        for job in data:
            if isinstance(job, str):
                # `generate create` (--wait 없음) 의 응답 형태: ["uuid", "uuid", ...]
                if job:
                    jobs.append(job)
            elif isinstance(job, dict):
                # `generate create --wait` 또는 `generate wait/get` 의 응답 형태
                _scan(job)
        # CLI 가 빈 리스트를 돌려준 케이스 — 진단 메시지 부착
        if not data and not err_parts:
            err_parts.append("CLI 가 빈 응답을 반환 (서버가 job 을 생성하지 않음 — "
                             "콘텐츠 정책 위반, 파라미터 거부, 또는 API 한계 가능)")
    elif isinstance(data, dict) and "error" in data:
        e = data["error"]
        if isinstance(e, dict):
            e = e.get("message", json.dumps(e, ensure_ascii=False))
        err_parts.append(str(e))
    elif isinstance(data, dict):
        _scan(data)
    elif data is None:
        err_parts.append("CLI 가 응답을 반환하지 않음 (timeout 또는 프로세스 종료)")
    else:
        # 예상 못 한 형태 — raw 일부를 진단용으로 노출
        snippet = json.dumps(data, ensure_ascii=False)[:200]
        err_parts.append(f"CLI 응답 파싱 불가: {snippet}")

    err = " | ".join(err_parts) if err_parts else None
    return jobs, images, err


# `generate wait <id>` 는 subprocess timeout 으로 죽으면 결과 누락 사고 → 대신
# `generate get <id>` 를 짧은 간격으로 polling. 각 호출은 < 20초라 subprocess
# timeout 사고 없음. 우리만 정한 max 시간까지 기다림.
MAX_WAIT_MINUTES = 60       # polling 최대 시간 — 가장 긴 비디오 모델도 여유
POLL_INTERVAL_SEC = 5.0     # 매 polling 간격
GET_TIMEOUT_SEC = 20        # generate get 단발 subprocess timeout (안전 여유)
CREATE_TIMEOUT_SEC = 90     # generate create — 보통 < 10s


def _wait_for_job(
    job_id: str,
    *,
    queue_id: str = "",
    project: str = "",
    max_minutes: int = MAX_WAIT_MINUTES,
) -> tuple[str | None, str | None, str]:
    """`generate get <id>` 를 POLL_INTERVAL_SEC 간격으로 반복 호출.
    completed/failed 까지 또는 max_minutes 초과까지. 매 호출은 짧으므로
    subprocess timeout 사고 없음. URL 받으면 jobs_log entry 에 즉시 누적.
    반환: (result_url, error_message, final_status)
    """
    deadline = time.monotonic() + max_minutes * 60
    last_status = ""
    while time.monotonic() < deadline:
        data = run_cli("generate", "get", job_id, timeout=GET_TIMEOUT_SEC)
        if isinstance(data, dict) and "error" not in data:
            status = (data.get("status") or data.get("job_status") or "").lower()
            last_status = status
            url = data.get("result_url") or ""
            if status == "completed" and url:
                # ★ URL 받자마자 entry 에 누적 — 다운로드 죽어도 보존
                if queue_id:
                    try:
                        jobs_log.append_result_url(queue_id, project=project, url=url)
                    except Exception:
                        pass
                return url, None, status
            if status in ("failed", "error", "rejected", "cancelled"):
                reason = data.get("fail_reason") or data.get("reason") or ""
                if isinstance(reason, dict):
                    reason = reason.get("message", json.dumps(reason, ensure_ascii=False))
                label = f"[{status}]"
                return None, (f"{label} {reason}" if reason else f"{label}"), status
            # user-action 요청 상태 — Higgsfield 사이트에서 사용자가 확인해야 진행됨.
            # polling 계속해도 자동 진행 불가 → 즉시 종료해서 post_recover 흐름 노출.
            # (이전엔 무한 polling 으로 MAX_WAIT_MINUTES 까지 HTTP 요청 점유)
            if status in ("ip_detected", "needs_confirmation", "needs_action",
                           "needs_user_action", "user_action_required", "nsfw_detected"):
                return None, f"[{status}] 사이트에서 확인 필요 — 결과 가져오기로 재시도", status
            # in_queue / queued / in_progress / processing → 계속 polling
        # CLI 응답 자체가 error 이면 일시적일 수 있으니 retry (다음 iteration)
        time.sleep(POLL_INTERVAL_SEC)
    # 우리 max 시간 초과 — 거의 일어나지 않지만 명시적으로
    return None, f"polling 시간 초과 ({max_minutes}분, 마지막 상태={last_status or '?'})", last_status


def _create_and_wait_one(
    create_args: list[str],
    *,
    queue_id: str = "",
    project: str = "",
) -> tuple[list[str], list[dict], str | None]:
    """create (job_id 받기) → wait (각 job 결과 대기) 의 통합 흐름.
    반환: (jobs, images, err)
    - jobs: 만들어진 모든 job_id (실패한 wait 도 포함 — 복구 추적용)
    - images: result_url 받은 것만
    - err: 첫 실패 사유 또는 None

    queue_id 주어지면 (1) create 직후 jobs_log entry 에 job_ids 를 기록 — wait 가
    subprocess timeout 으로 죽어도 entry 가 복구 트래킹 가능. (2) URL 을 받자마자
    entry.result_urls 에도 누적 저장 → 다운로드 실패해도 URL 만은 보존.
    """
    create_data = run_cli(*create_args, timeout=CREATE_TIMEOUT_SEC)
    jobs, _imgs_unused, create_err = _collect_one(create_data)

    # ★ create 가 job_id 를 만들었으면 즉시 jobs_log 에 저장 (wait 죽음 대비)
    if queue_id and jobs:
        try:
            jobs_log.update_job_ids(queue_id, project=project, job_ids=jobs)
        except Exception:
            pass

    if create_err and not jobs:
        return [], [], create_err
    if not jobs:
        return [], [], create_err or "CLI 가 job_id 를 만들지 않음"

    images: list[dict] = []
    wait_errs: list[str] = []
    for jid in jobs:
        # _wait_for_job 내부에서 URL 받자마자 entry.result_urls 에 저장됨
        url, werr, _status = _wait_for_job(jid, queue_id=queue_id, project=project)
        if url:
            images.append({"url": url})
        elif werr:
            wait_errs.append(f"{jid}: {werr}")

    err: str | None
    if wait_errs and not images:
        err = " | ".join(wait_errs)
    elif wait_errs:
        # 일부 성공/일부 실패 — 일단 성공한 거 다 처리하되 부분 실패 알림
        err = " | ".join(wait_errs)
    else:
        err = None
    return jobs, images, err


def run_parallel_indexed(
    create_args: list[str],
    repeat: int,
    *,
    queue_ids: list[str] | None = None,
    project: str = "",
) -> list[tuple[list[str], list[dict], str | None]]:
    """ThreadPool 로 repeat 회 병렬 실행 — idx 순서대로 (jobs, images, err) 반환.
    각 job 별 큐 카드를 따로 표시하려면 idx 보존 필수.

    queue_ids 주어지면 각 idx 의 create 직후 jobs_log entry 에 job_ids 가
    저장되어 wait timeout 시에도 복구 트래킹 가능."""
    results: list[tuple[list[str], list[dict], str | None]] = [([], [], None)] * repeat
    qids = queue_ids or [""] * repeat

    def _task(idx: int):
        return _create_and_wait_one(create_args, queue_id=qids[idx], project=project)

    with ThreadPoolExecutor(max_workers=repeat) as pool:
        futures = {pool.submit(_task, i): i for i in range(repeat)}
        for fut in as_completed(futures):
            idx = futures[fut]
            try:
                jobs, images, err = fut.result()
            except Exception as e:  # noqa: BLE001
                jobs, images, err = [], [], str(e)
            results[idx] = (jobs, images, err)
    return results


def fetch_cost_and_account(cost_args: list[str]) -> tuple[float, str]:
    cost_data = run_cli(*cost_args, timeout=15)
    cost_per_job = cost_data.get("credits_exact") or cost_data.get("credits") or 0
    cost_per_job = float(cost_per_job)

    acct = run_cli("account", "status", timeout=10)
    email = acct.get("email", "") if isinstance(acct, dict) else ""
    return cost_per_job, email


def build_metadata(payload: dict, jobs: list[str], cost_per_job: float, email: str) -> dict:
    total_cost = cost_per_job * len(jobs) if jobs else cost_per_job
    metadata = {
        "model": payload["model"],
        "prompt": payload["prompt"],
        "aspect_ratio": payload.get("aspect_ratio"),
        "credits": total_cost,
        "credits_per_job": cost_per_job,
        "creator": email,
        "created_at": datetime.now().isoformat(),
        "job_ids": jobs,
    }
    disp = payload.get("display_prompt")
    if disp and disp != payload.get("prompt"):
        metadata["display_prompt"] = disp
    src_ids = payload.get("source_ids") or []
    if src_ids:
        metadata["source_ids"] = list(src_ids)
    # favorite 매칭이 안 되는 외부 ref 도 식별 가능하도록 ref_urls 도 보존
    ref_urls = payload.get("ref_urls") or []
    if ref_urls:
        metadata["ref_urls"] = list(ref_urls)
    for k in METADATA_EXTRA_KEYS:
        v = payload.get(k)
        if v is not None and v != "":
            metadata[k] = v
    return metadata


def save_to_project(images: list[dict], project: str, source_ids: list, metadata: dict,
                    subdir: str = "Result") -> list[dict]:
    """결과 파일 다운로드 + sidecar + favorites. subdir 지정 시 그 폴더에 저장 (없으면 자동 생성)."""
    saved = []
    for img in images:
        url = img.get("url", "")
        if not url:
            continue
        rec = download_to_project(url, project, subdir)
        if not rec:
            continue
        write_sidecar(project, rec["path"], metadata)
        fav = append_favorite(project, rec["path"], source_ids)
        saved.append({
            "name": rec["name"],
            "path": rec["path"],
            "size": rec["size"],
            "favorite_id": (fav or {}).get("id"),
        })
    return saved


def _infer_kind(payload: dict) -> str:
    """payload 에서 image/video 추정 — duration/sound 있거나 model 명에 비디오 키워드."""
    if payload.get("duration") is not None or payload.get("sound") is not None:
        return "video"
    m = (payload.get("model") or "").lower()
    if any(k in m for k in ("video", "veo", "minimax", "kling", "luma", "wan")):
        return "video"
    return "image"


def generate(payload: dict) -> tuple[int, dict]:
    model = payload.get("model", "")
    prompt = payload.get("prompt", "")
    if not model or not prompt:
        return 400, {"error": "model 과 prompt 는 필수입니다."}

    target_project = (payload.get("project") or "").strip()
    source_ids = payload.get("source_ids") or []
    auto_download = bool(payload.get("auto_download", True))
    # 저장 폴더 — 항상 "Result" 또는 그 하위만 허용.
    # frontend 도 같은 clamp 를 하지만 belt-and-suspenders 로 backend 에서도 강제.
    # Assets 등 다른 폴더로 결과가 새는 걸 차단. ".." path traversal 은 download_to_project 안에서 검증됨.
    target_subdir = (payload.get("subdir") or "Result").strip().replace("\\", "/").strip("/")
    if target_subdir != "Result" and not target_subdir.startswith("Result/"):
        target_subdir = "Result"

    repeat = max(1, min(4, int(payload.get("repeat", 1))))
    if payload.get("batch_size") is not None:
        repeat = 1

    kind = _infer_kind(payload)
    ref_count = len(payload.get("ref_urls") or [])

    # ── Job Queue: repeat 만큼 entry pre-create (각 job 별 개별 카드) ──
    pre_ids: list[str] = []
    for _ in range(repeat):
        jid = generate_id()
        jobs_log.append_running(
            id=jid,
            project=target_project,
            model=model,
            prompt=prompt,
            display_prompt=payload.get("display_prompt"),
            kind=kind,
            ref_count=ref_count,
            subdir=target_subdir,
        )
        pre_ids.append(jid)

    try:
        create_args, cost_args = build_args(payload)

        # 모든 future 완료 대기 — idx 별 결과 보존.
        # queue_ids 전달 → create 직후 job_ids 가 jobs_log entry 에 즉시 저장됨.
        results = run_parallel_indexed(
            create_args, repeat,
            queue_ids=pre_ids,
            project=target_project,
        )

        # cost / account 정보는 한 번만 — 모든 job 에 동일 적용
        cost_per_job, email = fetch_cost_and_account(cost_args)

        all_jobs: list[str] = []
        all_images: list[dict] = []
        all_saved: list[dict] = []
        first_err: str | None = None

        # 각 idx 별로 metadata 생성 + 다운로드 + finalize (개별)
        for idx, (jobs, images, err) in enumerate(results):
            jid = pre_ids[idx]
            if err and first_err is None:
                first_err = err

            # 실패 (응답 없음) → 즉시 failed
            if err and not images and not jobs:
                jobs_log.finalize(jid, project=target_project, status="failed", error=err)
                continue

            # 이 job 의 metadata (job_ids = 이 idx 의 jobs 만)
            per_meta = build_metadata(payload, jobs, cost_per_job, email)
            for img in images:
                img["metadata"] = per_meta

            # 이 job 의 image 만 별도 다운로드
            saved_one: list[dict] = []
            if auto_download and target_project and images:
                saved_one = save_to_project(images, target_project, source_ids, per_meta,
                                            subdir=target_subdir)

            saved_paths = [s.get("path") for s in saved_one if s.get("path")]
            result_urls = [img.get("url") for img in images if img.get("url")]
            thumb = saved_paths[0] if saved_paths else None
            # status 판정 — completed = 실제로 사용자 컴퓨터에 파일 저장된 경우.
            # URL 만 있고 다운로드가 실패한 경우는 failed 이지만 result_urls 가
            # entry 에 남아 있어 카드 썸네일은 HF CDN URL 로 표시 가능 +
            # "↻ 결과 가져오기" 버튼이 URL 로 빠른 재시도 (CLI 호출 없음).
            if saved_paths:
                status = "completed"
                final_err = None
            else:
                status = "failed"
                if result_urls:
                    final_err = f"결과 URL 은 받았으나 다운로드 실패 ({len(result_urls)}개) — '↻ 결과 가져오기' 로 재시도"
                elif err:
                    final_err = err
                elif jobs:
                    final_err = f"결과 다운로드 안 됨 (job_ids: {', '.join(jobs[:2])}{'…' if len(jobs) > 2 else ''})"
                else:
                    final_err = "결과 없음"
            jobs_log.finalize(
                jid,
                project=target_project,
                status=status,
                job_ids=jobs,
                result_paths=saved_paths,
                result_urls=result_urls,
                thumbnail_path=thumb,
                error=final_err,
                credits=float(per_meta.get("credits") or 0),
            )

            all_jobs.extend(jobs)
            all_images.extend(images)
            all_saved.extend(saved_one)

        # 응답 (호환) — 전체 batch level 정보
        if not all_jobs and not all_images and first_err:
            return 502, {"error": first_err, "job_ids": pre_ids}

        batch_meta = build_metadata(payload, all_jobs, cost_per_job, email)
        return 200, {
            "job_ids": all_jobs,
            "status": "completed",
            "images": all_images,
            "saved": all_saved,
            "metadata": batch_meta,
            "queue_ids": pre_ids,  # 큐 탭의 entry id 들 (per-job)
        }
    except Exception as e:
        # 남은 entry 모두 failed 처리
        for jid in pre_ids:
            jobs_log.finalize(jid, project=target_project, status="failed", error=str(e))
        raise
