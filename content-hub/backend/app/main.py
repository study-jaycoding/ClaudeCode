"""FastAPI 엔트리 (Phase 2/3).

앱 팩토리: 시작 시 DB 초기화 + 기본 작업자 시드, 잡 큐 워커 기동,
라우터·정적 미디어·WebSocket 마운트.

실행: uvicorn app.main:app --reload  (backend/ 에서)
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import repo
from .config import CORS_ORIGINS, MEDIA_DIR, ensure_dirs
from .db import init_db
from .routers import generation, library, share, sync
from .services.jobs import queue
from .ws import manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 시작: DB 스키마 적용(멱등) + 기본 작업자 + 미디어 디렉터리 + 잡 큐 워커
    init_db()
    ensure_dirs()
    repo.ensure_default_worker()
    queue.start()
    yield
    # 종료: 잡 큐 워커 정리
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

# 로컬에 받아둔 미디어 원본 서빙(현재는 원격 URL 직접 사용, 향후 byte-cache 용).
# StaticFiles 는 마운트 시점에 디렉터리가 있어야 하므로 먼저 생성한다.
ensure_dirs()
app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")


@app.get("/api/health")
def health():
    from .services import cli_bridge

    return {"status": "ok", "cli_available": cli_bridge.cli_available()}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """생성 진행률 push 채널."""
    await manager.connect(ws)
    try:
        while True:
            # 클라이언트 → 서버 메시지는 현재 쓰지 않지만 연결 유지를 위해 수신.
            await ws.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(ws)
    except Exception:
        await manager.disconnect(ws)
