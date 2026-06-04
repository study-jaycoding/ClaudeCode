"""Spotlight 생성 작업 영구 이력 (Job Queue 데이터) — 프로젝트별 저장.

저장 위치: <project>/_meta/jobs.json  (프로젝트마다 별도)
ComfyUI 의 Job Queue 와 비슷한 방식 — running / completed / failed 상태를 통합.

데이터 모델 (한 job entry):
{
  "id":            str (batch id — generate() 한 번의 호출 = 하나의 entry),
  "job_ids":       [str, ...]   (Higgsfield 가 반환한 internal job id 목록),
  "project":       str,
  "kind":          "image" | "video",
  "status":        "running" | "completed" | "failed",
  "started_at":    epoch_ms,
  "finished_at":   epoch_ms | null,
  "duration_ms":   int | null,
  "result_paths":  [str, ...]    (이 호출이 만든 결과 파일 path 들; _generations 에서 메타 lookup),
  "thumbnail_path": str | null   (UI 썸네일용 — 첫 결과 경로),
  "error":         str | null,
  "ref_count":     int,
  // 표시용 cache (선택) — UI 빠른 렌더를 위해 일부만 보관. 진실 소스는 _generations.
  "model":         str           (cache),
  "prompt":        str           (cache),
  "display_prompt": str | null   (cache),
  "credits":       float | null  (cache)
}

레거시: CCDATA_DIR/spotlight_jobs.json 의 글로벌 이력을 첫 실행 시 프로젝트별로 자동 분해.
"""

import json
import os
import time
from pathlib import Path
from threading import Lock

from ._paths import CCDATA_DIR as _CCDATA_DIR, PROJECTS_DIR

# 새 구조 — 프로젝트별 위치
META_SUBDIR = "_meta"
JOBS_FILENAME = "jobs.json"

# 레거시 — 글로벌 단일 파일
LEGACY_GLOBAL_JOBS = Path(os.environ.get("CCDATA_JOBS_FILE", str(_CCDATA_DIR / "spotlight_jobs.json")))
LEGACY_BACKUP_SUFFIX = ".json.migrated"

# 프로젝트별 history 상한 (오래된 것부터 제거)
MAX_HISTORY = 1000

_LOCK = Lock()
_migrated_global = False  # 글로벌 → 프로젝트별 마이그레이션 1회만


# ── 경로 헬퍼 ────────────────────────────────────────────────────

def _jobs_file(project: str) -> Path:
    """프로젝트의 jobs.json 위치. project 가 빈 문자열이면 글로벌(legacy) 사용."""
    if not project:
        return LEGACY_GLOBAL_JOBS
    return PROJECTS_DIR / project / META_SUBDIR / JOBS_FILENAME


def _now_ms() -> int:
    return int(time.time() * 1000)


# ── 파일 read/write (atomic) ─────────────────────────────────────

def _read_all(project: str) -> list[dict]:
    """프로젝트의 jobs.json → list[dict]. 깨졌거나 없으면 빈 리스트."""
    p = _jobs_file(project)
    try:
        text = p.read_text(encoding="utf-8")
    except OSError:
        return []
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and isinstance(data.get("jobs"), list):
            return data["jobs"]
    except json.JSONDecodeError:
        pass
    return []


def _write_all(project: str, jobs: list[dict]) -> None:
    """atomic write — temp 에 쓰고 replace."""
    p = _jobs_file(project)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(jobs, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)


# ── 글로벌 → 프로젝트별 마이그레이션 ─────────────────────────────

