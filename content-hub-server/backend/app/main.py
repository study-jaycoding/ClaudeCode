"""FastAPI 엔트리 (Phase 2/3).

앱 팩토리: 시작 시 DB 초기화 + 기본 작업자 시드, 잡 큐 워커 기동,
라우터·정적 미디어·WebSocket 마운트.

실행: uvicorn app.main:app  (backend/ 에서)
⚠️ Windows 에서는 --reload 금지 — SelectorEventLoop 이 강제돼 CLI subprocess 가 깨진다.
"""

from __future__ import annotations

import asyncio
import sys
import warnings
from contextlib import asynccontextmanager

# Windows 함정: CLI 브리지(asyncio subprocess)는 Proactor 이벤트 루프가 필요하다.
# 아래처럼 import 시점에 Proactor 정책을 박아두면 일반 실행(uvicorn app.main:app)에서는
# subprocess 가 동작한다. 단, uvicorn --reload 는 리로더가 SelectorEventLoop 을 강제하므로
# 이 정책으로도 막을 수 없다(NotImplementedError) → Windows 에서는 --reload 없이 실행.
if sys.platform == "win32":
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        try:
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
        except Exception:
            pass

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import repo
from .config import AUTH_ENABLED, CORS_ORIGINS, FRONTEND_DIST, MEDIA_DIR, ensure_dirs
from .db import init_db
from .deps import session_token
from .routers import (
    assets,
    auth,
    generation,
    library,
    members,
    projects,
    share,
    sync,
)
from .services import auth as auth_svc
from .services.backup import periodic_backup
from .services.jobs import queue
from .services.syncer import periodic_sync
from .ws import manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 시작: DB 스키마 적용(멱등) + 기본 작업자 + 미디어 디렉터리 + 잡 큐 워커
    init_db()
    ensure_dirs()
    repo.ensure_default_worker()
    # 크래시/재시작 복구: 이전 프로세스에서 끊긴 진행중 잡(pending/running)을 failed 로 정리.
    orphaned = repo.fail_orphaned_jobs()
    if orphaned:
        print(f"[startup] 고아 잡 {orphaned}개를 failed 로 정리")
    # create/sync 레이스로 생긴 중복(같은 결과물 2행) 병합 정리
    dups = repo.reconcile_duplicates()
    if dups:
        print(f"[startup] 중복 동기화본 {dups}개를 병합 정리")
    # 생성자 식별자(result_url user_<id>) 백필 — 팀 워크스페이스 작성자 구분
    cu = repo.backfill_creator_uids()
    if cu:
        print(f"[startup] 생성자 uid {cu}개 백필")
    # 제공자 신원 — CLI account status 이메일로 기본값 캡처(공유 파일명·작성자 표기 기준).
    # 사용자가 바꾼 이름은 절대 안 덮어씀. CLI 오프라인이면 조용히 건너뜀(다음 기회).
    try:
        from .services import cli_bridge

        status = await cli_bridge.get_account_status()
        repo.capture_provider_identity(status.get("email") or None)
    except Exception as e:  # noqa: BLE001 — 신원 캡처 실패가 부팅을 막지 않게
        print(f"[startup] 제공자 신원 캡처 건너뜀: {e}")
    queue.start()
    periodic_sync.start()  # 힉스필드 주기 동기화(실시간) — 다른 기기/웹 잡 자동 반영
    periodic_backup.start()  # DB 자동 백업(서버 운영) — 시작 1회 + 주기, 회전 보관
    yield
    # 종료: 주기 백업 + 주기 동기화 + 잡 큐 워커 정리
    await periodic_backup.stop()
    await periodic_sync.stop()
    await queue.stop()


