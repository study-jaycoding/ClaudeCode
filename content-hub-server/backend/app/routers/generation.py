"""생성·재활용 라우터 (Phase 3).

생성 요청을 받아 로컬 generation 레코드를 만들고 잡 큐에 등록한다.
실제 CLI 생성은 잡 큐 워커(services/jobs.py)에서 비동기로 수행되며,
진행률은 WebSocket(/ws)으로 push 된다.
"""

from __future__ import annotations

import subprocess
import sys
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import repo
from ..config import DEFAULT_WORKER_ID, MEDIA_DIR
from ..models import (
    ColorIn,
    CommentIn,
    GenerationCreate,
    GenerationOut,
    ModelOut,
    RegenerateIn,
    SourceIn,
    TagsIn,
)
import asyncio

from ..services import cli_bridge, media_cache, syncer
from ..services.jobs import GenJob, queue
from .assets import _safe_project_dir, _safe_resolve

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


def _resolve_media_value(file_path: str) -> str:
    """에셋 파트 소스 토큰('asset:{project}|{path}')은 절대 로컬 경로로 resolve.
    CLI 가 로컬 경로를 자동 업로드하므로 그대로 넘기면 된다. 그 외(원격 URL/UUID/경로)는 통과."""
    if not file_path.startswith("asset:"):
        return file_path
    proj, _, rel = file_path[len("asset:"):].partition("|")
    pdir = _safe_project_dir(proj)
    target = _safe_resolve(pdir, rel) if pdir else None
    if not target or not target.is_file():
        raise HTTPException(status_code=400, detail=f"에셋 소스 파일 없음: {rel}")
    return str(target)


class RevealMediaIn(BaseModel):
    path: str  # /media/<file> 형태(로컬 보관된 결과물/소스)


@router.post("/reveal-media")
def reveal_media(body: RevealMediaIn):
    """로컬 보관된 결과물·소스(/media/...)의 원본 위치를 탐색기에서 열고 선택."""
    rel = body.path.split("?", 1)[0]
    if rel.startswith("/media/"):
        rel = rel[len("/media/"):]
    rel = rel.lstrip("/")
    if not rel:
        raise HTTPException(status_code=400, detail="로컬 보관 파일이 아닙니다(원격 URL)")
    target = _safe_resolve(MEDIA_DIR, rel)
    if not target or not target.exists():
        raise HTTPException(status_code=404, detail="로컬 파일 없음")
    try:
        if sys.platform == "win32":
            # explorer 는 성공해도 종료코드 1 을 반환하므로 검사하지 않음
            subprocess.Popen(["explorer", f"/select,{target}"])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target.parent)])
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"탐색기 열기 실패: {e}")
    return {"ok": True}


@router.get("/models", response_model=list[ModelOut])
async def list_models():
    """생성 모달용 모델 목록(CLI). 네트워크 호출이므로 명시적 엔드포인트."""
    try:
        return await cli_bridge.list_models()
    except cli_bridge.CLIError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/models/{job_set_type}/params")
async def model_params(job_set_type: str):
    """모델의 CLI 조절 가능 파라미터 스키마(동적 옵션 렌더용)."""
    try:
        return await cli_bridge.get_model_params(job_set_type)
    except cli_bridge.CLIError as e:
        raise HTTPException(status_code=502, detail=str(e))


class CostIn(BaseModel):
    model: str
    prompt: str = ""
    params: dict[str, Any] = {}


@router.get("/account")
async def account_status():
    """계정 상태(연결·크레딧·이메일) — 하단 상태줄 클릭 시 수동 조회."""
    return await cli_bridge.get_account_status()


@router.post("/import-jobs")
def import_jobs(jobs: list[dict[str, Any]]):
    """외부 JSON(다른 작업자의 generate list export)을 가져와 업서트.
    UUID 키로 중복 없이 병합 + result_url 의 user_<id> 로 생성자 자동 구분.
    팀 공유(각자 json export 교환) 모델의 핵심 입구."""
    counts = {"inserted": 0, "updated": 0, "unchanged": 0, "skipped": 0}
    for j in jobs:
        if not isinstance(j, dict) or not j.get("id"):
            counts["skipped"] += 1
            continue
        parsed = cli_bridge.parse_job(j)
        counts[repo.upsert_synced_generation(parsed, DEFAULT_WORKER_ID)] += 1
    return counts