def _migrate_legacy_global() -> int:
    """레거시 CCDATA_DIR/spotlight_jobs.json 의 entry 들을 각 entry 의 project 별로
    분해해서 <project>/_meta/jobs.json 에 저장. 완료되면 원본은 .migrated 백업.
    1회성. 반환: 이번에 분해한 entry 수."""
    global _migrated_global
    if _migrated_global:
        return 0
    _migrated_global = True
    if not LEGACY_GLOBAL_JOBS.is_file():
        return 0
    try:
        text = LEGACY_GLOBAL_JOBS.read_text(encoding="utf-8")
        data = json.loads(text)
    except Exception:
        return 0
    if isinstance(data, dict):
        data = data.get("jobs", [])
    if not isinstance(data, list):
        return 0

    # 프로젝트별로 그룹화 — 분류 불가는 unclassified 로 보존
    by_project: dict[str, list[dict]] = {}
    unclassified: list[dict] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        proj = entry.get("project") or ""
        if not proj:
            unclassified.append(entry)
            continue
        proj_path = PROJECTS_DIR / proj
        if not proj_path.is_dir():
            unclassified.append(entry)
            continue
        by_project.setdefault(proj, []).append(entry)

    moved = 0
    for proj, entries in by_project.items():
        # 기존 jobs.json 과 합치기 (이미 있으면)
        existing = _read_all(proj)
        existing_ids = {j.get("id") for j in existing}
        merged = existing + [e for e in entries if e.get("id") not in existing_ids]
        merged.sort(key=lambda j: j.get("started_at", 0))
        if len(merged) > MAX_HISTORY:
            merged = merged[-MAX_HISTORY:]
        _write_all(proj, merged)
        moved += len(entries)

    # 원본 백업 — collision 안전
    backup_path = LEGACY_GLOBAL_JOBS.with_suffix(LEGACY_BACKUP_SUFFIX)
    if backup_path.exists():
        n = 1
        while True:
            candidate = LEGACY_GLOBAL_JOBS.with_suffix(f"{LEGACY_BACKUP_SUFFIX}.{n}")
            if not candidate.exists():
                backup_path = candidate
                break
            n += 1
    try:
        import shutil
        shutil.copy2(str(LEGACY_GLOBAL_JOBS), str(backup_path))
    except OSError:
        pass

    # 분류 못 한 entry 는 글로벌에 보존 — 데이터 손실 방지
    try:
        if unclassified:
            LEGACY_GLOBAL_JOBS.parent.mkdir(parents=True, exist_ok=True)
            tmp = LEGACY_GLOBAL_JOBS.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(unclassified, ensure_ascii=False, indent=2),
                           encoding="utf-8")
            os.replace(tmp, LEGACY_GLOBAL_JOBS)
        else:
            # 전부 분류 성공 → 원본 제거 (이미 백업됨)
            LEGACY_GLOBAL_JOBS.unlink(missing_ok=True)
    except OSError:
        pass

    return moved


# ── public API ──────────────────────────────────────────────────

def append_running(
    *,
    id: str,
    project: str,
    model: str,
    prompt: str,
    display_prompt: str | None = None,
    kind: str = "image",
    ref_count: int = 0,
    subdir: str = "Result",
) -> dict:
    """generate() 진입 직후 호출 — running 상태로 entry 추가.
    model/prompt 는 표시용 cache. 진실 소스는 _generations (결과 저장 후 기록).
    subdir 은 복구 시점에 다시 같은 폴더에 저장하기 위해 entry 에 보존.
    project 가 빈 문자열이면 글로벌(legacy) 파일에 기록."""
    entry = {
        "id": id,
        "job_ids": [],
        "project": project or "",
        "subdir": subdir or "Result",    # 결과 저장 폴더 — 복구 시 재사용
        "model": model or "",            # cache (UI 빠른 렌더)
        "prompt": prompt or "",          # cache
        "display_prompt": display_prompt, # cache
        "kind": kind,
        "status": "running",
        "started_at": _now_ms(),
        "finished_at": None,
        "duration_ms": None,
        "result_paths": [],
        "result_urls": [],              # HF CDN URL — 다운로드 실패해도 카드 표시/복구용
        "thumbnail_path": None,
        "error": None,
        "credits": None,
        "ref_count": int(ref_count),
    }
    with _LOCK:
        _migrate_legacy_global()
        jobs = _read_all(project)
        jobs.append(entry)
        if len(jobs) > MAX_HISTORY:
            jobs = jobs[-MAX_HISTORY:]
        _write_all(project, jobs)
    return entry


