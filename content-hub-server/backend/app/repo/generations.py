"""생성본(generation) 업서트·로컬 생성·상태·조회/직렬화·소스 검색."""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Iterable, Optional

from ..config import DEFAULT_WORKER_ID
from ..db import get_connection
from . import identity, tags
from ._common import _cached_or_remote, new_id


def _upsert_reference(
    conn: sqlite3.Connection,
    *,
    ref_id: Optional[str],
    type_: str,
    file_path: str,
    source: str,
    thumbnail_path: Optional[str] = None,
    source_url: Optional[str] = None,
) -> str:
    rid = ref_id or new_id()
    conn.execute(
        "INSERT INTO reference(id, type, file_path, thumbnail_path, source, source_url) "
        "VALUES(?,?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET file_path=excluded.file_path, "
        "type=excluded.type, source_url=COALESCE(reference.source_url, excluded.source_url)",
        (rid, type_, file_path, thumbnail_path, source, source_url),
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
def upsert_synced_generation(parsed: dict[str, Any], worker_id: str) -> str:
    """cli_bridge.parse_job 결과를 로컬 DB 에 업서트.

    반환: 'inserted'(신규) | 'updated'(상태 변동) | 'unchanged'. 주기 동기화가
    변동 여부로 WS broadcast 를 결정한다. job id 를 PK 로 써서 재동기는 멱등.
    기존 레코드의 사용자 메타(태그/컬러/display_prompt/명명 레퍼런스)는 보존한다.
    """
    g = parsed["generation"]
    job_id = g["id"]
    if not job_id:
        return "unchanged"
    # 결과 미디어 URL — id/job_id 매칭이 깨졌을 때 '같은 결과물' 판정의 안정적 키.
    a0 = parsed.get("asset") or {}
    result_url = a0.get("file_path")
    if not (isinstance(result_url, str) and result_url.startswith("http")):
        result_url = None

    with get_connection() as conn:
        # 이미 이 잡을 대표하는 행이 있는가? — 동기화본(id=job_id) 이거나
        # 로컬 생성본(job_id 컬럼=job_id). 있으면 그 행을 갱신해 중복 삽입을 막는다.
        existing = conn.execute(
            "SELECT id, status FROM generation WHERE id = ? OR job_id = ? LIMIT 1",
            (job_id, job_id),
        ).fetchone()
        # URL 매칭 — id/job_id 로 못 찾았고 결과 URL 이 있으면, 같은 결과물을 가진 로컬 생성본을
        # 찾는다(create 가 job_id 를 못 받았거나 list id 와 다른 경우의 안전망). job_id 를 덮어쓴다.
        adopt = False
        if not existing and result_url:
            existing = conn.execute(
                "SELECT g.id, g.status FROM generation g JOIN asset a ON a.generation_id=g.id "
                "WHERE a.file_path=? OR a.source_url=? LIMIT 1",
                (result_url, result_url),
            ).fetchone()
            adopt = existing is not None

        result = "inserted"
        if existing:
            target_id = existing["id"]
            result = "updated" if existing["status"] != g["status"] else "unchanged"
            # adopt(URL 매칭)면 job_id 를 권위값으로 덮어씀, 아니면 기존 보존(COALESCE).
            # sort_ts 는 힉스필드 정밀 epoch 으로 갱신 → 로컬 생성본도 힉스필드 순서에 정렬(있을 때만).
            job_id_set = "job_id=?" if adopt else "job_id=COALESCE(job_id, ?)"
            conn.execute(
                f"UPDATE generation SET status=?, model=COALESCE(model,?), params=?, "
                f"sort_ts=COALESCE(?, sort_ts), creator_uid=COALESCE(?, creator_uid), "
                f"{job_id_set} WHERE id=?",
                (
                    g["status"],
                    g["model"],
                    json.dumps(g["params"], ensure_ascii=False),
                    g.get("sort_ts"),
                    g.get("creator_uid"),
                    job_id,
                    target_id,
                ),
            )
        else:
            target_id = job_id
            conn.execute(
                "INSERT INTO generation"
                "(id, worker_id, prompt, model, params, color, status, created_at, sort_ts, "
                "creator_uid, job_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    job_id,
                    worker_id,
                    g["prompt"],
                    g["model"],
                    json.dumps(g["params"], ensure_ascii=False),
                    None,
                    g["status"],
                    g["created_at"],
                    g.get("sort_ts"),
                    g.get("creator_uid"),
                    job_id,
                ),
            )

        # asset: generation 당 1개로 단순화(재동기 시 교체).
        # 이미 로컬 보관된 결과물이면 로컬 경로를 유지(출처 영속, 재동기로 안 깨짐).
        if parsed.get("asset"):
            a = parsed["asset"]
            is_img = a["type"] == "image"
            fp, thumb, src = _cached_or_remote(a["file_path"], is_img)
            conn.execute("DELETE FROM asset WHERE generation_id=?", (target_id,))
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path, thumbnail_path, source_url) "
                "VALUES(?,?,?,?,?,?)",
                (new_id(), target_id, a["type"], fp, thumb, src),
            )

        # references — 이미 레퍼런스가 있으면 건드리지 않는다(중복 방지 + 로컬 명명 보존).
        #  · 로컬 생성본: display_prompt 와 @소스명이 달린 레퍼런스를 그대로 유지.
        #  · 순수 동기화본: 첫 동기화 때만 medias 를 'uploaded' 로 넣고, 재동기엔 건드리지 않음.
        has_refs = conn.execute(
            "SELECT 1 FROM gen_reference WHERE generation_id=? LIMIT 1", (target_id,)
        ).fetchone()
        if not has_refs:
            for ref in parsed.get("references", []):
                is_img = ref["type"] == "image"
                fp, thumb, src = _cached_or_remote(ref["file_path"], is_img)
                rid = _upsert_reference(
                    conn,
                    ref_id=ref.get("id"),
                    type_=ref["type"],
                    file_path=fp,
                    # 번들이 실어 온 @소스명 보존(없으면 'uploaded') — create_local_generation 과 동일 규칙.
                    # buildPromptParts 가 이 source 로 display_prompt 의 인라인 칩 위치를 복원.
                    source=ref.get("source") or "uploaded",
                    thumbnail_path=thumb,
                    source_url=src,
                )
                _link_reference(conn, target_id, rid, ref.get("role"))

    return result


