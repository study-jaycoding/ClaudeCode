"""태그 / 자동 태그 (별도 네임스페이스)."""

from __future__ import annotations

import sqlite3
from typing import Iterable

from ..db import get_connection
from ._common import new_id


# ── 태그 / 레퍼런스 get-or-create ────────────────────────────────────────
def _get_or_create_tag(conn: sqlite3.Connection, name: str) -> str:
    name = name.strip()
    row = conn.execute("SELECT id FROM tag WHERE name = ?", (name,)).fetchone()
    if row:
        return row["id"]
    tid = new_id()
    conn.execute("INSERT INTO tag(id, name) VALUES(?,?)", (tid, name))
    return tid


def _set_tags(conn: sqlite3.Connection, gen_id: str, tags: Iterable[str]) -> None:
    """태그를 정확히 이 집합으로 교체(기존 제거 후 추가). 추가 로직은 _add_tags 와 공유."""
    conn.execute("DELETE FROM gen_tag WHERE generation_id = ?", (gen_id,))
    _add_tags(conn, gen_id, tags)


# ── 자동 태그(별도 네임스페이스) ──────────────────────────────────────────
def _get_or_create_auto_tag(conn: sqlite3.Connection, name: str) -> str:
    name = name.strip()
    row = conn.execute("SELECT id FROM auto_tag WHERE name = ?", (name,)).fetchone()
    if row:
        return row["id"]
    aid = new_id()
    conn.execute("INSERT INTO auto_tag(id, name) VALUES(?,?)", (aid, name))
    return aid


def _set_auto_tags(conn: sqlite3.Connection, gen_id: str, names: Iterable[str]) -> None:
    """생성 시 무장된 자동 태그를 결과물에 연결(일반 태그와 완전 분리)."""
    for name in {t.strip() for t in names if t and t.strip()}:
        aid = _get_or_create_auto_tag(conn, name)
        conn.execute(
            "INSERT OR IGNORE INTO gen_auto_tag(generation_id, auto_tag_id) VALUES(?,?)",
            (gen_id, aid),
        )


def list_auto_tags() -> list[str]:
    with get_connection() as conn:
        return [r["name"] for r in conn.execute("SELECT name FROM auto_tag ORDER BY name")]


def add_auto_tags(gen_id: str, names: Iterable[str]) -> None:
    """기존 자동태그를 유지한 채 추가(재생성 시 armed 자동태그 적용)."""
    with get_connection() as conn:
        _set_auto_tags(conn, gen_id, names)


def create_auto_tag(name: str) -> bool:
    """자동 태그 추가(+버튼). 이미 있으면 False, 새로 만들면 True."""
    name = (name or "").strip()
    if not name:
        return False
    with get_connection() as conn:
        exists = conn.execute("SELECT 1 FROM auto_tag WHERE name=?", (name,)).fetchone()
        if exists:
            return False
        conn.execute("INSERT INTO auto_tag(id, name) VALUES(?,?)", (new_id(), name))
        return True


def delete_auto_tag(name: str) -> int:
    """자동 태그를 전역 삭제(연결 + 태그 행). 제거된 연결 수 반환."""
    with get_connection() as conn:
        row = conn.execute("SELECT id FROM auto_tag WHERE name=?", (name,)).fetchone()
        if not row:
            return 0
        aid = row["id"]
        cur = conn.execute("DELETE FROM gen_auto_tag WHERE auto_tag_id=?", (aid,))
        conn.execute("DELETE FROM auto_tag WHERE id=?", (aid,))
        return cur.rowcount


def set_tags(gen_id: str, tags: Iterable[str]) -> None:
    with get_connection() as conn:
        _set_tags(conn, gen_id, tags)


def delete_tag_everywhere(name: str) -> int:
    """태그를 모든 generation 에서 제거(전역 삭제) + 고아 태그 행 정리. 제거된 링크 수 반환.
    에셋 파트 T 패널의 '모든 파일에서 삭제'와 동일한 동작을 생성 파트에 제공."""
    with get_connection() as conn:
        row = conn.execute("SELECT id FROM tag WHERE name=?", (name,)).fetchone()
        if not row:
            return 0
        tid = row["id"]
        cur = conn.execute("DELETE FROM gen_tag WHERE tag_id=?", (tid,))
        conn.execute("DELETE FROM tag WHERE id=?", (tid,))
        return cur.rowcount


def _add_tags(conn: sqlite3.Connection, gen_id: str, tags: Iterable[str]) -> None:
    """태그 union 추가(기존 유지). 번들 병합은 덮어쓰기 아니라 합집합."""
    for name in {t.strip() for t in tags if t and t.strip()}:
        tid = _get_or_create_tag(conn, name)
        conn.execute(
            "INSERT OR IGNORE INTO gen_tag(generation_id, tag_id) VALUES(?,?)",
            (gen_id, tid),
        )
