"""공통 상수와 경로.

환경변수 (.env 또는 OS env):
- CCDATA_DIR        : 데이터 루트 (기본: D:/ClaudeCode-data)
- SPOTLIGHT_PORT    : listen 포트 (기본: 8767)
- SPOTLIGHT_BIND    : listen 주소 (기본: 127.0.0.1)
override 시 PROJECTS_DIR / FAVORITES_FILE 도 따로 지정 가능."""

import os
import shutil
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
ROOT_DIR = BACKEND_DIR.parent
FRONTEND_DIR = ROOT_DIR / "frontend"

# ── .env 파일 자동 로드 (선택) ────────────────────────────────────
def _load_dotenv() -> None:
    """ROOT_DIR/.env 또는 BACKEND_DIR/.env 의 KEY=VALUE 를 os.environ 에 주입.
    이미 환경변수에 있으면 덮어쓰지 않는다."""
    for env_path in (ROOT_DIR / ".env", BACKEND_DIR / ".env"):
        if not env_path.is_file():
            continue
        try:
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
        except OSError:
            pass

_load_dotenv()

# ── 데이터 경로 ──────────────────────────────────────────────────
CCDATA_DIR = Path(os.environ.get("CCDATA_DIR", "D:/ClaudeCode-data"))
PROJECTS_DIR = Path(os.environ.get("CCDATA_PROJECTS_DIR", str(CCDATA_DIR / "projects")))
FAVORITES_FILE = Path(os.environ.get("CCDATA_FAVORITES_FILE", str(CCDATA_DIR / "favorites.json")))
UPLOAD_DIR = BACKEND_DIR / "_uploads"

# ── 서버 ─────────────────────────────────────────────────────────
PORT = int(os.environ.get("SPOTLIGHT_PORT", "8767"))
BIND = os.environ.get("SPOTLIGHT_BIND", "127.0.0.1")

HF_CLI = shutil.which("higgsfield") or "higgsfield"

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}

# same-origin 체크 — bind 가 0.0.0.0 같이 모든 인터페이스면 LAN IP 도 허용 필요.
# 가장 안전하게: 로컬 4개 + 환경변수로 추가 origin 허용.
_extra_origins = [o.strip() for o in os.environ.get("SPOTLIGHT_EXTRA_ORIGINS", "").split(",") if o.strip()]
_extra_hosts = [h.strip() for h in os.environ.get("SPOTLIGHT_EXTRA_HOSTS", "").split(",") if h.strip()]
ALLOWED_ORIGINS = {
    f"http://127.0.0.1:{PORT}",
    f"http://localhost:{PORT}",
    *_extra_origins,
}
ALLOWED_HOSTS = {
    f"127.0.0.1:{PORT}",
    f"localhost:{PORT}",
    *_extra_hosts,
}

MAX_UPLOAD_BYTES = int(os.environ.get("SPOTLIGHT_MAX_UPLOAD_MB", "20")) * 1024 * 1024
