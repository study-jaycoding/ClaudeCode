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
import queue
import re
import sys
import threading
import time

from urllib.parse import urlparse, parse_qs, unquote

# 절대 경로 기준점
BACKEND_DIR = Path(__file__).resolve().parent
ROOT_DIR = BACKEND_DIR.parent  # d:\ClaudeCode\project-viewer
FRONTEND_DIR = ROOT_DIR / "frontend"

# ── .env 자동 로드 (선택) ────────────────────────────────────────
# Spotlight 모듈들 (projects_ops / jobs_log 등) 이 import 시점에 os.environ 을 읽어
# 모듈 상수를 고정하기 때문에 — .env 로드는 반드시 그 import 보다 *먼저* 수행해야 한다.
def _load_dotenv() -> None:
    """ROOT_DIR/.env 또는 BACKEND_DIR/.env 의 KEY=VALUE 를 os.environ 에 주입.
    이미 있는 환경변수는 덮어쓰지 않는다. 의존성 없음."""
    import os
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

# .env 로드 *후에* Spotlight 통합 모듈 import — 이래야 CCDATA_DIR 등이 반영된다.
sys.path.insert(0, str(BACKEND_DIR))
from spotlight import api as sp_api

import os as _os
CCDATA_DIR = Path(_os.environ.get("CCDATA_DIR", "D:/ClaudeCode-data"))
PROJECTS_DIR = Path(_os.environ.get("CCDATA_PROJECTS_DIR", str(CCDATA_DIR / "projects")))

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

PORT = int(_os.environ.get("PV_PORT", "8766"))
BIND = _os.environ.get("PV_BIND", "127.0.0.1")
TEXT_MAX_BYTES = 1024 * 1024              # 텍스트 미리보기 최대 1MB
MAX_UPLOAD_BYTES = int(_os.environ.get("PV_MAX_UPLOAD_MB", "500")) * 1024 * 1024

# Cross-origin 차단을 위한 허용 목록
_extra_origins = [o.strip() for o in _os.environ.get("PV_EXTRA_ORIGINS", "").split(",") if o.strip()]
_extra_hosts = [h.strip() for h in _os.environ.get("PV_EXTRA_HOSTS", "").split(",") if h.strip()]
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

# Windows 에서 사용할 수 없는 파일명 문자 + 제어 문자
INVALID_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

# ─────────────────────────────────────────────────────────────────────
# SSE — favorites.json 변경 시 모든 클라이언트에 즉시 push
# (spotlight 가 다운로드 후 favorites.json 에 쓰면 viewer 가 자동 갱신)
# ─────────────────────────────────────────────────────────────────────
SSE_CLIENTS: list[queue.Queue] = []
SSE_LOCK = threading.Lock()


def _broadcast_event(msg: str) -> None:
    """모든 SSE 클라이언트 큐에 메시지를 push."""
    with SSE_LOCK:
        for q in list(SSE_CLIENTS):
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass


# ─────────────────────────────────────────────────────────────────────
# delete / rename / move 핸들러 공통: ledger + favorites 경로 동기화
# 메인 동작 (실제 파일 작업) 은 이미 성공한 다음 호출됨. 동기화 실패는 절대 메인을
# 깨면 안 되므로 try/except 로 광범위하게 감싸되 stderr 에 흔적은 남긴다.
# ─────────────────────────────────────────────────────────────────────

def _sync_ledger_path(project_dir: Path, old_rel: str, new_rel: str | None, *, is_dir: bool) -> None:
    """ledger 키 동기화. new_rel=None 이면 삭제, 아니면 rename. 폴더면 prefix 일괄."""
    try:
        from spotlight import ledger as sp_ledger
        if new_rel is None:
            if is_dir:
                sp_ledger.remove_with_prefix(project_dir, old_rel)
            else:
                sp_ledger.remove(project_dir, old_rel)
        else:
            sp_ledger.rename(project_dir, old_rel, new_rel, is_dir=is_dir)
    except Exception as e:  # noqa: BLE001
        print(f"[server] ledger sync fail ({old_rel} -> {new_rel}): {e}", file=sys.stderr)


