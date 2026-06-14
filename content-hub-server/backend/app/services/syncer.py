"""힉스필드 주기 동기화 (실시간성).

`generate list --json` 은 무료 읽기이므로 백그라운드에서 주기적으로 끌어와
다른 기기·웹·MCP 로 만들어진 잡(생성/결과물/실패)을 자동 반영한다. 변동이 있으면
WS 로 push 해 프론트가 즉시 새로고침하게 한다.

※ CLAUDE.md 의 '자동 동기화 금지' 원칙은 사용자의 실시간 요구로 이 기능에 한해 갱신됨.
   비용 호출(generate create)은 여전히 사용자 명시 동작에서만 일어난다.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from typing import Optional

from .. import repo
from ..config import DEFAULT_WORKER_ID
from ..ws import manager
from . import cli_bridge

# 주기(초). 0 이하이면 비활성. generate list 는 무료지만 과도한 호출 방지로 기본 20초.
SYNC_INTERVAL = float(os.environ.get("CONTENT_HUB_SYNC_INTERVAL", "20"))

# 갭 경보 워터마크: 한 번의 동기화에서 신규(inserted)가 이 수 이상이면 100-window 밖으로
# 못 본 잡이 밀려났을 수 있다는 신호(CLI 는 최신 100개·페이지네이션 불가).
# 받는 즉시 더 끌어올 방법은 없으므로 경보만 남기고, 사용자가 web/타 소스 export 로 보완.
SYNC_WATERMARK = int(os.environ.get("CONTENT_HUB_SYNC_WATERMARK", "85"))


async def sync_now(worker_id: Optional[str] = None) -> dict[str, int]:
    """CLI 에서 최근 생성 이력을 끌어와 업서트. 카운트 반환.
    신규가 워터마크 이상이면 gap_warning=1 을 함께 반환(누락 위험 알림)."""
    jobs = await cli_bridge.list_jobs()
    wid = worker_id or DEFAULT_WORKER_ID
    counts = {"inserted": 0, "updated": 0, "unchanged": 0}
    for parsed in jobs:
        counts[repo.upsert_synced_generation(parsed, wid)] += 1
    # 목록에 나타난 잡 = 힉스필드에 존재 → 흐림(hf_missing) 해제(재등장 항목 복구)
    repo.mark_present_by_job_ids(
        (p["generation"]["id"] for p in jobs if p.get("generation")),
    )
    counts["fetched"] = len(jobs)
    # 워터마크 초과 = 누락 위험. 100개를 꽉 채워 가져왔는데 대부분이 신규면 더 의심.
    counts["gap_warning"] = 1 if (
        counts["inserted"] >= SYNC_WATERMARK and len(jobs) >= 100
    ) else 0
    return counts


class PeriodicSync:
    def __init__(self, interval: float = SYNC_INTERVAL) -> None:
        self._interval = interval
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        if self._interval <= 0:
            return  # 비활성
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="periodic-sync")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            try:
                c = await sync_now()
                if c.get("gap_warning"):
                    print(
                        f"[periodic-sync] ⚠ 갭 경보: 신규 {c['inserted']}건 — "
                        f"100-window 밖으로 밀린 잡이 있을 수 있음. web/타 소스 export 로 보완 필요."
                    )
                    await manager.broadcast(
                        {"type": "gap_warning", "inserted": c["inserted"]}
                    )
                # 신규/상태변동이 있으면 프론트에 새로고침 신호.
                if c["inserted"] or c["updated"]:
                    await manager.broadcast({"type": "synced"})
            except asyncio.CancelledError:
                raise
            except cli_bridge.CLIError:
                # CLI 일시 불가(네트워크/로그아웃 등) — 조용히 다음 주기 재시도.
                pass
            except Exception as e:  # noqa: BLE001 — 워커가 죽지 않도록 격리
                print(f"[periodic-sync] 오류: {e}")


periodic_sync = PeriodicSync()
