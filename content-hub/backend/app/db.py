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
import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

# backend/app/db.py → backend/ 가 기준 디렉터리
BACKEND_DIR = Path(__file__).resolve().parent.parent
SCHEMA_PATH = BACKEND_DIR / "schema.sql"

# DB 경로는 환경변수로 재정의 가능(테스트·다중 워크스페이스 대비). 기본은 backend/content_hub.db
DEFAULT_DB_PATH = BACKEND_DIR / "content_hub.db"


def get_db_path() -> Path:
    """현재 사용할 DB 파일 경로. 환경변수 CONTENT_HUB_DB 가 있으면 우선."""
    env = os.environ.get("CONTENT_HUB_DB")
    return Path(env).expanduser().resolve() if env else DEFAULT_DB_PATH


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
    schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")

    conn = _connect(path)
    try:
        conn.executescript(schema_sql)
    finally:
        conn.close()
    return path


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
