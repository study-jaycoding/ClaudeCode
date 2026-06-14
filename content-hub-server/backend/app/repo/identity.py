"""작업자 / 앱 설정 / 생성자(creator) / 제공자(provider) 신원."""

from __future__ import annotations

import sqlite3
from typing import Any, Optional

from ..config import DEFAULT_WORKER_ID, DEFAULT_WORKER_NAME
from ..db import get_connection
from ._common import _UID_RE, _email_localpart


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


# ── 생성자(팀 워크스페이스 작성자) ────────────────────────────────────────
_MY_UID_CACHE: list[Any] = [None]  # [value] — None=미확정(매번 재조회), non-None=확정 캐시


def get_my_uid() -> Optional[str]:
    """내 생성자 uid(순수 읽기). 우선순위: ① 지정/학습된 my_creator_uid 설정 ② 로컬 생성본
    (id<>job_id)의 결과 URL user_<id>. 확정값(non-None)만 캐시 — 아직 못 정했으면 매번 재조회해
    로컬 생성본이 완료되는 즉시 is_mine 이 반영되게 한다.
    ※ 영속화(setting 쓰기)는 여기서 하지 않는다 — 학습은 생성 완료 시점에 learn_my_creator_uid()
      가 명시적으로 수행(읽기 경로에 쓰기 부작용을 두지 않기 위함)."""
    if _MY_UID_CACHE[0] is not None:
        return _MY_UID_CACHE[0]
    uid = get_setting("my_creator_uid")
    if not uid:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT creator_uid FROM generation "
                "WHERE id<>job_id AND job_id IS NOT NULL AND creator_uid IS NOT NULL LIMIT 1"
            ).fetchone()
        uid = row["creator_uid"] if row else None
    _MY_UID_CACHE[0] = uid  # None 이면 캐시 안 됨(위 가드에서 매번 재시도)
    return uid


def learn_my_creator_uid(uid: Optional[str]) -> None:
    """허브 생성 완료 시점에 내 user_<id> 를 영속화(이미 정해져 있으면 무시).
    읽기 경로(get_my_uid)가 아니라 생성 완료(jobs._process)에서 명시적으로 호출한다."""
    uid = (uid or "").strip()
    if not uid or get_setting("my_creator_uid"):
        return
    set_setting("my_creator_uid", uid)
    _MY_UID_CACHE[0] = None  # 다음 get_my_uid 가 새 값 반영


def set_my_creator(uid: str) -> dict[str, Optional[str]]:
    """이 생성자 uid 를 '나'로 지정 — is_mine 판정 기준이 되고, 제공자 이름을 그 uid 에 붙인다.
    팀 워크스페이스 동기화 데이터만으로는 내 작업을 못 가르므로 사용자가 한 번 지정해 고정.
    초기화로 DB 가 비면 다시 지정 필요(허브로 직접 생성 시엔 자동 학습됨)."""
    uid = (uid or "").strip()
    if not uid:
        return {"my_creator_uid": None, "name": None}
    set_setting("my_creator_uid", uid)
    name = get_provider().get("name")
    if name:
        set_creator_name(uid, name)  # 카드·사이드바에 '팀원' 대신 내 이름 표시
    _MY_UID_CACHE[0] = None  # is_mine 재계산(다음 get_my_uid 에서 새 값 반영)
    return {"my_creator_uid": uid, "name": name}


