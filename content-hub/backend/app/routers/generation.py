"""생성·재활용 라우터 (Phase 3).

생성 요청을 받아 로컬 generation 레코드를 만들고 잡 큐에 등록한다.
실제 CLI 생성은 잡 큐 워커(services/jobs.py)에서 비동기로 수행되며,
진행률은 WebSocket(/ws)으로 push 된다.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import repo
from ..config import DEFAULT_WORKER_ID
from ..models import (
    ColorIn,
    GenerationCreate,
    GenerationOut,
    ModelOut,
    RegenerateIn,
    TagsIn,
)
from ..services import cli_bridge
from ..services.jobs import GenJob, queue

router = APIRouter(prefix="/api", tags=["generation"])

# @Image1 / @Video 슬롯 role → higgsfield create 미디어 플래그
_ROLE_TO_FLAG = {
    "@image": "--image",
    "@video": "--video",
    "@start": "--start-image",
    "@end": "--end-image",
    "@audio": "--audio",
}


def _media_flag(role: str) -> str:
    key = (role or "").lower()
    for prefix, flag in _ROLE_TO_FLAG.items():
        if key.startswith(prefix):
            return flag
    return "--image"


@router.get("/models", response_model=list[ModelOut])
async def list_models():
    """생성 모달용 모델 목록(CLI). 네트워크 호출이므로 명시적 엔드포인트."""
    try:
        return await cli_bridge.list_models()
    except cli_bridge.CLIError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/generations", response_model=GenerationOut, status_code=201)
async def create_generation(body: GenerationCreate):
    worker_id = body.worker_id or DEFAULT_WORKER_ID
    gen_id = repo.create_local_generation(body.model_dump(), worker_id)

    media = [(_media_flag(r.role), r.file_path) for r in body.references]
    await queue.enqueue(
        GenJob(
            generation_id=gen_id,
            model=body.model,
            prompt=body.prompt,
            params=body.params,
            media=media,
        )
    )
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=500, detail="생성 레코드 조회 실패")
    return gen


@router.post("/generations/{gen_id}/regenerate", response_model=GenerationOut, status_code=201)
async def regenerate(gen_id: str, body: RegenerateIn):
    """기존 generation 을 복제해 새 잡 생성 + lineage 기록(DESIGN.md §3-7)."""
    parent = repo.get_generation(gen_id)
    if not parent:
        raise HTTPException(status_code=404, detail="원본 generation 없음")

    worker_id = body.worker_id or parent["worker_id"] or DEFAULT_WORKER_ID
    child_id = repo.import_generation(gen_id, worker_id)  # 복제 + lineage

    # 재생성 시 프롬프트/모델/컬러를 선택적으로 덮어쓴다(없으면 부모 값 유지).
    if body.color is not None:
        repo.set_color(child_id, body.color)
    if body.prompt or body.model:
        repo.override_prompt_model(child_id, prompt=body.prompt, model=body.model)

    child = repo.get_generation(child_id)
    media = [
        (_media_flag(r.get("role") or ""), r["file_path"])
        for r in (child["references"] if child else [])
    ]
    await queue.enqueue(
        GenJob(
            generation_id=child_id,
            model=child["model"] if child else (body.model or parent["model"]),
            prompt=child["prompt"] if child else (body.prompt or parent["prompt"]),
            params=(child.get("params") if child else None) or {},
            media=media,
        )
    )
    return child


@router.put("/generations/{gen_id}/tags", response_model=GenerationOut)
def set_tags(gen_id: str, body: TagsIn):
    if not repo.get_generation(gen_id):
        raise HTTPException(status_code=404, detail="generation 없음")
    repo.set_tags(gen_id, body.tags)
    return repo.get_generation(gen_id)


@router.put("/generations/{gen_id}/color", response_model=GenerationOut)
def set_color(gen_id: str, body: ColorIn):
    if not repo.get_generation(gen_id):
        raise HTTPException(status_code=404, detail="generation 없음")
    repo.set_color(gen_id, body.color)
    return repo.get_generation(gen_id)
