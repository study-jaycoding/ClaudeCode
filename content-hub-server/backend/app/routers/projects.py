"""프로젝트(작업 묶음) 라우터 — 로드맵 §0-4/§4-4.

프로젝트는 공유·이동의 단위. 생성·목록·이름변경·보관·삭제 + 결과물 귀속(assign).
로그인·등급 도입 전이므로 권한 검증은 아직 없다(식별 먼저, 차단은 나중).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import repo
from ..models import (
    AssignProjectIn,
    ProjectCreate,
    ProjectOut,
    ProjectsOut,
    ProjectUpdate,
)

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("", response_model=ProjectsOut)
def list_projects(include_archived: bool = False):
    return repo.list_projects(include_archived=include_archived)


@router.post("", response_model=ProjectOut)
def create_project(body: ProjectCreate):
    try:
        return repo.create_project(body.name, kind=body.kind)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/{pid}", response_model=ProjectOut)
def update_project(pid: str, body: ProjectUpdate):
    if not repo.get_project(pid):
        raise HTTPException(status_code=404, detail="없는 프로젝트")
    try:
        if body.name is not None:
            repo.rename_project(pid, body.name)
        if body.archived is not None:
            repo.set_archived(pid, body.archived)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return repo.get_project(pid)


@router.delete("/{pid}")
def delete_project(pid: str):
    """프로젝트 삭제 — 귀속 결과물은 미분류로 되돌리고 프로젝트만 제거."""
    removed = repo.delete_project(pid)
    if not removed:
        raise HTTPException(status_code=404, detail="없는 프로젝트")
    return {"ok": True}


@router.post("/assign")
def assign_project(body: AssignProjectIn):
    """결과물들을 프로젝트에 귀속(project_id=None 이면 미분류로 해제)."""
    try:
        n = repo.assign_to_project(body.generation_ids, body.project_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "updated": n}
