"""분리 창(Assets 파일 브라우저) 메타데이터 + 파일/생성본 코멘트 스레드."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Optional

from ..db import get_connection
from ._common import new_id


def _empty_asset_meta() -> dict[str, Any]:
    return {
        "is_source": False,
        "source_name": None,
        "tags": [],
        "comment": None,
        "color": None,
        "comment_count": 0,
        "has_unread": False,
    }


# ── 분리 창(Assets 파일 브라우저) 파일별 메타데이터 ───────────────────────
def get_asset_meta(
    project: str, worker_id: str = "me"
) -> dict[str, dict[str, Any]]:
    """파일별 메타 { path: {is_source, source_name, tags, comment, color,
    comment_count, has_unread} }. has_unread 는 worker_id 기준 미확인 코멘트 여부.
    내가 쓴 코멘트라도 작성 시점에 muted=1 로 저장된 것만 내 알림에서 제외(코멘트별)."""
    out: dict[str, dict[str, Any]] = {}
    with get_connection() as conn:
        for r in conn.execute(
            "SELECT path, is_source, source_name, tags, comment, color "
            "FROM asset_meta WHERE project=?",
            (project,),
        ):
            out[r["path"]] = {
                "is_source": bool(r["is_source"]),
                "source_name": r["source_name"],
                "tags": json.loads(r["tags"]) if r["tags"] else [],
                "comment": r["comment"],
                "color": r["color"],
                "comment_count": 0,
                "has_unread": False,
            }
        # 코멘트 개수
        for r in conn.execute(
            "SELECT path, COUNT(*) AS cnt FROM asset_comment WHERE project=? GROUP BY path",
            (project,),
        ):
            out.setdefault(r["path"], _empty_asset_meta())["comment_count"] = r["cnt"]
        # 미확인 여부(read_at 보다 나중에 달린 코멘트 존재).
        # 내 코멘트라도 작성 시점 muted=1 인 것만 내 알림에서 제외(코멘트별).
        # muted 는 "작성자 본인 알림만 억제" → 팀원에겐 그대로 알림(author=viewer 일 때만 적용).
        for r in conn.execute(
            "SELECT DISTINCT c.path FROM asset_comment c "
            "LEFT JOIN asset_comment_read rd "
            "ON rd.worker_id=? AND rd.project=c.project AND rd.path=c.path "
            "WHERE c.project=? AND (rd.read_at IS NULL OR c.created_at > rd.read_at) "
            "AND NOT (c.author=? AND c.muted=1)",
            (worker_id, project, worker_id),
        ):
            out.setdefault(r["path"], _empty_asset_meta())["has_unread"] = True
    return out


# ── 파일 코멘트 스레드(공유) ──────────────────────────────────────────────
def list_asset_comments(project: str, path: str) -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT c.id, c.author, w.name AS author_name, c.text, c.created_at, c.parent_id "
            "FROM asset_comment c LEFT JOIN worker w ON w.id = c.author "
            "WHERE c.project=? AND c.path=? ORDER BY c.created_at ASC, c.id ASC",
            (project, path),
        ).fetchall()
    return [dict(r) for r in rows]


def add_asset_comment(
    project: str,
    path: str,
    author: str,
    text: str,
    parent_id: Optional[str] = None,
    muted: bool = False,
) -> str:
    cid = new_id()
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO asset_comment(id, project, path, author, text, parent_id, muted) "
            "VALUES(?,?,?,?,?,?,?)",
            (cid, project, path, author, text, parent_id, 1 if muted else 0),
        )
    return cid


def _comment_owner_locked(
    conn: sqlite3.Connection, comment_id: str, worker_id: str
) -> tuple[Optional[bool], bool]:
    """(is_owner, locked) 반환. locked = 다른 사람이 단 답글이 있으면 True."""
    row = conn.execute(
        "SELECT author FROM asset_comment WHERE id=?", (comment_id,)
    ).fetchone()
    if not row:
        return (None, False)
    is_owner = row["author"] == worker_id
    locked = (
        conn.execute(
            "SELECT 1 FROM asset_comment WHERE parent_id=? AND author<>? LIMIT 1",
            (comment_id, worker_id),
        ).fetchone()
        is not None
    )
    return (is_owner, locked)


def edit_asset_comment(comment_id: str, worker_id: str, text: str) -> None:
    with get_connection() as conn:
        owner, locked = _comment_owner_locked(conn, comment_id, worker_id)
        if owner is None:
            raise ValueError("코멘트 없음")
        if not owner:
            raise PermissionError("내 코멘트만 수정할 수 있습니다")
        if locked:
            raise PermissionError("답글이 달려 수정할 수 없습니다")
        conn.execute("UPDATE asset_comment SET text=? WHERE id=?", (text, comment_id))


def delete_asset_comment(comment_id: str, worker_id: str) -> None:
    with get_connection() as conn:
        owner, locked = _comment_owner_locked(conn, comment_id, worker_id)
        if owner is None:
            return
        if not owner:
            raise PermissionError("내 코멘트만 삭제할 수 있습니다")
        if locked:
            raise PermissionError("답글이 달려 삭제할 수 없습니다")
        # 내가 단 답글(자식)은 함께 삭제
        conn.execute(
            "DELETE FROM asset_comment WHERE id=? OR parent_id=?", (comment_id, comment_id)
        )


def mark_asset_comments_read(worker_id: str, project: str, path: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO asset_comment_read(worker_id, project, path, read_at) "
            "VALUES(?,?,?, datetime('now')) "
            "ON CONFLICT(worker_id, project, path) DO UPDATE SET read_at=datetime('now')",
            (worker_id, project, path),
        )


# ── 생성본 코멘트 스레드(공유, 에셋과 별개) ──────────────────────────────
def list_generation_comments(gen_id: str) -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT c.id, c.author, w.name AS author_name, c.text, c.created_at, c.parent_id "
            "FROM generation_comment c LEFT JOIN worker w ON w.id = c.author "
            "WHERE c.gen_id=? ORDER BY c.created_at ASC, c.id ASC",
            (gen_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def add_generation_comment(
    gen_id: str,
    author: str,
    text: str,
    parent_id: Optional[str] = None,
    muted: bool = False,
) -> str:
    cid = new_id()
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO generation_comment(id, gen_id, author, text, parent_id, muted) "
            "VALUES(?,?,?,?,?,?)",
            (cid, gen_id, author, text, parent_id, 1 if muted else 0),
        )
    return cid


def _gen_comment_owner_locked(
    conn: sqlite3.Connection, comment_id: str, worker_id: str
) -> tuple[Optional[bool], bool]:
    """(is_owner, locked). locked = 다른 사람이 단 답글이 있으면 True(수정·삭제 잠김)."""
    row = conn.execute(
        "SELECT author FROM generation_comment WHERE id=?", (comment_id,)
    ).fetchone()
    if not row:
        return (None, False)
    is_owner = row["author"] == worker_id
    locked = (
        conn.execute(
            "SELECT 1 FROM generation_comment WHERE parent_id=? AND author<>? LIMIT 1",
            (comment_id, worker_id),
        ).fetchone()
        is not None
    )
    return (is_owner, locked)


def edit_generation_comment(comment_id: str, worker_id: str, text: str) -> None:
    with get_connection() as conn:
        owner, locked = _gen_comment_owner_locked(conn, comment_id, worker_id)
        if owner is None:
            raise ValueError("코멘트 없음")
        if not owner:
            raise PermissionError("내 코멘트만 수정할 수 있습니다")
        if locked:
            raise PermissionError("답글이 달려 수정할 수 없습니다")
        conn.execute(
            "UPDATE generation_comment SET text=? WHERE id=?", (text, comment_id)
        )


def delete_generation_comment(comment_id: str, worker_id: str) -> None:
    with get_connection() as conn:
        owner, locked = _gen_comment_owner_locked(conn, comment_id, worker_id)
        if owner is None:
            return
        if not owner:
            raise PermissionError("내 코멘트만 삭제할 수 있습니다")
        if locked:
            raise PermissionError("답글이 달려 삭제할 수 없습니다")
        conn.execute(
            "DELETE FROM generation_comment WHERE id=? OR parent_id=?",
            (comment_id, comment_id),
        )


def mark_generation_comments_read(worker_id: str, gen_id: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO generation_comment_read(worker_id, gen_id, read_at) "
            "VALUES(?,?, datetime('now')) "
            "ON CONFLICT(worker_id, gen_id) DO UPDATE SET read_at=datetime('now')",
            (worker_id, gen_id),
        )


def _ensure_asset_meta(conn: sqlite3.Connection, project: str, path: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO asset_meta(project, path) VALUES(?, ?)", (project, path)
    )


def set_asset_source(project: str, path: str, name: Optional[str], is_source: bool) -> None:
    with get_connection() as conn:
        _ensure_asset_meta(conn, project, path)
        conn.execute(
            "UPDATE asset_meta SET is_source=?, source_name=? WHERE project=? AND path=?",
            (1 if is_source else 0, (name or None) if is_source else None, project, path),
        )


def set_asset_tags(project: str, path: str, tags: list[str]) -> None:
    with get_connection() as conn:
        _ensure_asset_meta(conn, project, path)
        conn.execute(
            "UPDATE asset_meta SET tags=? WHERE project=? AND path=?",
            (json.dumps(tags, ensure_ascii=False) if tags else None, project, path),
        )


def set_asset_comment(project: str, path: str, comment: Optional[str]) -> None:
    with get_connection() as conn:
        _ensure_asset_meta(conn, project, path)
        conn.execute(
            "UPDATE asset_meta SET comment=? WHERE project=? AND path=?",
            (comment or None, project, path),
        )


def set_asset_color(project: str, path: str, color: Optional[str]) -> None:
    with get_connection() as conn:
        _ensure_asset_meta(conn, project, path)
        conn.execute(
            "UPDATE asset_meta SET color=? WHERE project=? AND path=?",
            (color or None, project, path),
        )