def finalize(
    id: str,
    *,
    project: str | None = None,
    status: str,
    job_ids: list[str] | None = None,
    result_paths: list[str] | None = None,
    result_urls: list[str] | None = None,
    thumbnail_path: str | None = None,
    error: str | None = None,
    credits: float | None = None,
) -> dict | None:
    """완료/실패 시 같은 id 의 entry 를 update.
    project 를 알면 직접 그 프로젝트의 jobs.json 만 봄. 모르면 모든 프로젝트 훑어 찾음."""
    with _LOCK:
        _migrate_legacy_global()
        # 후보 프로젝트 결정
        if project:
            candidates = [project]
        else:
            candidates = _all_project_names()
            candidates.append("")  # 글로벌 fallback

        for proj in candidates:
            jobs = _read_all(proj)
            for entry in reversed(jobs):
                if entry.get("id") != id:
                    continue
                now = _now_ms()
                entry["status"] = status
                entry["finished_at"] = now
                started = entry.get("started_at") or now
                entry["duration_ms"] = max(0, now - started)
                if job_ids is not None:
                    entry["job_ids"] = list(job_ids)
                if result_paths is not None:
                    entry["result_paths"] = list(result_paths)
                if result_urls is not None:
                    entry["result_urls"] = list(result_urls)
                if thumbnail_path is not None:
                    entry["thumbnail_path"] = thumbnail_path
                if error is not None:
                    entry["error"] = error
                if credits is not None:
                    entry["credits"] = float(credits)
                _write_all(proj, jobs)
                return entry
        return None


def append_result_url(id: str, *, project: str | None = None, url: str) -> dict | None:
    """`generate wait` 가 URL 을 받자마자 호출 — entry.result_urls 에 누적.
    다운로드가 죽어도 사용자가 본 URL 이 jobs.json 에 남아 복구/표시 가능.
    중복 URL 은 추가 안 함."""
    with _LOCK:
        _migrate_legacy_global()
        candidates = [project] if project else _all_project_names() + [""]
        for proj in candidates:
            jobs = _read_all(proj)
            for entry in reversed(jobs):
                if entry.get("id") != id:
                    continue
                urls = list(entry.get("result_urls") or [])
                if url and url not in urls:
                    urls.append(url)
                    entry["result_urls"] = urls
                    _write_all(proj, jobs)
                return entry
        return None


def get_job(id: str, *, project: str | None = None) -> dict | None:
    """단일 entry 조회 — 복구 endpoint 가 사용. 모든 프로젝트 훑어 첫 매치 반환."""
    _migrate_legacy_global()
    candidates = [project] if project else _all_project_names() + [""]
    for proj in candidates:
        for entry in _read_all(proj):
            if entry.get("id") == id:
                return entry
    return None


def update_job_ids(id: str, *, project: str | None = None, job_ids: list[str]) -> dict | None:
    """`generate create` 직후 호출 — running 상태 유지하면서 job_ids 만 기록.
    polling 단계가 중간에 죽거나 PV 재시작이 일어나도 entry 에 job_ids 가 남아
    사용자가 Higgsfield 콘솔에서 결과 확인 가능."""
    with _LOCK:
        _migrate_legacy_global()
        candidates = [project] if project else _all_project_names() + [""]
        for proj in candidates:
            jobs = _read_all(proj)
            for entry in reversed(jobs):
                if entry.get("id") != id:
                    continue
                entry["job_ids"] = list(job_ids)
                _write_all(proj, jobs)
                return entry
        return None


