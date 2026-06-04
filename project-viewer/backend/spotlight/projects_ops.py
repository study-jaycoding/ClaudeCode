"""프로젝트 폴더 다운로드 + favorites 업데이트.

viewer 의 server.py 상수와 함수를 사용하지 않고 자급자족하도록 작성.
viewer/spotlight 양쪽에서 같은 D:/ClaudeCode-data/ 경로를 본다.
"""

import mimetypes
import re
import time
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from ._paths import PROJECTS_DIR
from .favorites_store import generate_id


def resolve_media_path(local_url: str) -> Path | None:
    """`/media?project=X&path=Y` (viewer) 또는 `/pv-media?...` URL 을 절대경로로."""
    parsed = urlparse(local_url)
    params = parse_qs(parsed.query)
    project = params.get("project", [""])[0]
    rel = params.get("path", [""])[0]
    if not project or not rel or ".." in project or ".." in rel:
        return None
    filepath = (PROJECTS_DIR / project / rel).resolve()
    try:
        filepath.relative_to(PROJECTS_DIR.resolve())
    except ValueError:
        return None
    return filepath if filepath.is_file() else None


def _ext_from_url_or_ct(url: str, content_type: str | None) -> str:
    parsed = urlparse(url)
    m = re.search(r"\.(png|jpg|jpeg|webp|gif|mp4|webm|mov|m4v|mkv)(?:$|[?#])", parsed.path, re.I)
    if m:
        return "." + m.group(1).lower()
    if content_type:
        ct = content_type.split(";")[0].strip().lower()
        guessed = mimetypes.guess_extension(ct) or ""
        if guessed:
            return guessed
    return ".bin"


def _sanitize_segment(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_\-.]+", "_", s)[:120] or "file"


def download_to_project(url: str, project: str, subdir: str) -> dict | None:
    if not project or ".." in project:
        return None
    proj_root = (PROJECTS_DIR / project).resolve()
    try:
        proj_root.relative_to(PROJECTS_DIR.resolve())
    except ValueError:
        return None
    if not proj_root.is_dir():
        return None
    dest_dir = (proj_root / subdir).resolve()
    try:
        dest_dir.relative_to(proj_root)
    except ValueError:
        return None
    dest_dir.mkdir(parents=True, exist_ok=True)

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "spotlight/1.0"})
        # 비디오 결과는 100MB+ 가능 — timeout 충분히 길게.
        with urllib.request.urlopen(req, timeout=600) as resp:
            content_type = resp.headers.get("Content-Type", "")
            raw = resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
        print(f"[spotlight] download failed: {url}: {e}")
        return None

    ext = _ext_from_url_or_ct(url, content_type)
    base = _sanitize_segment(time.strftime("hf_%Y%m%d_%H%M%S") + "_" + generate_id())
    name = f"{base}{ext}"
    target = dest_dir / name
    i = 1
    while target.exists():
        target = dest_dir / f"{base}_{i}{ext}"
        i += 1
    target.write_bytes(raw)
    rel = f"{subdir}/{target.name}" if subdir else target.name
    return {"path": rel, "name": target.name, "size": len(raw)}


def write_sidecar(project: str, rel_path: str, metadata: dict) -> bool:
    """생성 메타데이터 기록 — 프로젝트별 누적 ledger 로 통합 저장."""
    try:
        from . import ledger
        ledger.set_(PROJECTS_DIR / project, rel_path, metadata)
        return True
    except Exception:
        return False


# favorites — generation.py 의 단일 호출자만 남음.
# 다른 모든 사용자 (server.py, spotlight API) 는 favorites_store 를 직접 import.
from . import favorites_store as _fs


def append_favorite(project: str, rel_path: str, source_ids: list) -> dict | None:
    """프로젝트별 favorites 에 entry 추가 — favorites_store 의 lock-safe 구현 사용."""
    return _fs.append_favorite(project, rel_path, source_ids)
