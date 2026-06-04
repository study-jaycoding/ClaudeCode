"""프로젝트 폴더/파일 ops + favorites.json 관리."""

import json
import mimetypes
import random
import re
import time
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from config import PROJECTS_DIR, FAVORITES_FILE

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
    """timestamp36 + random6 형식 ID (frontend generateId 와 호환)."""
    ts = int(time.time() * 1000)
    rand = "".join(random.choices(_ID_ALPHABET, k=6))
    return _to_base36(ts) + rand


def resolve_local_path(local_url: str) -> Path | None:
    """`/pv-media?project=X&path=Y` 형식 URL 을 절대경로로 변환. 탈출 시 None."""
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


def list_projects() -> list[str]:
    """프로젝트 폴더 이름 목록."""
    try:
        return sorted(
            [p.name for p in PROJECTS_DIR.iterdir() if p.is_dir() and not p.name.startswith(".")]
        )
    except OSError:
        return []


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
    """원격 URL 을 <PROJECTS_DIR>/<project>/<subdir>/ 에 다운로드.
    반환: {"path": "<subdir>/<filename>", "name": <filename>, "size": int} 또는 None."""
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
    """이미지와 같은 이름의 .json sidecar 파일 작성."""
    try:
        sidecar = (PROJECTS_DIR / project / rel_path).with_suffix(".json")
        sidecar.write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return True
    except Exception:
        return False


# ── favorites — favorites_store 모듈로 위임 (프로젝트별 _meta/favorites.json)
import favorites_store as _fs


def load_favorites(project: str = "") -> list[dict]:
    """프로젝트별 favorites read. project 없으면 모든 프로젝트 합산."""
    if project:
        return _fs.load_favorites(project)
    return _fs.all_favorites()


def save_favorites(project: str, favs: list[dict]) -> None:
    """락 타임아웃 시 FavoritesLockTimeout 전파 — caller 가 처리."""
    with _fs.FavoritesLock(project):
        _fs.save_favorites(project, favs)


def append_favorite(project: str, rel_path: str, source_ids: list) -> dict | None:
    return _fs.append_favorite(project, rel_path, source_ids)


def filter_image_favorites(favs: list[dict]) -> list[dict]:
    return _fs.filter_image_favorites(favs)


# (favorites 함수들은 위 favorites_store 위임으로 모두 정의 완료)
