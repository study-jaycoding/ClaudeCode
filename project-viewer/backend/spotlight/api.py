"""Spotlight 엔드포인트 함수 — 모두 (status, body) 반환."""

import json
import uuid
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
    data = run_cli("generate", "get", job_id)
    if "error" in data:
        return 502, data
    return 200, {
        "status": data.get("status", "unknown"),
        "images": [{"url": data["result_url"]}] if data.get("result_url") else [],
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


def post_cost(raw_body: str) -> tuple[int, dict]:
    """예상 크레딧 추정. CLI 의 'generate cost' 한 번 호출.
    repeat 또는 batch_size 를 곱해 total 계산."""
    try:
        payload = json.loads(raw_body) if raw_body else {}
    except json.JSONDecodeError:
        return 400, {"error": "잘못된 JSON"}
    model = payload.get("model", "")
    if not model:
        return 400, {"error": "model required"}
    # CLI 는 빈 prompt 를 거부할 수 있어 placeholder 한 글자 사용 — cost 만 보고 결과는 안 받음.
    if not payload.get("prompt"):
        payload["prompt"] = "x"
    _, cost_args = build_args(payload)
    data = run_cli(*cost_args, timeout=15)
    if "error" in data:
        return 200, {"credits_per_job": 0, "error": str(data.get("error", ""))}
    per_job = float(data.get("credits_exact") or data.get("credits") or 0)
    repeat = max(1, min(4, int(payload.get("repeat", 1) or 1)))
    if payload.get("batch_size") is not None:
        # batch_size 가 있으면 단일 호출에 N개를 만드므로 별도 처리
        batch = max(1, min(4, int(payload.get("batch_size") or 1)))
        total = per_job * batch
    else:
        total = per_job * repeat
    return 200, {"credits_per_job": per_job, "credits_total": total}
