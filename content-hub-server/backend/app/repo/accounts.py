"""로그인 계정 데이터 접근 (보안) — 로드맵 §4-1/§4-2.

계정 = '로그인하는 사람'. 멤버(creator, 생성물 작성자)와 별개 축이지만 creator_uid 로 연결 가능.
자동 등록(pending) → 관리자 승인(approved). **첫 계정은 부트스트랩 관리자(C0/approved)** —
서버를 처음 띄운 사람이 자동으로 관리자가 되어 이후 가입자를 승인한다.
비밀번호 해시·토큰은 services/auth.py(stdlib). 여기선 password_hash 를 절대 밖으로 내보내지 않는다.
"""

from __future__ import annotations

from typing import Any, Optional

from ..db import get_connection
from ..services import auth
from .identity import ROLES

_PUBLIC = "email, name, status, role, creator_uid, created_at, approved_at"


def _row(conn, email: str) -> Optional[dict[str, Any]]:
    r = conn.execute(
        f"SELECT {_PUBLIC} FROM account WHERE email=?", (email.lower(),)
    ).fetchone()
    return dict(r) if r else None


def count_accounts() -> int:
    with get_connection() as conn:
        return conn.execute("SELECT COUNT(*) c FROM account").fetchone()["c"]


def register(email: str, password: str, name: Optional[str] = None) -> dict[str, Any]:
    """신규 계정 등록. 첫 계정 → 관리자(C0/approved), 그 외 → pending/C2.
    이미 있는 이메일이면 ValueError. password 는 해시로만 저장."""
    email = (email or "").strip().lower()
    if not email or "@" not in email:
        raise ValueError("올바른 이메일이 필요합니다")
    if not password or len(password) < 6:
        raise ValueError("비밀번호는 6자 이상이어야 합니다")
    with get_connection() as conn:
        if conn.execute("SELECT 1 FROM account WHERE email=?", (email,)).fetchone():
            raise ValueError("이미 등록된 이메일입니다")
        first = conn.execute("SELECT COUNT(*) c FROM account").fetchone()["c"] == 0
        status = "approved" if first else "pending"  # 첫 계정 = 부트스트랩 관리자
        role = "C0" if first else "C2"
        conn.execute(
            "INSERT INTO account(email, name, password_hash, status, role) VALUES(?,?,?,?,?)",
            (email, (name or "").strip() or None, auth.hash_password(password), status, role),
        )
        if first:
            conn.execute(
                "UPDATE account SET approved_at=datetime('now') WHERE email=?", (email,)
            )
        return _row(conn, email)


def authenticate(email: str, password: str) -> Optional[dict[str, Any]]:
    """이메일+비밀번호 검증. 성공 시 계정(공개필드) 반환, 실패 시 None.
    status 와 무관하게 비밀번호만 검증(승인 여부는 호출측에서 판단)."""
    email = (email or "").strip().lower()
    with get_connection() as conn:
        row = conn.execute(
            "SELECT password_hash FROM account WHERE email=?", (email,)
        ).fetchone()
        if not row or not auth.verify_password(password, row["password_hash"]):
            return None
        return _row(conn, email)


def get_account(email: str) -> Optional[dict[str, Any]]:
    with get_connection() as conn:
        return _row(conn, (email or "").strip().lower())


def list_accounts(status: Optional[str] = None) -> list[dict[str, Any]]:
    """계정 목록(관리자용). status 로 필터(pending/approved/rejected). 해시 제외."""
    clause = " WHERE status=?" if status else ""
    args = (status,) if status else ()
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT {_PUBLIC} FROM account{clause} "
            "ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, "
            "created_at DESC",
            args,
        ).fetchall()
        return [dict(r) for r in rows]


def set_account_status(email: str, status: str) -> Optional[dict[str, Any]]:
    """승인/거부/대기 전환. approved 면 approved_at 기록."""
    if status not in ("pending", "approved", "rejected"):
        raise ValueError(f"잘못된 상태: {status}")
    email = (email or "").strip().lower()
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM account WHERE email=?", (email,)).fetchone():
            return None
        if status == "approved":
            conn.execute(
                "UPDATE account SET status='approved', "
                "approved_at=COALESCE(approved_at, datetime('now')) WHERE email=?",
                (email,),
            )
        else:
            conn.execute("UPDATE account SET status=? WHERE email=?", (status, email))
        return _row(conn, email)


def set_account_role(email: str, role: str) -> Optional[dict[str, Any]]:
    if role not in ROLES:
        raise ValueError(f"잘못된 등급: {role} (허용: {', '.join(ROLES)})")
    email = (email or "").strip().lower()
    with get_connection() as conn:
        cur = conn.execute("UPDATE account SET role=? WHERE email=?", (role, email))
        return _row(conn, email) if cur.rowcount else None