# ── 로컬 생성 (POST create) ──────────────────────────────────────────────
def create_local_generation(data: dict[str, Any], worker_id: str) -> str:
    """status=pending 인 로컬 generation 레코드 생성. gen_id 반환.

    data: GenerationCreate.model_dump() 형태.
    """
    gen_id = new_id()
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO generation"
            "(id, worker_id, prompt, display_prompt, model, params, color, status, sort_ts, project_id) "
            "VALUES(?,?,?,?,?,?,?, 'pending', ?, ?)",
            (
                gen_id,
                worker_id,
                data["prompt"],
                data.get("display_prompt"),
                data.get("model"),
                json.dumps(data.get("params") or {}, ensure_ascii=False),
                data.get("color"),
                time.time(),  # 정렬키 — 동기화되면 힉스필드 정밀 epoch 으로 갱신됨
                data.get("project_id"),  # 생성 시 보던 프로젝트로 자동 귀속(없으면 미분류)
            ),
        )
        tags._set_tags(conn, gen_id, data.get("tags") or [])
        tags._set_auto_tags(conn, gen_id, data.get("auto_tags") or [])
        for ref in data.get("references") or []:
            rid = _upsert_reference(
                conn,
                ref_id=None,
                type_=ref.get("type", "image"),
                file_path=ref["file_path"],
                thumbnail_path=ref.get("thumbnail"),  # 표시용(에셋 소스 썸네일)
                source=ref.get("name") or "uploaded",  # 칩 이름(@소스명) — 인라인 칩 복원 키
                source_url=ref.get("source_url"),
            )
            _link_reference(conn, gen_id, rid, ref.get("role"))
    return gen_id


