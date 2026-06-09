"""동기화 라우터 (Phase 2/3 보조).

`higgsfield generate list --json` 을 끌어와 로컬 DB 에 업서트한다.
이걸로 라이브러리가 실제 생성 이력으로 채워진다.

CLAUDE.md 원칙 2(자동 동기화 금지)에 따라 **사용자가 명시적으로 호출**할 때만
동작한다. 시작 시 자동 실행하지 않는다. job id 를 PK 로 써서 재동기는 멱등.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import repo
from ..config import DEFAULT_WORKER_ID
from ..services import cli_bridge

router = APIRouter(prefix="/api", tags=["sync"])


class SyncResult(BaseModel):
    fetched: int
    inserted: int
    updated: int


@router.post("/sync", response_model=SyncResult)
async def sync_from_cli(worker_id: str | None = None):
    """CLI 에서 최근 생성 이력을 가져와 로컬 DB 업서트."""
    try:
        jobs = await cli_bridge.list_jobs()
    except cli_bridge.CLIError as e:
        raise HTTPException(status_code=502, detail=f"CLI 동기화 실패: {e}")

    wid = worker_id or DEFAULT_WORKER_ID
    inserted = 0
    for parsed in jobs:
        if repo.upsert_synced_generation(parsed, wid):
            inserted += 1
    return SyncResult(
        fetched=len(jobs), inserted=inserted, updated=len(jobs) - inserted
    )
