"""데이터 접근 계층 (Phase 2/3).

라우터·잡 큐·동기화가 공유하는 SQLite 읽기/쓰기. 직렬화(Row → API dict)도 여기서.
모든 ID 는 UUID 문자열(CLAUDE.md 컨벤션). 단, 동기화로 들어온 generation 은
higgsfield job id 를 그대로 PK 로 써서 재동기 시 멱등하게 한다.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any, Iterable, Optional

from .config import DEFAULT_WORKER_ID, DEFAULT_WORKER_NAME
from .db import get_connection


def new_id() -> str:
    return str(uuid.uuid4())


# ── 작업자 ───────────────────────────────────────────────────────────────
def ensure_worker(
    conn: sqlite3.Connection,
    worker_id: str,
    name: str,
    account_type: str = "personal",
) -> None:
    conn.execute(
        "INSERT INTO worker(id, name, account_type) VALUES(?,?,?) "
        "ON CONFLICT(id) DO NOTHING",
        (worker_id, name, account_type),
    )


def ensure_default_worker() -> None:
    with get_connection() as conn:
        ensure_worker(conn, DEFAULT_WORKER_ID, DEFAULT_WORKER_NAME, "personal")


def list_workers() -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT id, name, account_type FROM worker ORDER BY name"
        ).fetchall()
    return [dict(r) for r in rows]


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
    conn.execute("DELETE FROM gen_tag WHERE generation_id = ?", (gen_id,))
    for name in {t.strip() for t in tags if t and t.strip()}:
        tid = _get_or_create_tag(conn, name)
        conn.execute(
            "INSERT OR IGNORE INTO gen_tag(generation_id, tag_id) VALUES(?,?)",
            (gen_id, tid),
        )


def _upsert_reference(
    conn: sqlite3.Connection,
    *,
    ref_id: Optional[str],
    type_: str,
    file_path: str,
    source: str,
    thumbnail_path: Optional[str] = None,
) -> str:
    rid = ref_id or new_id()
    conn.execute(
        "INSERT INTO reference(id, type, file_path, thumbnail_path, source) "
        "VALUES(?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET file_path=excluded.file_path, "
        "type=excluded.type",
        (rid, type_, file_path, thumbnail_path, source),
    )
    return rid


def _link_reference(
    conn: sqlite3.Connection, gen_id: str, ref_id: str, role: Optional[str]
) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO gen_reference(generation_id, reference_id, role) "
        "VALUES(?,?,?)",
        (gen_id, ref_id, role or ""),
    )


# ── 동기화 업서트 (CLI → 로컬) ───────────────────────────────────────────
def upsert_synced_generation(parsed: dict[str, Any], worker_id: str) -> bool:
    """cli_bridge.parse_job 결과를 로컬 DB 에 업서트. 신규면 True.

    job id 를 generation PK 로 사용하므로 재동기는 멱등(중복 생성 없음).
    기존 레코드의 사용자 메타(태그/컬러)는 보존하고, status/asset 만 갱신한다.
    """
    g = parsed["generation"]
    gen_id = g["id"]
    if not gen_id:
        return False

    with get_connection() as conn:
        existing = conn.execute(
            "SELECT id FROM generation WHERE id = ?", (gen_id,)
        ).fetchone()

        if existing:
            conn.execute(
                "UPDATE generation SET status=?, model=COALESCE(model,?), params=? "
                "WHERE id=?",
                (g["status"], g["model"], json.dumps(g["params"], ensure_ascii=False), gen_id),
            )
        else:
            conn.execute(
                "INSERT INTO generation"
                "(id, worker_id, prompt, model, params, color, status, created_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (
                    gen_id,
                    worker_id,
                    g["prompt"],
                    g["model"],
                    json.dumps(g["params"], ensure_ascii=False),
                    None,
                    g["status"],
                    g["created_at"],
                ),
            )

        # asset: generation 당 1개로 단순화(재동기 시 교체)
        if parsed.get("asset"):
            a = parsed["asset"]
            thumb = a["file_path"] if a["type"] == "image" else None
            conn.execute("DELETE FROM asset WHERE generation_id=?", (gen_id,))
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path, thumbnail_path) "
                "VALUES(?,?,?,?,?)",
                (new_id(), gen_id, a["type"], a["file_path"], thumb),
            )

        # references
        for ref in parsed.get("references", []):
            thumb = ref["file_path"] if ref["type"] == "image" else None
            rid = _upsert_reference(
                conn,
                ref_id=ref.get("id"),
                type_=ref["type"],
                file_path=ref["file_path"],
                source="uploaded",
                thumbnail_path=thumb,
            )
            _link_reference(conn, gen_id, rid, ref.get("role"))

    return existing is None


# ── 로컬 생성 (POST create) ──────────────────────────────────────────────
def create_local_generation(data: dict[str, Any], worker_id: str) -> str:
    """status=pending 인 로컬 generation 레코드 생성. gen_id 반환.

    data: GenerationCreate.model_dump() 형태.
    """
    gen_id = new_id()
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO generation"
            "(id, worker_id, prompt, model, params, color, status) "
            "VALUES(?,?,?,?,?,?, 'pending')",
            (
                gen_id,
                worker_id,
                data["prompt"],
                data.get("model"),
                json.dumps(data.get("params") or {}, ensure_ascii=False),
                data.get("color"),
            ),
        )
        _set_tags(conn, gen_id, data.get("tags") or [])
        for ref in data.get("references") or []:
            rid = _upsert_reference(
                conn,
                ref_id=None,
                type_=ref.get("type", "image"),
                file_path=ref["file_path"],
                source="uploaded",
            )
            _link_reference(conn, gen_id, rid, ref.get("role"))
    return gen_id


def set_status(gen_id: str, status: str) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE generation SET status=? WHERE id=?", (status, gen_id))


def add_asset(
    gen_id: str, type_: str, file_path: str, thumbnail_path: Optional[str] = None
) -> str:
    aid = new_id()
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO asset(id, generation_id, type, file_path, thumbnail_path) "
            "VALUES(?,?,?,?,?)",
            (aid, gen_id, type_, file_path, thumbnail_path),
        )
    return aid


def set_tags(gen_id: str, tags: Iterable[str]) -> None:
    with get_connection() as conn:
        _set_tags(conn, gen_id, tags)


def set_color(gen_id: str, color: Optional[str]) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE generation SET color=? WHERE id=?", (color, gen_id))


def override_prompt_model(
    gen_id: str, prompt: Optional[str] = None, model: Optional[str] = None
) -> None:
    """재생성 시 프롬프트/모델만 선택적으로 덮어쓴다(None 은 기존 값 유지)."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET prompt=COALESCE(?,prompt), "
            "model=COALESCE(?,model) WHERE id=?",
            (prompt, model, gen_id),
        )


