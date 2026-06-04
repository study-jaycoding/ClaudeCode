"""Higgsfield Spotlight — HTTP server bootstrap + routing.

Port: 8767
Auth: higgsfield CLI (npm @higgsfield/cli) — run 'higgsfield auth login' first
"""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from config import PORT, BIND, HF_CLI, ALLOWED_HOSTS, ALLOWED_ORIGINS
from catalog import MODEL_CATALOG
import api
import media


class Handler(BaseHTTPRequestHandler):

    # ── 공통 헬퍼 ────────────────────────────────────────────────────

    def _check_same_origin(self) -> bool:
        host = self.headers.get("Host", "")
        if host not in ALLOWED_HOSTS:
            return False
        site = self.headers.get("Sec-Fetch-Site")
        if site is not None and site != "same-origin":
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            return False
        return True

    def _send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    # ── GET 라우팅 ───────────────────────────────────────────────────

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/api/models":
            self._send_json(*api.get_models()); return

        if path == "/api/projects":
            self._send_json(*api.get_projects()); return

        if path == "/api/balance":
            self._send_json(*api.get_balance()); return

        if path == "/api/favorites":
            self._send_json(*api.get_favorites()); return

        if path.startswith("/api/jobs/"):
            self._send_json(*api.get_job(path[len("/api/jobs/"):])); return

        if path == "/pv-media":
            media.serve_pv_media(
                self,
                params.get("project", [""])[0],
                params.get("path", [""])[0],
            )
            return

        media.serve_static(self, path)

    # ── POST 라우팅 ──────────────────────────────────────────────────

    def do_POST(self) -> None:
        if not self._check_same_origin():
            self._send_json(403, {"error": "허용되지 않은 요청입니다."})
            return

        parsed = urlparse(self.path)

        if parsed.path == "/api/login":
            self._send_json(*api.post_login()); return

        if parsed.path == "/api/upload":
            length = int(self.headers.get("Content-Length", "0"))
            filename = self.headers.get("X-File-Name", "upload.png")
            body = self.rfile.read(length) if length > 0 else b""
            self._send_json(*api.post_upload(length, filename, body))
            return

        if parsed.path == "/api/generate":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length else ""
            self._send_json(*api.post_generate(raw))
            return

        if parsed.path == "/api/save":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length else ""
            self._send_json(*api.post_save(raw))
            return

        self.send_error(404, "Not Found")


def main() -> None:
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    print("=" * 60)
    print("  Higgsfield Spotlight (CLI mode)")
    print(f"  bind: {BIND}:{PORT}")
    print(f"  local: http://127.0.0.1:{PORT}")
    print(f"  CLI: {HF_CLI}")
    print(f"  Models: {len(MODEL_CATALOG)}")
    print("=" * 60)
    print("종료: Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n종료")
        server.shutdown()


if __name__ == "__main__":
    main()
