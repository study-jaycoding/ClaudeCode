"""각 /api/* 엔드포인트 핸들러. 모두 (status, dict) 반환."""

import json
import uuid

from config import UPLOAD_DIR, MAX_UPLOAD_BYTES
from catalog import MODEL_CATALOG
from cli import run_cli
from projects import (
    list_projects,
    load_favorites,
    filter_image_favorites,
)
from generation import generate, save_to_project


def get_models() -> tuple[int, dict]:
    return 200, {"models": MODEL_CATALOG}


def get_projects() -> tuple[int, dict]:
    return 200, {"projects": list_projects()}


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


def get_favorites() -> tuple[int, dict]:
    favs = load_favorites()
    return 200, {"favorites": filter_image_favorites(favs)}


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


def post_upload(content_length: int, filename: str, body: bytes) -> tuple[int, dict]:
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
    return generate(payload)


def post_save(raw_body: str) -> tuple[int, dict]:
    """폴링으로 받은 result_url 들을 프로젝트 폴더로 다운로드.
    payload: {project, urls:[], source_ids:[], metadata:{}}
    비디오 같이 --wait 안에 안 끝난 경우, 클라이언트가 폴링 완료 후 호출."""
    try:
        payload = json.loads(raw_body) if raw_body else {}
    except json.JSONDecodeError:
        return 400, {"error": "잘못된 JSON"}
    project = (payload.get("project") or "").strip()
    urls = payload.get("urls") or []
    if not project:
        return 400, {"error": "project 가 비어있습니다."}
    if not urls:
        return 400, {"error": "urls 가 비어있습니다."}
    images = [{"url": u} for u in urls if u]
    source_ids = payload.get("source_ids") or []
    metadata = payload.get("metadata") or {}
    saved = save_to_project(images, project, source_ids, metadata)
    return 200, {"saved": saved}
