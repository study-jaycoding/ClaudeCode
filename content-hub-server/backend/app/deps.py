"""요청 의존성 — 인증/권한 헬퍼 (로드맵 §4-6 2겹 차단의 '서버 검증' 층).

미들웨어(main.py)가 토큰을 검증해 request.state.account 를 채운다. 여기 헬퍼는
라우터에서 '관리자만' 같은 추가 권한을 강제한다. AUTH_ENABLED=off 면 모두 통과(개발).
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException, Request

from .config import AUTH_ENABLED

_ADMIN_ROLES = ("C0", "C1")


# 세션 쿠키 이름 — img 태그·WebSocket 처럼 헤더를 못 붙이는 요청용(브라우저 자동 첨부).
SESSION_COOKIE = "ch_session"


def bearer_token(request: Request) -> Optional[str]:
    h = request.headers.get("authorization") or ""
    if h.lower().startswith("bearer "):
        return h[7:].strip() or None
    return None


def session_token(request: Request) -> Optional[str]:
    """요청의 세션 토큰 — Authorization 헤더(우선) 또는 세션 쿠키.
    /media·/ws 는 헤더를 못 붙이므로 쿠키로 인증한다."""
    return bearer_token(request) or request.cookies.get(SESSION_COOKIE)


def current_account(request: Request) -> Optional[dict[str, Any]]:
    return getattr(request.state, "account", None)


def require_admin(request: Request) -> None:
    """관리자(C0/C1)만. AUTH off 면 통과(차단 비활성)."""
    if not AUTH_ENABLED:
        return
    acc = current_account(request)
    if not acc or acc.get("role") not in _ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다")
