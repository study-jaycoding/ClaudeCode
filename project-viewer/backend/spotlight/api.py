"""Spotlight 엔드포인트 함수 — 모두 (status, body) 반환."""

import json
import uuid
from datetime import datetime
from pathlib import Path

from .catalog import MODEL_CATALOG
from .cli import run_cli
from .generation import generate as gen, build_args

UPLOAD_DIR = Path(__file__).resolve().parent.parent / "_uploads"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


def get_models() -> tuple[int, dict]:
    return 200, {"models": MODEL_CATALOG}


def get_balance() -> tuple[int, dict]:
    data = run_cli("account", "status")
    if "error" in data:
        return 200, {"credits": 0, "plan": "not_connected", "connected": False, "email": ""}
    return 200, {
        "credits": data.get("credits", 0),
        "plan": data.get("subscription_plan_type", "unknown"),
        "email": data.get("email", ""),
        "connected": True,
    }


def get_job(job_id: str) -> tuple[int, dict]:
    """단일 Higgsfield job 의 현재 상태/사유/결과 URL 을 노출.
    실패/거부 시 fail_reason 을 그대로 전달해 UI 에서 사용자에게 표시."""
    data = run_cli("generate", "get", job_id)
    if "error" in data:
        return 502, data
    status = data.get("status") or data.get("job_status") or "unknown"
    fail_reason = data.get("fail_reason") or data.get("reason") or ""
    result_url = data.get("result_url") or ""
    return 200, {
        "status": status,
        "fail_reason": fail_reason,
        "result_url": result_url,
        "images": [{"url": result_url}] if result_url else [],
        # display_name 등 보조 정보도 같이 (UI 가 필요하면 사용)
        "display_name": data.get("display_name", ""),
        "created_at": data.get("created_at"),
    }


def post_login() -> tuple[int, dict]:
    data = run_cli("auth", "login", timeout=120)
    if "error" in data:
        err = data["error"]
        if isinstance(err, dict):
            err = err.get("message", str(err))
        return 502, {"error": str(err)}
    return 200, {"ok": True}


def post_ref_upload(content_length: int, filename: str, body: bytes) -> tuple[int, dict]:
    if content_length <= 0 or content_length > MAX_UPLOAD_BYTES:
        return 400, {"error": f"파일이 없거나 너무 큽니다 (최대 {MAX_UPLOAD_BYTES // 1024 // 1024}MB)"}
    UPLOAD_DIR.mkdir(exist_ok=True)
    safe_name = f"{uuid.uuid4().hex}_{filename}"
    target = UPLOAD_DIR / safe_name
    target.write_bytes(body)
    return 200, {"path": str(target), "name": filename}


def post_generate(raw_body: str) -> tuple[int, dict]:
    try:
        payload = json.loads(raw_body) if raw_body else {}
    except json.JSONDecodeError:
        return 400, {"error": "잘못된 JSON"}
    return gen(payload)


# ip_detected 같이 사용자 동의가 필요한 상태들 — 사용자가 사이트에서 confirm 해야 진행
PENDING_USER_STATUSES = {"ip_detected", "nsfw_detected", "needs_confirmation", "pending_review"}


