"""Pydantic 모델 — API 요청/응답 스키마 (Phase 2).

API 응답은 snake_case JSON (CLAUDE.md 컨벤션).
DB row(sqlite3.Row) → 응답 모델 변환은 라우터의 직렬화 헬퍼에서 처리한다.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

# ── 공통 타입 ────────────────────────────────────────────────────────────
MediaType = Literal["image", "video"]
GenStatus = Literal["pending", "running", "done", "failed"]
AccountType = Literal["personal", "team"]


# ── 응답 모델 ────────────────────────────────────────────────────────────
class WorkerOut(BaseModel):
    id: str
    name: str
    account_type: AccountType = "personal"


class AssetOut(BaseModel):
    id: str
    generation_id: str
    type: MediaType
    file_path: str
    thumbnail_path: Optional[str] = None


class ReferenceOut(BaseModel):
    id: str
    type: MediaType
    file_path: str
    thumbnail_path: Optional[str] = None
    source: Optional[str] = None
    role: Optional[str] = None  # gen_reference.role (조회 맥락에 따라 채워짐)


class GenerationOut(BaseModel):
    id: str
    worker_id: str
    worker_name: Optional[str] = None
    prompt: str
    model: Optional[str] = None
    params: Optional[dict[str, Any]] = None
    color: Optional[str] = None
    status: GenStatus
    created_at: str
    assets: list[AssetOut] = Field(default_factory=list)
    references: list[ReferenceOut] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    shared: bool = False
    parent_gen_id: Optional[str] = None  # lineage 상 부모(있으면 재활용본)


class FacetsOut(BaseModel):
    """좌측 필터 사이드바용 패싯(DESIGN.md §4)."""

    colors: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    workers: list[WorkerOut] = Field(default_factory=list)


class ModelOut(BaseModel):
    display_name: str
    job_set_type: str
    type: str  # 'image' | 'video' | 'text'


# ── 요청 모델 ────────────────────────────────────────────────────────────
class ReferenceIn(BaseModel):
    """생성 모달의 레퍼런스 슬롯(@Image/@Video)."""

    file_path: str  # 로컬 경로 또는 업로드/잡 UUID
    type: MediaType = "image"
    role: str = "@Image1"


class GenerationCreate(BaseModel):
    prompt: str = Field(min_length=1)
    model: str  # job_set_type, 예: 'nano_banana_2'
    params: dict[str, Any] = Field(default_factory=dict)
    color: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    references: list[ReferenceIn] = Field(default_factory=list)
    worker_id: Optional[str] = None  # 없으면 기본 작업자


class RegenerateIn(BaseModel):
    """기존 generation 을 재활용해 새 잡 생성(프롬프트·레퍼런스 복제)."""

    prompt: Optional[str] = None  # 없으면 부모 프롬프트 그대로
    model: Optional[str] = None
    color: Optional[str] = None
    worker_id: Optional[str] = None


class TagsIn(BaseModel):
    tags: list[str]


class ColorIn(BaseModel):
    color: Optional[str] = None


class PublishIn(BaseModel):
    visibility: str = "team"
    shared_by: Optional[str] = None  # 없으면 기본 작업자


class ImportIn(BaseModel):
    """팀 공유 항목을 내 워크스페이스로 가져오기(로컬 복제 + lineage)."""

    worker_id: Optional[str] = None