@router.get("/export-bundle")
def export_bundle(creator_uid: str | None = None, mine: bool = False):
    """로컬 DB 를 '사실 + 오버레이' 번들로 내보낸다(팀 공유 입구, >100 제약 우회).
    mine=true 면 내 생성자(creator_uid) 것만. 받는 쪽은 /import-bundle 로 병합."""
    uid = creator_uid
    if mine and not uid:
        uid = repo.get_my_uid()
    return repo.export_bundle(creator_uid=uid)


@router.post("/import-bundle")
def import_bundle(bundle: dict[str, Any]):
    """content-hub 번들(사실 + 오버레이)을 가져와 병합.
    사실은 uuid 멱등 upsert, 태그 union, 코멘트 id dedup append, 레퍼런스 위치 보존."""
    if not isinstance(bundle.get("generations"), list):
        raise HTTPException(status_code=400, detail="번들 형식 오류: generations 배열 없음")
    # import_bundle_payload 로 위임 — provider/creators 이름 맵까지 적용(작성자가 user_xxx 아닌
    # 이름으로 뜨게). 파일 가져오기(import_share_file)와 동일 경로 → 표기 일관성 보장.
    return repo.import_bundle_payload(bundle, DEFAULT_WORKER_ID)


@router.get("/creators")
def list_creators():
    """생성자 목록(팀 워크스페이스 작성자) [{uid, name, count, is_mine}]."""
    return repo.list_creators()


class CreatorNameIn(BaseModel):
    name: str


@router.put("/creators/{uid}")
def rename_creator(uid: str, body: CreatorNameIn):
    """생성자 uid 에 이름 부여(CLI 가 uid→이름을 안 주므로 직접 라벨)."""
    repo.set_creator_name(uid, body.name)
    return {"ok": True}


@router.post("/creators/{uid}/claim")
def claim_creator(uid: str):
    """이 생성자 uid 를 '나'로 지정 — 이후 그 작성자의 작업이 내 작업(is_mine)으로 잡히고
    제공자 이름이 표시된다. 팀 워크스페이스 동기화 데이터만으론 내 작업을 못 가르므로 1회 지정."""
    return repo.set_my_creator(uid)


@router.get("/workspaces")
async def list_workspaces():
    """워크스페이스 목록(개인/팀). is_selected 로 현재 컨텍스트 표시."""
    return await cli_bridge.list_workspaces()


class WorkspaceSelectIn(BaseModel):
    workspace_id: str


@router.post("/workspaces/select")
async def select_workspace(body: WorkspaceSelectIn):
    """워크스페이스 선택(팀 공유 UUID 공간으로 전환) 후 재동기화.
    이후 generate list/get/create 가 해당 워크스페이스로 스코프된다."""
    await cli_bridge.set_workspace(body.workspace_id)
    counts = await syncer.sync_now()  # 새 컨텍스트의 잡을 즉시 반영
    return {"workspaces": await cli_bridge.list_workspaces(), "sync": counts}


@router.post("/workspaces/unselect")
async def unselect_workspace():
    """워크스페이스 해제 → 개인 계정 컨텍스트 복귀 후 재동기화."""
    await cli_bridge.unset_workspace()
    counts = await syncer.sync_now()
    return {"workspaces": await cli_bridge.list_workspaces(), "sync": counts}


@router.post("/cost")
async def estimate_cost(body: CostIn):
    """예상 크레딧 추정(잡 생성 안 함). Generate 버튼에 표시."""
    try:
        return await cli_bridge.estimate_cost(body.model, body.params, body.prompt)
    except cli_bridge.CLIError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/generations", response_model=GenerationOut, status_code=201)