def remove_path(project: str, rel_path: str) -> int:
    """파일/폴더 삭제 시 jobs.json 의 thumbnail_path / result_paths 에서 그 경로 정리.
    폴더면 prefix 매치. 반환: 갱신된 entry 수."""
    if not project or not rel_path:
        return 0
    rel = rel_path.replace("\\", "/")
    prefix = rel + "/"
    changed_count = 0
    with _LOCK:
        jobs = _read_all(project)
        dirty = False
        for entry in jobs:
            tp = entry.get("thumbnail_path") or ""
            rps = entry.get("result_paths") or []
            new_rps = [p for p in rps if p != rel and not p.startswith(prefix)]
            new_tp = tp if (tp and tp != rel and not tp.startswith(prefix)) else None
            # 썸네일이 비었으면 남은 result 의 첫 path 사용
            if new_tp is None and new_rps:
                new_tp = new_rps[0]
            if new_rps != rps or new_tp != tp:
                entry["result_paths"] = new_rps
                entry["thumbnail_path"] = new_tp
                changed_count += 1
                dirty = True
        if dirty:
            _write_all(project, jobs)
    return changed_count


def rename_path(project: str, old_rel: str, new_rel: str, *, is_dir: bool) -> int:
    """파일/폴더 이동/이름변경 시 jobs.json 의 thumbnail_path / result_paths 갱신.
    파일이면 정확 매치, 폴더면 prefix 치환. 반환: 갱신된 entry 수."""
    if not project or not old_rel or not new_rel:
        return 0
    old = old_rel.replace("\\", "/")
    new = new_rel.replace("\\", "/")
    prefix = old + "/"
    changed_count = 0
    with _LOCK:
        jobs = _read_all(project)
        dirty = False
        for entry in jobs:
            tp = entry.get("thumbnail_path") or ""
            rps = entry.get("result_paths") or []
            changed = False
            new_rps = []
            for p in rps:
                if is_dir:
                    if p == old or p.startswith(prefix):
                        new_rps.append(new + p[len(old):])
                        changed = True
                    else:
                        new_rps.append(p)
                else:
                    if p == old:
                        new_rps.append(new)
                        changed = True
                    else:
                        new_rps.append(p)
            new_tp = tp
            if tp:
                if is_dir:
                    if tp == old or tp.startswith(prefix):
                        new_tp = new + tp[len(old):]
                        changed = True
                else:
                    if tp == old:
                        new_tp = new
                        changed = True
            if changed:
                entry["result_paths"] = new_rps
                entry["thumbnail_path"] = new_tp
                changed_count += 1
                dirty = True
        if dirty:
            _write_all(project, jobs)
    return changed_count


def cleanup_missing_result_files() -> int:
    """PV 시작 시 호출 — completed entry 의 thumbnail_path / result_paths 가 실제 파일과
    안 맞으면 정리 (큐 카드 ⚠ 썸네일 방지). 옛 코드에서 file rename/move 시
    jobs.json 동기화 안 되던 시절의 stale path 청소용."""
    cleaned = 0
    with _LOCK:
        for proj in _all_project_names():
            proj_root = PROJECTS_DIR / proj
            if not proj_root.is_dir():
                continue
            jobs = _read_all(proj)
            dirty = False
            for entry in jobs:
                if entry.get("status") != "completed":
                    continue
                rps = entry.get("result_paths") or []
                tp = entry.get("thumbnail_path")
                # 실제로 존재하는 path 만 남김
                existing = [p for p in rps if (proj_root / p).is_file()]
                tp_ok = tp and (proj_root / tp).is_file()
                if not tp_ok and existing:
                    tp = existing[0]
                    tp_ok = True
                if existing != rps or (not tp_ok and tp):
                    entry["result_paths"] = existing
                    entry["thumbnail_path"] = tp if tp_ok else None
                    cleaned += 1
                    dirty = True
            if dirty:
                _write_all(proj, jobs)
    return cleaned


