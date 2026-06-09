"""공유·가져오기 라우터 (Phase 5, 로컬 구현).

⚠️ 스코프: 원격 공유 서버(PostgreSQL + MinIO)는 의도적으로 보류했다.
publish/import + lineage 를 로컬 단일 SQLite 에 구현해 전체 루프
(발행 → 팀 공유 탭 → 가져오기 → lineage)가 로컬에서 동작하게 한다.
원격 서버 연동은 이 라우터의 구현만 교체하면 되도록 repo 계층 뒤에 격리돼 있다.

CLAUDE.md 원칙 2(명시적 발행만), 3(원본 보존), 4(lineage 기록).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import repo
from ..config import DEFAULT_WORKER_ID
from ..models import GenerationOut, ImportIn, PublishIn

router = APIRouter(prefix="/api", tags=["share"])


@router.post("/generations/{gen_id}/publish", response_model=GenerationOut)
def publish(gen_id: str, body: PublishIn):
    """generation 을 팀에 발행한다(명시적). 한 generation 은 0~1개의 share."""
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    if gen["status"] != "done":
        raise HTTPException(status_code=409, detail="완료된 생성만 발행할 수 있음")
    shared_by = body.shared_by or gen["worker_id"] or DEFAULT_WORKER_ID
    repo.publish(gen_id, shared_by, body.visibility)
    return repo.get_generation(gen_id)


@router.post("/generations/{gen_id}/import", response_model=GenerationOut, status_code=201)
def import_to_workspace(gen_id: str, body: ImportIn):
    """공유 항목을 내 워크스페이스로 복제(프롬프트·레퍼런스 보존) + lineage."""
    src = repo.get_generation(gen_id)
    if not src:
        raise HTTPException(status_code=404, detail="원본 generation 없음")
    if not src["shared"]:
        raise HTTPException(status_code=409, detail="공유되지 않은 항목은 가져올 수 없음")
    worker_id = body.worker_id or DEFAULT_WORKER_ID
    child_id = repo.import_generation(gen_id, worker_id)
    child = repo.get_generation(child_id)
    if not child:
        raise HTTPException(status_code=500, detail="복제 실패")
    return child
