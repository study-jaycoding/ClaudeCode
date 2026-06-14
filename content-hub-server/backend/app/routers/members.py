"""멤버·등급 라우터 (관리자 창) — 로드맵 §4-3/§4-5.

멤버 = 생성자(creator). 등급 C0~C5 를 부여·표시한다.
등급 부여는 관리자(C0/C1)만 — require_admin(AUTH_ENABLED 일 때 강제, off 면 통과).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from .. import repo
from ..deps import require_admin
from ..models import MemberOut, RoleIn

router = APIRouter(prefix="/api/members", tags=["members"])


@router.get("", response_model=list[MemberOut])
def list_members(request: Request):
    require_admin(request)
    return repo.list_members()


@router.patch("/{uid}/role", response_model=list[MemberOut])
def set_member_role(uid: str, body: RoleIn, request: Request):
    """멤버 등급 변경 후 갱신된 전체 멤버 목록 반환(관리자 창 즉시 반영)."""
    require_admin(request)
    try:
        repo.set_member_role(uid, body.role)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return repo.list_members()