def set_status(gen_id: str, status: str, error: Optional[str] = None) -> None:
    """상태 전이. failed 면 error(사유)를 저장하고, 그 외 전이는 error 를 비운다
    (재시도/재생성으로 성공·진행 시 옛 사유가 남지 않게)."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET status=?, error=? WHERE id=?",
            (status, error if status == "failed" else None, gen_id),
        )


def fail_orphaned_jobs() -> int:
    """서버 시작 시 호출 — 인메모리 잡 큐는 부팅 시 비어 있으므로, DB 의
    pending/running 은 모두 이전 프로세스에서 끊긴 고아 잡이다(워커가 사라져
    영영 완료되지 않음). failed 로 정리해 UI 가 '생성중'에 멈추지 않게 한다.
    실제 결과는 Higgsfield 에 있으므로 사용자가 동기화로 가져올 수 있다."""
    with get_connection() as conn:
        cur = conn.execute(
            "UPDATE generation SET status='failed', "
            "error=COALESCE(error, '서버 재시작으로 생성이 중단되었습니다. 동기화로 결과를 가져오거나 재생성하세요.') "
            "WHERE status IN ('pending','running')"
        )
        return cur.rowcount


def set_generation_timestamp(
    gen_id: str, created_at: Optional[str], sort_ts: Optional[float]
) -> None:
    """힉스필드가 부여한 created_at/sort_ts 를 로컬 생성본에 즉시 반영 — 주기 동기화를
    기다리지 않고 생성 완료 시점에 바로 '제자리'(정확한 순서)를 잡게 한다.
    sort_ts 가 없으면(응답에 created_at 없음) 로컬 시각 유지 → 다음 동기화가 채택."""
    if sort_ts is None:
        return
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET sort_ts=?, created_at=COALESCE(?, created_at) WHERE id=?",
            (sort_ts, created_at, gen_id),
        )


def set_job_id(gen_id: str, job_id: str) -> None:
    """로컬 생성본에 실제 Higgsfield 잡 id 를 기록 — 이후 동기화가 이 행을
    중복 생성 없이 갱신하도록(중복 방지의 핵심).

    레이스 병합: 로컬 생성이 끝나기 전에 주기 동기화가 같은 잡을 먼저 동기화본
    (id == job_id)으로 INSERT 했을 수 있다. 그 경우 사용자 메타(display_prompt·@소스명·
    태그·컬러)가 없는 동기화본은 버리고 로컬을 남긴다(병합)."""
    with get_connection() as conn:
        dup = conn.execute(
            "SELECT id FROM generation WHERE id=? AND id<>?", (job_id, gen_id)
        ).fetchone()
        if dup:
            _delete_generation(conn, job_id)  # 레이스로 생긴 동기화 중복본 제거
        conn.execute("UPDATE generation SET job_id=? WHERE id=?", (job_id, gen_id))


def update_asset_cache(
    asset_id: str, file_path: str, thumbnail_path: Optional[str], source_url: Optional[str]
) -> None:
    """asset 을 로컬 캐시 경로로 전환하고 원본 URL 을 source_url 에 보존."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE asset SET file_path=?, thumbnail_path=?, "
            "source_url=COALESCE(source_url, ?) WHERE id=?",
            (file_path, thumbnail_path, source_url, asset_id),
        )


def update_reference_cache(
    ref_id: str, file_path: str, thumbnail_path: Optional[str], source_url: Optional[str]
) -> None:
    """reference 를 로컬 캐시 경로로 전환하고 원본 URL 을 source_url 에 보존."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE reference SET file_path=?, thumbnail_path=?, "
            "source_url=COALESCE(source_url, ?) WHERE id=?",
            (file_path, thumbnail_path, source_url, ref_id),
        )


def all_generation_ids() -> list[str]:
    with get_connection() as conn:
        return [
            r["id"]
            for r in conn.execute(
                "SELECT id FROM generation ORDER BY created_at DESC"
            ).fetchall()
        ]


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


def set_color(gen_id: str, color: Optional[str]) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE generation SET color=? WHERE id=?", (color, gen_id))


def set_source(gen_id: str, name: Optional[str], is_source: bool = True) -> None:
    """생성본을 소스 라이브러리에 등록/해제(@이름)."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET is_source=?, source_name=? WHERE id=?",
            (1 if is_source else 0, (name or None) if is_source else None, gen_id),
        )


def set_comment(gen_id: str, comment: Optional[str]) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET comment=? WHERE id=?", (comment or None, gen_id)
        )


