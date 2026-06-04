"""이미지/비디오 생성 흐름: CLI args 빌드, 병렬 실행, 메타데이터, 자동 저장."""

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from cli import run_cli
from projects import (
    resolve_local_path,
    download_to_project,
    write_sidecar,
    append_favorite,
)

PASSTHROUGH_KEYS = {
    "resolution", "quality", "mode", "batch_size",
    "duration", "sound", "genre",
}

VIDEO_REF_EXTS = (".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi")
AUDIO_REF_EXTS = (".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac")


def _ref_flag(ref: str, resolved: str = "") -> str:
    """ref URL 또는 로컬 경로의 확장자로 CLI flag 선택.
    비디오/오디오는 --video/--audio, 나머지(기본 이미지)는 --image."""
    for candidate in (resolved, ref):
        if not candidate:
            continue
        low = candidate.lower().split("?")[0].split("#")[0]
        if low.endswith(VIDEO_REF_EXTS):
            return "--video"
        if low.endswith(AUDIO_REF_EXTS):
            return "--audio"
    return "--image"

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
    """generate create / cost 두 명령에 공통으로 쓰일 args 를 만든다.
    반환: (create_args, cost_args)

    NOTE: --wait 를 안 붙임 — 비디오 모델은 subprocess timeout 으로 죽을 만큼
    오래 걸리는 경우가 많아 별도 wait 호출로 분리. 자세한 사유는 PV쪽 generation.py 참고.
    """
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
        if ref.startswith("/pv-media"):
            local = resolve_local_path(ref)
            if local:
                create += [_ref_flag(ref, str(local)), str(local)]
        else:
            create += [_ref_flag(ref), ref]

    return create, cost


def _collect_one(data) -> tuple[list[str], list[dict], str | None]:
    """CLI 응답 한 건에서 job_id 들, image dict 들, 에러 메시지를 추출.
    - `generate create` (--wait 없음) 응답: ["uuid", "uuid", ...]
    - `generate create --wait` / `generate get/wait` 응답: [{...}, {...}] 또는 {...}
    """
    jobs, images, err = [], [], None
    if isinstance(data, list):
        for job in data:
            if isinstance(job, str):
                if job:
                    jobs.append(job)
            elif isinstance(job, dict):
                jid = job.get("id", "")
                if jid:
                    jobs.append(jid)
                url = job.get("result_url", "")
                if url:
                    images.append({"url": url})
    elif isinstance(data, dict) and "error" in data:
        e = data["error"]
        if isinstance(e, dict):
            e = e.get("message", json.dumps(e, ensure_ascii=False))
        err = str(e)
    elif isinstance(data, dict):
        jid = data.get("id", "")
        if jid:
            jobs.append(jid)
        url = data.get("result_url", "")
        if url:
            images.append({"url": url})
    return jobs, images, err


# `generate wait` 가 subprocess timeout 으로 죽으면 결과 누락 사고. 대신
# `generate get` 을 짧은 간격으로 polling — 각 호출은 짧으므로 timeout 사고 없음.
MAX_WAIT_MINUTES = 60       # polling 최대 시간 — 가장 긴 비디오도 여유
POLL_INTERVAL_SEC = 5.0
GET_TIMEOUT_SEC = 20
CREATE_TIMEOUT_SEC = 90


def _wait_for_job(job_id: str, *, max_minutes: int = MAX_WAIT_MINUTES) -> tuple[str | None, str | None]:
    """`generate get <id>` polling. completed/failed 또는 max_minutes 까지."""
    deadline = time.monotonic() + max_minutes * 60
    last_status = ""
    while time.monotonic() < deadline:
        data = run_cli("generate", "get", job_id, timeout=GET_TIMEOUT_SEC)
        if isinstance(data, dict) and "error" not in data:
            status = (data.get("status") or data.get("job_status") or "").lower()
            last_status = status
            url = data.get("result_url") or ""
            if status == "completed" and url:
                return url, None
            if status in ("failed", "error", "rejected", "cancelled"):
                reason = data.get("fail_reason") or data.get("reason") or ""
                if isinstance(reason, dict):
                    reason = reason.get("message", json.dumps(reason, ensure_ascii=False))
                return None, f"[{status}] {reason}" if reason else f"[{status}]"
        time.sleep(POLL_INTERVAL_SEC)
    return None, f"polling 시간 초과 ({max_minutes}분, 마지막={last_status or '?'})"


