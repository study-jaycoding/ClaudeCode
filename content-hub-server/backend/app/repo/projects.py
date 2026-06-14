"""프로젝트(작업 묶음) 데이터 접근 — 로드맵 §0-4/§4-4.

프로젝트는 **공유·이동의 단위**다(개인필터인 태그·컬러와 다름). 선택하면 그 안의
결과물만 보인다. generation.project_id 로 귀속하고, NULL = 미분류.

로그인·등급은 아직 없으므로 가시성 enforcement(멤버만 보기)는 하지 않는다 —
project_member 는 전방 호환용으로 기록만 한다(로드맵: 식별 먼저, 차단은 나중).
"""

from __future__ import annotations

import sqlite3
from typing import Any, Optional

from ..db import get_connection
from ._common import new_id

_SELECT = (
    "SELECT p.id, p.name, p.kind, p.created_by, p.created_at, p.archived, "
    "(SELECT COUNT(*) FROM generation g WHERE g.project_id = p.id) AS count "
    "FROM project p"
)


def _provider_uid() -> Optional[str]:
    """프로젝트 created_by 기본값 — 로그인 전엔 제공자 신원(없으면 None)."""
    from .identity import get_provider

    try:
        return get_provider().get("uid")
    except Exception:  # noqa: BLE001 — 신원 미설정이어도 프로젝트 생성은 가능해야
        return None


def _row(conn: sqlite3.Connection, pid: str) -> Optional[dict[str, Any]]:
    row = conn.execute(f"{_SELECT} WHERE p.id = ?", (pid,)).fetchone()
    return dict(row) if row else None


def create_project(
    name: str, kind: str = "team", created_by: Optional[str] = None
) -> dict[str, Any]:
    """새 프로젝트 생성. 같은 이름(미보관)이 이미 있으면 그것을 반환(멱등적 생성)."""
    name = (name or "").strip()
    if not name:
        raise ValueError("빈 프로젝트 이름")
    kind = kind if kind in ("team", "personal") else "team"
    with get_connection() as conn:
        existing = conn.execute(
            "SELECT id FROM project WHERE name = ? AND archived = 0", (name,)
        ).fetchone()
        if existing:
            return _row(conn, existing["id"])  # type: ignore[return-value]
        pid = new_id()
        conn.execute(
            "INSERT INTO project(id, name, kind, created_by) VALUES(?,?,?,?)",
            (pid, name, kind, created_by or _provider_uid()),
        )
        return _row(conn, pid)  # type: ignore[return-value]


def get_project(pid: str) -> Optional[dict[str, Any]]:
    with get_connection() as conn:
        return _row(conn, pid)


def list_projects(include_archived: bool = False) -> dict[str, Any]:
    """프로젝트 목록 + 미분류 수. 결과물 많은 순 → 이름 순.
    반환: {"projects": [...], "unassigned": N}."""
    clause = "" if include_archived else " WHERE p.archived = 0"
    sql = f"{_SELECT}{clause} ORDER BY count DESC, p.name COLLATE NOCASE"
    with get_connection() as conn:
        projects = [dict(r) for r in conn.execute(sql).fetchall()]
        unassigned = conn.execute(
            "SELECT COUNT(*) AS c FROM generation WHERE project_id IS NULL"
        ).fetchone()["c"]
    return {"projects": projects, "unassigned": unassigned}


def rename_project(pid: str, name: str) -> bool:
    name = (name or "").strip()
    if not name:
        raise ValueError("빈 프로젝트 이름")
    with get_connection() as conn:
        cur = conn.execute("UPDATE project SET name = ? WHERE id = ?", (name, pid))
        return cur.rowcount > 0


def set_archived(pid: str, archived: bool) -> bool:
    with get_connection() as conn:
        cur = conn.execute(
            "UPDATE project SET archived = ? WHERE id = ?", (1 if archived else 0, pid)
        )
        return cur.rowcount > 0


def delete_project(pid: str) -> bool:
    """프로젝트 삭제 — 귀속 결과물은 지우지 않고 미분류(NULL)로 되돌린다.
    project_member 는 FK ON DELETE CASCADE 로 함께 정리."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET project_id = NULL WHERE project_id = ?", (pid,)
        )
        cur = conn.execute("DELETE FROM project WHERE id = ?", (pid,))
        return cur.rowcount > 0


def assign_to_project(generation_ids: list[str], project_id: Optional[str]) -> int:
    """결과물들을 프로젝트에 귀속(또는 project_id=None 으로 미분류 해제). 변경 행수 반환.
    project_id 가 실재하는지 검증(없으면 ValueError)."""
    if not generation_ids:
        return 0
    with get_connection() as conn:
        if project_id is not None and not conn.execute(
            "SELECT 1 FROM project WHERE id = ?", (project_id,)
        ).fetchone():
            raise ValueError(f"없는 프로젝트: {project_id}")
        placeholders = ",".join("?" for _ in generation_ids)
        cur = conn.execute(
            f"UPDATE generation SET project_id = ? WHERE id IN ({placeholders})",
            [project_id, *generation_ids],
        )
        return cur.rowcount


def add_project_member(pid: str, creator_uid: str) -> bool:
    """프로젝트 멤버 기록(전방 호환). 멱등. (멤버 등급 list_members 와 이름 충돌 회피)."""
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM project WHERE id = ?", (pid,)).fetchone():
            raise ValueError(f"없는 프로젝트: {pid}")
        conn.execute(
            "INSERT OR IGNORE INTO project_member(project_id, creator_uid) VALUES(?,?)",
            (pid, creator_uid),
        )
        return True


def list_project_members(pid: str) -> list[str]:
    with get_connection() as conn:
        return [
            r["creator_uid"]
            for r in conn.execute(
                "SELECT creator_uid FROM project_member WHERE project_id = ?", (pid,)
            ).fetchall()
        ]