app = FastAPI(title="Content Hub", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in CORS_ORIGINS if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(library.router)
app.include_router(generation.router)
app.include_router(share.router)
app.include_router(sync.router)
app.include_router(assets.router)
app.include_router(projects.router)
app.include_router(members.router)
app.include_router(auth.router)


# ── 인증 enforcement 미들웨어 (로드맵 §4-6 '서버가 매번 검증') ─────────────────
# AUTH_ENABLED 일 때만 작동. 보호 경로(/api/* 와 /media/*)는 승인된 세션을 요구한다.
# 토큰은 Authorization: Bearer <token> 또는 세션 쿠키(ch_session — img/태그·WS 용).
# 검증되면 request.state.account 에 계정을 싣는다. 정적 SPA 는 공개, /ws 는 핸들러에서 검증.
_AUTH_PUBLIC_PREFIXES = ("/api/auth/", "/api/health")


@app.middleware("http")
async def auth_enforcement(request: Request, call_next):
    request.state.account = None
    path = request.url.path
    # 토큰(헤더 또는 쿠키)이 있으면 모드와 무관하게 계정을 실어둔다(/me·관리자 검증·표시에).
    token = session_token(request)
    if token:
        email = auth_svc.verify_token(token)
        if email:
            acc = repo.get_account(email)
            if acc and acc["status"] == "approved":
                request.state.account = acc
    if not AUTH_ENABLED:
        return await call_next(request)
    # 보호: /api/*(로그인·가입·헬스 제외) + /media/*. 정적 SPA·/ws 는 여기서 제외.
    api_protected = path.startswith("/api/") and not path.startswith(_AUTH_PUBLIC_PREFIXES)
    media_protected = path.startswith("/media")
    if (api_protected or media_protected) and request.state.account is None:
        return JSONResponse({"detail": "로그인이 필요합니다"}, status_code=401)
    return await call_next(request)

# 로컬에 받아둔 미디어 원본 서빙(현재는 원격 URL 직접 사용, 향후 byte-cache 용).
# StaticFiles 는 마운트 시점에 디렉터리가 있어야 하므로 먼저 생성한다.
ensure_dirs()
app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")


@app.get("/api/health")
def health():
    from .services import cli_bridge

    return {"status": "ok", "cli_available": cli_bridge.cli_available()}


@app.get("/api/backups")
def list_backups():
    """보관 중인 DB 백업 목록(최신순). 운영/관리자용."""
    from .services.backup import list_backups_info

    return list_backups_info()


@app.post("/api/backup")
async def trigger_backup():
    """수동 DB 백업 즉시 실행(회전 포함). 관리자/운영용."""
    from .services.backup import backup_now

    path = await asyncio.to_thread(backup_now)
    return {"ok": path is not None, "file": path.name if path else None}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """생성 진행률 push 채널. AUTH_ENABLED 면 세션 쿠키(또는 ?token=)로 인증 후 수락."""
    if AUTH_ENABLED:
        from .deps import SESSION_COOKIE

        token = ws.cookies.get(SESSION_COOKIE) or ws.query_params.get("token")
        email = auth_svc.verify_token(token) if token else None
        acc = repo.get_account(email) if email else None
        if not acc or acc["status"] != "approved":
            await ws.close(code=1008)  # policy violation
            return
    await manager.connect(ws)
    try:
        while True:
            # 클라이언트 → 서버 메시지는 현재 쓰지 않지만 연결 유지를 위해 수신.
            await ws.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(ws)
    except Exception:
        await manager.disconnect(ws)


# ── 서버 모드: 빌드된 프론트엔드(dist) 서빙 ──────────────────────────────────
# 백엔드가 프론트를 같은 오리진에서 제공 → 프론트의 상대경로가 그대로 동작하고
# CORS 도 불필요. dist 가 없으면(개발: Vite dev server 사용) 이 블록은 건너뛴다.
# 라우터·/media 마운트보다 *뒤*에 등록해야 API 경로를 가리지 않는다.
if FRONTEND_DIST.is_dir():
    _ASSETS_DIR = FRONTEND_DIST / "assets"
    if _ASSETS_DIR.is_dir():
        app.mount("/assets", StaticFiles(directory=str(_ASSETS_DIR)), name="spa-assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        """SPA 진입점. 실제 파일이면 그 파일을, 아니면 index.html 을 돌려준다.
        알 수 없는 /api·/ws·/media 요청은 200(index.html)으로 삼키지 않고 404 로."""
        if full_path.startswith(("api/", "ws", "media/")):
            raise HTTPException(status_code=404, detail="Not Found")
        candidate = (FRONTEND_DIST / full_path).resolve()
        # 경로 탈출 방지: dist 바깥을 가리키면 거부
        if (
            full_path
            and candidate.is_file()
            and str(candidate).startswith(str(FRONTEND_DIST))
        ):
            return FileResponse(str(candidate))
        return FileResponse(str(FRONTEND_DIST / "index.html"))
else:
    print(f"[startup] 프론트엔드 dist 없음 → API 전용 모드 ({FRONTEND_DIST})")


def run() -> None:
    """`python -m app.main` — 서버 모드 실행(0.0.0.0 바인딩, env 로 host/port 재정의).
    ⚠️ Windows 에서 --reload 는 금지(SelectorEventLoop 강제로 CLI subprocess 깨짐)이라
    여기서도 reload=False 고정. CLI 와 동일한 검증된 실행 경로."""
    import uvicorn

    from .config import HOST, PORT

    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=False, log_level="info")


if __name__ == "__main__":
    run()