# ── 공유 / 가져오기 (Phase 5, 로컬) ──────────────────────────────────────
def publish(gen_id: str, shared_by: str, visibility: str = "team") -> str:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id FROM share WHERE generation_id=?", (gen_id,)
        ).fetchone()
        if row:
            return row["id"]
        sid = new_id()
        conn.execute(
            "INSERT INTO share(id, generation_id, shared_by, visibility) "
            "VALUES(?,?,?,?)",
            (sid, gen_id, shared_by, visibility),
        )
    return sid


def import_generation(source_gen_id: str, worker_id: str) -> str:
    """공유 항목을 내 워크스페이스로 복제(프롬프트·레퍼런스 보존) + lineage 기록.

    DESIGN.md §3-6/7, CLAUDE.md 원칙 3·4. 새 gen_id 반환.
    """
    with get_connection() as conn:
        src = conn.execute(
            "SELECT prompt, model, params, color FROM generation WHERE id=?",
            (source_gen_id,),
        ).fetchone()
        if not src:
            raise ValueError(f"원본 generation 없음: {source_gen_id}")

        child_id = new_id()
        conn.execute(
            "INSERT INTO generation"
            "(id, worker_id, prompt, model, params, color, status) "
            "VALUES(?,?,?,?,?,?, 'pending')",
            (child_id, worker_id, src["prompt"], src["model"], src["params"], src["color"]),
        )
        # 레퍼런스 연결 복제(원본 reference 레코드는 공유)
        refs = conn.execute(
            "SELECT reference_id, role FROM gen_reference WHERE generation_id=?",
            (source_gen_id,),
        ).fetchall()
        for r in refs:
            _link_reference(conn, child_id, r["reference_id"], r["role"])
        # 태그 복제
        tags = conn.execute(
            "SELECT t.name FROM gen_tag gt JOIN tag t ON t.id=gt.tag_id "
            "WHERE gt.generation_id=?",
            (source_gen_id,),
        ).fetchall()
        _set_tags(conn, child_id, [t["name"] for t in tags])
        # lineage 기록
        conn.execute(
            "INSERT INTO lineage(id, parent_gen_id, child_gen_id) VALUES(?,?,?)",
            (new_id(), source_gen_id, child_id),
        )
    return child_id


