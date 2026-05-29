"""프로젝트 폴더 다운로드 + favorites 업데이트.

viewer 의 server.py 상수와 함수를 사용하지 않고 자급자족하도록 작성.
viewer/spotlight 양쪽에서 같은 D:/ClaudeCode-data/ 경로를 본다.
"""

import json
import mimetypes
import random
import re
import time
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import urlparse, parse_qs

PROJECTS_DIR = Path("D:/ClaudeCode-data/projects")
FAVORITES_FILE = Path("D:/ClaudeCode-data/favorites.json")

_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"


def _to_base36(n: int) -> str:
    if n == 0:
        return "0"
    digits = []
    while n:
        n, r = divmod(n, 36)
        digits.append(_ID_ALPHABET[r])
    return "".join(reversed(digits))


def generate_id() -> str:
    ts = int(time.time() * 1000)
    rand = "".join(random.choices(_ID_ALPHABET, k=6))
    return _to_base36(ts) + rand


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
        with urllib.request.urlopen(req, timeout=120) as resp:
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


def load_favorites() -> list[dict]:
    if not FAVORITES_FILE.exists():
        return []
    try:
        data = json.loads(FAVORITES_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def save_favorites(favs: list[dict]) -> None:
    try:
        FAVORITES_FILE.parent.mkdir(parents=True, exist_ok=True)
        FAVORITES_FILE.write_text(json.dumps(favs, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as e:
        print(f"[spotlight] favorites write failed: {e}")


def append_favorite(project: str, rel_path: str, source_ids: list) -> dict | None:
    favs = load_favorites()
    for f in favs:
        if f.get("project") == project and f.get("path") == rel_path:
            existing = f.get("sourceIds") or []
            merged = list(dict.fromkeys(existing + list(source_ids or [])))
            f["sourceIds"] = merged
            save_favorites(favs)
            return f

    new_fav = {
        "id": generate_id(),
        "project": project,
        "path": rel_path,
        "tags": [],
        "note": "",
        "sourceIds": list(source_ids or []),
        "isSource": False,
        "addedAt": int(time.time() * 1000),
    }
    favs.append(new_fav)
    save_favorites(favs)
    return new_fav
