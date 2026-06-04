"""생성 메타데이터 ledger — 프로젝트별 Result/_generations/ 안에 entry-per-file 로 보관.

각 entry 가 독립 파일이라 여러 사용자가 동시에 생성해도 lost-update 가 본질적으로 불가.
파일명은 rel_path 의 sha1 해시 (16자) — 한글/특수문자 안전, 길이 안전.

저장 구조:
  <project>/Result/_generations/<hash16>.json
  {"rel": "Result/img/hf_xxx.png", "metadata": {...}}

레거시:
- 기존 단일파일 Result/_generations.json → 자동으로 분해 후 .migrated 백업
- 더 옛 *.json sidecar → 기존 migrate_sidecars 가 합치고 원본 삭제
"""

import hashlib
import json
from pathlib import Path

# 새 구조 — 프로젝트 안 _meta/ 표준 위치
LEDGER_DIR = "_generations"        # _meta/ 아래 디렉토리명
LEDGER_SUBDIR = "_meta"            # ledger 가 사는 부모 폴더 (프로젝트 직속)

# 레거시
LEGACY_SUBDIR_RESULT = "Result"               # 옛 위치: Result/_generations/
LEGACY_SINGLE_FILE = "_generations.json"      # 옛 단일파일: Result/_generations.json
LEGACY_BACKUP_SUFFIX = ".json.migrated"

# 마이그레이션 시 sidecar 와 짝지을 미디어 확장자 (오래된 *.json sidecar 용)
_MEDIA_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
    ".mp4", ".webm", ".mov", ".mkv",
}

# 프로세스 lifetime 동안 마이그레이션 1회만 시도.
_migrated: set[str] = set()


# ── 경로 헬퍼 ────────────────────────────────────────────────────

def _entry_dir(project_dir: Path) -> Path:
    """프로젝트의 ledger 디렉토리 — _meta/_generations/."""
    return project_dir / LEDGER_SUBDIR / LEDGER_DIR


def _legacy_entry_dir(project_dir: Path) -> Path:
    """옛 ledger 위치 — Result/_generations/. 자동 마이그레이션용."""
    return project_dir / LEGACY_SUBDIR_RESULT / LEDGER_DIR


def _hash_of(rel_path: str) -> str:
    """rel_path → 짧은 sha1 16자 해시. 한글/특수문자 안전."""
    norm = str(rel_path).replace("\\", "/")
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:16]


def _entry_file(project_dir: Path, rel_path: str) -> Path:
    return _entry_dir(project_dir) / f"{_hash_of(rel_path)}.json"


def _legacy_single_file(project_dir: Path) -> Path:
    """옛 단일 파일 위치 — Result/_generations.json."""
    return project_dir / LEGACY_SUBDIR_RESULT / LEGACY_SINGLE_FILE


# ── 파일별 read/write (atomic) ───────────────────────────────────

def _read_entry(p: Path) -> dict | None:
    if not p.is_file():
        return None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(d, dict) or "rel" not in d:
            return None
        return d
    except Exception:
        return None


def _write_entry(project_dir: Path, rel_path: str, metadata: dict) -> None:
    rel_norm = str(rel_path).replace("\\", "/")
    p = _entry_file(project_dir, rel_norm)
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = {"rel": rel_norm, "metadata": metadata}
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    tmp.replace(p)  # atomic on POSIX, mostly atomic on Windows


# ── 트리 노출 차단 ───────────────────────────────────────────────

def is_ledger_path(path: Path) -> bool:
    """트리 빌드 시 이 경로를 건너뛸지 결정.
    노출 차단 대상:
      - _meta/                            (시스템 메타 폴더 전체)
      - _generations/                     (옛 위치 — Result/_generations/)
      - _generations.json                 (옛 단일 파일)
      - *.json.migrated                   (마이그레이션 백업)
    """
    name = path.name
    if name == LEDGER_SUBDIR and path.is_dir():
        return True  # _meta/
    if name == LEDGER_DIR and path.is_dir():
        return True  # 옛 위치의 _generations/
    if name == LEGACY_SINGLE_FILE:
        return True
    if name.endswith(LEGACY_BACKUP_SUFFIX):
        return True
    return False


# ── 마이그레이션 ─────────────────────────────────────────────────