def backfill_creator_uids() -> int:
    """creator_uid 없는 gen 을 asset URL(source_url/file_path)의 user_<id> 로 채움. 멱등."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT g.id, COALESCE(a.source_url, a.file_path) url "
            "FROM generation g JOIN asset a ON a.generation_id=g.id "
            "WHERE g.creator_uid IS NULL"
        ).fetchall()
        n = 0
        for r in rows:
            m = _UID_RE.search(r["url"] or "")
            if m:
                conn.execute(
                    "UPDATE generation SET creator_uid=? WHERE id=?", (m.group(1), r["id"])
                )
                n += 1
    _MY_UID_CACHE[0] = None  # 재계산 트리거(다음 get_my_uid 에서 재조회)
    return n


def list_creators() -> list[dict[str, Any]]:
    """생성자 목록 [{uid, name, count, is_mine}] — 사이드바 필터 + 이름붙이기."""
    my = get_my_uid()
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT g.creator_uid uid, COUNT(*) cnt, c.name name "
            "FROM generation g LEFT JOIN creator c ON c.uid=g.creator_uid "
            "WHERE g.creator_uid IS NOT NULL "
            "GROUP BY g.creator_uid ORDER BY cnt DESC"
        ).fetchall()
        return [
            {"uid": r["uid"], "name": r["name"], "count": r["cnt"], "is_mine": r["uid"] == my}
            for r in rows
        ]


# ── 멤버 등급(C0~C5) — 로드맵 §4-3 ───────────────────────────────────────
# C0=관리자(전부) / C1=프로젝트 관리자 / C2~C5=피관리(할당 프로젝트만, 외부권한 나중).
# ⚠️ 현재는 '식별·표시'까지만 — 실제 접근 차단은 로그인 단계에서(식별 먼저, 차단 나중).
ROLES = ("C0", "C1", "C2", "C3", "C4", "C5")
_DEFAULT_ROLE = "C2"  # 미지정 멤버 기본 표시(피관리)


def _effective_role(stored: Optional[str], is_mine: bool) -> str:
    """저장된 등급이 있으면 그대로, 없으면 나(제공자)는 C0(관리자), 그 외는 기본 피관리."""
    if stored in ROLES:
        return stored
    return "C0" if is_mine else _DEFAULT_ROLE


def list_members() -> list[dict[str, Any]]:
    """멤버(=생성자) 목록 [{uid, name, role, is_mine, count, email}].
    관리자 창용 — 생성물 있는 생성자 + '나'(생성물 없어도 항상 포함)."""
    my = get_my_uid()
    prov = get_provider()
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT g.creator_uid uid, COUNT(*) cnt, c.name name, c.role role "
            "FROM generation g LEFT JOIN creator c ON c.uid=g.creator_uid "
            "WHERE g.creator_uid IS NOT NULL "
            "GROUP BY g.creator_uid ORDER BY cnt DESC"
        ).fetchall()
        members = [
            {
                "uid": r["uid"],
                "name": r["name"],
                "role": _effective_role(r["role"], r["uid"] == my),
                "is_mine": r["uid"] == my,
                "count": r["cnt"],
                "email": prov.get("email") if r["uid"] == my else None,
            }
            for r in rows
        ]
        # '나'(my_creator_uid)가 생성물 0이라 목록에 없으면 합성 추가(항상 보이게)
        if my and not any(m["uid"] == my for m in members):
            row = conn.execute(
                "SELECT name, role FROM creator WHERE uid=?", (my,)
            ).fetchone()
            members.insert(
                0,
                {
                    "uid": my,
                    "name": (row["name"] if row else None) or prov.get("name"),
                    "role": _effective_role(row["role"] if row else None, True),
                    "is_mine": True,
                    "count": 0,
                    "email": prov.get("email"),
                },
            )
    return members


def set_member_role(uid: str, role: Optional[str]) -> None:
    """멤버 등급 부여/변경(creator 행 upsert, 이름 보존). role=None 이면 미지정으로."""
    if role is not None and role not in ROLES:
        raise ValueError(f"잘못된 등급: {role} (허용: {', '.join(ROLES)})")
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO creator(uid, role) VALUES(?,?) "
            "ON CONFLICT(uid) DO UPDATE SET role=excluded.role",
            (uid, role),
        )


def set_creator_name(uid: str, name: Optional[str], overwrite: bool = True) -> None:
    """생성자 uid 에 사용자 지정 이름 부여(CLI 가 uid→이름을 안 주므로).
    overwrite=False 면 이미 이름이 있는 경우 보존(받은 번들의 이름이 내 로컬 명명을 침범하지 않게)."""
    conflict = (
        "ON CONFLICT(uid) DO UPDATE SET name=excluded.name"
        if overwrite
        else "ON CONFLICT(uid) DO NOTHING"
    )
    with get_connection() as conn:
        conn.execute(
            f"INSERT INTO creator(uid, name) VALUES(?,?) {conflict}",
            (uid, (name or "").strip() or None),
        )


# ── 앱 설정 / 제공자 신원 ─────────────────────────────────────────────────
def get_setting(key: str, default: Optional[str] = None) -> Optional[str]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT value FROM app_setting WHERE key=?", (key,)
        ).fetchone()
    return row["value"] if row and row["value"] is not None else default


def set_setting(key: str, value: Optional[str]) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO app_setting(key, value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def capture_provider_identity(email: Optional[str]) -> None:
    """시작 시 CLI account status 이메일로 제공자 신원 기본값을 잡는다(멱등).
    uid 앵커는 이메일 우선(불변·안정), 없으면 로컬 생성본의 user_<id>. 표시이름은 미설정 시
    이메일 로컬파트. 이미 설정된 값(특히 사용자가 바꾼 이름)은 절대 덮어쓰지 않는다."""
    if email:
        set_setting("provider_email", email)
    if not get_setting("provider_uid"):
        uid = email or get_my_uid()
        if uid:
            set_setting("provider_uid", uid)
    if not get_setting("provider_name"):
        name = _email_localpart(email) or get_my_uid()
        if name:
            set_setting("provider_name", name)


def get_provider() -> dict[str, Optional[str]]:
    """내 제공자 신원 {uid, name, email}. 공유 파일명·작성자 표기의 기준(불변 uid + 가변 이름)."""
    email = get_setting("provider_email")
    uid = get_setting("provider_uid") or email or get_my_uid()
    name = get_setting("provider_name") or _email_localpart(email) or uid or "me"
    return {"uid": uid, "name": name, "email": email}


def set_provider_name(name: str) -> dict[str, Optional[str]]:
    """제공자 표시이름 변경 → 이후 모든 공유 파일명·작성자 표기에 반영.
    uid 앵커는 그대로라 병합·dedup 이 깨지지 않는다. 내 uid 의 creator 행에도 미러(목록 표기)."""
    name = (name or "").strip()
    if not name:
        return get_provider()
    set_setting("provider_name", name)
    # 내 신원과 연결된 모든 uid(이메일 앵커 + 지정한 user_<id>)에 새 이름 미러 → 카드 표기 갱신.
    for uid in {get_setting("provider_uid"), get_setting("my_creator_uid")}:
        if uid:
            set_creator_name(uid, name)
    return get_provider()
