"""Favorites 저장소 — 프로젝트별 <project>/_meta/favorites.json 으로 보관.

각 entry 는 자기 프로젝트 안 favorites 파일에만 등록된다. PV / spotlight 모두
이 모듈을 통해서만 favorites 를 read/write 해야 cross-process race 가 안전하다.

데이터 모델 (한 entry):
{
  "id": str (timestamp36 + random6),
  "project": str,
  "path": str (프로젝트 내 상대경로),
  "tags": [str, ...],
  "note": str,
  "sourceIds": [str, ...],
  "isSource": bool,
  "addedAt": int (epoch ms)
}
"""

import json
import os
import random
import time
from pathlib import Path
from threading import Lock

# ── 경로 ─────────────────────────────────────────────────────────
_CCDATA_DIR = Path(os.environ.get("CCDATA_DIR", "D:/ClaudeCode-data"))
PROJECTS_DIR = Path(os.environ.get("CCDATA_PROJECTS_DIR", str(_CCDATA_DIR / "projects")))

META_SUBDIR = "_meta"
FAVORITES_FILENAME = "favorites.json"

# 레거시 — 글로벌 단일 파일
LEGACY_GLOBAL_FAVS = Path(os.environ.get("CCDATA_FAVORITES_FILE", str(_CCDATA_DIR / "favorites.json")))
LEGACY_BACKUP_SUFFIX = ".json.migrated"


# ── ID 생성 ──────────────────────────────────────────────────────
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
    """timestamp36 + random6 — frontend generateId 와 호환."""
    ts = int(time.time() * 1000)
    rand = "".join(random.choices(_ID_ALPHABET, k=6))
    return _to_base36(ts) + rand


# ── 파일 경로 ────────────────────────────────────────────────────

def favs_file(project: str) -> Path:
    """프로젝트의 favorites.json 경로. project 없으면 글로벌(legacy)."""
    if not project:
        return LEGACY_GLOBAL_FAVS
    return PROJECTS_DIR / project / META_SUBDIR / FAVORITES_FILENAME


def all_favorites_files() -> list[Path]:
    """모든 프로젝트의 favorites.json + 글로벌 leftover — SSE watcher 가 mtime 폴링용."""
    out: list[Path] = []
    try:
        for p in PROJECTS_DIR.iterdir():
            if p.is_dir() and not p.name.startswith("."):
                out.append(p / META_SUBDIR / FAVORITES_FILENAME)
    except OSError:
        pass
    out.append(LEGACY_GLOBAL_FAVS)
    return out


# ── cross-process file lock ─────────────────────────────────────
_LOCAL_LOCK = Lock()
_LOCK_STALE_SECS = 30


def _lock_path_for(project: str) -> Path:
    p = favs_file(project)
    return p.parent / (p.name + ".lock")


class FavoritesLockTimeout(RuntimeError):
    """타임아웃 안에 락 획득 실패. 호출자는 작업을 포기하거나 재시도해야 함."""


class FavoritesLock:
    """프로젝트별 file-based exclusive lock. PV server 와 spotlight backend 가
    같은 파일을 동시 read-modify-write 할 때 직렬화.

    안전성: 타임아웃 안에 락을 잡지 못하면 FavoritesLockTimeout 을 raise 한다
    (이전엔 락 없이 진입했고 __exit__ 가 남의 락을 unlink 하는 문제 있었음)."""

    def __init__(self, project: str, timeout: float = 10.0):
        self.project = project
        self.timeout = timeout
        self._lock_path = _lock_path_for(project)
        self._acquired = False

    def __enter__(self):
        _LOCAL_LOCK.acquire()
        try:
            self._lock_path.parent.mkdir(parents=True, exist_ok=True)
            deadline = time.time() + self.timeout
            while True:
                try:
                    fd = os.open(
                        str(self._lock_path),
                        os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    )
                    os.close(fd)
                    self._acquired = True
                    return self
                except FileExistsError:
                    try:
                        age = time.time() - self._lock_path.stat().st_mtime
                        if age > _LOCK_STALE_SECS:
                            try:
                                self._lock_path.unlink()
                            except OSError:
                                pass
                            continue
                    except OSError:
                        pass
                    if time.time() >= deadline:
                        raise FavoritesLockTimeout(
                            f"favorites lock timeout ({self.timeout}s) for project={self.project!r}"
                        )
                    time.sleep(0.05)
        except Exception:
            _LOCAL_LOCK.release()
            raise

    def __exit__(self, exc_type, exc, tb):
        try:
            if self._acquired:
                try:
                    self._lock_path.unlink()
                except OSError:
                    pass
                self._acquired = False
        finally:
            _LOCAL_LOCK.release()
        return False


