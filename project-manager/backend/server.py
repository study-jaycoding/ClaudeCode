"""
프로젝트 폴더 생성 백엔드 서버.

특징
- Python 표준 라이브러리만 사용 (http.server, json, pathlib).
- 같은 origin 에서 프론트엔드 정적 파일과 API 를 모두 서빙한다.
- 기본 포트: 8765.
- 새 프로젝트는 ROOT/../projects/<이름>/ 에 생성되고 기본 README.md 가 함께 만들어진다.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import re
from datetime import datetime
from urllib.parse import urlparse

# 백엔드 스크립트 기준 절대 경로 계산
BACKEND_DIR = Path(__file__).resolve().parent
ROOT_DIR = BACKEND_DIR.parent  # d:\ClaudeCode\project-manager
FRONTEND_DIR = ROOT_DIR / "frontend"
<<<<<<< Updated upstream
# 실제 프로젝트들이 생성되는 위치 (project-manager 와 동급)
PROJECTS_DIR = ROOT_DIR.parent / "projects"
=======
# 실제 프로젝트들이 생성되는 위치.
# git repo (d:\ClaudeCode) 바깥에 두어 작업 결과물이 커밋 대상에 섞이지 않게 한다.
PROJECTS_DIR = Path("D:/ClaudeCode-data/projects")
>>>>>>> Stashed changes

# 프로젝트 이름 검증 정규식: 한글/영문/숫자/공백/하이픈/언더스코어, 1~50자
NAME_PATTERN = re.compile(r"^[\w\sㄱ-ㅎㅏ-ㅣ가-힣\-]{1,50}$", re.UNICODE)

# 정적 파일 확장자별 MIME 타입
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def ensure_projects_dir() -> None:
    """projects 디렉토리가 없으면 생성한다."""
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)


def list_projects() -> list[dict]:
    """projects 폴더 안의 디렉토리를 메타 정보와 함께 리스트로 반환한다."""
    ensure_projects_dir()
    items = []
    # 이름 기준 오름차순 정렬
    for entry in sorted(PROJECTS_DIR.iterdir(), key=lambda p: p.name.lower()):
        if entry.is_dir():
            stat = entry.stat()
            items.append({
                "name": entry.name,
                # ctime 은 Windows 에서 생성 시각을 나타냄
                "created": datetime.fromtimestamp(stat.st_ctime).strftime("%Y-%m-%d %H:%M:%S"),
                "path": str(entry),
            })
    return items


def create_project(name: str) -> tuple[int, dict]:
    """
    프로젝트 폴더를 생성한다.

    반환값: (HTTP 상태 코드, 응답 JSON 으로 사용할 dict)
    """
    name = name.strip()
    if not name:
        return 400, {"error": "프로젝트 이름이 비어있습니다."}
    if not NAME_PATTERN.match(name):
        return 400, {
            "error": "프로젝트 이름은 한글/영문/숫자/공백/하이픈/언더스코어, 1~50자만 허용됩니다."
        }

    ensure_projects_dir()
    target = PROJECTS_DIR / name
    if target.exists():
        return 409, {"error": f"이미 존재하는 프로젝트입니다: {name}"}

    # 폴더 생성 + 기본 README.md 작성
    target.mkdir(parents=True)
    # 기본 에셋 하위 폴더 생성 (CH: 캐릭터, BG: 배경, PR: 프랍)
    for sub in ("CH", "BG", "PR"):
        (target / "Assets" / sub).mkdir(parents=True)
    created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    readme = target / "README.md"
    readme.write_text(
        f"# {name}\n\n생성일: {created_at}\n",
        encoding="utf-8",
    )
    return 201, {"name": name, "created": created_at, "path": str(target)}


<<<<<<< Updated upstream
class Handler(BaseHTTPRequestHandler):
    """단일 HTTP 요청을 처리하는 핸들러."""

=======
PORT = 8765

ALLOWED_ORIGINS = {
    f"http://127.0.0.1:{PORT}",
    f"http://localhost:{PORT}",
}
ALLOWED_HOSTS = {
    f"127.0.0.1:{PORT}",
    f"localhost:{PORT}",
}


class Handler(BaseHTTPRequestHandler):
    """단일 HTTP 요청을 처리하는 핸들러."""

    def _check_same_origin(self) -> bool:
        """같은 origin (127.0.0.1:8765 또는 localhost:8765) 의 요청만 허용."""
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

>>>>>>> Stashed changes
    def _send_json(self, status: int, body: dict) -> None:
        """JSON 응답을 보낸다."""
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, path: Path) -> None:
        """정적 파일 응답을 보낸다."""
        if not path.exists() or not path.is_file():
            self.send_error(404, "Not Found")
            return
        mime = MIME_TYPES.get(path.suffix.lower(), "application/octet-stream")
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        # API: 프로젝트 목록
        if path == "/api/projects":
            self._send_json(200, {"projects": list_projects()})
            return

        # 루트 경로 → index.html 서빙
        if path in ("/", ""):
            self._send_file(FRONTEND_DIR / "index.html")
            return

        # 그 외 GET 은 frontend/ 디렉토리 안의 정적 파일로 취급
        # 디렉토리 탈출 공격 방지: resolve 후 frontend 디렉토리 안인지 검사
        candidate = (FRONTEND_DIR / path.lstrip("/")).resolve()
        try:
            candidate.relative_to(FRONTEND_DIR.resolve())
        except ValueError:
            self.send_error(403, "Forbidden")
            return
        self._send_file(candidate)

    def do_POST(self) -> None:
<<<<<<< Updated upstream
=======
        if not self._check_same_origin():
            self._send_json(403, {"error": "허용되지 않은 요청입니다."})
            return

>>>>>>> Stashed changes
        parsed = urlparse(self.path)
        if parsed.path != "/api/projects":
            self.send_error(404, "Not Found")
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "잘못된 JSON 형식입니다."})
            return

        status, body = create_project(payload.get("name", ""))
        self._send_json(status, body)

    def log_message(self, fmt: str, *args) -> None:
        # 콘솔에 간결한 로그 출력
        print(f"[{self.log_date_time_string()}] {fmt % args}")


def main() -> None:
    """서버 부트스트랩."""
    ensure_projects_dir()
<<<<<<< Updated upstream
    port = 8765
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("=" * 60)
    print("프로젝트 매니저 서버 시작")
    print(f"  주소           : http://127.0.0.1:{port}")
=======
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("=" * 60)
    print("프로젝트 매니저 서버 시작")
    print(f"  주소           : http://127.0.0.1:{PORT}")
>>>>>>> Stashed changes
    print(f"  프로젝트 폴더  : {PROJECTS_DIR}")
    print(f"  프론트엔드 폴더: {FRONTEND_DIR}")
    print("=" * 60)
    print("종료하려면 Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")
        server.shutdown()


if __name__ == "__main__":
    main()