def _create_and_wait_one(create_args: list[str]) -> tuple[list[str], list[dict], str | None]:
    """create → wait 두 단계로 분리. subprocess timeout 으로 wait 가 죽어도
    job_id 만큼은 받아서 반환 — 호출자가 사용자에게 알려줄 수 있음."""
    create_data = run_cli(*create_args, timeout=CREATE_TIMEOUT_SEC)
    jobs, _imgs_unused, create_err = _collect_one(create_data)
    if create_err and not jobs:
        return [], [], create_err
    if not jobs:
        return [], [], create_err or "CLI 가 job_id 를 만들지 않음"

    images: list[dict] = []
    wait_errs: list[str] = []
    for jid in jobs:
        url, werr = _wait_for_job(jid)
        if url:
            images.append({"url": url})
        elif werr:
            wait_errs.append(f"{jid}: {werr}")
    err = " | ".join(wait_errs) if wait_errs else None
    return jobs, images, err


def run_parallel(create_args: list[str], repeat: int) -> tuple[list[str], list[dict], str | None]:
    """ThreadPool 로 CLI 를 repeat 회 병렬 실행."""
    all_jobs, all_images, first_err = [], [], None

    with ThreadPoolExecutor(max_workers=repeat) as pool:
        futures = [pool.submit(_create_and_wait_one, create_args) for _ in range(repeat)]
        for fut in as_completed(futures):
            jobs, images, err = fut.result()
            all_jobs.extend(jobs)
            all_images.extend(images)
            if err and first_err is None:
                first_err = err

    return all_jobs, all_images, first_err


def fetch_cost_and_account(cost_args: list[str]) -> tuple[float, str]:
    """생성 비용과 계정 이메일 조회."""
    cost_data = run_cli(*cost_args, timeout=15)
    cost_per_job = cost_data.get("credits_exact") or cost_data.get("credits") or 0
    cost_per_job = float(cost_per_job)

    acct = run_cli("account", "status", timeout=10)
    email = acct.get("email", "") if isinstance(acct, dict) else ""
    return cost_per_job, email


def build_metadata(payload: dict, jobs: list[str], cost_per_job: float, email: str) -> dict:
    """생성 메타데이터 빌드. 사이드카 및 결과 카드에서 사용."""
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
    for k in METADATA_EXTRA_KEYS:
        v = payload.get(k)
        if v is not None and v != "":
            metadata[k] = v
    return metadata


def save_to_project(images: list[dict], project: str, source_ids: list, metadata: dict) -> list[dict]:
    """결과를 프로젝트 폴더에 다운로드 + sidecar + favorite 등록."""
    saved = []
    for img in images:
        url = img.get("url", "")
        if not url:
            continue
        rec = download_to_project(url, project, "Result")
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


def generate(payload: dict) -> tuple[int, dict]:
    """전체 generate 흐름. 반환: (status_code, response_body)."""
    model = payload.get("model", "")
    prompt = payload.get("prompt", "")
    if not model or not prompt:
        return 400, {"error": "model 과 prompt 는 필수입니다."}

    create_args, cost_args = build_args(payload)

    repeat = max(1, min(4, int(payload.get("repeat", 1))))
    if payload.get("batch_size") is not None:
        repeat = 1

    all_jobs, all_images, first_err = run_parallel(create_args, repeat)

    if not all_jobs and not all_images and first_err:
        return 502, {"error": first_err}

    cost_per_job, email = fetch_cost_and_account(cost_args)
    metadata = build_metadata(payload, all_jobs, cost_per_job, email)

    for img in all_images:
        img["metadata"] = metadata

    auto_download = bool(payload.get("auto_download", True))
    target_project = (payload.get("project") or "").strip()
    source_ids = payload.get("source_ids") or []
    saved = []
    if auto_download and target_project and all_images:
        saved = save_to_project(all_images, target_project, source_ids, metadata)

    return 200, {
        "job_ids": all_jobs,
        "status": "completed",
        "images": all_images,
        "saved": saved,
        "metadata": metadata,
    }
