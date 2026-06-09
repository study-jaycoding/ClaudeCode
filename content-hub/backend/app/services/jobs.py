"""비동기 잡 큐 (Phase 3).

생성 요청을 asyncio.Queue 에 넣고, 백그라운드 워커가 하나씩 꺼내
cli_bridge.create_job 으로 실제 생성한다. 상태 전이는 WebSocket 으로 push.

DESIGN.md §3: 입력 → CLI 비동기 호출 → 진행률 push → 결과 저장·DB 기록.
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass, field
from typing import Any, Optional

from .. import repo
from ..ws import manager
from . import cli_bridge


@dataclass
class GenJob:
    generation_id: str
    model: str
    prompt: str
    params: dict[str, Any] = field(default_factory=dict)
    media: list[tuple[str, str]] = field(default_factory=list)


class JobQueue:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[GenJob] = asyncio.Queue()
        self._worker: Optional[asyncio.Task] = None

    def start(self) -> None:
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._run(), name="job-queue-worker")

    async def stop(self) -> None:
        if self._worker:
            self._worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._worker
            self._worker = None

    async def enqueue(self, job: GenJob) -> None:
        await self._queue.put(job)
        await manager.broadcast(
            {"type": "queued", "generation_id": job.generation_id}
        )

    async def _run(self) -> None:
        while True:
            job = await self._queue.get()
            try:
                await self._process(job)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # 워커가 죽지 않도록 잡 단위로 격리
                repo.set_status(job.generation_id, "failed")
                await manager.broadcast(
                    {
                        "type": "progress",
                        "generation_id": job.generation_id,
                        "status": "failed",
                        "error": str(e),
                    }
                )
            finally:
                self._queue.task_done()

    async def _process(self, job: GenJob) -> None:
        # running 전이
        repo.set_status(job.generation_id, "running")
        await manager.broadcast(
            {
                "type": "progress",
                "generation_id": job.generation_id,
                "status": "running",
            }
        )

        # ⚠️ 실제 유료 생성 호출 (--wait 로 완료까지 블록)
        parsed = await cli_bridge.create_job(
            model=job.model,
            prompt=job.prompt,
            params=job.params,
            media=job.media,
        )

        # 결과 저장 — asset 기록
        asset = parsed.get("asset")
        if asset:
            thumb = asset["file_path"] if asset["type"] == "image" else None
            repo.add_asset(
                job.generation_id, asset["type"], asset["file_path"], thumb
            )

        status = parsed["generation"]["status"] or "done"
        repo.set_status(job.generation_id, status)
        await manager.broadcast(
            {
                "type": "progress",
                "generation_id": job.generation_id,
                "status": status,
                "result_url": asset["file_path"] if asset else None,
            }
        )


# 앱 전역 단일 큐
queue = JobQueue()
