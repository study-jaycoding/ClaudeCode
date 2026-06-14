"""Assets(구성) 라우터 — project-viewer 의 '구성 탭'(폴더 트리 브라우저) 포팅.

ASSETS_ROOT(= PV PROJECTS_DIR) 아래의 프로젝트 폴더를 트리로 보여주고 파일을 서빙한다.
프로젝트 = 루트 아래 한 폴더. 기본 테스트 폴더는 config.DEFAULT_PROJECT.

경로 보안: 모든 접근은 ASSETS_ROOT/<project> 안으로 제한(traversal 차단) — PV 의
safe_project_dir / safe_resolve 가드를 그대로 따른다.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from PIL import Image
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .. import repo
from ..config import ASSETS_ROOT, DEFAULT_PROJECT, DEFAULT_WORKER_ID, MEDIA_DIR

_THUMB_DIR = MEDIA_DIR / ".thumbs"  # 썸네일 디스크 캐시

router = APIRouter(prefix="/api/assets", tags=["assets"])

_IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
_VIDEO_EXT = (".mp4", ".mov", ".webm", ".mkv", ".avi")
_AUDIO_EXT = (".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac")


def _media_type(name: str) -> Optional[str]:
    low = name.lower()
    if low.endswith(_IMAGE_EXT):
        return "image"
    if low.endswith(_VIDEO_EXT):
        return "video"
    if low.endswith(_AUDIO_EXT):
        return "audio"
    return None


def _safe_project_dir(project: str) -> Optional[Path]:
    cand = (ASSETS_ROOT / project).resolve()
    try:
        cand.relative_to(ASSETS_ROOT)
    except ValueError:
        return None
    return cand if cand.is_dir() else None


def _safe_resolve(project_dir: Path, rel: str) -> Optional[Path]:
    cand = (project_dir / rel).resolve()
    try:
        cand.relative_to(project_dir)
    except ValueError:
        return None
    return cand


def _hidden(name: str) -> bool:
    # 시스템/ledger 파일·placeholder 숨김 (PV 와 동일한 취지)
    return name.startswith((".", "_")) or name.lower() == "readme.md"


def _build_tree(directory: Path, rel_prefix: str) -> list[dict[str, Any]]:
    """디렉터리를 재귀 순회 — 폴더 우선, 미디어 파일만 포함."""
    try:
        entries = sorted(
            directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())
        )
    except (PermissionError, OSError):
        return []

    out: list[dict[str, Any]] = []
    for entry in entries:
        if _hidden(entry.name):
            continue
        rel = f"{rel_prefix}{entry.name}"
        if entry.is_dir():
            out.append(
                {
                    "name": entry.name,
                    "type": "dir",
                    "path": rel,
                    "children": _build_tree(entry, rel + "/"),
                }
            )
        else:
            mt = _media_type(entry.name)
            if mt:
                out.append({"name": entry.name, "type": mt, "path": rel})
    return out


class ProjectsOut(BaseModel):
    projects: list[str]
    default: str
    root: str


@router.get("/projects", response_model=ProjectsOut)
def list_projects():
    """ASSETS_ROOT 아래 프로젝트(폴더) 목록 + 기본 테스트 프로젝트."""
    projects: list[str] = []
    if ASSETS_ROOT.exists():
        projects = sorted(
            (p.name for p in ASSETS_ROOT.iterdir() if p.is_dir() and not _hidden(p.name)),
            key=str.lower,
        )
    # 기본 프로젝트가 존재하면 그것, 아니면 첫 프로젝트
    default = DEFAULT_PROJECT if DEFAULT_PROJECT in projects else (projects[0] if projects else "")
    return ProjectsOut(projects=projects, default=default, root=str(ASSETS_ROOT))


@router.get("/tree")
def project_tree(project: str = Query(...)):
    """프로젝트 폴더 트리(폴더 + 미디어 파일)."""
    proj_dir = _safe_project_dir(project)
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    return {
        "project": project,
        "name": proj_dir.name,
        "children": _build_tree(proj_dir, ""),
    }


# ── 파일별 메타데이터(소스/태그/코멘트/컬러) ─────────────────────────────
class AssetSourceIn(BaseModel):
    project: str
    path: str
    name: Optional[str] = None
    is_source: bool = True


class AssetTagsIn(BaseModel):
    project: str
    path: str
    tags: list[str] = []


class AssetCommentIn(BaseModel):
    project: str
    path: str
    comment: Optional[str] = None


class AssetColorIn(BaseModel):
    project: str
    path: str
    color: Optional[str] = None


def _require_project(project: str) -> None:
    if not _safe_project_dir(project):
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")


@router.get("/meta")
def asset_meta(
    project: str = Query(...),
    worker_id: str = Query(DEFAULT_WORKER_ID),
):
    """파일별 메타(+ comment_count·has_unread). 미확인은 코멘트별 muted 플래그를 따른다."""
    _require_project(project)
    return repo.get_asset_meta(project, worker_id)


class CommentAddIn(BaseModel):
    project: str
    path: str
    text: str
    author: Optional[str] = None
    parent_id: Optional[str] = None
    muted: bool = False  # 작성 시점 '내 알림 끄기' 상태(코멘트별 캡처)


class CommentEditIn(BaseModel):
    text: str
    worker_id: Optional[str] = None


class CommentReadIn(BaseModel):
    project: str
    path: str
    worker_id: Optional[str] = None


@router.get("/comments")
def list_comments(project: str = Query(...), path: str = Query(...)):
    """파일 코멘트 스레드(작성자·시각 포함, 오래된→최신)."""
    _require_project(project)
    return repo.list_asset_comments(project, path)


@router.post("/comments")
def add_comment(body: CommentAddIn):
    _require_project(body.project)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="빈 코멘트")
    cid = repo.add_asset_comment(
        body.project,
        body.path,
        body.author or DEFAULT_WORKER_ID,
        text,
        body.parent_id,
        body.muted,
    )
    return {"id": cid}


@router.put("/comments/{comment_id}")
def edit_comment(comment_id: str, body: CommentEditIn):
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="빈 코멘트")
    try:
        repo.edit_asset_comment(comment_id, body.worker_id or DEFAULT_WORKER_ID, text)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"ok": True}


@router.delete("/comments/{comment_id}")
def delete_comment(comment_id: str, worker_id: str = Query(DEFAULT_WORKER_ID)):
    try:
        repo.delete_asset_comment(comment_id, worker_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return {"ok": True}


@router.post("/comments/read")
def read_comments(body: CommentReadIn):
    repo.mark_asset_comments_read(body.worker_id or DEFAULT_WORKER_ID, body.project, body.path)
    return {"ok": True}


@router.put("/source")
def asset_set_source(body: AssetSourceIn):
    _require_project(body.project)
    repo.set_asset_source(body.project, body.path, body.name, body.is_source)
    return {"ok": True}


@router.put("/tags")
def asset_set_tags(body: AssetTagsIn):
    _require_project(body.project)
    repo.set_asset_tags(body.project, body.path, body.tags)
    return {"ok": True}


@router.put("/comment")
def asset_set_comment(body: AssetCommentIn):
    _require_project(body.project)
    repo.set_asset_comment(body.project, body.path, body.comment)
    return {"ok": True}


@router.put("/color")
def asset_set_color(body: AssetColorIn):
    _require_project(body.project)
    repo.set_asset_color(body.project, body.path, body.color)
    return {"ok": True}


@router.get("/file")
def get_file(project: str = Query(...), path: str = Query(...)):
    """프로젝트 내 파일 서빙(경로 보안)."""
    proj_dir = _safe_project_dir(project)
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    target = _safe_resolve(proj_dir, path)
    if not target or not target.is_file():
        raise HTTPException(status_code=404, detail="파일 없음")
    return FileResponse(target)


@router.get("/thumb")
def get_thumb(
    project: str = Query(...),
    path: str = Query(...),
    w: int = Query(512, ge=64, le=1024),
):
    """이미지 썸네일(리사이즈+디스크 캐시) — 그리드/리스트 스크롤 성능용.
    원본 풀해상도(수 MP) 대신 작은 이미지를 디코딩하게 해 렉을 없앤다."""
    proj_dir = _safe_project_dir(project)
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    target = _safe_resolve(proj_dir, path)
    if not target or not target.is_file():
        raise HTTPException(status_code=404, detail="파일 없음")
    if _media_type(target.name) != "image":
        raise HTTPException(status_code=415, detail="썸네일은 이미지만 지원")

    mtime = int(target.stat().st_mtime)
    key = hashlib.sha1(f"{target}|{mtime}|{w}".encode("utf-8")).hexdigest()
    _THUMB_DIR.mkdir(parents=True, exist_ok=True)
    cache = _THUMB_DIR / f"{key}.jpg"
    if not cache.exists():
        try:
            with Image.open(target) as im:
                im = im.convert("RGB")  # JPEG: 알파 제거(어두운 카드 배경이라 무방)
                im.thumbnail((w, w), Image.LANCZOS)
                im.save(cache, "JPEG", quality=82)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"썸네일 생성 실패: {e}")
    return FileResponse(cache, media_type="image/jpeg")


@router.post("/upload")
async def upload_assets(
    project: str = Form(...),
    dir: str = Form(""),
    files: list[UploadFile] = File(...),
):
    """외부 파일을 현재 폴더(dir, 비면 프로젝트 루트)로 가져오기(드롭 업로드).
    파일명은 basename 만 사용(경로 traversal 차단), 미디어가 아닌 파일은 제외,
    이름 충돌은 _2, _3… 으로 회피(덮어쓰기 안 함)."""
    proj_dir = _safe_project_dir(project)
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    dest = _safe_resolve(proj_dir, dir) if dir else proj_dir
    if not dest or not dest.is_dir():
        raise HTTPException(status_code=400, detail="대상 폴더 없음")

    saved: list[str] = []
    skipped: list[str] = []
    for up in files:
        raw = os.path.basename((up.filename or "").replace("\\", "/"))
        if not raw:
            continue
        if _media_type(raw) is None:  # 미디어(이미지/영상/오디오)만 — 그 외는 제외
            skipped.append(raw)
            continue
        target = _safe_resolve(dest, raw)
        if not target:
            skipped.append(raw)
            continue
        if target.exists():  # 덮어쓰기 방지
            stem, ext, i = target.stem, target.suffix, 2
            while True:
                cand = dest / f"{stem}_{i}{ext}"
                if not cand.exists():
                    target = cand
                    break
                i += 1
        try:
            target.write_bytes(await up.read())
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"저장 실패({raw}): {e}")
        saved.append(target.relative_to(proj_dir).as_posix())

    return {"saved": saved, "skipped": skipped}


@router.get("/zip")
def export_zip(project: str = Query(...), paths: list[str] = Query(default=[])):
    """선택한 여러 파일을 zip 으로 묶어 스트리밍(OS 드래그 다중 내보내기용).
    네이티브 DownloadURL 드래그는 1건만 지원하므로, 다중선택은 이 zip 한 건으로 내보낸다.
    zip 내부는 파일명만으로 평탄화하고 동일 이름은 _2, _3… 으로 회피한다."""
    proj_dir = _safe_project_dir(project)
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    if not paths:
        raise HTTPException(status_code=400, detail="내보낼 파일이 없음")

    tmp = tempfile.NamedTemporaryFile(prefix="ch-export-", suffix=".zip", delete=False)
    tmp_path = tmp.name
    tmp.close()
    used: set[str] = set()
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for rel in paths:
                target = _safe_resolve(proj_dir, rel)
                if not target or not target.is_file():
                    continue
                arc = target.name  # 폴더 구조 평탄화 — 파일명만
                if arc in used:  # 이름 충돌 회피
                    stem, dot, ext = arc.rpartition(".")
                    i = 2
                    while True:
                        cand = f"{stem}_{i}.{ext}" if dot else f"{arc}_{i}"
                        if cand not in used:
                            arc = cand
                            break
                        i += 1
                used.add(arc)
                zf.write(target, arcname=arc)
    except Exception as e:  # noqa: BLE001
        os.unlink(tmp_path)
        raise HTTPException(status_code=500, detail=f"zip 생성 실패: {e}")

    if not used:
        os.unlink(tmp_path)
        raise HTTPException(status_code=404, detail="유효한 파일이 없음")

    return FileResponse(
        tmp_path,
        media_type="application/zip",
        filename=f"assets-{len(used)}.zip",
        background=BackgroundTask(os.unlink, tmp_path),  # 전송 후 임시 zip 삭제
    )


class RevealIn(BaseModel):
    project: str
    path: str


@router.post("/reveal")
def reveal_file(body: RevealIn):
    """OS 파일 탐색기에서 원본 위치를 열고 해당 파일을 선택(로컬 전용)."""
    proj_dir = _safe_project_dir(body.project)
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {body.project}")
    target = _safe_resolve(proj_dir, body.path)
    if not target or not target.exists():
        raise HTTPException(status_code=404, detail="파일 없음")
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
