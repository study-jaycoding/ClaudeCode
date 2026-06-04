"""
프로젝트 폴더 생성 백엔드 서버.

특징
- Python 표준 라이브러리만 사용 (http.server, json, pathlib).
- 같은 origin 에서 프론트엔드 정적 파일과 API 를 모두 서빙한다.
- 기본 포트: 8765.
- 새 프로젝트는 D:/ClaudeCode-data/projects/<이름>/ 에 생성되고 기본 README.md 가 함께 만들어진다.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import re
import shutil
import traceback
from datetime import datetime
from urllib.parse import urlparse

# 백엔드 스크립트 기준 절대 경로 계산
BACKEND_DIR = Path(__file__).resolve().parent
ROOT_DIR = BACKEND_DIR.parent  # d:\ClaudeCode\project-manager
FRONTEND_DIR = ROOT_DIR / "frontend"
# 실제 프로젝트들이 생성되는 위치.
# git repo (d:\ClaudeCode) 바깥에 두어 작업 결과물이 커밋 대상에 섞이지 않게 한다.
# 환경변수 PROJECTS_DIR 로 다른 경로 지정 가능 (예: 다른 PC 에 배포 시).
PROJECTS_DIR = Path(os.environ.get("PROJECTS_DIR", "D:/ClaudeCode-data/projects"))

# 프로젝트 이름 검증 정규식: 한글/영문/숫자/공백/하이픈/언더스코어, 1~50자
NAME_PATTERN = re.compile(r"^[\w\sㄱ-ㅎㅏ-ㅣ가-힣\-]{1,50}$", re.UNICODE)

# Windows 예약 이름 (대소문자 무시) — 폴더로 만들 수 없다.
WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

# POST body 최대 크기 (바이트). 프로젝트 이름 정도면 1KB 도 과하지만 여유 둠.
MAX_POST_BODY = 4096

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
    # Windows 예약 이름은 폴더로 만들 수 없음
    if name.upper() in WINDOWS_RESERVED:
        return 400, {"error": f"'{name}' 은(는) 시스템 예약 이름이라 사용할 수 없습니다."}

    ensure_projects_dir()
    target = PROJECTS_DIR / name

    # mkdir(exist_ok=False) 로 race condition 방어 — 동시에 두 요청이 들어와도
    # 한쪽만 폴더를 만들고 다른 쪽은 FileExistsError 로 떨어진다.
    try:
        target.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        return 409, {"error": f"이미 존재하는 프로젝트입니다: {name}"}
    except OSError as e:
        return 500, {"error": f"프로젝트 폴더 생성 실패: {e.strerror or str(e)}"}

    # 이후 단계에서 실패하면 방금 만든 target 을 통째로 지워 부분 생성 상태를 남기지 않는다.
    try:
        # 기본 에셋 하위 폴더 생성 (CH: 캐릭터, BG: 배경, PR: 프랍)
        for sub in ("CH", "BG", "PR"):
            (target / "Assets" / sub).mkdir(parents=True)
        # 레퍼런스 하위 폴더 (img: 이미지, mov: 동영상)
        for sub in ("img", "mov"):
            (target / "Reference" / sub).mkdir(parents=True)
        # 결과물 하위 폴더 (img: 이미지, mov: 동영상)
        for sub in ("img", "mov"):
            (target / "Result" / sub).mkdir(parents=True)
        created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        readme = target / "README.md"
        readme.write_text(
            f"# {name}\n\n생성일: {created_at}\n",
            encoding="utf-8",
        )
    except OSError as e:
        shutil.rmtree(target, ignore_errors=True)
        return 500, {"error": f"하위 폴더 생성 실패: {e.strerror or str(e)}"}

    return 201, {"name": name, "created": created_at, "path": str(target)}


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
        try:
            parsed = urlparse(self.path)
            path = parsed.path

            # API 는 same-origin 만 허용 (정보 노출 일관성 차원)
            if path.startswith("/api/"):
                if not self._check_same_origin():
                    self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                    return
                if path == "/api/projects":
                    self._send_json(200, {"projects": list_projects()})
                    return
                self.send_error(404, "Not Found")
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
        except Exception:
            # traceback 은 서버 콘솔에만 찍고, 클라이언트엔 일반 500 JSON 만 보낸다.
            traceback.print_exc()
            self._safe_send_json(500, {"error": "서버 내부 오류가 발생했습니다."})

    def do_POST(self) -> None:
        try:
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                return

            parsed = urlparse(self.path)
            if parsed.path != "/api/projects":
                self.send_error(404, "Not Found")
                return

            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self._send_json(400, {"error": "잘못된 Content-Length 입니다."})
                return
            if length < 0:
                self._send_json(400, {"error": "잘못된 Content-Length 입니다."})
                return
            if length > MAX_POST_BODY:
                self._send_json(413, {"error": "요청 본문이 너무 큽니다."})
                return

            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                self._send_json(400, {"error": "잘못된 JSON 형식입니다."})
                return
            if not isinstance(payload, dict):
                self._send_json(400, {"error": "요청 본문은 JSON 객체여야 합니다."})
                return

            status, body = create_project(payload.get("name", ""))
            self._send_json(status, body)
        except Exception:
            traceback.print_exc()
            self._safe_send_json(500, {"error": "서버 내부 오류가 발생했습니다."})

    def _safe_send_json(self, status: int, body: dict) -> None:
        """이미 응답이 일부 전송된 상태에서도 예외로 죽지 않도록 감싼 _send_json."""
        try:
            self._send_json(status, body)
        except Exception:
            # 응답 헤더가 이미 나갔거나 소켓이 닫힌 경우 — 더 할 일이 없다.
            pass

    def log_message(self, fmt: str, *args) -> None:
        # 콘솔에 간결한 로그 출력
        print(f"[{self.log_date_time_string()}] {fmt % args}")


def main() -> None:
    """서버 부트스트랩."""
    ensure_projects_dir()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("=" * 60)
    print("프로젝트 매니저 서버 시작")
    print(f"  주소           : http://127.0.0.1:{PORT}")
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