async def create_generation(body: GenerationCreate):
    worker_id = body.worker_id or DEFAULT_WORKER_ID
    # 에셋 참조 해석(없는 파일이면 400)을 레코드 삽입보다 먼저 — 실패 시 큐에도 안 들어간
    # pending 카드가 고아로 남지 않게(검증→삽입 순서).
    media = [(_media_flag(r.role), _resolve_media_value(r.file_path)) for r in body.references]
    gen_id = repo.create_local_generation(body.model_dump(), worker_id)

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
    # 재생성 시점에 무장된 자동태그를 결과물에 적용(부모 자동태그에 더해짐).
    if body.auto_tags:
        repo.add_auto_tags(child_id, body.auto_tags)

    child = repo.get_generation(child_id)
    # 캐시된 레퍼런스는 file_path 가 /media 로컬 경로 → CLI 가 못 읽는다.
    # 원본 원격 URL(source_url)을 우선 사용(없으면 file_path/에셋 토큰).
    media = [
        (_media_flag(r.get("role") or ""), _resolve_media_value(r.get("source_url") or r["file_path"]))
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


@router.delete("/tags/{tag}")
def delete_tag(tag: str):
    """태그를 모든 generation 에서 전역 삭제(에셋 T 패널 ✕ 와 동일)."""
    return {"removed": repo.delete_tag_everywhere(tag)}


@router.post("/generations/clear-failed")
def clear_failed():
    """힉스필드에 안 올라간 로컬 유령 실패(failed + job_id 없음)만 일괄 삭제."""
    return {"removed": repo.delete_failed_orphans()}


@router.post("/generations/verify-higgsfield")
async def verify_higgsfield():
    """job_id 가진 모든 generation 을 generate get 으로 검증 → 힉스필드에서 삭제된 것
    (hf_missing=1) 표시. '로컬 보기'/흐림 처리에 반영. 무료 호출(생성 아님)."""
    gens = repo.gens_with_job_id()
    sem = asyncio.Semaphore(8)  # 동시 CLI 호출 제한

    async def check(gen_id: str, job_id: str):
        async with sem:
            exists = await cli_bridge.job_exists(job_id)
            return gen_id, exists  # True/False/None(확인불가)

    results = await asyncio.gather(*(check(g, j) for g, j in gens))
    missing = 0
    for gen_id, exists in results:
        if exists is None:
            continue  # 확인 불가 → 상태 변경 안 함
        repo.set_hf_missing(gen_id, not exists)
        if not exists:
            missing += 1
    return {"checked": len(gens), "missing": missing}


@router.delete("/generations/{gen_id}")
def delete_generation(gen_id: str):
    """generation 1건 삭제(자식 행 포함). 로컬 기록만 제거 — 힉스필드 원본엔 영향 없음."""
    return {"deleted": repo.delete_generation(gen_id)}


@router.put("/generations/{gen_id}/color", response_model=GenerationOut)
def set_color(gen_id: str, body: ColorIn):
    if not repo.get_generation(gen_id):
        raise HTTPException(status_code=404, detail="generation 없음")
    repo.set_color(gen_id, body.color)
    return repo.get_generation(gen_id)


@router.put("/generations/{gen_id}/source", response_model=GenerationOut)
def set_source(gen_id: str, body: SourceIn):
    """소스 라이브러리 등록/해제(@이름). 등록하면 @ 피커에 노출된다."""
    if not repo.get_generation(gen_id):
        raise HTTPException(status_code=404, detail="generation 없음")
    repo.set_source(gen_id, body.name, body.is_source)
    return repo.get_generation(gen_id)


@router.get("/sources", response_model=list[GenerationOut])
def list_sources(
    query: str | None = None,
    tag: str | None = None,
    asset_project: str | None = None,
    asset_dir: str | None = None,
):
    """스포트라이트 @/# 피커: 소스 등록된 생성본을 이름/태그로 검색.
    asset_project 가 오면 에셋 파트 소스(현재 폴더 asset_dir 로 스코프)도 함께 반환."""
    return repo.search_sources(
        query=query, tag=tag, asset_project=asset_project, asset_dir=asset_dir
    )


@router.put("/generations/{gen_id}/comment", response_model=GenerationOut)
def set_comment(gen_id: str, body: CommentIn):
    if not repo.get_generation(gen_id):
        raise HTTPException(status_code=404, detail="generation 없음")
    repo.set_comment(gen_id, body.comment)
    return repo.get_generation(gen_id)


# ── 생성본 코멘트 스레드(공유, 에셋과 별개) ───────────────────────────────
class GenCommentAddIn(BaseModel):
    text: str
    author: str | None = None
    parent_id: str | None = None
    muted: bool = False  # 작성 시점 '내 알림 끄기' 상태(코멘트별 캡처)


class GenCommentEditIn(BaseModel):
    text: str
    worker_id: str | None = None


class GenCommentReadIn(BaseModel):
    worker_id: str | None = None


@router.get("/generations/{gen_id}/comments")
def list_gen_comments(gen_id: str):
    """생성본 코멘트 스레드(작성자·시각 포함, 오래된→최신)."""
    return repo.list_generation_comments(gen_id)


@router.post("/generations/{gen_id}/comments")
def add_gen_comment(gen_id: str, body: GenCommentAddIn):
    if not repo.get_generation(gen_id):
        raise HTTPException(status_code=404, detail="generation 없음")
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="빈 코멘트")
    cid = repo.add_generation_comment(
        gen_id, body.author or DEFAULT_WORKER_ID, text, body.parent_id, body.muted
    )
    return {"id": cid}