# ── read / write (atomic) ───────────────────────────────────────

def load_favorites(project: str) -> list[dict]:
    """프로젝트의 favorites 만 read. 없으면 빈 리스트."""
    _maybe_migrate_legacy_global()
    p = favs_file(project)
    if not p.is_file():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def save_favorites(project: str, favs: list[dict]) -> None:
    """프로젝트 favorites 통째 덮어쓰기. 호출자가 FavoritesLock 안에서 부르면 race 안전."""
    p = favs_file(project)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(favs, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(p)
    except OSError as e:
        print(f"[favorites] save failed: {e}")


def append_favorite(project: str, rel_path: str, source_ids: list) -> dict | None:
    """favorites 에 entry 추가. 이미 있으면 source_ids 만 보강. lock 안전.
    락 타임아웃 시 None 반환 (호출자는 재시도 또는 무시)."""
    if not project:
        return None
    try:
        with FavoritesLock(project):
            favs = load_favorites(project)
            for f in favs:
                if f.get("project") == project and f.get("path") == rel_path:
                    existing = f.get("sourceIds") or []
                    merged = list(dict.fromkeys(existing + list(source_ids or [])))
                    f["sourceIds"] = merged
                    save_favorites(project, favs)
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
            save_favorites(project, favs)
            return new_fav
    except FavoritesLockTimeout:
        return None


def all_favorites() -> list[dict]:
    """모든 프로젝트의 favorites 합쳐서 반환. cross-project 검색 / 글로벌 view 용."""
    _maybe_migrate_legacy_global()
    out: list[dict] = []
    try:
        for proj_dir in PROJECTS_DIR.iterdir():
            if not proj_dir.is_dir() or proj_dir.name.startswith("."):
                continue
            out.extend(load_favorites(proj_dir.name))
    except OSError:
        pass
    # 글로벌 leftover (마이그레이션 안 된 entry — 보통 비어있음)
    if LEGACY_GLOBAL_FAVS.is_file():
        try:
            data = json.loads(LEGACY_GLOBAL_FAVS.read_text(encoding="utf-8"))
            if isinstance(data, list):
                # 이미 분류된 거 제외하고 미분류만
                proj_names = {p.name for p in PROJECTS_DIR.iterdir() if p.is_dir()} \
                    if PROJECTS_DIR.is_dir() else set()
                for f in data:
                    if isinstance(f, dict) and f.get("project") not in proj_names:
                        out.append(f)
        except (json.JSONDecodeError, OSError):
            pass
    return out


def filter_image_favorites(favs: list[dict]) -> list[dict]:
    """이미지 확장자만 골라낸다."""
    img_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
    return [
        f for f in favs
        if any(f.get("path", "").lower().endswith(e) for e in img_exts)
    ]


# ── 자동 마이그레이션 ────────────────────────────────────────────
_migrated_global = False


def _maybe_migrate_legacy_global() -> int:
    """레거시 글로벌 favorites.json 의 entry 들을 각 entry 의 project 별로 분해해서
    <project>/_meta/favorites.json 에 저장. 1회만 시도. 분류 못 한 entry (project
    필드 없거나 폴더 없음) 는 글로벌에 남겨둠. 원본은 .migrated 백업."""
    global _migrated_global
    if _migrated_global:
        return 0
    _migrated_global = True
    if not LEGACY_GLOBAL_FAVS.is_file():
        return 0
    try:
        data = json.loads(LEGACY_GLOBAL_FAVS.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return 0
    if not isinstance(data, list):
        return 0

    proj_names = set()
    try:
        for p in PROJECTS_DIR.iterdir():
            if p.is_dir() and not p.name.startswith("."):
                proj_names.add(p.name)
    except OSError:
        pass

    by_project: dict[str, list[dict]] = {}
    unclassified: list[dict] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        proj = entry.get("project") or ""
        if proj and proj in proj_names:
            by_project.setdefault(proj, []).append(entry)
        else:
            unclassified.append(entry)

    moved = 0
    for proj, entries in by_project.items():
        # 기존 _meta/favorites.json 과 합치기 (이미 있으면 중복 제거)
        existing = load_favorites(proj)
        existing_ids = {f.get("id") for f in existing if isinstance(f, dict)}
        merged = existing + [e for e in entries if e.get("id") not in existing_ids]
        save_favorites(proj, merged)
        moved += len(entries)

    # 원본 백업 + 분류 못 한 entry 만 글로벌에 남김 (선택)
    try:
        LEGACY_GLOBAL_FAVS.rename(LEGACY_GLOBAL_FAVS.with_suffix(LEGACY_BACKUP_SUFFIX))
    except OSError:
        pass

    return moved