# ── 조회 / 직렬화 ────────────────────────────────────────────────────────
def _attach_children(
    conn: sqlite3.Connection, gens: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """generation dict 목록에 assets/references/tags/shared/parent 를 채운다."""
    if not gens:
        return gens
    ids = [g["id"] for g in gens]
    placeholders = ",".join("?" * len(ids))
    by_id = {g["id"]: g for g in gens}
    for g in gens:
        g["assets"] = []
        g["references"] = []
        g["tags"] = []
        g["shared"] = False
        g["parent_gen_id"] = None
        g["params"] = json.loads(g["params"]) if g.get("params") else None

    for r in conn.execute(
        f"SELECT id, generation_id, type, file_path, thumbnail_path "
        f"FROM asset WHERE generation_id IN ({placeholders})",
        ids,
    ).fetchall():
        by_id[r["generation_id"]]["assets"].append(dict(r))

    for r in conn.execute(
        f"SELECT gr.generation_id, r.id, r.type, r.file_path, r.thumbnail_path, "
        f"r.source, gr.role FROM gen_reference gr "
        f"JOIN reference r ON r.id = gr.reference_id "
        f"WHERE gr.generation_id IN ({placeholders})",
        ids,
    ).fetchall():
        d = dict(r)
        gid = d.pop("generation_id")
        by_id[gid]["references"].append(d)

    for r in conn.execute(
        f"SELECT gt.generation_id, t.name FROM gen_tag gt "
        f"JOIN tag t ON t.id = gt.tag_id "
        f"WHERE gt.generation_id IN ({placeholders})",
        ids,
    ).fetchall():
        by_id[r["generation_id"]]["tags"].append(r["name"])

    for r in conn.execute(
        f"SELECT DISTINCT generation_id FROM share "
        f"WHERE generation_id IN ({placeholders})",
        ids,
    ).fetchall():
        by_id[r["generation_id"]]["shared"] = True

    for r in conn.execute(
        f"SELECT child_gen_id, parent_gen_id FROM lineage "
        f"WHERE child_gen_id IN ({placeholders})",
        ids,
    ).fetchall():
        by_id[r["child_gen_id"]]["parent_gen_id"] = r["parent_gen_id"]

    return gens


def list_generations(
    *,
    tab: str = "my",
    worker_id: Optional[str] = None,
    color: Optional[str] = None,
    tag: Optional[str] = None,
    shared_only: bool = False,
    search: Optional[str] = None,
    limit: int = 500,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """필터 적용된 generation 목록(DESIGN.md §4 좌측 필터).

    tab='team' 이면 공유된 것만 보여준다(로컬 단일 DB 에서 팀 공유 갤러리 모사).
    """
    where: list[str] = []
    args: list[Any] = []

    if tab == "team":
        where.append("EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id)")
    if worker_id:
        where.append("g.worker_id = ?")
        args.append(worker_id)
    if color:
        where.append("g.color = ?")
        args.append(color)
    if shared_only:
        where.append("EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id)")
    if tag:
        where.append(
            "EXISTS (SELECT 1 FROM gen_tag gt JOIN tag t ON t.id=gt.tag_id "
            "WHERE gt.generation_id=g.id AND t.name = ?)"
        )
        args.append(tag)
    if search:
        where.append("(g.prompt LIKE ? OR EXISTS (SELECT 1 FROM gen_tag gt "
                     "JOIN tag t ON t.id=gt.tag_id WHERE gt.generation_id=g.id "
                     "AND t.name LIKE ?))")
        args += [f"%{search}%", f"%{search}%"]

    clause = (" WHERE " + " AND ".join(where)) if where else ""
    sql = (
        "SELECT g.id, g.worker_id, w.name AS worker_name, g.prompt, g.model, "
        "g.params, g.color, g.status, g.created_at "
        "FROM generation g LEFT JOIN worker w ON w.id = g.worker_id"
        f"{clause} ORDER BY g.created_at DESC LIMIT ? OFFSET ?"
    )
    args += [limit, offset]

    with get_connection() as conn:
        rows = [dict(r) for r in conn.execute(sql, args).fetchall()]
        return _attach_children(conn, rows)


def get_generation(gen_id: str) -> Optional[dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT g.id, g.worker_id, w.name AS worker_name, g.prompt, g.model, "
            "g.params, g.color, g.status, g.created_at "
            "FROM generation g LEFT JOIN worker w ON w.id = g.worker_id "
            "WHERE g.id = ?",
            (gen_id,),
        ).fetchone()
        if not row:
            return None
        return _attach_children(conn, [dict(row)])[0]


def get_facets() -> dict[str, Any]:
    with get_connection() as conn:
        colors = [
            r["color"]
            for r in conn.execute(
                "SELECT DISTINCT color FROM generation "
                "WHERE color IS NOT NULL AND color <> '' ORDER BY color"
            ).fetchall()
        ]
        tags = [
            r["name"]
            for r in conn.execute("SELECT name FROM tag ORDER BY name").fetchall()
        ]
        workers = [
            dict(r)
            for r in conn.execute(
                "SELECT id, name, account_type FROM worker ORDER BY name"
            ).fetchall()
        ]
    return {"colors": colors, "tags": tags, "workers": workers}