def post_recover(raw_body: str) -> tuple[int, dict]:
    """실패한 큐 entry 의 job_ids 를 다시 조회해서 결과를 받아옴.

    주 사용 케이스:
    - ip_detected (저작권/likeness 동의 필요) — 사용자가 사이트에서 'I confirm' 누른 후 호출
    - polling 시간 초과로 PV는 failed 처리했지만 서버에서 결과는 만들어진 케이스
    """
    try:
        body = json.loads(raw_body) if raw_body else {}
    except json.JSONDecodeError:
        return 400, {"error": "잘못된 JSON"}
    queue_id = (body.get("queue_id") or body.get("id") or "").strip()
    if not queue_id:
        return 400, {"error": "queue_id 가 필요합니다."}

    from . import jobs_log, projects_ops

    entry = jobs_log.get_job(queue_id)
    if not entry:
        return 404, {"error": "queue entry 를 찾을 수 없습니다."}
    project = entry.get("project") or ""
    if not project:
        return 400, {"error": "entry 에 프로젝트 정보가 없습니다."}
    job_ids = entry.get("job_ids") or []
    if not job_ids:
        return 400, {
            "error": "이 entry 에는 Higgsfield job_id 가 없어 복구할 수 없습니다. "
                     "CLI 호출 자체가 실패한 케이스 — 다시 생성을 시도하세요.",
        }
    # 원래 저장 폴더 — entry 에 보존돼 있으면 그곳에, 없으면 fallback Result/
    target_subdir = (entry.get("subdir") or "Result").strip().replace("\\", "/")
    if not target_subdir or target_subdir.startswith("/"):
        target_subdir = "Result"

    recovered_paths: list[str] = []
    pending_user: list[dict] = []   # 사이트 confirm 대기 (ip_detected 등)
    still_running: list[str] = []
    errors: list[str] = []

    for jid in job_ids:
        data = run_cli("generate", "get", jid, timeout=20)
        if not isinstance(data, dict) or "error" in data:
            err = data.get("error") if isinstance(data, dict) else "CLI 응답 형식 불가"
            errors.append(f"{jid[:8]}: {err}")
            continue
        status = (data.get("status") or data.get("job_status") or "").lower()
        url = data.get("result_url") or ""

        if status == "completed" and url:
            rec = projects_ops.download_to_project(url, project, target_subdir)
            if not rec:
                errors.append(f"{jid[:8]}: 다운로드 실패")
                continue
            meta = {
                "model": entry.get("model") or "",
                "prompt": entry.get("prompt") or "",
                "credits": entry.get("credits") or 0,
                "creator": "",
                "created_at": datetime.now().isoformat(),
                "job_ids": [jid],
                "recovered": True,
            }
            disp = entry.get("display_prompt")
            if disp and disp != entry.get("prompt"):
                meta["display_prompt"] = disp
            projects_ops.write_sidecar(project, rec["path"], meta)
            projects_ops.append_favorite(project, rec["path"], [])
            recovered_paths.append(rec["path"])
        elif status in PENDING_USER_STATUSES:
            pending_user.append({"job_id": jid, "status": status})
        elif status in ("failed", "error", "rejected", "cancelled"):
            reason = data.get("fail_reason") or data.get("reason") or status
            if isinstance(reason, dict):
                reason = reason.get("message", json.dumps(reason, ensure_ascii=False))
            errors.append(f"{jid[:8]}: [{status}] {reason}")
        else:
            still_running.append(jid)

    # entry 업데이트
    new_paths = list(entry.get("result_paths") or []) + recovered_paths
    thumb = entry.get("thumbnail_path") or (new_paths[0] if new_paths else None)
    if new_paths:
        new_status = "completed"
        final_err = None
    elif pending_user:
        new_status = "failed"  # 사용자 액션 대기 = 실패 상태 유지
        ids_str = ", ".join(p["job_id"][:8] for p in pending_user[:3])
        final_err = (
            f"Higgsfield 사이트에서 'I confirm' 필요 — "
            f"{len(pending_user)}개 잡 ({ids_str}{'...' if len(pending_user) > 3 else ''}) 이 "
            "저작권/콘텐츠 검토 대기 중입니다. 사이트에서 확인 후 다시 '↻ 결과 가져오기' 클릭."
        )
    elif still_running:
        new_status = "running"
        final_err = "Higgsfield 에서 아직 처리 중 — 잠시 후 다시 시도하세요."
    else:
        new_status = "failed"
        final_err = "; ".join(errors) if errors else "복구할 결과가 없습니다."

    jobs_log.finalize(
        queue_id, project=project, status=new_status,
        result_paths=new_paths, thumbnail_path=thumb, error=final_err,
    )
    return 200, {
        "queue_id": queue_id,
        "status": new_status,
        "recovered": len(recovered_paths),
        "pending_user": len(pending_user),
        "still_running": len(still_running),
        "errors": errors,
        "result_paths": new_paths,
    }


# cost 캐시 — (model + 옵션 keys) 가 같으면 CLI 안 부르고 즉시 반환. TTL 5분.
# repeat / batch_size 는 cache key 에서 빼고 곱셈만 — per_job 만 캐싱하면 같은 모델/옵션
# 조합의 반복 클릭이 즉시 응답됨.
import time as _time
_COST_CACHE: dict[tuple, tuple[float, float]] = {}  # key → (per_job, fetched_at)
_COST_TTL_SEC = 300


def _cost_cache_key(payload: dict) -> tuple:
    """per_job cost 에 영향을 주는 필드만 key 로. prompt / project / repeat 등은 무관."""
    model = payload.get("model", "")
    keys = ("aspect_ratio", "resolution", "quality", "mode", "duration", "sound", "genre",
            "flux_variant", "veo_variant", "minimax_variant")
    extra = tuple((k, payload.get(k)) for k in keys if payload.get(k) is not None)
    return (model, extra)


def post_cost(raw_body: str) -> tuple[int, dict]:
    """예상 크레딧 추정. (model + 옵션) 캐시 hit 시 즉시 반환, miss 시 CLI 호출.
    repeat / batch_size 곱셈은 매번 계산 (캐시 무관)."""
    try:
        payload = json.loads(raw_body) if raw_body else {}
    except json.JSONDecodeError:
        return 400, {"error": "잘못된 JSON"}
    model = payload.get("model", "")
    if not model:
        return 400, {"error": "model required"}

    # repeat / batch_size 처리 (캐시와 별개)
    def _multiply(per_job: float) -> dict:
        repeat = max(1, min(4, int(payload.get("repeat", 1) or 1)))
        if payload.get("batch_size") is not None:
            batch = max(1, min(4, int(payload.get("batch_size") or 1)))
            total = per_job * batch
        else:
            total = per_job * repeat
        return {"credits_per_job": per_job, "credits_total": total}

    # 캐시 hit 시 CLI 우회 — 거의 즉시 반환
    key = _cost_cache_key(payload)
    cached = _COST_CACHE.get(key)
    if cached and (_time.time() - cached[1]) < _COST_TTL_SEC:
        return 200, {**_multiply(cached[0]), "cached": True}

    # CLI 호출 (1~2초 걸림)
    if not payload.get("prompt"):
        payload["prompt"] = "x"
    _, cost_args = build_args(payload)
    data = run_cli(*cost_args, timeout=15)
    if "error" in data:
        return 200, {"credits_per_job": 0, "error": str(data.get("error", ""))}
    per_job = float(data.get("credits_exact") or data.get("credits") or 0)
    if per_job > 0:
        _COST_CACHE[key] = (per_job, _time.time())
    return 200, _multiply(per_job)