def override_prompt_model(
    gen_id: str, prompt: Optional[str] = None, model: Optional[str] = None
) -> None:
    """재생성 시 프롬프트/모델만 선택적으로 덮어쓴다(None 은 기존 값 유지).

    프롬프트를 교체하면 부모에서 복제된 display_prompt(레퍼런스 위치가 박힌 옛 프롬프트)는
    무효 → NULL 로 비운다. 응답이 `display_prompt || prompt` 로 렌더되므로, 비우지 않으면
    CLI 엔 새 텍스트가 가도 화면·내보내기엔 옛 프롬프트가 남는다. 모델만 바꿀 땐 보존."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET prompt=COALESCE(?,prompt), "
            "model=COALESCE(?,model), "
            "display_prompt=CASE WHEN ? IS NOT NULL THEN NULL ELSE display_prompt END "
            "WHERE id=?",
            (prompt, model, prompt, gen_id),
        )


def _delete_generation(conn: sqlite3.Connection, gen_id: str) -> bool:
    """generation + 모든 자식 행을 한 트랜잭션에서 제거.
    share·lineage 는 ON DELETE CASCADE 가 없고, generation_comment(_read) 는 FK 자체가
    없어 본체만 지우면 FK 에러나 고아 행이 남는다 → 명시적으로 전부 정리."""
    conn.execute("DELETE FROM share WHERE generation_id=?", (gen_id,))
    conn.execute(
        "DELETE FROM lineage WHERE parent_gen_id=? OR child_gen_id=?", (gen_id, gen_id)
    )
    conn.execute("DELETE FROM generation_comment WHERE gen_id=?", (gen_id,))
    conn.execute("DELETE FROM generation_comment_read WHERE gen_id=?", (gen_id,))
    conn.execute("DELETE FROM gen_tag WHERE generation_id=?", (gen_id,))
    conn.execute("DELETE FROM gen_auto_tag WHERE generation_id=?", (gen_id,))
    conn.execute("DELETE FROM gen_reference WHERE generation_id=?", (gen_id,))
    conn.execute("DELETE FROM asset WHERE generation_id=?", (gen_id,))
    return conn.execute("DELETE FROM generation WHERE id=?", (gen_id,)).rowcount > 0


def delete_generation(gen_id: str) -> bool:
    with get_connection() as conn:
        return _delete_generation(conn, gen_id)


def gens_with_job_id() -> list[tuple[str, str]]:
    """job_id 를 가진 generation [(id, job_id)] — 힉스필드 존재 검증 대상."""
    with get_connection() as conn:
        return [
            (r["id"], r["job_id"])
            for r in conn.execute(
                "SELECT id, job_id FROM generation WHERE job_id IS NOT NULL AND job_id<>''"
            ).fetchall()
        ]


def set_hf_missing(gen_id: str, missing: bool) -> None:
    """힉스필드 삭제 검증 결과 반영(로컬-only 흐림 처리/필터에 사용)."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET hf_missing=? WHERE id=?", (1 if missing else 0, gen_id)
        )


def mark_present_by_job_ids(job_ids: Iterable[str]) -> None:
    """동기화 목록에 나타난 잡 = 힉스필드에 존재 → hf_missing 해제(재등장 항목 흐림 해제)."""
    ids = [j for j in job_ids if j]
    if not ids:
        return
    with get_connection() as conn:
        ph = ",".join("?" * len(ids))
        conn.execute(
            f"UPDATE generation SET hf_missing=0 WHERE job_id IN ({ph})", ids
        )


def reconcile_duplicates() -> int:
    """create/sync 레이스로 생긴 중복(같은 결과 URL 을 가진 로컬+동기화 행) 정리.
    로컬(id<>job_id, 사용자 메타 보존)을 남기고 동기화본(id==job_id)의 권위 job_id 를
    로컬에 보장한 뒤 동기화 중복본을 삭제. 예상 모양(로컬 1개)이 아니면 건너뜀(안전)."""
    with get_connection() as conn:
        groups = conn.execute(
            "SELECT GROUP_CONCAT(DISTINCT g.id) ids "
            "FROM generation g JOIN asset a ON a.generation_id=g.id "
            "WHERE COALESCE(a.source_url, a.file_path) LIKE 'http%' "
            "GROUP BY COALESCE(a.source_url, a.file_path) HAVING COUNT(DISTINCT g.id) > 1"
        ).fetchall()
        merged = 0
        for grp in groups:
            ids = [x for x in (grp["ids"] or "").split(",") if x]
            rows = [
                r
                for r in (
                    conn.execute(
                        "SELECT id, job_id FROM generation WHERE id=?", (gid,)
                    ).fetchone()
                    for gid in ids
                )
                if r
            ]
            synced = [r for r in rows if r["job_id"] and r["job_id"] == r["id"]]
            local = [r for r in rows if not (r["job_id"] and r["job_id"] == r["id"])]
            if len(local) != 1 or not synced:
                continue  # 예상 모양(로컬 1 + 동기화 N) 아님 → 안전하게 건너뜀
            keep = local[0]
            conn.execute(
                "UPDATE generation SET job_id=? WHERE id=?", (synced[0]["job_id"], keep["id"])
            )
            for s in synced:
                _delete_generation(conn, s["id"])
                merged += 1
        return merged


