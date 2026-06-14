"""라이브러리 조회 라우터 (Phase 2) — 로컬 탐색·필터.

CLAUDE.md 원칙 1: 내 작업물 탐색은 네트워크를 절대 타지 않는다(전부 로컬 DB).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from .. import repo
from ..models import FacetsOut, GenerationOut

router = APIRouter(prefix="/api", tags=["library"])


@router.get("/generations", response_model=list[GenerationOut])
def list_generations(
    tab: str = Query("my", pattern="^(my|team)$"),
    worker_id: Optional[str] = None,
    color: Optional[str] = None,
    tag: Optional[str] = None,
    share_dir: Optional[str] = Query(None, pattern="^(mine|received)$"),
    local_only: bool = False,
    creator_uid: Optional[str] = None,
    project_id: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(500, ge=1, le=2000),
    offset: int = Query(0, ge=0),
):
    return repo.list_generations(
        tab=tab,
        worker_id=worker_id,
        color=color,
        tag=tag,
        share_dir=share_dir,
        local_only=local_only,
        creator_uid=creator_uid,
        project_id=project_id,
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


# ── 자동 태그(별도 네임스페이스) — 필터 사이드바에서만 관리 ────────────────
class AutoTagIn(BaseModel):
    name: str


@router.get("/auto-tags")
def list_auto_tags():
    return {"auto_tags": repo.list_auto_tags()}


@router.post("/auto-tags")
def create_auto_tag(body: AutoTagIn):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="빈 이름")
    created = repo.create_auto_tag(name)
    if not created:
        raise HTTPException(status_code=409, detail=f"이미 있는 자동 태그: {name}")
    return {"ok": True, "name": name}


@router.delete("/auto-tags/{name}")
def delete_auto_tag(name: str):
    return {"removed": repo.delete_auto_tag(name)}
