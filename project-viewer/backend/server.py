"""
프로젝트 뷰어 백엔드 서버.

기능
- project-manager 가 d:\\ClaudeCode\\projects\\ 에 만들어 둔 프로젝트들을 탐색한다.
- 이미지/영상/텍스트 파일을 브라우저에서 미리보기 할 수 있게 한다.
- 영상은 HTTP Range 요청을 지원하여 큰 파일도 seek 가능하게 스트리밍한다.
- 드래그앤드롭 업로드를 받는다 (현재 보고 있는 폴더에 파일이 저장된다).

특징
- Python 표준 라이브러리만 사용 (의존성 0).
- 같은 origin 에서 프론트엔드 정적 파일과 API 를 모두 서빙한다.
- 기본 포트: 8766 (project-manager 의 8765 와 충돌하지 않도록 분리).
- 업로드 POST 는 same-origin 요청만 허용 (cross-origin write 차단).
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import mimetypes
import re
from urllib.parse import urlparse, parse_qs, unquote

# 절대 경로 기준점
BACKEND_DIR = Path(__file__).resolve().parent
ROOT_DIR = BACKEND_DIR.parent  # d:\ClaudeCode\project-viewer
FRONTEND_DIR = ROOT_DIR / "frontend"
# project-manager 와 동일한 projects 폴더 (git repo 바깥) 를 본다.
PROJECTS_DIR = Path("D:/ClaudeCode-data/projects")
FAVORITES_FILE = Path("D:/ClaudeCode-data/favorites.json")

# 확장자 기반 파일 분류
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"}
TEXT_EXTS = {
    ".txt", ".md", ".json", ".py", ".js", ".ts", ".jsx", ".tsx",
    ".html", ".css", ".scss", ".log", ".yaml", ".yml", ".ini",
    ".conf", ".cfg", ".csv", ".xml", ".bat", ".sh", ".ps1",
    ".gitignore", ".env",
}

# 정적 자산 (frontend) 응답용 MIME
STATIC_MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}

PORT = 8766
TEXT_MAX_BYTES = 1024 * 1024              # 텍스트 미리보기 최대 1MB
MAX_UPLOAD_BYTES = 500 * 1024 * 1024      # 업로드 최대 500MB

# Cross-origin 차단을 위한 허용 목록
ALLOWED_ORIGINS = {
    f"http://127.0.0.1:{PORT}",
    f"http://localhost:{PORT}",
}
ALLOWED_HOSTS = {
    f"127.0.0.1:{PORT}",
    f"localhost:{PORT}",
}

# Windows 에서 사용할 수 없는 파일명 문자 + 제어 문자
INVALID_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def classify(path: Path) -> str:
    """확장자로 파일 종류를 분류한다."""
    ext = path.suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    if ext in TEXT_EXTS or path.name.startswith("."):
        return "text"
    return "other"


def safe_project_dir(project_name: str) -> Path | None:
    """프로젝트 이름을 받아 안전한 절대경로를 반환. 비정상 입력은 None."""
    if not project_name:
        return None
    if any(ch in project_name for ch in ("/", "\\")) or ".." in project_name:
        return None
    candidate = (PROJECTS_DIR / project_name).resolve()
    try:
        candidate.relative_to(PROJECTS_DIR.resolve())
    except ValueError:
        return None
    if not candidate.is_dir():
        return None
    return candidate


def safe_resolve(project_dir: Path, rel: str) -> Path | None:
    """프로젝트 디렉토리 기준 상대경로를 안전하게 resolve. 탈출 시 None."""
    if rel is None:
        return None
    target = (project_dir / rel).resolve()
    try:
        target.relative_to(project_dir.resolve())
    except ValueError:
        return None
    return target


def is_safe_filename(name: str) -> bool:
    """업로드 파일명 안전성 검증."""
    if not name:
        return False
    if name in (".", "..") or ".." in name:
        return False
    if len(name) > 200:
        return False
    if INVALID_FILENAME_CHARS.search(name):
        return False
    return True


def unique_path(parent: Path, filename: str) -> Path:
    """parent 안에 filename 충돌 시 ' (2).ext' 형식으로 회피한 경로를 반환."""
    base = parent / filename
    if not base.exists():
        return base
    stem = base.stem
    suffix = base.suffix
    n = 2
    while True:
        candidate = parent / f"{stem} ({n}){suffix}"
        if not candidate.exists():
            return candidate
        n += 1


def list_projects() -> list[dict]:
    """projects 폴더 안의 디렉토리 목록을 이름순으로 반환."""
    if not PROJECTS_DIR.exists():
        return []
    return [
        {"name": entry.name}
        for entry in sorted(PROJECTS_DIR.iterdir(), key=lambda p: p.name.lower())
        if entry.is_dir()
    ]


def build_tree(root: Path) -> dict:
    """프로젝트 루트를 재귀 순회하여 트리 dict 를 만든다."""
    node = {"name": root.name, "type": "dir", "path": "", "children": []}
    _fill_tree(root, node, prefix="")
    return node


def _fill_tree(directory: Path, parent_node: dict, prefix: str) -> None:
    """디렉토리 내용을 parent_node['children'] 에 채운다. 폴더 우선, 같은 종류는 이름순."""
    try:
        entries = sorted(
            directory.iterdir(),
            key=lambda p: (not p.is_dir(), p.name.lower()),
        )
    except PermissionError:
        return

    for entry in entries:
        rel = f"{prefix}{entry.name}"
        if entry.is_dir():
            child = {"name": entry.name, "type": "dir", "path": rel, "children": []}
            parent_node["children"].append(child)
            _fill_tree(entry, child, rel + "/")
        else:
            try:
                size = entry.stat().st_size
            except OSError:
                size = 0
            parent_node["children"].append({
                "name": entry.name,
                "type": "file",
                "kind": classify(entry),
                "path": rel,
                "size": size,
            })


class Handler(BaseHTTPRequestHandler):
    """HTTP 요청 처리. GET 은 탐색/미리보기, POST 는 업로드."""

    # --- 공통 헬퍼 --------------------------------------------------------

    def _send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_static(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(404, "Not Found")
            return
        mime = STATIC_MIME.get(path.suffix.lower(), "application/octet-stream")
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_media(self, path: Path) -> None:
        """이미지/영상 파일을 응답. Range 헤더 있으면 206 Partial Content."""
        if not path.exists() or not path.is_file():
            self.send_error(404, "Not Found")
            return

        mime, _ = mimetypes.guess_type(str(path))
        if not mime:
            mime = "application/octet-stream"

        size = path.stat().st_size
        range_header = self.headers.get("Range")

        if range_header and range_header.startswith("bytes="):
            try:
                rng = range_header[6:].split("-", 1)
                if not rng[0]:
                    # Suffix range: bytes=-500 means last 500 bytes
                    start = max(0, size - int(rng[1]))
                    end = size - 1
                else:
                    start = int(rng[0])
                    end = int(rng[1]) if len(rng) > 1 and rng[1] else size - 1
            except ValueError:
                self.send_error(416, "Invalid Range")
                return
            if start >= size or start < 0 or end < start:
                self.send_error(416, "Invalid Range")
                return
            end = min(end, size - 1)
            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            self.end_headers()
            self._stream_file(path, start, length)
        else:
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            self._stream_file(path, 0, size)

    def _stream_file(self, path: Path, start: int, length: int) -> None:
        """파일을 chunk 단위로 wfile 로 흘려보낸다."""
        chunk = 64 * 1024
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                buf = f.read(min(chunk, remaining))
                if not buf:
                    break
                try:
                    self.wfile.write(buf)
                except (BrokenPipeError, ConnectionResetError):
                    return
                remaining -= len(buf)

    def _check_same_origin(self) -> bool:
        """같은 origin (127.0.0.1:8766 또는 localhost:8766) 의 요청만 허용."""
        host = self.headers.get("Host", "")
        if host not in ALLOWED_HOSTS:
            return False
        # 최신 브라우저는 Sec-Fetch-Site 를 자동으로 보낸다.
        site = self.headers.get("Sec-Fetch-Site")
        if site is not None and site != "same-origin":
            return False
        # Origin 헤더가 있으면 우리 origin 인지 확인
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            return False
        return True

    # --- 라우팅 -----------------------------------------------------------

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/api/projects":
            self._send_json(200, {"projects": list_projects()})
            return

        if path == "/api/favorites":
            if FAVORITES_FILE.exists():
                try:
                    favs = json.loads(FAVORITES_FILE.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    favs = []
            else:
                favs = []
            self._send_json(200, {"favorites": favs})
            return

        if path == "/api/tree":
            project = params.get("project", [""])[0]
            project_dir = safe_project_dir(project)
            if project_dir is None:
                self._send_json(404, {"error": "프로젝트를 찾을 수 없습니다."})
                return
            self._send_json(200, {"tree": build_tree(project_dir)})
            return

        if path == "/api/file":
            project = params.get("project", [""])[0]
            rel = params.get("path", [""])[0]
            project_dir = safe_project_dir(project)
            if project_dir is None:
                self._send_json(404, {"error": "프로젝트를 찾을 수 없습니다."})
                return
            target = safe_resolve(project_dir, rel)
            if target is None or not target.is_file():
                self._send_json(404, {"error": "파일을 찾을 수 없습니다."})
                return
            if classify(target) != "text":
                self._send_json(400, {"error": "텍스트 파일이 아닙니다."})
                return

            raw = target.read_bytes()
            truncated = False
            if len(raw) > TEXT_MAX_BYTES:
                raw = raw[:TEXT_MAX_BYTES]
                truncated = True
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = raw.decode("latin-1", errors="replace")

            self._send_json(200, {
                "name": target.name,
                "path": rel,
                "kind": "text",
                "content": text,
                "truncated": truncated,
                "size": target.stat().st_size,
            })
            return

        if path == "/media":
            project = params.get("project", [""])[0]
            rel = params.get("path", [""])[0]
            project_dir = safe_project_dir(project)
            if project_dir is None:
                self.send_error(404, "Not Found")
                return
            target = safe_resolve(project_dir, rel)
            if target is None or not target.is_file():
                self.send_error(404, "Not Found")
                return
            self._send_media(target)
            return

        # 루트 → index.html
        if path in ("/", ""):
            self._send_static(FRONTEND_DIR / "index.html")
            return

        # 그 외는 frontend 정적 파일
        candidate = (FRONTEND_DIR / path.lstrip("/")).resolve()
        try:
            candidate.relative_to(FRONTEND_DIR.resolve())
        except ValueError:
            self.send_error(403, "Forbidden")
            return
        self._send_static(candidate)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/api/favorites":
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                return
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length else "[]"
            try:
                favs = json.loads(raw)
            except json.JSONDecodeError:
                self._send_json(400, {"error": "잘못된 JSON"})
                return
            FAVORITES_FILE.parent.mkdir(parents=True, exist_ok=True)
            FAVORITES_FILE.write_text(
                json.dumps(favs, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            self._send_json(200, {"ok": True, "count": len(favs)})
            return

        if path != "/api/upload":
            self.send_error(404, "Not Found")
            return

        # Cross-origin POST 차단
        if not self._check_same_origin():
            self._send_json(403, {"error": "허용되지 않은 요청입니다."})
            return

        # Content-Length 검증
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "잘못된 Content-Length 헤더입니다."})
            return
        if length <= 0:
            self._send_json(400, {"error": "본문이 비어있습니다."})
            return
        if length > MAX_UPLOAD_BYTES:
            self._send_json(413, {
                "error": f"파일이 너무 큽니다 (최대 {MAX_UPLOAD_BYTES // 1024 // 1024}MB)."
            })
            return

        # project / dir 검증
        project = params.get("project", [""])[0]
        rel_dir = params.get("dir", [""])[0]
        project_dir = safe_project_dir(project)
        if project_dir is None:
            self._send_json(404, {"error": "프로젝트를 찾을 수 없습니다."})
            return
        target_dir = safe_resolve(project_dir, rel_dir) if rel_dir else project_dir
        if target_dir is None or not target_dir.is_dir():
            self._send_json(404, {"error": "대상 폴더를 찾을 수 없습니다."})
            return

        # X-File-Name 헤더에서 파일명 받기 (URL 인코딩된 한글 등 디코딩)
        raw_name = self.headers.get("X-File-Name", "")
        try:
            filename = unquote(raw_name)
        except Exception:
            filename = raw_name
        if not is_safe_filename(filename):
            self._send_json(400, {"error": "잘못된 파일 이름입니다."})
            return

        # 중복 시 자동 rename
        target_path = unique_path(target_dir, filename)

        # 본문을 chunk 단위로 읽어 파일에 저장
        written = 0
        try:
            with open(target_path, "wb") as f:
                remaining = length
                chunk = 64 * 1024
                while remaining > 0:
                    buf = self.rfile.read(min(chunk, remaining))
                    if not buf:
                        break
                    f.write(buf)
                    written += len(buf)
                    remaining -= len(buf)
        except Exception as e:
            # 실패 시 부분 저장된 파일 정리
            try:
                target_path.unlink(missing_ok=True)
            except Exception:
                pass
            self._send_json(500, {"error": f"저장 실패: {e}"})
            return

        # 전체 바이트를 수신하지 못한 경우 부분 파일 삭제 후 에러
        if written < length:
            try:
                target_path.unlink(missing_ok=True)
            except Exception:
                pass
            self._send_json(500, {
                "error": f"업로드가 불완전합니다 ({written}/{length} 바이트 수신)."
            })
            return

        # 응답: 프로젝트 루트 기준 상대경로
        try:
            new_rel = str(target_path.relative_to(project_dir)).replace("\\", "/")
        except Exception:
            new_rel = target_path.name
        self._send_json(201, {
            "name": target_path.name,
            "path": new_rel,
            "size": written,
        })

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("=" * 60)
    print("프로젝트 뷰어 서버 시작")
    print(f"  주소           : http://127.0.0.1:{PORT}")
    print(f"  프로젝트 폴더  : {PROJECTS_DIR}")
    print(f"  프론트엔드 폴더: {FRONTEND_DIR}")
    print(f"  최대 업로드    : {MAX_UPLOAD_BYTES // 1024 // 1024}MB")
    print("=" * 60)
    print("종료하려면 Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")
        server.shutdown()


if __name__ == "__main__":
    main()
