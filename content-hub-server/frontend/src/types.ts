// 백엔드 API 응답 타입 (backend/app/models.py 와 1:1)

export type MediaType = "image" | "video";
export type GenStatus = "pending" | "running" | "done" | "failed";

export interface Asset {
  id: string;
  generation_id: string;
  type: MediaType;
  file_path: string;
  thumbnail_path: string | null;
  source_url: string | null;
  cached: boolean;
}

export interface Reference {
  id: string;
  type: MediaType;
  file_path: string;
  thumbnail_path: string | null;
  source: string | null;
  role: string | null;
  source_url: string | null;
  cached: boolean;
}

export interface Generation {
  id: string;
  worker_id: string;
  worker_name: string | null;
  prompt: string;
  display_prompt: string | null; // UI 표시용(칩 자리에 @소스명). 없으면 prompt
  model: string | null;
  params: Record<string, unknown> | null;
  color: string | null;
  status: GenStatus;
  created_at: string;
  assets: Asset[];
  references: Reference[];
  tags: string[];
  auto_tags: string[]; // 자동 태그(별도 네임스페이스 — 사이드바 필터 전용, 카드 미표시)
  shared: boolean;
  parent_gen_id: string | null;
  is_source: boolean; // 소스 라이브러리 등록 여부(@ 참조)
  source_name: string | null; // @이름
  comment: string | null; // 카드 코멘트(메모, 레거시 — UI 미사용)
  error: string | null; // 실패 사유(status=failed 일 때)
  comment_count: number; // 공유 코멘트 스레드 글 수
  has_unread: boolean; // 미확인 코멘트 존재(C 뱃지)
  local_only: boolean; // 힉스필드에 없고 로컬에만 있음(흐림 처리 + '로컬 보기' 필터)
  creator_uid: string | null; // 생성자 식별자(팀 워크스페이스)
  creator_name: string | null; // 사용자 지정 이름
  is_mine: boolean; // 내 생성물인가(아니면 팀원)
  project_id: string | null; // 귀속 프로젝트(작업 묶음). null=미분류
}

// 프로젝트(작업 묶음) — 공유·이동의 단위. Assets 패널의 폴더(ProjectsInfo)와 별개.
export interface Project {
  id: string;
  name: string;
  kind: string; // 'team' | 'personal'
  created_by: string | null;
  created_at: string;
  archived: boolean;
  count: number; // 귀속 결과물 수
}

export interface ProjectsResponse {
  projects: Project[];
  unassigned: number; // 미분류 결과물 수
}

// 멤버(=생성자) + 등급(C0~C5) — 관리자 창. 로드맵 §4-3.
export interface Member {
  uid: string;
  name: string | null;
  role: string; // 'C0'~'C5' (C0=관리자, C1=프로젝트관리자, C2~C5=피관리)
  is_mine: boolean;
  count: number; // 생성물 수
  email: string | null; // '나'(제공자)만
}

// 로그인 계정(보안) — 로드맵 §4-1/§4-2
export interface Account {
  email: string;
  name: string | null;
  status: string; // pending | approved | rejected
  role: string; // C0~C5
  creator_uid: string | null;
  created_at: string;
  approved_at: string | null;
}

export interface AuthConfig {
  auth_enabled: boolean;
  has_accounts: boolean;
}

export const ROLES = ["C0", "C1", "C2", "C3", "C4", "C5"] as const;
export const ROLE_LABEL: Record<string, string> = {
  C0: "C0 · 관리자",
  C1: "C1 · 프로젝트 관리자",
  C2: "C2 · 멤버",
  C3: "C3 · 멤버",
  C4: "C4 · 멤버",
  C5: "C5 · 멤버",
};

export interface Creator {
  uid: string;
  name: string | null;
  count: number;
  is_mine: boolean;
}

// 생성본 코멘트 스레드 항목(에셋 코멘트와 동일 모양, 키만 gen_id)
export type GenComment = AssetComment;

export interface Worker {
  id: string;
  name: string;
  account_type: string;
}

export interface Facets {
  colors: string[];
  tags: string[];
  auto_tags: string[]; // 자동 태그(별도 네임스페이스 — 필터 사이드바 전용)
  workers: Worker[];
}

export interface ModelInfo {
  display_name: string;
  job_set_type: string;
  type: string;
}

// 모델별 CLI 조절 가능 파라미터(동적 옵션)
export interface ModelParam {
  name: string;
  type: string; // string | integer | array | object …
  default: unknown;
  required: boolean;
  enum?: string[];
}
export interface ModelParamsOut {
  display_name?: string;
  job_set_type: string;
  type: string;
  params: ModelParam[];
}

export interface Workspace {
  id: string;
  name: string | null;
  plan_type: string; // free | team …
  credits: number;
  is_selected: boolean; // 현재 컨텍스트
  user_role: string; // owner | member …
}

export interface Filters {
  tab: "my" | "team" | "compose";
  worker_id?: string;
  color?: string;
  tag?: string;
  share_dir?: "mine" | "received"; // 공유한 것 / 공유 받은 것(타 작업자 생성)
  local_only?: boolean; // 로컬 보기 — 힉스필드에 없고 로컬에만 있는 것
  creator_uid?: string; // 특정 생성자(팀원)만 보기
  project_id?: string; // 프로젝트 필터. 특정 id 또는 'none'(미분류)
  search?: string;
}

// Assets(구성) 패널 — PV 구성탭(폴더 트리)
export interface AssetNode {
  name: string;
  type: "dir" | "image" | "video" | "audio";
  path: string;
  children?: AssetNode[];
}

export interface AssetTree {
  project: string;
  name: string;
  children: AssetNode[];
}

export interface ProjectsInfo {
  projects: string[];
  default: string;
  root: string;
}

// 분리 창 파일별 메타데이터(소스/태그/코멘트/컬러)
export interface AssetMeta {
  is_source: boolean;
  source_name: string | null;
  tags: string[];
  comment: string | null;
  color: string | null;
  comment_count: number;
  has_unread: boolean; // 미확인 코멘트 존재(C 뱃지)
}

// 파일 코멘트 스레드 항목
export interface AssetComment {
  id: string;
  author: string;
  author_name: string | null;
  text: string;
  created_at: string;
  parent_id: string | null; // 답글이면 부모 id
}

// 중간클릭 정보 팝업 대상 (generation 카드 또는 Assets 파일)
export type InfoTarget =
  | { kind: "generation"; gen: Generation; x: number; y: number }
  | { kind: "file"; project: string; node: AssetNode; meta?: AssetMeta; x: number; y: number };

// 클릭 시 떠오르는 미디어 미리보기(이미지 표시 / 영상 재생)
export interface PreviewTarget {
  url: string;
  type: MediaType;
  name: string;
}

// WebSocket 진행률 메시지
export interface ProgressMessage {
  type: "queued" | "progress" | "synced"; // synced = 주기 동기화로 변동 발생(전체 새로고침)
  generation_id?: string;
  status?: GenStatus;
  result_url?: string | null;
  error?: string;
}
