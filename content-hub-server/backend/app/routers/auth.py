"""인증 라우터 — 로그인/가입/세션 + 관리자 계정 승인 (로드맵 §4-1/§4-2).

가입은 자동 등록(pending), 첫 계정만 부트스트랩 관리자(approved/C0). 로그인은 승인된
계정만 토큰 발급. 관리자(C0/C1)는 가입 대기 계정을 승인/거부·등급 변경.
⚠️ enforcement(미들웨어)는 CONTENT_HUB_AUTH=1 일 때만. off 면 이 엔드포인트는 동작하되
   토큰 없이도 누구나 접근(개발). config 엔드포인트로 프론트가 모드를 안다.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from .. import repo
from ..config import AUTH_ENABLED
from ..deps import SESSION_COOKIE, require_admin
from ..services import auth

router = APIRouter(prefix="/api/auth", tags=["auth"])

_COOKIE_MAX_AGE = 14 * 24 * 3600  # 토큰 TTL 과 동일(2주)


def _set_session_cookie(response: Response, token: str) -> None:
    """세션 쿠키 발급 — /media·/ws(헤더 못 붙임)용. httpOnly(스크립트 접근 차단)·SameSite=Lax."""
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        path="/",
    )


class RegisterIn(BaseModel):
    email: str
    password: str
    name: Optional[str] = None


class LoginIn(BaseModel):
    email: str
    password: str


class StatusIn(BaseModel):
    status: str  # approved | rejected | pending


class AccountRoleIn(BaseModel):
    role: str  # C0~C5


@router.get("/config")
def auth_config():
    """프론트가 로그인 화면 표시 여부·부트스트랩 안내를 결정하는 데 쓴다."""
    return {"auth_enabled": AUTH_ENABLED, "has_accounts": repo.count_accounts() > 0}


@router.post("/register")
def register(body: RegisterIn, response: Response):
    try:
        acc = repo.register(body.email, body.password, body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # 첫 계정(부트스트랩 관리자)은 즉시 승인 → 바로 토큰 발급(자동 로그인) + 쿠키.
    token = auth.make_token(acc["email"]) if acc["status"] == "approved" else None
    if token:
        _set_session_cookie(response, token)
    return {"account": acc, "token": token}


@router.post("/login")
def login(body: LoginIn, response: Response):
    acc = repo.authenticate(body.email, body.password)
    if not acc:
        raise HTTPException(status_code=401, detail="이메일 또는 비밀번호가 올바르지 않습니다")
    if acc["status"] == "pending":
        raise HTTPException(status_code=403, detail="관리자 승인 대기 중입니다")
    if acc["status"] != "approved":
        raise HTTPException(status_code=403, detail="접근이 거부된 계정입니다")
    token = auth.make_token(acc["email"])
    _set_session_cookie(response, token)  # /media·/ws 용 쿠키 동반 발급
    return {"account": acc, "token": token}


@router.get("/me")
def me(request: Request):
    """현재 세션의 계정. 미들웨어가 채운 request.state.account 사용."""
    acc = getattr(request.state, "account", None)
    if not acc:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    return acc


@router.post("/logout")
def logout(response: Response):
    """토큰은 무상태라 서버 저장이 없다 — 클라이언트가 토큰을 버리고 세션 쿠키를 지운다."""
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


# ── 관리자: 계정 승인·등급 ───────────────────────────────────────────────────
@router.get("/accounts")
def list_accounts(request: Request, status: Optional[str] = None):
    require_admin(request)
    return repo.list_accounts(status)


@router.patch("/accounts/{email}/status")
def set_status(email: str, body: StatusIn, request: Request):
    require_admin(request)
    try:
        acc = repo.set_account_status(email, body.status)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not acc:
        raise HTTPException(status_code=404, detail="없는 계정")
    return acc


@router.patch("/accounts/{email}/role")
def set_role(email: str, body: AccountRoleIn, request: Request):
    require_admin(request)
    try:
        acc = repo.set_account_role(email, body.role)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not acc:
        raise HTTPException(status_code=404, detail="없는 계정")
    return acc
