"""비동기 잡 큐 (Phase 3).

생성 요청을 asyncio.Queue 에 넣고, 백그라운드 워커가 하나씩 꺼내
cli_bridge.create_job 으로 실제 생성한다. 상태 전이는 WebSocket 으로 push.

DESIGN.md §3: 입력 → CLI 비동기 호출 → 진행률 push → 결과 저장·DB 기록.
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass, field
from typing import Any

from .. import repo
from ..ws import manager
from . import cli_bridge, media_cache


@dataclass
class GenJob:
    generation_id: str
    model: str
    prompt: str
    params: dict[str, Any] = field(default_factory=dict)
    media: list[tuple[str, str]] = field(default_factory=list)


class JobQueue:
    """동시 워커 풀. 워커가 여럿이면 배치(한 번에 N장 = create N회)나 서로 다른
    생성 요청이 병렬로 CLI(--wait) 를 호출해 Higgsfield 에 같이 올라간다.
    create_job 은 asyncio 서브프로세스라 진짜 동시 실행된다(이벤트 루프 블록 없음).
    """

    def __init__(self, concurrency: int = 4) -> None:
        self._queue: asyncio.Queue[GenJob] = asyncio.Queue()
        self._workers: list[asyncio.Task] = []
        self._concurrency = max(1, concurrency)

    def start(self) -> None:
        # 죽었거나 아직 없는 워커만 (재)기동해 풀 크기를 채운다.
        self._workers = [w for w in self._workers if not w.done()]
        while len(self._workers) < self._concurrency:
            idx = len(self._workers)
            self._workers.append(
                asyncio.create_task(self._run(), name=f"job-queue-worker-{idx}")
            )

    async def stop(self) -> None:
        for w in self._workers:
            w.cancel()
        for w in self._workers:
            with contextlib.suppress(asyncio.CancelledError):
                await w
        self._workers = []

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
                err = str(e)  # CLIError 는 stderr(실제 사유)를 담는다
                repo.set_status(job.generation_id, "failed", err)
                await manager.broadcast(
                    {
                        "type": "progress",
                        "generation_id": job.generation_id,
                        "status": "failed",
                        "error": err,
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
            aid = repo.add_asset(
                job.generation_id, asset["type"], asset["file_path"], thumb
            )
            # 출처 영속화: 내가 만든 결과물은 즉시 로컬로 보관(원격 URL 은 source_url 보존)
            local = await media_cache.cache_url(asset["file_path"])
            if local:
                repo.update_asset_cache(
                    aid, local, local if asset["type"] == "image" else None,
                    asset["file_path"],
                )

        # 실제 Higgsfield 잡 id 기록 → 이후 동기화가 이 행을 중복 없이 갱신.
        gen = parsed.get("generation") or {}
        real_job_id = gen.get("id")
        if real_job_id:
            repo.set_job_id(job.generation_id, real_job_id)
        # 힉스필드 created_at/sort_ts 즉시 반영 → 동기화 전에 정확한 위치(순서) 확정.
        repo.set_generation_timestamp(job.generation_id, gen.get("created_at"), gen.get("sort_ts"))
        # 내 신원 학습 — 허브로 직접 만든 결과 URL 의 user_<id> 가 곧 '나'. 한 번만 영속화.
        repo.learn_my_creator_uid(gen.get("creator_uid"))

        status = parsed["generation"]["status"] or "done"
        # rc=0 인데 잡이 실패로 반환된 경우(NSFW 거부 등) — 사유를 저장.
        err = None
        if status == "failed":
            err = parsed["generation"].get("error") or (
                "힉스필드가 사유 없이 실패로 반환했습니다 — 보통 콘텐츠 정책 위반 또는 모델 내부 "
                "오류입니다. (힉스필드 API 가 실패 사유를 제공하지 않아 정확한 원인은 웹에서 확인 필요)"
            )
        repo.set_status(job.generation_id, status, err)
        await manager.broadcast(
            {
                "type": "progress",
                "generation_id": job.generation_id,
                "status": status,
                "result_url": asset["file_path"] if asset else None,
                "error": err,
            }
        )


# 앱 전역 단일 큐
queue = JobQueue()