def _maybe_migrate(project_dir: Path) -> None:
    key = str(project_dir)
    if key in _migrated:
        return
    _migrated.add(key)
    # 1) 옛 위치 Result/_generations/ 의 entry 파일들을 새 위치 _meta/_generations/ 로 이동
    migrate_legacy_result_dir(project_dir)
    # 2) 옛 단일 _generations.json 이 있으면 entry-per-file 로 분해
    migrate_legacy_single_file(project_dir)
    # 3) 그보다 더 옛 *.json sidecar 들을 모아서 entry 로 변환
    migrate_sidecars(project_dir)


def migrate_legacy_result_dir(project_dir: Path) -> int:
    """옛 위치 Result/_generations/<hash>.json 들을 새 위치 _meta/_generations/ 로 이동.
    이미 새 위치에 같은 hash 가 있으면 옛 파일 무시 (새 게 우선)."""
    old_dir = _legacy_entry_dir(project_dir)
    if not old_dir.is_dir():
        return 0
    new_dir = _entry_dir(project_dir)
    new_dir.mkdir(parents=True, exist_ok=True)
    moved = 0
    for f in list(old_dir.glob("*.json")):
        target = new_dir / f.name
        if target.exists():
            # 새 위치에 이미 같은 entry — 옛 거 백업으로 이름 변경만
            try:
                f.rename(f.with_suffix(LEGACY_BACKUP_SUFFIX))
            except OSError:
                pass
            continue
        try:
            f.rename(target)
            moved += 1
        except OSError:
            # rename 실패 시 read/write 로 복사 후 옛 거 삭제
            try:
                target.write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
                f.unlink()
                moved += 1
            except OSError:
                pass
    # 옛 디렉토리 비어있으면 제거
    try:
        if not any(old_dir.iterdir()):
            old_dir.rmdir()
    except OSError:
        pass
    return moved


def migrate_legacy_single_file(project_dir: Path) -> int:
    """기존 Result/_generations.json (items dict 형식) 을 entry-per-file 로 분해.
    완료되면 .migrated 백업 (안전).
    이미 분해된 적 있으면 no-op. 반환: 이번에 분해한 entry 수."""
    old = _legacy_single_file(project_dir)
    if not old.is_file():
        return 0
    try:
        data = json.loads(old.read_text(encoding="utf-8"))
    except Exception:
        return 0
    if not isinstance(data, dict):
        return 0
    items = data.get("items", {})
    if not isinstance(items, dict) or not items:
        # 비어있어도 파일은 백업 처리 (다음 실행 시 또 시도하지 않게)
        try:
            old.rename(old.with_suffix(LEGACY_BACKUP_SUFFIX))
        except Exception:
            pass
        return 0
    moved = 0
    for rel, meta in items.items():
        if not isinstance(rel, str) or not isinstance(meta, dict):
            continue
        _write_entry(project_dir, rel, meta)
        moved += 1
    try:
        old.rename(old.with_suffix(LEGACY_BACKUP_SUFFIX))
    except Exception:
        pass
    return moved