def _sync_favorites_path(project: str, old_rel: str, new_rel: str | None, *, is_dir: bool) -> None:
    """favorites 의 path 동기화. new_rel=None 이면 해당 entry 삭제, 아니면 rename.
    프로젝트별 lock 안에서 실행."""
    try:
        from spotlight import favorites_store as _fs
        old_rel = old_rel.replace("\\", "/")
        new_rel_norm = new_rel.replace("\\", "/") if new_rel else None
        with _fs.FavoritesLock(project):
            favs = _fs.load_favorites(project)
            changed = False
            kept: list[dict] = []
            for f in favs:
                p = f.get("path", "")
                if new_rel_norm is None:
                    # 삭제 — 파일은 정확 매치, 폴더는 prefix 매치
                    if is_dir:
                        if p == old_rel or p.startswith(old_rel + "/"):
                            changed = True
                            continue
                    else:
                        if p == old_rel:
                            changed = True
                            continue
                    kept.append(f)
                else:
                    # rename — 파일은 정확 매치, 폴더는 prefix 치환
                    if is_dir:
                        if p == old_rel or p.startswith(old_rel + "/"):
                            f["path"] = new_rel_norm + p[len(old_rel):]
                            changed = True
                    else:
                        if p == old_rel:
                            f["path"] = new_rel_norm
                            changed = True
                    kept.append(f)
            if changed:
                _fs.save_favorites(project, kept)
    except Exception as e:  # noqa: BLE001
        print(f"[server] favorites sync fail ({old_rel} -> {new_rel}): {e}", file=sys.stderr)


def _sync_colors_path(project: str, old_rel: str, new_rel: str | None, *, is_dir: bool) -> None:
    """colors 의 path 동기화. new_rel=None 이면 entry 삭제, 아니면 rename. 폴더면 prefix."""
    try:
        from spotlight import colors_store
        if new_rel is None:
            colors_store.remove_path(project, old_rel)
        else:
            colors_store.rename_path(project, old_rel, new_rel, is_dir=is_dir)
    except Exception as e:  # noqa: BLE001
        print(f"[server] colors sync fail ({old_rel} -> {new_rel}): {e}", file=sys.stderr)


def _sync_jobs_path(project: str, old_rel: str, new_rel: str | None, *, is_dir: bool) -> None:
    """jobs.json 의 thumbnail_path / result_paths 동기화 — 큐 카드 썸네일 오류 방지."""
    try:
        from spotlight import jobs_log
        if new_rel is None:
            jobs_log.remove_path(project, old_rel)
        else:
            jobs_log.rename_path(project, old_rel, new_rel, is_dir=is_dir)
    except Exception as e:  # noqa: BLE001
        print(f"[server] jobs sync fail ({old_rel} -> {new_rel}): {e}", file=sys.stderr)


def _sync_comments_path(project: str, old_rel: str, new_rel: str | None, *, is_dir: bool) -> None:
    """comments.json 의 path 동기화. new_rel=None 이면 entry 삭제, 아니면 rename."""
    try:
        from spotlight import comments_store
        if new_rel is None:
            comments_store.remove_path(project, old_rel)
        else:
            comments_store.rename_path(project, old_rel, new_rel, is_dir=is_dir)
    except Exception as e:  # noqa: BLE001
        print(f"[server] comments sync fail ({old_rel} -> {new_rel}): {e}", file=sys.stderr)


def _favorites_watcher() -> None:
    """모든 프로젝트의 _meta/favorites.json + 글로벌 leftover 의 mtime 폴링.
    어느 하나라도 변경되면 SSE broadcast — 모든 PV 클라이언트가 즉시 자동 갱신.
    프로젝트 추가/삭제도 매 폴링 시 자동 반영."""
    last_max = 0.0
    while True:
        time.sleep(1.0)
        cur_max = 0.0
        try:
            from spotlight.favorites_store import all_favorites_files
            for p in all_favorites_files():
                try:
                    m = p.stat().st_mtime
                    if m > cur_max:
                        cur_max = m
                except OSError:
                    continue
        except Exception:
            continue
        if cur_max != last_max:
            last_max = cur_max
            _broadcast_event("favorites-changed")


def _jobs_watcher() -> None:
    """모든 프로젝트의 _meta/jobs.json + 글로벌 leftover 파일의 mtime 을 폴링.
    어느 하나라도 변경되면 SSE broadcast — Queue 탭이 자동 갱신.
    프로젝트 추가/삭제도 다음 폴링 시 자동 반영 (all_jobs_files 가 매번 재열거)."""
    from spotlight.jobs_log import all_jobs_files
    last_max = 0.0
    while True:
        time.sleep(1.0)
        cur_max = 0.0
        try:
            for p in all_jobs_files():
                try:
                    m = p.stat().st_mtime
                    if m > cur_max:
                        cur_max = m
                except OSError:
                    continue
        except Exception:
            continue
        if cur_max != last_max:
            last_max = cur_max
            _broadcast_event("jobs-changed")


import struct
from datetime import datetime