def cleanup_stale_running() -> int:
    """PV process 시작 시 한 번만 호출. 모든 프로젝트의 running entry 를 stale 로
    간주하고 failed 로 마킹 (이전 process 의 polling thread 가 죽었을 가능성).
    job_ids 는 보존 — 사용자가 모달의 '↻ 결과 다시 가져오기' 로 복구 가능.
    반환: 정리된 entry 수.
    """
    _migrate_legacy_global()
    cleaned = 0
    with _LOCK:
        for proj in _all_project_names() + [""]:
            jobs = _read_all(proj)
            changed = False
            for entry in jobs:
                if entry.get("status") != "running":
                    continue
                now = _now_ms()
                entry["status"] = "failed"
                entry["finished_at"] = now
                started = entry.get("started_at") or now
                entry["duration_ms"] = max(0, now - started)
                entry["error"] = (
                    "PV 재시작으로 추적 중단됨 — 사이트에서 결과 확인 후 "
                    "'상세' 버튼 → '↻ 결과 다시 가져오기' 클릭"
                )
                changed = True
                cleaned += 1
            if changed:
                _write_all(proj, jobs)
    return cleaned


def list_jobs(*, status: str | None = None, project: str | None = None, limit: int | None = None) -> list[dict]:
    """필터링된 job 목록을 최신순(started_at desc) 으로 반환.
    project 가 None 또는 빈 문자열이면 모든 프로젝트의 jobs 를 합쳐서 반환."""
    _migrate_legacy_global()
    if project:
        jobs = _read_all(project)
    else:
        jobs = []
        for proj in _all_project_names():
            jobs.extend(_read_all(proj))
        jobs.extend(_read_all(""))  # 글로벌 leftover
    if status:
        jobs = [j for j in jobs if j.get("status") == status]
    jobs.sort(key=lambda j: j.get("started_at", 0), reverse=True)
    if limit and limit > 0:
        jobs = jobs[:limit]
    return jobs


def clear_finished(*, project: str | None = None, only_status: str | None = None) -> int:
    """완료/실패한 job 제거. 진행 중 (running) 은 항상 보존.
    project None 이면 모든 프로젝트 + 글로벌 fallback 대상."""
    with _LOCK:
        _migrate_legacy_global()
        targets = [project] if project else _all_project_names() + [""]
        removed = 0
        for proj in targets:
            jobs = _read_all(proj)
            before = len(jobs)
            if only_status in ("completed", "failed"):
                jobs = [j for j in jobs if j.get("status") != only_status]
            else:
                jobs = [j for j in jobs if j.get("status") == "running"]
            if len(jobs) != before:
                _write_all(proj, jobs)
                removed += before - len(jobs)
        return removed


def clear_all(*, project: str | None = None) -> int:
    """모두 제거 (단일 프로젝트 또는 전체)."""
    with _LOCK:
        _migrate_legacy_global()
        targets = [project] if project else _all_project_names() + [""]
        removed = 0
        for proj in targets:
            jobs = _read_all(proj)
            n = len(jobs)
            _write_all(proj, [])
            removed += n
        return removed


def remove_job(id: str, *, project: str | None = None) -> bool:
    """단일 job 제거."""
    with _LOCK:
        _migrate_legacy_global()
        targets = [project] if project else _all_project_names() + [""]
        for proj in targets:
            jobs = _read_all(proj)
            new_jobs = [j for j in jobs if j.get("id") != id]
            if len(new_jobs) != len(jobs):
                _write_all(proj, new_jobs)
                return True
        return False


# ── 내부 — 모든 프로젝트 이름 열거 ───────────────────────────────

def _all_project_names() -> list[str]:
    """PROJECTS_DIR 안의 하위 디렉토리 이름 목록."""
    try:
        return [p.name for p in PROJECTS_DIR.iterdir() if p.is_dir() and not p.name.startswith(".")]
    except OSError:
        return []


def all_jobs_files() -> list[Path]:
    """모든 프로젝트의 jobs.json 경로 + 글로벌 leftover. SSE watcher 가 mtime 폴링용."""
    out: list[Path] = []
    for proj in _all_project_names():
        out.append(_jobs_file(proj))
    out.append(LEGACY_GLOBAL_JOBS)
    return out
