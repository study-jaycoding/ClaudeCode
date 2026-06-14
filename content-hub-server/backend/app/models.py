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
    source_url: Optional[str] = None  # 원본 원격 URL(로컬 캐시 후에도 출처 보존)
    cached: bool = False  # file_path 가 로컬(/media)인지


class ReferenceOut(BaseModel):
    id: str
    type: MediaType
    file_path: str
    thumbnail_path: Optional[str] = None
    source: Optional[str] = None
    role: Optional[str] = None  # gen_reference.role (조회 맥락에 따라 채워짐)
    source_url: Optional[str] = None  # 원본 원격 URL
    cached: bool = False


class GenerationOut(BaseModel):
    id: str
    worker_id: str
    worker_name: Optional[str] = None
    prompt: str
    display_prompt: Optional[str] = None  # UI 표시용(칩 자리에 @소스명). 없으면 prompt
    model: Optional[str] = None
    params: Optional[dict[str, Any]] = None
    color: Optional[str] = None
    status: GenStatus
    created_at: str
    assets: list[AssetOut] = Field(default_factory=list)
    references: list[ReferenceOut] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    auto_tags: list[str] = Field(default_factory=list)  # 별도 네임스페이스(사이드바 필터 전용)
    shared: bool = False
    parent_gen_id: Optional[str] = None  # lineage 상 부모(있으면 재활용본)
    is_source: bool = False  # 소스 라이브러리 등록 여부(@ 참조 대상)
    source_name: Optional[str] = None  # @이름
    comment: Optional[str] = None  # 카드 코멘트(메모, 레거시 — UI 미사용)
    error: Optional[str] = None  # 실패 사유(status=failed 일 때)
    comment_count: int = 0  # 공유 코멘트 스레드 글 수
    has_unread: bool = False  # 미확인 코멘트 존재(뷰어 기준 — C 뱃지)
    local_only: bool = False  # 힉스필드에 없고 로컬에만 있음(흐림 처리 + '로컬 보기' 필터)
    creator_uid: Optional[str] = None  # 생성자 식별자(팀 워크스페이스)
    creator_name: Optional[str] = None  # 사용자 지정 이름(uid→이름)
    is_mine: bool = True  # 내 생성물인가(아니면 팀원)
    project_id: Optional[str] = None  # 귀속 프로젝트(작업 묶음). NULL=미분류


class FacetsOut(BaseModel):
    """좌측 필터 사이드바용 패싯(DESIGN.md §4)."""

    colors: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    auto_tags: list[str] = Field(default_factory=list)  # 자동 태그(별도 네임스페이스)
    workers: list[WorkerOut] = Field(default_factory=list)


class ModelOut(BaseModel):
    display_name: str
    job_set_type: str
    type: str  # 'image' | 'video' | 'text'


# ── 요청 모델 ────────────────────────────────────────────────────────────
class ReferenceIn(BaseModel):
    """생성 모달의 레퍼런스 슬롯(@Image/@Video)."""

    file_path: str  # 로컬 경로/업로드 UUID 또는 asset:proj|path 토큰
    type: MediaType = "image"
    role: str = "@Image1"
    name: Optional[str] = None  # 칩 표시 이름(@소스명) — 프롬프트 인라인 칩 복원/매칭용
    thumbnail: Optional[str] = None  # 표시용 썸네일 URL(에셋 소스 칩의 썸네일)
    source_url: Optional[str] = None  # 출처 URL(있으면 보존)


class GenerationCreate(BaseModel):
    prompt: str = Field(min_length=1)
    display_prompt: Optional[str] = None  # UI 표시용(칩 자리에 @소스명)
    model: str  # job_set_type, 예: 'nano_banana_2'
    params: dict[str, Any] = Field(default_factory=dict)
    color: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    auto_tags: list[str] = Field(default_factory=list)  # 무장된 자동 태그(별도 네임스페이스)
    references: list[ReferenceIn] = Field(default_factory=list)
    worker_id: Optional[str] = None  # 없으면 기본 작업자
    project_id: Optional[str] = None  # 생성 시 보던 프로젝트로 자동 귀속(없으면 미분류)


class RegenerateIn(BaseModel):
    """기존 generation 을 재활용해 새 잡 생성(프롬프트·레퍼런스 복제)."""

    prompt: Optional[str] = None  # 없으면 부모 프롬프트 그대로
    model: Optional[str] = None
    color: Optional[str] = None
    worker_id: Optional[str] = None
    auto_tags: Optional[list[str]] = None  # 재생성 시점 무장된 자동태그(부모 자동태그에 더해 적용)


class TagsIn(BaseModel):
    tags: list[str]


class ColorIn(BaseModel):
    color: Optional[str] = None


class SourceIn(BaseModel):
    """선택한 생성본을 소스 라이브러리에 등록(@이름)."""

    name: Optional[str] = None  # @이름. is_source=False 면 무시
    is_source: bool = True


class CommentIn(BaseModel):
    comment: Optional[str] = None  # 빈 문자열/None 이면 코멘트 제거


class PublishIn(BaseModel):
    visibility: str = "team"
    shared_by: Optional[str] = None  # 없으면 기본 작업자


class ImportIn(BaseModel):
    """팀 공유 항목을 내 워크스페이스로 가져오기(로컬 복제 + lineage)."""

    worker_id: Optional[str] = None


# ── 프로젝트(작업 묶음) ───────────────────────────────────────────────────
class ProjectOut(BaseModel):
    id: str
    name: str
    kind: str = "team"  # 'team' | 'personal'
    created_by: Optional[str] = None
    created_at: str
    archived: bool = False
    count: int = 0  # 귀속된 결과물 수


class ProjectsOut(BaseModel):
    projects: list[ProjectOut] = Field(default_factory=list)
    unassigned: int = 0  # 미분류(project_id IS NULL) 결과물 수


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1)
    kind: str = "team"


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    archived: Optional[bool] = None


class AssignProjectIn(BaseModel):
    """결과물들을 프로젝트에 귀속(또는 project_id=None 으로 미분류 해제)."""

    generation_ids: list[str] = Field(default_factory=list)
    project_id: Optional[str] = None


# ── 멤버 등급(C0~C5) — 로드맵 §4-3 ────────────────────────────────────────
class MemberOut(BaseModel):
    uid: str
    name: Optional[str] = None
    role: str = "C2"  # 효과적 등급(미지정이면 나=C0, 그 외=C2)
    is_mine: bool = False
    count: int = 0  # 생성물 수
    email: Optional[str] = None  # '나'(제공자)만 채워짐


class RoleIn(BaseModel):
    role: Optional[str] = None  # 'C0'~'C5' 또는 None(미지정)
