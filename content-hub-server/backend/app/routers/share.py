"""공유·가져오기 라우터 (Phase 5, 로컬 구현).

⚠️ 스코프: 원격 공유 서버(PostgreSQL + MinIO)는 의도적으로 보류했다.
publish/import + lineage 를 로컬 단일 SQLite 에 구현해 전체 루프
(발행 → 팀 공유 탭 → 가져오기 → lineage)가 로컬에서 동작하게 한다.
원격 서버 연동은 이 라우터의 구현만 교체하면 되도록 repo 계층 뒤에 격리돼 있다.

CLAUDE.md 원칙 2(명시적 발행만), 3(원본 보존), 4(lineage 기록).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import repo
from ..config import DEFAULT_WORKER_ID
from ..models import GenerationOut, ImportIn, PublishIn

router = APIRouter(prefix="/api", tags=["share"])


@router.post("/generations/{gen_id}/publish", response_model=GenerationOut)
def publish(gen_id: str, body: PublishIn):
    """generation 을 팀에 발행한다(명시적). 한 generation 은 0~1개의 share.
    발행 = share-set 에 추가 → 내 share 파일을 즉시 재생성(추가 시 동기화)."""
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    if gen["status"] != "done":
        raise HTTPException(status_code=409, detail="완료된 생성만 발행할 수 있음")
    shared_by = body.shared_by or gen["worker_id"] or DEFAULT_WORKER_ID
    repo.publish(gen_id, shared_by, body.visibility)
    repo.write_my_share_file()  # share-set 변화 → 파일 갱신(재push 원본)
    return repo.get_generation(gen_id)


@router.post("/generations/{gen_id}/unpublish", response_model=GenerationOut)
def unpublish(gen_id: str):
    """팀 공유 해제 — share 행을 제거한다(내가 공유한 것을 되돌림).
    제거 = share-set 에서 빼기 → 내 share 파일 재생성(0건이면 파일 삭제)."""
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    repo.unpublish(gen_id)
    repo.write_my_share_file()  # share-set 변화 → 파일 갱신
    return repo.get_generation(gen_id)


# ── 제공자 신원 ───────────────────────────────────────────────────────────
class ProviderNameIn(BaseModel):
    name: str


@router.get("/provider")
def get_provider() -> dict[str, Any]:
    """내 제공자 신원 {uid, name, email}. 공유 파일명·작성자 표기의 기준."""
    return repo.get_provider()


@router.patch("/provider")
def set_provider_name(body: ProviderNameIn) -> dict[str, Any]:
    """제공자 표시이름 변경 → 이후 모든 공유 파일명·작성자 표기에 반영(uid 앵커는 불변).
    이름이 바뀌면 기존 share 파일명도 새 이름으로 다시 쓴다(옛 파일 정리)."""
    old = repo.my_share_path()
    prov = repo.set_provider_name(body.name)
    new = repo.my_share_path()
    if old != new and old.exists():
        old.unlink()  # 옛 이름 파일 제거(중복 방지)
    repo.write_my_share_file()  # 새 이름으로 재생성
    return prov


# ── 팀 공유 파일(data/shared) ─────────────────────────────────────────────
@router.post("/share/rebuild")
def rebuild_share_file() -> dict[str, Any]:
    """내 share 파일을 현재 share-set 으로 강제 재생성(수동 보정용)."""
    return repo.write_my_share_file()


@router.get("/share/received")
def received_shares() -> dict[str, Any]:
    """shared 폴더에서 받은(남의) share 파일 요약 목록 — in 뷰."""
    return {"items": repo.list_received_shares()}


class ImportFileIn(BaseModel):
    filename: str


@router.post("/share/received/import")
def import_received(body: ImportFileIn) -> dict[str, int]:
    """받은 share 파일 1개를 내 라이브러리로 병합(받기)."""
    return repo.import_share_file(body.filename)


@router.post("/share/received/import-all")
def import_received_all() -> dict[str, int]:
    """shared 폴더의 받은 share 파일 전부를 병합(일괄 받기)."""
    total = {"inserted": 0, "updated": 0, "unchanged": 0, "skipped": 0}
    for it in repo.list_received_shares():
        c = repo.import_share_file(it["filename"])
        for k in total:
            total[k] += c.get(k, 0)
    return total


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
