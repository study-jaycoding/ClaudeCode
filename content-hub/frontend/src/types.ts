// 백엔드 API 응답 타입 (backend/app/models.py 와 1:1)

export type MediaType = "image" | "video";
export type GenStatus = "pending" | "running" | "done" | "failed";

export interface Asset {
  id: string;
  generation_id: string;
  type: MediaType;
  file_path: string;
  thumbnail_path: string | null;
}

export interface Reference {
  id: string;
  type: MediaType;
  file_path: string;
  thumbnail_path: string | null;
  source: string | null;
  role: string | null;
}

export interface Generation {
  id: string;
  worker_id: string;
  worker_name: string | null;
  prompt: string;
  model: string | null;
  params: Record<string, unknown> | null;
  color: string | null;
  status: GenStatus;
  created_at: string;
  assets: Asset[];
  references: Reference[];
  tags: string[];
  shared: boolean;
  parent_gen_id: string | null;
}

export interface Worker {
  id: string;
  name: string;
  account_type: string;
}

export interface Facets {
  colors: string[];
  tags: string[];
  workers: Worker[];
}

export interface ModelInfo {
  display_name: string;
  job_set_type: string;
  type: string;
}

export interface Filters {
  tab: "my" | "team" | "compose";
  worker_id?: string;
  color?: string;
  tag?: string;
  shared_only?: boolean;
  search?: string;
}

// WebSocket 진행률 메시지
export interface ProgressMessage {
  type: "queued" | "progress";
  generation_id: string;
  status?: GenStatus;
  result_url?: string | null;
  error?: string;
}