@router.put("/generation-comments/{comment_id}")
def edit_gen_comment(comment_id: str, body: GenCommentEditIn):
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="빈 코멘트")
    try:
        repo.edit_generation_comment(comment_id, body.worker_id or DEFAULT_WORKER_ID, text)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"ok": True}


@router.delete("/generation-comments/{comment_id}")
def delete_gen_comment(comment_id: str, worker_id: str = DEFAULT_WORKER_ID):
    try:
        repo.delete_generation_comment(comment_id, worker_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return {"ok": True}


@router.post("/generations/{gen_id}/comments/read")
def read_gen_comments(gen_id: str, body: GenCommentReadIn):
    repo.mark_generation_comments_read(body.worker_id or DEFAULT_WORKER_ID, gen_id)
    return {"ok": True}


# ── 출처 영속화 (byte-cache): 소스·결과물을 로컬로 보관 ───────────────────
async def cache_generation_media(gen: dict) -> dict[str, int]:
    """한 generation 의 asset·reference 원격 URL 을 로컬로 내려받고 경로를 갱신.

    원본 URL 은 repo 헬퍼가 source_url 에 보존한다(출처 영속).
    동시 다운로드, 실패는 건너뛰고(원격 URL 유지) 카운트만 집계.
    """
    targets: list[tuple[str, str, str, bool]] = []  # (kind, id, url, is_image)
    for a in gen.get("assets", []):
        if not a["file_path"].startswith("/media/"):
            targets.append(("asset", a["id"], a["file_path"], a["type"] == "image"))
    for r in gen.get("references", []):
        if not r["file_path"].startswith("/media/"):
            targets.append(("ref", r["id"], r["file_path"], r["type"] == "image"))

    if not targets:
        return {"cached": 0, "failed": 0, "skipped": 0}

    results = await asyncio.gather(*(media_cache.cache_url(t[2]) for t in targets))

    cached = failed = 0
    for (kind, rid, url, is_image), local in zip(targets, results):
        if not local:
            failed += 1
            continue
        thumb = local if is_image else None
        if kind == "asset":
            repo.update_asset_cache(rid, local, thumb, url)
        else:
            repo.update_reference_cache(rid, local, thumb, url)
        cached += 1
    return {"cached": cached, "failed": failed, "skipped": 0}


@router.post("/generations/{gen_id}/cache")
async def cache_one(gen_id: str):
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    res = await cache_generation_media(gen)
    res["generation"] = repo.get_generation(gen_id)
    return res


@router.post("/cache-all")
async def cache_all():
    """모든 generation 의 소스·결과물을 로컬로 보관(미보관분만). 출처 영속화 일괄.
    gen 단위로 병렬 처리(동시성 캡)해 일괄 보관 속도를 높인다 — 각 gen 내부 미디어도 gather."""
    total = {"cached": 0, "failed": 0, "generations": 0}
    sem = asyncio.Semaphore(6)  # 동시 다운로드 상한(서버 과부하·레이트리밋 방지)

    async def _one(gid: str) -> dict[str, int] | None:
        async with sem:
            gen = repo.get_generation(gid)
            if not gen:
                return None
            return await cache_generation_media(gen)

    for r in await asyncio.gather(*(_one(g) for g in repo.all_generation_ids())):
        if not r:
            continue
        total["cached"] += r["cached"]
        total["failed"] += r["failed"]
        if r["cached"]:
            total["generations"] += 1
    return total
