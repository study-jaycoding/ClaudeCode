"""라이브러리 조회 라우터 (Phase 2) — 로컬 탐색·필터.

CLAUDE.md 원칙 1: 내 작업물 탐색은 네트워크를 절대 타지 않는다(전부 로컬 DB).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from .. import repo
from ..models import FacetsOut, GenerationOut

router = APIRouter(prefix="/api", tags=["library"])


@router.get("/generations", response_model=list[GenerationOut])
def list_generations(
    tab: str = Query("my", pattern="^(my|team)$"),
    worker_id: Optional[str] = None,
    color: Optional[str] = None,
    tag: Optional[str] = None,
    shared_only: bool = False,
    search: Optional[str] = None,
    limit: int = Query(500, ge=1, le=2000),
    offset: int = Query(0, ge=0),
):
    return repo.list_generations(
        tab=tab,
        worker_id=worker_id,
        color=color,
        tag=tag,
        shared_only=shared_only,
        search=search,
        limit=limit,
        offset=offset,
    )


@router.get("/generations/{gen_id}", response_model=GenerationOut)
def get_generation(gen_id: str):
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    return gen


@router.get("/facets", response_model=FacetsOut)
def facets():
    return repo.get_facets()
