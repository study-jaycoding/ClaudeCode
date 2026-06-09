"""WebSocket 진행률 푸시 (Phase 3).

생성 잡의 상태 전이(pending→running→done/failed)를 연결된 모든 UI 에 broadcast 한다.
higgsfield 는 퍼센트가 아니라 상태 전이를 주므로, 가짜 진행바 대신 coarse 한
상태를 그대로 푸시한다(advisor 지침).
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self._active: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._active.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._active.discard(ws)

    async def broadcast(self, message: dict[str, Any]) -> None:
        async with self._lock:
            targets = list(self._active)
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._active.discard(ws)


# 앱 전역 단일 인스턴스
manager = ConnectionManager()
