"""미디어 파일 응답 + 정적 파일 응답."""

import mimetypes
from pathlib import Path

from config import PROJECTS_DIR, FRONTEND_DIR, MIME_TYPES


def serve_pv_media(handler, project: str, rel: str) -> None:
    """`/pv-media?project=X&path=Y` 핸들러. handler 는 BaseHTTPRequestHandler 인스턴스."""
    if not project or not rel:
        handler.send_error(400, "Bad Request")
        return
    if ".." in project or ".." in rel:
        handler.send_error(403, "Forbidden")
        return
    target = (PROJECTS_DIR / project / rel).resolve()
    try:
        target.relative_to(PROJECTS_DIR.resolve())
    except ValueError:
        handler.send_error(403, "Forbidden")
        return
    if not target.is_file():
        handler.send_error(404, "Not Found")
        return
    mime_type, _ = mimetypes.guess_type(str(target))
    if not mime_type:
        mime_type = "application/octet-stream"
    data = target.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", mime_type)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "max-age=3600")
    handler.end_headers()
    handler.wfile.write(data)


def serve_static(handler, request_path: str) -> None:
    """프론트엔드 정적 파일 응답."""
    if request_path in ("/", ""):
        _send_file(handler, FRONTEND_DIR / "index.html")
        return
    candidate = (FRONTEND_DIR / request_path.lstrip("/")).resolve()
    try:
        candidate.relative_to(FRONTEND_DIR.resolve())
    except ValueError:
        handler.send_error(403, "Forbidden")
        return
    _send_file(handler, candidate)


def _send_file(handler, path: Path) -> None:
    if not path.exists() or not path.is_file():
        handler.send_error(404, "Not Found")
        return
    mime = MIME_TYPES.get(path.suffix.lower(), "application/octet-stream")
    data = path.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", mime)
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)
