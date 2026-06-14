"""SQLite 연결·초기화 (Phase 1).

설계 근거: DESIGN.md §1(로컬 우선) / §2(데이터 모델), CLAUDE.md 설계 원칙 1.

핵심:
- WAL 저널 모드 — 읽기(UI 탐색)와 쓰기(생성 기록)가 서로를 막지 않게 한다.
  WAL 은 DB 파일에 영속되는 설정이라 한 번만 켜도 유지되지만, 신규 파일에서도
  확실히 적용되도록 init 시 명시적으로 선언한다.
- foreign_keys 는 SQLite 에서 커넥션마다 꺼진 채 시작하므로, 모든 커넥션에서
  다시 ON 으로 켠다. 안 켜면 ON DELETE CASCADE / 참조 무결성이 동작하지 않는다.

사용:
    from app.db import get_connection, init_db

    init_db()                      # 최초 1회 (스키마 적용 + WAL 확인)
    with get_connection() as conn:
        conn.execute("INSERT INTO worker (id, name) VALUES (?, ?)", (...))

CLI:
    python -m app.db init          # DB 생성 + 스키마 적용
    python -m app.db check         # 현재 PRAGMA 상태 출력
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from . import config

# backend/app/db.py → backend/ 가 기준 디렉터리
BACKEND_DIR = Path(__file__).resolve().parent.parent
SCHEMA_PATH = BACKEND_DIR / "schema.sql"

# DB 경로는 환경변수로 재정의 가능(테스트·다중 워크스페이스 대비). 기본은 <데이터 루트>/db/content_hub.db.
# 데이터 루트는 config.DATA_DIR(= CONTENT_HUB_DATA) 를 따른다 — media/shared 와 같은 루트에 묶이게.
DEFAULT_DB_PATH = config.DATA_DIR / "db" / "content_hub.db"
# 구버전 경로(backend 루트 직속) — 재시작 시 새 위치로 1회 자동 이전.
_LEGACY_DB_PATH = BACKEND_DIR / "content_hub.db"


def get_db_path() -> Path:
    """현재 사용할 DB 파일 경로. 환경변수 CONTENT_HUB_DB 가 있으면 우선."""
    env = os.environ.get("CONTENT_HUB_DB")
    return Path(env).expanduser().resolve() if env else DEFAULT_DB_PATH


def _migrate_db_location(path: Path) -> None:
    """구버전 backend/content_hub.db → data/db/ 로 1회 이전(멱등, WAL·SHM 동반).
    기본 경로를 쓰고 새 위치가 아직 없을 때만 이동(env 재정의·기존 데이터 보호)."""
    if path != DEFAULT_DB_PATH or path.exists() or not _LEGACY_DB_PATH.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        src = Path(str(_LEGACY_DB_PATH) + suffix)
        if src.exists():
            shutil.move(str(src), str(Path(str(path) + suffix)))
    print(f"[migrate] DB 이전: {_LEGACY_DB_PATH} → {path}")


def _connect(db_path: Path) -> sqlite3.Connection:
    """커넥션을 만들고 로컬-우선 워크로드에 맞는 PRAGMA 를 적용한다."""
    conn = sqlite3.connect(
        db_path,
        # 파이썬이 BEGIN 을 자동 삽입하지 않게 해 명시적 트랜잭션 제어를 가능케 한다.
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    # 커넥션마다 반드시 다시 켜야 하는 설정들
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    # WAL 과 함께 쓰는 권장 동기화 레벨 — 내구성과 속도의 균형
    conn.execute("PRAGMA synchronous = NORMAL;")
    return conn


@contextmanager
def get_connection(db_path: Path | None = None) -> Iterator[sqlite3.Connection]:
    """트랜잭션 단위 커넥션 컨텍스트.

    블록이 정상 종료되면 commit, 예외가 나면 rollback 후 항상 close.
    """
    conn = _connect(db_path or get_db_path())
    try:
        yield conn
        conn.execute("COMMIT;") if conn.in_transaction else None
    except Exception:
        if conn.in_transaction:
            conn.execute("ROLLBACK;")
        raise
    finally:
        conn.close()


def init_db(db_path: Path | None = None) -> Path:
    """schema.sql 을 적용해 DB 를 초기화한다(멱등). 적용된 DB 경로를 반환."""
    path = db_path or get_db_path()
    if not SCHEMA_PATH.exists():
        raise FileNotFoundError(f"스키마 파일을 찾을 수 없음: {SCHEMA_PATH}")

    path.parent.mkdir(parents=True, exist_ok=True)
    _migrate_db_location(path)  # 연결 전에 구버전 위치 → 새 위치 이동
    schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")

    conn = _connect(path)
    try:
        conn.executescript(schema_sql)
        _migrate(conn)
    finally:
        conn.close()
    return path


def _migrate(conn: sqlite3.Connection) -> None:
    """기존 DB 에 누락된 컬럼을 추가(멱등). schema.sql 의 CREATE IF NOT EXISTS 는
    기존 테이블에 컬럼을 더하지 않으므로 여기서 보강한다."""
    for table in ("asset", "reference"):
        cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        if "source_url" not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN source_url TEXT")

    gen_cols = {row[1] for row in conn.execute("PRAGMA table_info(generation)")}
    if "job_id" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN job_id TEXT")
    # 소스 라이브러리: 생성본을 @이름 + 태그로 재사용(별도 테이블 없이 generation 플래그)
    if "is_source" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN is_source INTEGER NOT NULL DEFAULT 0")
    if "source_name" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN source_name TEXT")
    if "comment" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN comment TEXT")
    # UI 표시용 프롬프트(칩 자리에 @소스명 보존) — CLI 본문(prompt)과 분리
    if "display_prompt" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN display_prompt TEXT")
    # 실패 사유(CLI stderr 등) — status=failed 일 때 정보팝업에 표시
    if "error" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN error TEXT")
    # 힉스필드에서 삭제됨 플래그(로컬-only 판정) — generate get 검증으로 설정
    if "hf_missing" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN hf_missing INTEGER NOT NULL DEFAULT 0")
    # 생성자 식별자(result_url 의 user_<id>) — 팀 워크스페이스에서 작성자 구분
    if "creator_uid" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN creator_uid TEXT")
    # 프로젝트(작업 묶음) 귀속 — NULL = 미분류. 로드맵 §0-4/§4-4.
    if "project_id" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN project_id TEXT")
    # 정렬용 정밀 epoch — 힉스필드 created_at(sub-second) 순서를 그대로 재현
    if "sort_ts" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN sort_ts REAL")
        # 기존 행: created_at(UTC 문자열) → epoch(초 정밀) backfill. 신규 동기화는 sub-second.
        conn.execute(
            "UPDATE generation SET sort_ts = strftime('%s', created_at) "
            "WHERE sort_ts IS NULL AND created_at IS NOT NULL"
        )
    # 코멘트 답글(parent_id) — 기존 asset_comment 에 보강
    ac_cols = {row[1] for row in conn.execute("PRAGMA table_info(asset_comment)")}
    if ac_cols and "parent_id" not in ac_cols:
        conn.execute("ALTER TABLE asset_comment ADD COLUMN parent_id TEXT")
    # 코멘트별 '내 알림 끄기' 캡처(muted) — asset/generation 코멘트 양쪽 보강
    if ac_cols and "muted" not in ac_cols:
        conn.execute("ALTER TABLE asset_comment ADD COLUMN muted INTEGER NOT NULL DEFAULT 0")
    gc_cols = {row[1] for row in conn.execute("PRAGMA table_info(generation_comment)")}
    if gc_cols and "muted" not in gc_cols:
        conn.execute("ALTER TABLE generation_comment ADD COLUMN muted INTEGER NOT NULL DEFAULT 0")
    # 멤버 등급(C0~C5) — 로드맵 §4-3. creator(=멤버)에 역할 부여. NULL=미지정(피관리 기본 취급).
    cr_cols = {row[1] for row in conn.execute("PRAGMA table_info(creator)")}
    if cr_cols and "role" not in cr_cols:
        conn.execute("ALTER TABLE creator ADD COLUMN role TEXT")
    # 컬럼이 존재함을 보장한 뒤 인덱스 생성(신규/기존 DB 공통, 멱등)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_generation_job ON generation(job_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_generation_source ON generation(is_source)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_generation_project ON generation(project_id)")


def check_db(db_path: Path | None = None) -> dict[str, str]:
    """현재 DB 의 주요 PRAGMA 상태를 읽어 반환(진단용)."""
    path = db_path or get_db_path()
    conn = _connect(path)
    try:
        journal = conn.execute("PRAGMA journal_mode;").fetchone()[0]
        fk = conn.execute("PRAGMA foreign_keys;").fetchone()[0]
        sync = conn.execute("PRAGMA synchronous;").fetchone()[0]
        tables = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
            ).fetchall()
        ]
    finally:
        conn.close()
    return {
        "db_path": str(path),
        "journal_mode": journal,
        "foreign_keys": "ON" if fk else "OFF",
        "synchronous": str(sync),
        "tables": ", ".join(tables) or "(없음)",
    }


def _main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "init"
    if cmd == "init":
        path = init_db()
        print(f"[init] DB 초기화 완료 → {path}")
        for k, v in check_db().items():
            print(f"  {k}: {v}")
        return 0
    if cmd == "check":
        for k, v in check_db().items():
            print(f"{k}: {v}")
        return 0
    print(f"알 수 없는 명령: {cmd!r} (사용: init | check)", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv))