def delete_failed_orphans() -> int:
    """힉스필드에 도달하지 못한 로컬 유령 실패만 제거 = status=failed AND job_id 없음.
    힉스필드에서 실패로 돌아온 것(job_id 있음)은 실제 실패이므로 보존. list-diff 안 함."""
    with get_connection() as conn:
        ids = [
            r["id"]
            for r in conn.execute(
                "SELECT id FROM generation WHERE status='failed' "
                "AND (job_id IS NULL OR job_id='')"
            ).fetchall()
        ]
        n = 0
        for gid in ids:
            if _delete_generation(conn, gid):
                n += 1
        return n


def import_generation(source_gen_id: str, worker_id: str) -> str:
    """공유 항목을 내 워크스페이스로 복제(프롬프트·레퍼런스 보존) + lineage 기록.

    DESIGN.md §3-6/7, CLAUDE.md 원칙 3·4. 새 gen_id 반환.
    """
    with get_connection() as conn:
        src = conn.execute(
            "SELECT prompt, display_prompt, model, params, color, project_id "
            "FROM generation WHERE id=?",
            (source_gen_id,),
        ).fetchone()
        if not src:
            raise ValueError(f"원본 generation 없음: {source_gen_id}")

        child_id = new_id()
        conn.execute(
            "INSERT INTO generation"
            "(id, worker_id, prompt, display_prompt, model, params, color, status, sort_ts, project_id) "
            "VALUES(?,?,?,?,?,?,?, 'pending', ?, ?)",
            (
                child_id,
                worker_id,
                src["prompt"],
                src["display_prompt"],  # @소스명 위치 보존 → 인라인 칩 정상 표시
                src["model"],
                src["params"],
                src["color"],
                time.time(),  # 재생성/임포트 직후 맨 위에 보이게(완료 시 힉스필드 시각으로 갱신)
                src["project_id"],  # 재생성본은 부모와 같은 프로젝트에 귀속(일관성)
            ),
        )
        # 레퍼런스 연결 복제(원본 reference 레코드는 공유)
        refs = conn.execute(
            "SELECT reference_id, role FROM gen_reference WHERE generation_id=?",
            (source_gen_id,),
        ).fetchall()
        for r in refs:
            _link_reference(conn, child_id, r["reference_id"], r["role"])
        # 태그 복제
        tag_rows = conn.execute(
            "SELECT t.name FROM gen_tag gt JOIN tag t ON t.id=gt.tag_id "
            "WHERE gt.generation_id=?",
            (source_gen_id,),
        ).fetchall()
        tags._set_tags(conn, child_id, [t["name"] for t in tag_rows])
        # 자동 태그 복제(일반 태그와 동일하게 — 재생성 시 부모 자동태그 유지)
        auto = conn.execute(
            "SELECT at.name FROM gen_auto_tag gat JOIN auto_tag at ON at.id=gat.auto_tag_id "
            "WHERE gat.generation_id=?",
            (source_gen_id,),
        ).fetchall()
        tags._set_auto_tags(conn, child_id, [a["name"] for a in auto])
        # lineage 기록
        conn.execute(
            "INSERT INTO lineage(id, parent_gen_id, child_gen_id) VALUES(?,?,?)",
            (new_id(), source_gen_id, child_id),
        )
    return child_id