def migrate_sidecars(project_dir: Path) -> int:
    """프로젝트 안의 모든 *.json sidecar (같은 stem 의 이미지/비디오와 짝) 을
    entry 로 변환하고 원본 sidecar 삭제. 반환: 마이그레이션된 항목 수."""
    if not project_dir.is_dir():
        return 0
    migrated = 0
    for json_file in project_dir.rglob("*.json"):
        # ledger 자체 / 백업 / _meta 안 / 옛 _generations/ 안 파일은 건너뜀
        if is_ledger_path(json_file):
            continue
        # 부모 또는 조상 중 _meta / _generations 가 있으면 시스템 파일
        if any(p.name in (LEDGER_SUBDIR, LEDGER_DIR) for p in json_file.parents):
            continue
        media = None
        for ext in _MEDIA_EXTS:
            cand = json_file.with_suffix(ext)
            if cand.is_file():
                media = cand
                break
        if media is None:
            continue
        try:
            content = json.loads(json_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        try:
            rel = str(media.relative_to(project_dir)).replace("\\", "/")
        except ValueError:
            continue
        _write_entry(project_dir, rel, content)
        try:
            json_file.unlink()
        except Exception:
            pass
        migrated += 1
    return migrated


# ── public API (server.py / projects_ops.py 가 호출) ─────────────

def get(project_dir: Path, rel_path: str) -> dict | None:
    """프로젝트 내 rel_path 의 생성 메타데이터 반환 (없으면 None)."""
    _maybe_migrate(project_dir)
    p = _entry_file(project_dir, rel_path)
    entry = _read_entry(p)
    if entry is None:
        return None
    # hash 충돌 방어 — rel 이 정확히 일치하는지 검증
    if entry.get("rel") != str(rel_path).replace("\\", "/"):
        return None
    return entry.get("metadata")


def set_(project_dir: Path, rel_path: str, metadata: dict) -> None:
    """생성 메타데이터 upsert. 같은 rel_path 에 동시 set 은 마지막 쓰기 승.
    다른 rel_path 끼리는 서로 다른 파일이라 절대 충돌 없음."""
    _maybe_migrate(project_dir)
    _write_entry(project_dir, rel_path, metadata)


def remove(project_dir: Path, rel_path: str) -> bool:
    """파일이 삭제될 때 ledger 에서도 제거. 반환: 실제 제거 여부."""
    p = _entry_file(project_dir, rel_path)
    entry = _read_entry(p)
    if entry is None:
        return False
    if entry.get("rel") != str(rel_path).replace("\\", "/"):
        return False
    try:
        p.unlink()
        return True
    except OSError:
        return False


def remove_with_prefix(project_dir: Path, prefix: str) -> int:
    """폴더 삭제 시 그 안의 모든 ledger 항목 제거. 반환: 제거된 항목 수."""
    p = str(prefix).replace("\\", "/").rstrip("/")
    if not p:
        return 0
    d = _entry_dir(project_dir)
    if not d.is_dir():
        return 0
    removed = 0
    for f in list(d.glob("*.json")):
        entry = _read_entry(f)
        if entry is None:
            continue
        rel = entry.get("rel", "")
        if rel == p or rel.startswith(p + "/"):
            try:
                f.unlink()
                removed += 1
            except OSError:
                pass
    return removed


def rename(project_dir: Path, old_rel: str, new_rel: str, is_dir: bool = False) -> int:
    """파일/폴더 이동·이름변경에 따라 ledger entry 의 키(rel) 를 갱신.
    is_dir=True 면 old_rel/ prefix 의 모든 entry 를 new_rel/ 로 치환.
    반환: 업데이트된 entry 수.

    구현: hash(rel) 이 바뀌므로 새 파일에 write 후 옛 파일 삭제."""
    old = str(old_rel).replace("\\", "/").rstrip("/")
    new = str(new_rel).replace("\\", "/").rstrip("/")
    if not old or old == new:
        return 0
    d = _entry_dir(project_dir)
    if not d.is_dir():
        return 0
    updated = 0
    if is_dir:
        # 디렉토리 prefix 일괄 — 모든 entry 를 훑어 매칭 시 옮김
        for f in list(d.glob("*.json")):
            entry = _read_entry(f)
            if entry is None:
                continue
            rel = entry.get("rel", "")
            new_rel_for_entry: str | None = None
            if rel == old:
                new_rel_for_entry = new
            elif rel.startswith(old + "/"):
                new_rel_for_entry = new + rel[len(old):]
            if new_rel_for_entry is None:
                continue
            meta = entry.get("metadata", {})
            _write_entry(project_dir, new_rel_for_entry, meta)
            # 새 파일 = 새 hash. old hash 가 같지 않은지 확인 후 삭제.
            if _entry_file(project_dir, new_rel_for_entry) != f:
                try:
                    f.unlink()
                except OSError:
                    pass
            updated += 1
    else:
        # 단일 파일 — get/set/remove
        meta = get(project_dir, old)
        if meta is None:
            return 0
        _write_entry(project_dir, new, meta)
        if _entry_file(project_dir, new) != _entry_file(project_dir, old):
            try:
                _entry_file(project_dir, old).unlink()
            except OSError:
                pass
        updated = 1
    return updated


def all_entries(project_dir: Path) -> dict:
    """모든 entry 를 {rel: metadata} dict 으로 반환.
    /api/meta_bulk 같은 일괄 조회 또는 디버그용."""
    _maybe_migrate(project_dir)
    out: dict = {}
    d = _entry_dir(project_dir)
    if not d.is_dir():
        return out
    for f in d.glob("*.json"):
        entry = _read_entry(f)
        if entry is None:
            continue
        rel = entry.get("rel")
        if rel:
            out[rel] = entry.get("metadata", {})
    return out
