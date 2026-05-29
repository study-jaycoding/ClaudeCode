"""생성 메타데이터 ledger — 프로젝트별 Result/_generations.json 에 누적.

각 이미지마다 .json sidecar 를 만들지 않고 한 파일에 모아 보관한다.
키 = 프로젝트 내 상대경로 (예: "Result/hf_xxx.png"), 값 = 메타데이터 dict.

마이그레이션: 기존 .png + .json 짝의 sidecar 들을 ledger 로 합치고 원본 삭제.
"""

import json
from pathlib import Path

LEDGER_FILENAME = "_generations.json"
LEDGER_SUBDIR = "Result"

# 마이그레이션 시 sidecar 와 짝지을 미디어 확장자
_MEDIA_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
    ".mp4", ".webm", ".mov", ".mkv",
}

# 프로세스 lifetime 동안 마이그레이션 1회만 시도 (sidecar 삭제 후엔 no-op).
_migrated: set[str] = set()


def _ledger_file(project_dir: Path) -> Path:
    return project_dir / LEDGER_SUBDIR / LEDGER_FILENAME


def _read(project_dir: Path) -> dict:
    p = _ledger_file(project_dir)
    if not p.is_file():
        return {"version": 1, "items": {}}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or "items" not in data:
            return {"version": 1, "items": {}}
        return data
    except Exception:
        return {"version": 1, "items": {}}


def _write(project_dir: Path, ledger: dict) -> None:
    p = _ledger_file(project_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(ledger, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    tmp.replace(p)


def is_ledger_file(path: Path) -> bool:
    return path.name == LEDGER_FILENAME


def _maybe_migrate(project_dir: Path) -> None:
    key = str(project_dir)
    if key in _migrated:
        return
    _migrated.add(key)
    migrate_sidecars(project_dir)


def get(project_dir: Path, rel_path: str) -> dict | None:
    """프로젝트 내 rel_path 의 생성 메타데이터 반환 (없으면 None)."""
    _maybe_migrate(project_dir)
    rel_norm = str(rel_path).replace("\\", "/")
    return _read(project_dir)["items"].get(rel_norm)


def set_(project_dir: Path, rel_path: str, metadata: dict) -> None:
    """생성 메타데이터 upsert."""
    _maybe_migrate(project_dir)
    rel_norm = str(rel_path).replace("\\", "/")
    ledger = _read(project_dir)
    ledger["items"][rel_norm] = metadata
    _write(project_dir, ledger)


def remove(project_dir: Path, rel_path: str) -> bool:
    """파일이 삭제될 때 ledger 에서도 제거. 반환: 실제 제거 여부."""
    rel_norm = str(rel_path).replace("\\", "/")
    ledger = _read(project_dir)
    if rel_norm in ledger["items"]:
        del ledger["items"][rel_norm]
        _write(project_dir, ledger)
        return True
    return False


def remove_with_prefix(project_dir: Path, prefix: str) -> int:
    """폴더 삭제 시 그 안 모든 ledger 항목 제거. 반환: 제거된 항목 수."""
    p = str(prefix).replace("\\", "/").rstrip("/")
    if not p:
        return 0
    ledger = _read(project_dir)
    items = ledger["items"]
    keys = [k for k in items if k == p or k.startswith(p + "/")]
    if not keys:
        return 0
    for k in keys:
        del items[k]
    _write(project_dir, ledger)
    return len(keys)


def rename(project_dir: Path, old_rel: str, new_rel: str, is_dir: bool = False) -> int:
    """파일/폴더 이동·이름변경에 따라 ledger 키 업데이트.
    is_dir=True 면 old_rel/ prefix 의 모든 키를 new_rel/ 로 치환.
    반환: 업데이트된 키 수."""
    old = str(old_rel).replace("\\", "/").rstrip("/")
    new = str(new_rel).replace("\\", "/").rstrip("/")
    if not old or old == new:
        return 0
    ledger = _read(project_dir)
    items = ledger["items"]
    updated = 0
    if is_dir:
        renamed = {}
        for k, v in list(items.items()):
            if k == old:
                renamed[new] = v
                updated += 1
            elif k.startswith(old + "/"):
                renamed[new + k[len(old):]] = v
                updated += 1
            else:
                renamed[k] = v
        if updated:
            ledger["items"] = renamed
            _write(project_dir, ledger)
    else:
        if old in items:
            items[new] = items.pop(old)
            _write(project_dir, ledger)
            updated = 1
    return updated


def migrate_sidecars(project_dir: Path) -> int:
    """프로젝트 안의 모든 *.json sidecar (같은 stem 의 이미지/비디오와 짝) 을
    ledger 로 합치고 원본 sidecar 삭제. 반환: 마이그레이션된 항목 수.

    `_generations.json` 자체는 건너뜀. 짝이 되는 미디어가 없는 .json 도 건너뜀
    (사용자의 일반 JSON 파일 보호)."""
    if not project_dir.is_dir():
        return 0
    ledger = _read(project_dir)
    items = ledger["items"]
    migrated = 0
    for json_file in project_dir.rglob("*.json"):
        if json_file.name == LEDGER_FILENAME:
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
        items[rel] = content
        try:
            json_file.unlink()
        except Exception:
            pass
        migrated += 1
    if migrated:
        _write(project_dir, ledger)
    return migrated