# ── 조회 / 직렬화 ────────────────────────────────────────────────────────
def _attach_children(
    conn: sqlite3.Connection, gens: list[dict[str, Any]], viewer_id: str = DEFAULT_WORKER_ID
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
        g["auto_tags"] = []  # 별도 네임스페이스 — 필터 사이드바 전용(카드·# 피커엔 안 씀)
        g["shared"] = False
        g["parent_gen_id"] = None
        g["params"] = json.loads(g["params"]) if g.get("params") else None
        if "is_source" in g:
            g["is_source"] = bool(g["is_source"])

    # 생성자(creator_uid) → is_mine + 사용자 지정 이름.
    # uid 없을 때: 내 신원이 정해지기 전(단일 사용자)이면 내 것 취급(옛 데이터 보존), 신원이 정해진
    # 팀 모드면 내 것으로 단정 안 함 — creator_uid 없는 팀원 생성물을 내 작업으로 오인하지 않게.
    my_uid = identity.get_my_uid()
    cuids = {g.get("creator_uid") for g in gens if g.get("creator_uid")}
    cnames: dict[str, Optional[str]] = {}
    if cuids:
        cph = ",".join("?" * len(cuids))
        for r in conn.execute(
            f"SELECT uid, name FROM creator WHERE uid IN ({cph})", list(cuids)
        ).fetchall():
            cnames[r["uid"]] = r["name"]
    for g in gens:
        cu = g.get("creator_uid")
        g["is_mine"] = (cu == my_uid) if cu else (my_uid is None)
        g["creator_name"] = cnames.get(cu)

    for r in conn.execute(
        f"SELECT id, generation_id, type, file_path, thumbnail_path, source_url "
        f"FROM asset WHERE generation_id IN ({placeholders})",
        ids,
    ).fetchall():
        d = dict(r)
        d["cached"] = bool(d.get("file_path", "").startswith("/media/"))
        by_id[d["generation_id"]]["assets"].append(d)

    for r in conn.execute(
        f"SELECT gr.generation_id, r.id, r.type, r.file_path, r.thumbnail_path, "
        f"r.source, r.source_url, gr.role FROM gen_reference gr "
        f"JOIN reference r ON r.id = gr.reference_id "
        f"WHERE gr.generation_id IN ({placeholders}) "
        f"ORDER BY gr.rowid",  # 삽입(=제출) 순서 보장 → 인라인 칩 위치 매칭
        ids,
    ).fetchall():
        d = dict(r)
        gid = d.pop("generation_id")
        d["cached"] = bool(d.get("file_path", "").startswith("/media/"))
        by_id[gid]["references"].append(d)

    for r in conn.execute(
        f"SELECT gt.generation_id, t.name FROM gen_tag gt "
        f"JOIN tag t ON t.id = gt.tag_id "
        f"WHERE gt.generation_id IN ({placeholders})",
        ids,
    ).fetchall():
        by_id[r["generation_id"]]["tags"].append(r["name"])

    # 자동 태그(별도 네임스페이스) — 사이드바 필터 전용. 카드/# 피커는 gen.tags 만 읽으므로 누출 없음.
    for r in conn.execute(
        f"SELECT gat.generation_id, a.name FROM gen_auto_tag gat "
        f"JOIN auto_tag a ON a.id = gat.auto_tag_id "
        f"WHERE gat.generation_id IN ({placeholders})",
        ids,
    ).fetchall():
        by_id[r["generation_id"]]["auto_tags"].append(r["name"])

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

    # 공유 코멘트 스레드 메타: 글 수 + 미확인 여부(뷰어=DEFAULT_WORKER_ID, 내 글 제외).
    # 그리드 C 뱃지가 카드마다 떠야 하므로 list 경로에서 배치로 계산(N+1 회피).
    for g in gens:
        g["comment_count"] = 0
        g["has_unread"] = False
    for r in conn.execute(
        f"SELECT gen_id, COUNT(*) AS cnt FROM generation_comment "
        f"WHERE gen_id IN ({placeholders}) GROUP BY gen_id",
        ids,
    ).fetchall():
        by_id[r["gen_id"]]["comment_count"] = r["cnt"]
    # 내 코멘트라도 작성 시점 muted=1 인 것만 내 알림에서 제외(코멘트별).
    # muted 는 작성자 본인 알림만 억제 → author=viewer 일 때만 적용(팀원에겐 그대로 알림).
    for r in conn.execute(
        f"SELECT DISTINCT c.gen_id FROM generation_comment c "
        f"LEFT JOIN generation_comment_read rd "
        f"ON rd.worker_id=? AND rd.gen_id=c.gen_id "
        f"WHERE c.gen_id IN ({placeholders}) "
        f"AND (rd.read_at IS NULL OR c.created_at > rd.read_at) "
        f"AND NOT (c.author=? AND c.muted=1)",
        [viewer_id, *ids, viewer_id],
    ).fetchall():
        by_id[r["gen_id"]]["has_unread"] = True

    return gens


def list_generations(
    *,
    tab: str = "my",
    worker_id: Optional[str] = None,
    color: Optional[str] = None,
    tag: Optional[str] = None,
    share_dir: Optional[str] = None,  # None | 'mine'(내가 공유) | 'received'(타 작업자 공유본)
    local_only: bool = False,  # 힉스필드에 없고 로컬에만 있는 것(job_id 없음 or hf_missing)
    creator_uid: Optional[str] = None,  # 특정 생성자(팀원)만
    project_id: Optional[str] = None,  # 프로젝트 귀속 필터. 'none'=미분류(NULL), 그 외=해당 프로젝트
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
    if share_dir == "mine":
        # 공유한 것 — 내가 공유(발행)한 결과물
        where.append(
            "EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id AND s.shared_by = ?)"
        )
        args.append(DEFAULT_WORKER_ID)
    elif share_dir == "received":
        # 공유 받은 것 — 제공자(나 아닌 누군가)를 발신자로 한 share 행이 있는 결과물.
        # worker_id(작업 워크스테이션=항상 'me')가 아니라 shared_by 로 판별 — 가져온 번들은
        # worker_id='me' 로 들어오므로(import_bundle_payload), shared_by<>'me' 가 올바른 기준.
        where.append(
            "EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id AND s.shared_by <> ?)"
        )
        args.append(DEFAULT_WORKER_ID)
    if local_only:
        # 힉스필드에 없음 = job_id 미보유(한 번도 안 감) 또는 검증으로 삭제 확인됨
        where.append("(g.job_id IS NULL OR g.job_id='' OR g.hf_missing=1)")
    if creator_uid:
        where.append("g.creator_uid = ?")
        args.append(creator_uid)
    if project_id == "none":
        where.append("g.project_id IS NULL")
    elif project_id:
        where.append("g.project_id = ?")
        args.append(project_id)
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
        "SELECT g.id, g.worker_id, w.name AS worker_name, g.prompt, g.display_prompt, g.model, "
        "g.params, g.color, g.status, g.created_at, g.is_source, g.source_name, g.comment, g.error, "
        "g.creator_uid, g.project_id, "
        "(g.job_id IS NULL OR g.job_id='' OR g.hf_missing=1) AS local_only "
        "FROM generation g LEFT JOIN worker w ON w.id = g.worker_id"
        # 힉스필드 created_at(sub-second)을 보존한 sort_ts 로 정렬 → 힉스필드 순서 그대로.
        f"{clause} ORDER BY g.sort_ts DESC, g.created_at DESC LIMIT ? OFFSET ?"
    )
    args += [limit, offset]

    with get_connection() as conn:
        rows = [dict(r) for r in conn.execute(sql, args).fetchall()]
        return _attach_children(conn, rows)


def get_generation(gen_id: str) -> Optional[dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT g.id, g.worker_id, w.name AS worker_name, g.prompt, g.display_prompt, g.model, "
            "g.params, g.color, g.status, g.created_at, g.is_source, g.source_name, g.comment, g.error, "
            "g.creator_uid, g.project_id, "
            "(g.job_id IS NULL OR g.job_id='' OR g.hf_missing=1) AS local_only "
            "FROM generation g LEFT JOIN worker w ON w.id = g.worker_id "
            "WHERE g.id = ?",
            (gen_id,),
        ).fetchone()
        if not row:
            return None
        return _attach_children(conn, [dict(row)])[0]


# 에셋 소스 합성용 — 레퍼런스 타입은 image|video 만(오디오 등 제외)
_ASSET_IMG_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
_ASSET_VID_EXT = (".mp4", ".mov", ".webm", ".mkv", ".avi")


def _asset_media_type(name: str) -> Optional[str]:
    low = name.lower()
    if low.endswith(_ASSET_IMG_EXT):
        return "image"
    if low.endswith(_ASSET_VID_EXT):
        return "video"
    return None


def _asset_sources(
    conn: sqlite3.Connection,
    query: Optional[str],
    tag: Optional[str],
    project: str,
    directory: Optional[str],
    limit: int,
) -> list[dict[str, Any]]:
    """에셋 파트(asset_meta)의 소스(is_source=1)를 Generation 모양으로 합성.

    현재 에셋 폴더(directory)로 스코프 — 그 폴더 및 하위만. @ 피커에 생성 소스와 함께 노출.
    레퍼런스 값은 'asset:{project}|{path}' 토큰(생성 시 절대 로컬경로로 resolve → CLI 자동 업로드).
    """
    from urllib.parse import quote

    where = ["project = ?", "is_source = 1"]
    args: list[Any] = [project]
    if directory:
        where.append("(path = ? OR path LIKE ?)")
        args += [directory, directory + "/%"]
    if query:
        where.append("source_name LIKE ?")
        args.append(f"%{query}%")
    sql = (
        "SELECT path, source_name, tags, color FROM asset_meta WHERE "
        + " AND ".join(where)
        + " ORDER BY source_name IS NULL, source_name LIMIT ?"
    )
    args.append(limit)

    out: list[dict[str, Any]] = []
    for r in conn.execute(sql, args).fetchall():
        path = r["path"]
        name = path.split("/")[-1]
        mt = _asset_media_type(name)
        if not mt:  # 오디오 등은 레퍼런스 타입(image|video) 밖 → 제외
            continue
        tags_val = json.loads(r["tags"]) if r["tags"] else []
        if tag and tag not in tags_val:  # # 태그 필터(asset_meta tags 는 JSON 이라 파이썬서 필터)
            continue
        qp = f"project={quote(project)}&path={quote(path)}"
        sid = f"asset:{project}:{path}"
        out.append(
            {
                "id": sid,
                "worker_id": DEFAULT_WORKER_ID,
                "worker_name": None,
                "prompt": r["source_name"] or name,
                "model": None,
                "params": None,
                "color": r["color"],
                "status": "done",
                "created_at": "",
                "tags": tags_val,
                "shared": False,
                "parent_gen_id": None,
                "is_source": True,
                "source_name": r["source_name"] or name.rsplit(".", 1)[0],
                "comment": None,
                "assets": [
                    {
                        "id": sid,
                        "generation_id": sid,
                        "type": mt,
                        "file_path": f"/api/assets/file?{qp}",
                        "thumbnail_path": f"/api/assets/thumb?{qp}&w=512" if mt == "image" else None,
                        "source_url": f"asset:{project}|{path}",
                        "cached": True,
                    }
                ],
                "references": [],
            }
        )
    return out


def search_sources(
    query: Optional[str] = None,
    tag: Optional[str] = None,
    limit: int = 60,
    asset_project: Optional[str] = None,
    asset_dir: Optional[str] = None,
) -> list[dict[str, Any]]:
    """소스 등록된 생성본을 @이름/프롬프트(query) 또는 #태그(tag)로 검색.

    스포트라이트의 @/# 피커가 사용. is_source=1 인 것만.
    asset_project 가 주어지면 에셋 파트 소스(현재 폴더 asset_dir 로 스코프)도 합류한다.
    """
    where = ["g.is_source = 1"]
    args: list[Any] = []
    if query:
        where.append("(g.source_name LIKE ? OR g.prompt LIKE ?)")
        args += [f"%{query}%", f"%{query}%"]
    if tag:
        where.append(
            "EXISTS (SELECT 1 FROM gen_tag gt JOIN tag t ON t.id=gt.tag_id "
            "WHERE gt.generation_id=g.id AND t.name = ?)"
        )
        args.append(tag)
    sql = (
        "SELECT g.id, g.worker_id, w.name AS worker_name, g.prompt, g.display_prompt, g.model, "
        "g.params, g.color, g.status, g.created_at, g.is_source, g.source_name, g.comment, g.error "
        "FROM generation g LEFT JOIN worker w ON w.id = g.worker_id "
        "WHERE " + " AND ".join(where) +
        " ORDER BY g.source_name IS NULL, g.source_name, g.created_at DESC LIMIT ?"
    )
    args.append(limit)
    with get_connection() as conn:
        rows = [dict(r) for r in conn.execute(sql, args).fetchall()]
        gen_sources = _attach_children(conn, rows)
        asset_sources = (
            _asset_sources(conn, query, tag, asset_project, asset_dir, limit)
            if asset_project
            else []
        )
    return gen_sources + asset_sources


def get_facets() -> dict[str, Any]:
    with get_connection() as conn:
        colors = [
            r["color"]
            for r in conn.execute(
                "SELECT DISTINCT color FROM generation "
                "WHERE color IS NOT NULL AND color <> '' ORDER BY color"
            ).fetchall()
        ]
        tags_list = [
            r["name"]
            for r in conn.execute("SELECT name FROM tag ORDER BY name").fetchall()
        ]
        # 자동 태그는 별도 테이블 — 일반 tags 와 완전 분리(누출 없음)
        auto_tags = [
            r["name"]
            for r in conn.execute("SELECT name FROM auto_tag ORDER BY name").fetchall()
        ]
        workers = [
            dict(r)
            for r in conn.execute(
                "SELECT id, name, account_type FROM worker ORDER BY name"
            ).fetchall()
        ]
    return {"colors": colors, "tags": tags_list, "auto_tags": auto_tags, "workers": workers}