def get_image_dimensions(path: Path) -> tuple[int | None, int | None]:
    """PNG/JPEG 파일의 해상도를 표준 라이브러리만으로 읽는다."""
    ext = path.suffix.lower()
    try:
        if ext == ".png":
            with open(path, "rb") as f:
                header = f.read(24)
                if len(header) >= 24 and header[:8] == b"\x89PNG\r\n\x1a\n":
                    w, h = struct.unpack(">II", header[16:24])
                    return w, h
        elif ext in (".jpg", ".jpeg"):
            with open(path, "rb") as f:
                if f.read(2) != b"\xff\xd8":
                    return None, None
                while True:
                    marker = f.read(2)
                    if len(marker) < 2 or marker[0] != 0xFF:
                        break
                    code = marker[1]
                    if code in (0xC0, 0xC1, 0xC2):
                        f.read(3)
                        h, w = struct.unpack(">HH", f.read(4))
                        return w, h
                    elif code == 0xD9:
                        break
                    elif code in (0xD0, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0x01):
                        continue
                    else:
                        seg_len = struct.unpack(">H", f.read(2))[0]
                        f.read(seg_len - 2)
    except Exception:
        pass
    return None, None


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

    # ledger 모듈은 자신이 만든 파일·폴더가 트리에 노출되지 않게 판별 함수를 제공.
    try:
        from spotlight import ledger as _sp_ledger_filter
        _is_ledger = _sp_ledger_filter.is_ledger_path
    except Exception:
        _is_ledger = lambda p: False  # fallback

    for entry in entries:
        # 시스템 ledger 파일·폴더는 트리에 노출 안 함 (_generations/, _generations.json,
        # _generations.json.migrated 등 모두 포함)
        if _is_ledger(entry):
            continue
        # project-manager 가 새 프로젝트 생성 시 자동으로 만드는 placeholder.
        # 미디어 뷰어 트리에서는 숨김 (디스크에는 그대로 둠).
        if entry.is_file() and entry.name.lower() == "readme.md":
            continue
        # Reference/scratch/ — 외부 drag-drop / 클립보드 capture 의 일회성 파일 격리 폴더.
        # 트리/그리드에서 숨김. spotlight 의 #scratch 태그 필터로만 접근 (정리·재사용 용).
        if entry.is_dir() and entry.name == "scratch" and prefix.rstrip("/") == "Reference":
            continue
        rel = f"{prefix}{entry.name}"
        if entry.is_dir():
            child = {"name": entry.name, "type": "dir", "path": rel, "children": []}
            parent_node["children"].append(child)
            _fill_tree(entry, child, rel + "/")
        else:
            try:
                st = entry.stat()
                size = st.st_size
                mtime = st.st_mtime
            except OSError:
                size = 0
                mtime = 0
            parent_node["children"].append({
                "name": entry.name,
                "type": "file",
                "kind": classify(entry),
                "path": rel,
                "size": size,
                "mtime": mtime,
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

    def _read_body(self) -> bytes:
        """Content-Length 만큼 raw body 읽기. 0 이면 b''."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        return self.rfile.read(length) if length > 0 else b""

    def _read_body_text(self) -> str:
        """raw body 를 UTF-8 텍스트로. 빈 본문은 ''."""
        return self._read_body().decode("utf-8")

    def _read_json_body(self) -> dict | None:
        """JSON body 파싱. 잘못된 JSON 이면 400 응답 후 None 반환 — 호출자는 즉시 return."""
        raw = self._read_body_text() or "{}"
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "잘못된 JSON"})
            return None

    def _serve_sse(self) -> None:
        """SSE 스트림 — favorites.json 변경 등을 client 에 즉시 push.
        20초 timeout 으로 keep-alive ping; 연결 끊기면 종료."""
        q: queue.Queue = queue.Queue(maxsize=100)
        with SSE_LOCK:
            SSE_CLIENTS.append(q)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            # 연결 직후 keep-alive 한 번
            try:
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
            except OSError:
                return
            while True:
                try:
                    msg = q.get(timeout=20)
                    payload = f"data: {msg}\n\n".encode("utf-8")
                except queue.Empty:
                    payload = b": ping\n\n"
                try:
                    self.wfile.write(payload)
                    self.wfile.flush()
                except OSError:
                    break  # 클라이언트 끊김
        finally:
            with SSE_LOCK:
                if q in SSE_CLIENTS:
                    SSE_CLIENTS.remove(q)

    def _send_static(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(404, "Not Found")
            return
        mime = STATIC_MIME.get(path.suffix.lower(), "application/octet-stream")
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(data)

    def _send_media(self, path: Path) -> None:
        """이미지/영상 파일을 응답. Range 헤더 있으면 206 Partial Content.
        Cache-Control + ETag 로 브라우저 캐시 활용 → 새로고침 시 304 로 즉시 응답."""
        if not path.exists() or not path.is_file():
            self.send_error(404, "Not Found")
            return

        mime, _ = mimetypes.guess_type(str(path))
        if not mime:
            mime = "application/octet-stream"

        stat = path.stat()
        size = stat.st_size
        mtime = int(stat.st_mtime)
        # ETag = mtime + size 의 hex — 파일 내용 변경 시 자동으로 새 ETag.
        etag = f'"{mtime:x}-{size:x}"'
        # 304 Not Modified — 클라이언트의 If-None-Match 가 현재 ETag 와 같으면 본문 없이 응답
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "private, max-age=3600, must-revalidate")
            self.end_headers()
            return

        range_header = self.headers.get("Range")
        cache_headers = [
            ("ETag", etag),
            # 1시간 동안 캐시 OK, 그 후엔 ETag 로 conditional GET. 로컬 파일이라 long max-age 안전.
            ("Cache-Control", "private, max-age=3600, must-revalidate"),
            ("Last-Modified", time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(mtime))),
        ]

        if range_header and range_header.startswith("bytes="):
            try:
                rng = range_header[6:].split("-", 1)
                if not rng[0]:
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
            for k, v in cache_headers:
                self.send_header(k, v)
            self.end_headers()
            self._stream_file(path, start, length)
        else:
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(size))
            for k, v in cache_headers:
                self.send_header(k, v)
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

        # ── Spotlight 엔드포인트 ─────────────────────────────────────
        if path == "/api/sp/models":
            self._send_json(*sp_api.get_models()); return
        if path == "/api/sp/balance":
            self._send_json(*sp_api.get_balance()); return
        # /api/sp/jobs (list)  vs  /api/sp/jobs/{id} (single status from CLI)
        if path == "/api/sp/jobs":
            from spotlight import jobs_log
            status = params.get("status", [None])[0]
            project = params.get("project", [None])[0]
            limit_raw = params.get("limit", [None])[0]
            try:
                limit = int(limit_raw) if limit_raw else None
            except ValueError:
                limit = None
            self._send_json(200, {"jobs": jobs_log.list_jobs(
                status=status, project=project, limit=limit,
            )})
            return
        if path.startswith("/api/sp/jobs/"):
            self._send_json(*sp_api.get_job(path[len("/api/sp/jobs/"):])); return

        if path == "/api/projects":
            self._send_json(200, {"projects": list_projects()})
            return

        if path == "/api/events":
            self._serve_sse()
            return

        if path == "/api/favorites":
            # ?project=<name> 이면 그 프로젝트만, 없으면 전체 (모든 프로젝트 + 글로벌 leftover)
            project = (params.get("project") or [""])[0]
            try:
                from spotlight import favorites_store as _fs
                favs = _fs.load_favorites(project) if project else _fs.all_favorites()
            except Exception:
                favs = []
            self._send_json(200, {"favorites": favs})
            return

        if path == "/api/colors":
            project = (params.get("project") or [""])[0]
            try:
                from spotlight import colors_store
                colors = colors_store.load_colors(project) if project else {}
            except Exception:
                colors = {}
            self._send_json(200, {"colors": colors})
            return

        if path == "/api/comments":
            project = (params.get("project") or [""])[0]
            try:
                from spotlight import comments_store
                comments = comments_store.load_all(project) if project else {}
            except Exception:
                comments = {}
            self._send_json(200, {"comments": comments})
            return

        if path == "/api/meta":
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
            stat = target.stat()
            w, h = get_image_dimensions(target)
            # 생성 메타데이터 — 프로젝트별 누적 ledger 에서 조회.
            # (기존 *.json sidecar 들은 ledger.get 호출 시 자동 1회 마이그레이션 + 삭제.)
            try:
                from spotlight import ledger as sp_ledger
                sidecar = sp_ledger.get(project_dir, rel)
            except Exception:
                sidecar = None
            self._send_json(200, {
                "name": target.name,
                "path": rel,
                "ext": target.suffix.lower(),
                "size": stat.st_size,
                "width": w,
                "height": h,
                "kind": classify(target),
                "ctime": datetime.fromtimestamp(stat.st_ctime).strftime("%Y-%m-%d %H:%M:%S"),
                "mtime": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                "sidecar": sidecar,
            })
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

        if path == "/thumb":
            # 서버 사이드 썸네일 — 원본 디코드 회피. 한 번 생성 후 디스크 영구 캐시.
            project = params.get("project", [""])[0]
            rel = params.get("path", [""])[0]
            try:
                size = int(params.get("size", ["800"])[0])
            except ValueError:
                size = 800
            project_dir = safe_project_dir(project)
            if project_dir is None:
                self.send_error(404, "Not Found"); return
            src = safe_resolve(project_dir, rel)
            if src is None or not src.is_file():
                self.send_error(404, "Not Found"); return
            # 모듈 import 는 첫 호출 시 — startup 안 막음
            from spotlight import thumbs

            def _resolver(p: str, r: str):
                pd = safe_project_dir(p)
                return safe_resolve(pd, r) if pd else None

            thumb_path = thumbs.ensure_thumb(project, rel, size, src_resolver=_resolver)
            if thumb_path is None:
                # 생성 실패 (Pillow 없음 / ffmpeg 없음 / 손상 파일 등) — 원본 그대로 응답
                self._send_media(src); return

            stat = thumb_path.stat()
            etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", "public, max-age=31536000, immutable")
                self.end_headers()
                return
            data = thumb_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.send_header("ETag", etag)
            self.end_headers()
            self.wfile.write(data)
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

        # ── Spotlight Jobs Queue 관리 ────────────────────────────────
        if path == "/api/sp/jobs/clear-finished":
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."}); return
            from spotlight import jobs_log
            # ?status=completed | failed → 그 상태만. 없으면 둘 다.
            only = (params.get("status") or [None])[0]
            if only not in ("completed", "failed"):
                only = None
            project = (params.get("project") or [None])[0]
            n = jobs_log.clear_finished(project=project, only_status=only)
            self._send_json(200, {"removed": n})
            return
        if path == "/api/sp/jobs/clear-all":
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."}); return
            from spotlight import jobs_log
            project = (params.get("project") or [None])[0]
            n = jobs_log.clear_all(project=project)
            self._send_json(200, {"removed": n})
            return
        if path == "/api/sp/jobs/remove":
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."}); return
            body = self._read_json_body()
            if body is None: return
            job_id = (body.get("id") or "").strip()
            if not job_id:
                self._send_json(400, {"error": "id 가 필요합니다."}); return
            project = (body.get("project") or None) or None
            from spotlight import jobs_log
            ok = jobs_log.remove_job(job_id, project=project)
            self._send_json(200, {"removed": 1 if ok else 0})
            return

        # ── Spotlight 엔드포인트 ─────────────────────────────────────
        if path in ("/api/sp/login", "/api/sp/generate", "/api/sp/cost",
                    "/api/sp/ref-upload", "/api/sp/recover"):
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                return
            if path == "/api/sp/login":
                self._send_json(*sp_api.post_login()); return
            if path == "/api/sp/generate":
                self._send_json(*sp_api.post_generate(self._read_body_text())); return
            if path == "/api/sp/cost":
                self._send_json(*sp_api.post_cost(self._read_body_text())); return
            if path == "/api/sp/recover":
                self._send_json(*sp_api.post_recover(self._read_body_text())); return
            if path == "/api/sp/ref-upload":
                # header length 로 사전 size 검증 — 거짓 큰 헤더로 read OOM 차단.
                length = int(self.headers.get("Content-Length", "0") or "0")
                filename = self.headers.get("X-File-Name", "upload.png")
                body = self.rfile.read(length) if length > 0 else b""
                self._send_json(*sp_api.post_ref_upload(length, filename, body)); return

        if path == "/api/fetch-url":
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                return
            payload = self._read_json_body()
            if payload is None: return
            project = payload.get("project", "")
            rel_dir = payload.get("dir", "")
            src_url = payload.get("url", "")
            filename = payload.get("filename", "")
            if not src_url or not src_url.lower().startswith(("http://", "https://")):
                self._send_json(400, {"error": "유효한 URL 이 필요합니다."})
                return
            project_dir = safe_project_dir(project)
            if project_dir is None:
                self._send_json(404, {"error": "프로젝트를 찾을 수 없습니다."})
                return
            target_dir = safe_resolve(project_dir, rel_dir) if rel_dir else project_dir
            if target_dir is None or not target_dir.is_dir():
                self._send_json(404, {"error": "대상 폴더를 찾을 수 없습니다."})
                return
            if not filename:
                filename = unquote(urlparse(src_url).path.split("/")[-1]) or "downloaded"
            if not is_safe_filename(filename):
                self._send_json(400, {"error": "잘못된 파일 이름입니다."})
                return
            import urllib.request
            try:
                req = urllib.request.Request(src_url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=30) as resp:
                    if int(resp.headers.get("Content-Length", "0")) > MAX_UPLOAD_BYTES:
                        self._send_json(413, {"error": "파일이 너무 큽니다."})
                        return
                    data = resp.read(MAX_UPLOAD_BYTES + 1)
                    if len(data) > MAX_UPLOAD_BYTES:
                        self._send_json(413, {"error": "파일이 너무 큽니다."})
                        return
            except Exception as e:
                self._send_json(502, {"error": f"URL 다운로드 실패: {e}"})
                return
            target_path = unique_path(target_dir, filename)
            target_path.write_bytes(data)
            new_rel = str(target_path.relative_to(project_dir)).replace("\\", "/")
            self._send_json(201, {"name": target_path.name, "path": new_rel, "size": len(data)})
            return

        if path == "/api/delete":
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                return
            payload = self._read_json_body()
            if payload is None: return
            project = payload.get("project", "")
            rel = payload.get("path", "")
            project_dir = safe_project_dir(project)
            if project_dir is None:
                self._send_json(404, {"error": "프로젝트를 찾을 수 없습니다."})
                return
            target = safe_resolve(project_dir, rel)
            if target is None or not target.exists():
                self._send_json(404, {"error": "파일/폴더를 찾을 수 없습니다."})
                return
            was_dir = target.is_dir()
            try:
                if was_dir:
                    import shutil
                    shutil.rmtree(target)
                else:
                    target.unlink()
            except Exception as e:
                self._send_json(500, {"error": f"삭제 실패: {e}"})
                return
            _sync_ledger_path(project_dir, rel, None, is_dir=was_dir)
            _sync_favorites_path(project, rel, None, is_dir=was_dir)
            _sync_colors_path(project, rel, None, is_dir=was_dir)
            _sync_jobs_path(project, rel, None, is_dir=was_dir)
            _sync_comments_path(project, rel, None, is_dir=was_dir)
            self._send_json(200, {"deleted": rel})
            return

        if path == "/api/mkdir":
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                return
            payload = self._read_json_body()
            if payload is None: return
            project = payload.get("project", "")
            parent = payload.get("parent", "")
            name = (payload.get("name", "") or "").strip()
            if not name or any(c in name for c in '/\\:*?"<>|'):
                self._send_json(400, {"error": "잘못된 폴더 이름"})
                return
            project_dir = safe_project_dir(project)
            if project_dir is None:
                self._send_json(404, {"error": "프로젝트를 찾을 수 없습니다."})
                return
            parent_dir = safe_resolve(project_dir, parent) if parent else project_dir
            if parent_dir is None:
                self._send_json(404, {"error": "잘못된 부모 경로입니다."})
                return
            target = parent_dir / name
            if target.exists():
                self._send_json(409, {"error": "이미 존재하는 이름입니다."})
                return
            try:
                # 부모 폴더가 아직 없으면 함께 생성 (예: Result/ 미생성 상태)
                target.mkdir(parents=True, exist_ok=False)
            except Exception as e:
                self._send_json(500, {"error": f"폴더 생성 실패: {e}"})
                return
            rel = str(target.relative_to(project_dir)).replace("\\", "/")
            self._send_json(201, {"path": rel, "name": name})
            return

        if path == "/api/rename":
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                return
            payload = self._read_json_body()
            if payload is None: return
            project = payload.get("project", "")
            rel = payload.get("path", "")
            new_name = payload.get("newName", "").strip()
            project_dir = safe_project_dir(project)
            if project_dir is None:
                self._send_json(404, {"error": "프로젝트를 찾을 수 없습니다."})
                return
            target = safe_resolve(project_dir, rel)
            if target is None or not target.exists():
                self._send_json(404, {"error": "파일/폴더를 찾을 수 없습니다."})
                return
            if not is_safe_filename(new_name):
                self._send_json(400, {"error": "잘못된 이름입니다."})
                return
            dst = target.parent / new_name
            if dst.exists():
                self._send_json(409, {"error": f"같은 이름이 이미 존재합니다: {new_name}"})
                return
            try:
                target.rename(dst)
            except Exception as e:
                self._send_json(500, {"error": f"이름 변경 실패: {e}"})
                return
            new_rel = str(dst.relative_to(project_dir)).replace("\\", "/")
            old_rel = rel.replace("\\", "/")
            was_dir = dst.is_dir()
            _sync_ledger_path(project_dir, old_rel, new_rel, is_dir=was_dir)
            _sync_favorites_path(project, old_rel, new_rel, is_dir=was_dir)
            _sync_colors_path(project, old_rel, new_rel, is_dir=was_dir)
            _sync_jobs_path(project, old_rel, new_rel, is_dir=was_dir)
            _sync_comments_path(project, old_rel, new_rel, is_dir=was_dir)
            self._send_json(200, {"name": new_name, "from": rel, "to": new_rel})
            return

        if path == "/api/reveal":
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                return
            # LAN 노출 (bind 가 localhost 외) 인 경우 reveal 차단.
            # 이유: 서버 PC 에 Explorer 가 떠도 LAN 사용자에겐 보이지 않고, 잠재적 보안 위험.
            if BIND not in ("127.0.0.1", "localhost", "::1"):
                self._send_json(403, {
                    "error": "LAN 모드에서는 '원본 위치 열기' 가 비활성화됩니다.",
                    "hint": "이 기능은 PV_BIND=127.0.0.1 (로컬 전용) 모드에서만 동작합니다.",
                })
                return
            payload = self._read_json_body()
            if payload is None: return
            project = payload.get("project", "")
            rel = payload.get("path", "")
            project_dir = safe_project_dir(project)
            if project_dir is None:
                self._send_json(404, {"error": "프로젝트를 찾을 수 없습니다."})
                return
            target = safe_resolve(project_dir, rel)
            if target is None or not target.exists():
                self._send_json(404, {"error": "파일을 찾을 수 없습니다."})
                return
            import subprocess
            try:
                # Windows 탐색기에서 파일이 선택된 상태로 폴더 열기
                subprocess.Popen(["explorer.exe", f"/select,{str(target)}"])
            except Exception as e:
                self._send_json(500, {"error": f"탐색기 열기 실패: {e}"})
                return
            self._send_json(200, {"opened": str(target)})
            return

        if path == "/api/move":
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                return
            payload = self._read_json_body()
            if payload is None: return
            project = payload.get("project", "")
            from_path = payload.get("from", "")
            to_dir = payload.get("toDir", "")
            project_dir = safe_project_dir(project)
            if project_dir is None:
                self._send_json(404, {"error": "프로젝트를 찾을 수 없습니다."})
                return
            src = safe_resolve(project_dir, from_path)
            if src is None or not src.is_file():
                self._send_json(404, {"error": "원본 파일을 찾을 수 없습니다."})
                return
            dst_dir = safe_resolve(project_dir, to_dir) if to_dir else project_dir
            if dst_dir is None or not dst_dir.is_dir():
                self._send_json(404, {"error": "대상 폴더를 찾을 수 없습니다."})
                return
            dst = dst_dir / src.name
            if dst.exists():
                self._send_json(409, {"error": f"대상에 같은 이름의 파일이 존재합니다: {src.name}"})
                return
            try:
                src.rename(dst)
            except Exception as e:
                self._send_json(500, {"error": f"이동 실패: {e}"})
                return
            new_rel = str(dst.relative_to(project_dir)).replace("\\", "/")
            _sync_ledger_path(project_dir, from_path, new_rel, is_dir=False)
            _sync_favorites_path(project, from_path, new_rel, is_dir=False)
            _sync_colors_path(project, from_path, new_rel, is_dir=False)
            _sync_jobs_path(project, from_path, new_rel, is_dir=False)
            _sync_comments_path(project, from_path, new_rel, is_dir=False)
            self._send_json(200, {"name": src.name, "from": from_path, "to": new_rel})
            return

        if path == "/api/favorites":
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                return
            raw = self._read_body_text() or "[]"
            try:
                favs = json.loads(raw)
            except json.JSONDecodeError:
                self._send_json(400, {"error": "잘못된 JSON"})
                return
            # ?project=<name> 필수. 없으면 글로벌 통째 쓰기는 거부 (실수 방지).
            project = (params.get("project") or [""])[0]
            if not project:
                self._send_json(400, {
                    "error": "project 파라미터가 필요합니다.",
                    "hint": "POST /api/favorites?project=<프로젝트이름> 으로 호출하세요.",
                })
                return
            # 그 프로젝트 favorites 통째 덮어쓰기 (lock-safe)
            from spotlight import favorites_store as _fs
            try:
                with _fs.FavoritesLock(project):
                    _fs.save_favorites(project, favs)
            except _fs.FavoritesLockTimeout:
                self._send_json(503, {
                    "error": "favorites 락 획득 실패 (다른 프로세스가 점유 중) — 잠시 후 재시도하세요.",
                })
                return
            self._send_json(200, {"ok": True, "project": project, "count": len(favs)})
            return

        if path == "/api/colors":
            # POST: {project, paths: [...], color: "red"|"green"|"blue"|null}
            # color=null/"" 이면 해당 paths 의 entry 삭제.
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                return
            body = self._read_json_body()
            if body is None: return
            project = (body.get("project") or "").strip()
            paths = body.get("paths") or []
            color = body.get("color") or None
            if not project:
                self._send_json(400, {"error": "project 파라미터가 필요합니다."})
                return
            if not isinstance(paths, list):
                self._send_json(400, {"error": "paths 는 배열이어야 합니다."})
                return
            try:
                from spotlight import colors_store
                colors = colors_store.set_colors_bulk(project, paths, color)
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
                return
            self._send_json(200, {"ok": True, "project": project, "colors": colors})
            return

        if path == "/api/comments":
            # POST: { project, path, author, text } → 새 코멘트 추가
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                return
            body = self._read_json_body()
            if body is None: return
            project = (body.get("project") or "").strip()
            target_path = (body.get("path") or "").strip()
            author = body.get("author") or ""
            text = body.get("text") or ""
            if not project or not target_path:
                self._send_json(400, {"error": "project / path 가 필요합니다."})
                return
            from spotlight import comments_store
            entry = comments_store.add(project, target_path, author, text)
            if entry is None:
                self._send_json(400, {"error": "본문이 비어 있습니다."})
                return
            self._send_json(200, {"ok": True, "comment": entry})
            return

        if path == "/api/comments/reply":
            # POST: { project, path, parentId, author, text } → 기존 코멘트에 답글 추가
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                return
            body = self._read_json_body()
            if body is None: return
            project = (body.get("project") or "").strip()
            target_path = (body.get("path") or "").strip()
            parent_id = (body.get("parentId") or "").strip()
            author = body.get("author") or ""
            text = body.get("text") or ""
            if not project or not target_path or not parent_id:
                self._send_json(400, {"error": "project / path / parentId 가 필요합니다."})
                return
            from spotlight import comments_store
            reply = comments_store.add_reply(project, target_path, parent_id, author, text)
            if reply is None:
                self._send_json(400, {"error": "답글 추가 실패 (부모 코멘트 없음 또는 빈 본문)"})
                return
            self._send_json(200, {"ok": True, "reply": reply})
            return

        if path == "/api/comments/delete":
            # POST: { project, path, id } → 코멘트 1개 제거
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                return
            body = self._read_json_body()
            if body is None: return
            project = (body.get("project") or "").strip()
            target_path = (body.get("path") or "").strip()
            comment_id = (body.get("id") or "").strip()
            if not project or not target_path or not comment_id:
                self._send_json(400, {"error": "project / path / id 가 필요합니다."})
                return
            from spotlight import comments_store
            ok = comments_store.delete(project, target_path, comment_id)
            self._send_json(200, {"ok": ok})
            return

        if path == "/api/comments/update":
            # POST: { project, path, id, text } → 본문 수정
            if not self._check_same_origin():
                self._send_json(403, {"error": "허용되지 않은 요청입니다."})
                return
            body = self._read_json_body()
            if body is None: return
            project = (body.get("project") or "").strip()
            target_path = (body.get("path") or "").strip()
            comment_id = (body.get("id") or "").strip()
            text = body.get("text") or ""
            if not project or not target_path or not comment_id:
                self._send_json(400, {"error": "project / path / id 가 필요합니다."})
                return
            from spotlight import comments_store
            ok = comments_store.update(project, target_path, comment_id, text)
            if not ok:
                self._send_json(400, {"error": "수정 실패 (본문이 비었거나 코멘트 없음)"})
                return
            self._send_json(200, {"ok": True})
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
        if target_dir is None:
            self._send_json(404, {"error": "대상 폴더 경로가 잘못되었습니다."})
            return
        # 폴더가 없으면 자동 생성 — Reference/scratch/ 같은 자동 분리 폴더 대응.
        # safe_resolve 가 project_dir 안으로 격리하므로 path traversal 안전.
        if not target_dir.exists():
            try:
                target_dir.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                self._send_json(500, {"error": f"폴더 생성 실패: {e}"})
                return
        if not target_dir.is_dir():
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
    # favorites.json + spotlight_jobs.json mtime watcher — 변경 감지 시 SSE broadcast
    threading.Thread(target=_favorites_watcher, daemon=True).start()
    threading.Thread(target=_jobs_watcher, daemon=True).start()

    # PV 재시작 시 옛 running entry 들은 추적 thread 가 죽었으므로 stale.
    # job_ids 는 보존 — 사용자가 '↻ 결과 다시 가져오기' 로 복구 가능.
    try:
        from spotlight import jobs_log as _jl
        cleaned = _jl.cleanup_stale_running()
        if cleaned > 0:
            print(f"  startup        : 옛 running entry {cleaned}개를 failed(stale) 로 정리 (job_ids 보존)")
        # completed 인데 thumbnail/result_paths 가 stale (파일 이동/삭제 후 동기화 안 된 것) 정리.
        missing_fixed = _jl.cleanup_missing_result_files()
        if missing_fixed > 0:
            print(f"  startup        : 잘못된 thumbnail path {missing_fixed}개 entry 정리")
    except Exception as e:  # noqa: BLE001
        print(f"[server] stale cleanup fail: {e}", file=sys.stderr)

    server = ThreadingHTTPServer((BIND, PORT), Handler)
    print("=" * 60)
    print("프로젝트 뷰어 서버 시작")
    print(f"  bind           : {BIND}:{PORT}")
    print(f"  local          : http://127.0.0.1:{PORT}")
    print(f"  프로젝트 폴더  : {PROJECTS_DIR}")
    print(f"  프론트엔드 폴더: {FRONTEND_DIR}")
    print(f"  최대 업로드    : {MAX_UPLOAD_BYTES // 1024 // 1024}MB")
    print(f"  SSE 이벤트     : /api/events (favorites watcher 동작 중)")
    print("=" * 60)
    print("종료하려면 Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")
        server.shutdown()


if __name__ == "__main__":
    main()
