// 타입 안전 API 클라이언트. 모든 호출은 /api 프록시를 통해 로컬 백엔드로.
import type {
  AssetComment,
  AssetMeta,
  AssetTree,
  Creator,
  Facets,
  Filters,
  Generation,
  Member,
  ModelInfo,
  Project,
  ProjectsInfo,
  ProjectsResponse,
  Workspace,
} from "./types";

// ── 인증 토큰(세션) — localStorage 영속 + 모든 요청에 Bearer 첨부 ──────────────
const TOKEN_KEY = "ch.auth.token";
let authToken: string | null = (() => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
})();

export function setAuthToken(token: string | null): void {
  authToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function getAuthToken(): string | null {
  return authToken;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    // 401 = 세션 만료/무효 → 토큰 폐기 + 로그인 요구 신호(App 이 받아 로그인 화면 표시)
    if (res.status === 401 && !url.includes("/api/auth/")) {
      setAuthToken(null);
      window.dispatchEvent(new CustomEvent("ch:auth-required"));
    }
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail || detail;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

function buildQuery(filters: Filters): string {
  const q = new URLSearchParams();
  q.set("tab", filters.tab);
  if (filters.worker_id) q.set("worker_id", filters.worker_id);
  if (filters.color) q.set("color", filters.color);
  if (filters.tag) q.set("tag", filters.tag);
  if (filters.share_dir) q.set("share_dir", filters.share_dir);
  if (filters.local_only) q.set("local_only", "true");
  if (filters.creator_uid) q.set("creator_uid", filters.creator_uid);
  if (filters.project_id) q.set("project_id", filters.project_id);
  if (filters.search) q.set("search", filters.search);
  q.set("limit", "2000"); // 전부 로드 후 프론트에서 점진 렌더(무한스크롤). 백엔드 상한=2000
  return q.toString();
}

export const api = {
  listGenerations: (filters: Filters) =>
    jsonFetch<Generation[]>(`/api/generations?${buildQuery(filters)}`),

  getGeneration: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${id}`),

  facets: () => jsonFetch<Facets>("/api/facets"),

  models: () => jsonFetch<ModelInfo[]>("/api/models"),

  // 모델별 CLI 조절 가능 파라미터(동적 옵션)
  modelParams: (jobSetType: string) =>
    jsonFetch<import("./types").ModelParamsOut>(
      `/api/models/${encodeURIComponent(jobSetType)}/params`,
    ),

  // 예상 크레딧 추정(잡 생성 안 함) — Generate 버튼 표시용
  estimateCost: (model: string, params: Record<string, unknown>, prompt = "") =>
    jsonFetch<{ credits: number }>("/api/cost", {
      method: "POST",
      body: JSON.stringify({ model, params, prompt }),
    }),

  // 계정 상태(연결·크레딧·이메일) — 하단 상태줄 클릭 시 수동 조회
  account: () =>
    jsonFetch<{ connected: boolean; credits: number | null; email: string; plan: string }>(
      "/api/account",
    ),

  // 외부 JSON(다른 작업자의 generate list export) 가져오기 — UUID 병합 + 생성자 자동 구분
  importJobs: (jobs: unknown[]) =>
    jsonFetch<{ inserted: number; updated: number; unchanged: number; skipped: number }>(
      "/api/import-jobs",
      { method: "POST", body: JSON.stringify(jobs) },
    ),

  // content-hub 번들 내보내기(사실 + 오버레이: 레퍼런스 위치·태그·코멘트·생성자).
  // mine=true 면 내 생성자 것만. >100 제약을 누적 DB 로 우회해 전부 공유.
  exportBundle: (mine = false) =>
    jsonFetch<{ format: string; version: number; generations: unknown[] }>(
      `/api/export-bundle${mine ? "?mine=true" : ""}`,
    ),

  // content-hub 번들 가져오기 — uuid 멱등 병합(태그 union, 코멘트 dedup append)
  importBundle: (bundle: unknown) =>
    jsonFetch<{ inserted: number; updated: number; unchanged: number; skipped: number }>(
      "/api/import-bundle",
      { method: "POST", body: JSON.stringify(bundle) },
    ),

  // ── 제공자 신원 (공유 파일명·작성자 표기 기준) ──────────────────────────
  // {uid(불변 앵커), name(편집 가능 표시이름), email}. CLI 이메일에서 기본값을 잡음.
  provider: () =>
    jsonFetch<{ uid: string | null; name: string | null; email: string | null }>(
      "/api/provider",
    ),
  // 표시이름 변경 → 이후 공유 파일명·작성자 표기에 반영(uid 는 그대로라 병합 안 깨짐)
  setProviderName: (name: string) =>
    jsonFetch<{ uid: string | null; name: string | null; email: string | null }>(
      "/api/provider",
      { method: "PATCH", body: JSON.stringify({ name }) },
    ),

  // ── 프로젝트(작업 묶음) — 공유·이동의 단위 ─────────────────────────────
  projects: (includeArchived = false) =>
    jsonFetch<ProjectsResponse>(
      `/api/projects${includeArchived ? "?include_archived=true" : ""}`,
    ),
  createProject: (name: string, kind = "team") =>
    jsonFetch<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, kind }),
    }),
  updateProject: (id: string, patch: { name?: string; archived?: boolean }) =>
    jsonFetch<Project>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteProject: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),
  // 결과물들을 프로젝트에 귀속(project_id=null 이면 미분류로 해제)
  assignProject: (generationIds: string[], projectId: string | null) =>
    jsonFetch<{ ok: boolean; updated: number }>("/api/projects/assign", {
      method: "POST",
      body: JSON.stringify({ generation_ids: generationIds, project_id: projectId }),
    }),

  // ── 인증/계정(보안) — 로드맵 §4-1/§4-2 ────────────────────────────────
  authConfig: () =>
    jsonFetch<import("./types").AuthConfig>("/api/auth/config"),
  register: (email: string, password: string, name?: string) =>
    jsonFetch<{ account: import("./types").Account; token: string | null }>(
      "/api/auth/register",
      { method: "POST", body: JSON.stringify({ email, password, name }) },
    ),
  login: (email: string, password: string) =>
    jsonFetch<{ account: import("./types").Account; token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => jsonFetch<import("./types").Account>("/api/auth/me"),
  logout: () => jsonFetch<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  // 관리자: 계정 목록·승인/거부·등급
  listAccounts: (status?: string) =>
    jsonFetch<import("./types").Account[]>(
      `/api/auth/accounts${status ? `?status=${status}` : ""}`,
    ),
  setAccountStatus: (email: string, status: string) =>
    jsonFetch<import("./types").Account>(
      `/api/auth/accounts/${encodeURIComponent(email)}/status`,
      { method: "PATCH", body: JSON.stringify({ status }) },
    ),
  setAccountRole: (email: string, role: string) =>
    jsonFetch<import("./types").Account>(
      `/api/auth/accounts/${encodeURIComponent(email)}/role`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    ),

  // ── 멤버·등급(C0~C5) — 관리자 창 ───────────────────────────────────────
  members: () => jsonFetch<Member[]>("/api/members"),
  // 등급 변경 → 갱신된 전체 멤버 목록 반환
  setMemberRole: (uid: string, role: string | null) =>
    jsonFetch<Member[]>(`/api/members/${encodeURIComponent(uid)}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),

  // ── 팀 공유 파일(data/shared) ──────────────────────────────────────────
  // 내 share 파일을 현재 share-set(공유 표시된 것들)으로 강제 재생성
  rebuildShare: () =>
    jsonFetch<{ path: string | null; count: number }>("/api/share/rebuild", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  // shared 폴더에서 받은(남의) share 파일 요약 목록 — in 뷰
  receivedShares: () =>
    jsonFetch<{
      items: {
        filename: string;
        provider: { uid: string | null; name: string | null; email: string | null };
        count: number;
      }[];
    }>("/api/share/received"),
  // 받은 share 파일 1개를 내 라이브러리로 병합(받기)
  importReceived: (filename: string) =>
    jsonFetch<{ inserted: number; updated: number; unchanged: number; skipped: number }>(
      "/api/share/received/import",
      { method: "POST", body: JSON.stringify({ filename }) },
    ),
  // shared 폴더의 받은 share 파일 전부 일괄 병합
  importReceivedAll: () =>
    jsonFetch<{ inserted: number; updated: number; unchanged: number; skipped: number }>(
      "/api/share/received/import-all",
      { method: "POST", body: JSON.stringify({}) },
    ),

  // 생성자(팀 워크스페이스 작성자) — 목록·이름붙이기
  creators: () => jsonFetch<Creator[]>("/api/creators"),
  renameCreator: (uid: string, name: string) =>
    jsonFetch<{ ok: boolean }>(`/api/creators/${encodeURIComponent(uid)}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),
  // 이 생성자를 '나'로 지정 → 그 작업이 내 작업(is_mine)으로 잡히고 제공자 이름 표시.
  // 팀 워크스페이스에선 CLI 가 내 user_<id> 를 안 줘서 1회 지정 필요(초기화 후엔 다시).
  claimCreator: (uid: string) =>
    jsonFetch<{ my_creator_uid: string | null; name: string | null }>(
      `/api/creators/${encodeURIComponent(uid)}/claim`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  // 워크스페이스(팀 공유 UUID 공간) — 목록·선택·해제
  workspaces: () => jsonFetch<Workspace[]>("/api/workspaces"),
  selectWorkspace: (workspace_id: string) =>
    jsonFetch<{ workspaces: Workspace[] }>("/api/workspaces/select", {
      method: "POST",
      body: JSON.stringify({ workspace_id }),
    }),
  unselectWorkspace: () =>
    jsonFetch<{ workspaces: Workspace[] }>("/api/workspaces/unselect", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  sync: () =>
    jsonFetch<{ fetched: number; inserted: number; updated: number }>(
      "/api/sync",
      { method: "POST" },
    ),

  // 출처 영속화: 소스·결과물을 로컬로 보관(원격 URL 만료 무관하게 재사용 가능)
  cacheAll: () =>
    jsonFetch<{ cached: number; failed: number; generations: number }>(
      "/api/cache-all",
      { method: "POST" },
    ),

  create: (body: {
    prompt: string;
    display_prompt?: string;
    model: string;
    params?: Record<string, unknown>;
    color?: string | null;
    tags?: string[];
    auto_tags?: string[];
    references?: {
      file_path: string;
      type: string;
      role: string;
      name?: string;
      thumbnail?: string;
      source_url?: string;
    }[];
    project_id?: string; // 생성 시 보던 프로젝트로 자동 귀속
  }) =>
    jsonFetch<Generation>("/api/generations", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  regenerate: (
    id: string,
    body: { prompt?: string; color?: string | null; auto_tags?: string[] },
  ) =>
    jsonFetch<Generation>(`/api/generations/${id}/regenerate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  setTags: (id: string, tags: string[]) =>
    jsonFetch<Generation>(`/api/generations/${id}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tags }),
    }),

  // 태그 전역 삭제(모든 생성본에서 제거) — 에셋 T 패널 ✕ 와 동일
  deleteTag: (tag: string) =>
    jsonFetch<{ removed: number }>(`/api/tags/${encodeURIComponent(tag)}`, {
      method: "DELETE",
    }),

  // 힉스필드 존재 검증(generate get) → 삭제된 것 hf_missing 표시. 로컬 보기/흐림에 반영
  verifyHiggsfield: () =>
    jsonFetch<{ checked: number; missing: number }>(
      "/api/generations/verify-higgsfield",
      { method: "POST", body: JSON.stringify({}) },
    ),

  // 힉스필드에 안 올라간 로컬 유령 실패(failed+job_id 없음) 일괄 삭제
  clearFailed: () =>
    jsonFetch<{ removed: number }>("/api/generations/clear-failed", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  // generation 1건 삭제(로컬 기록만)
  deleteGeneration: (id: string) =>
    jsonFetch<{ deleted: boolean }>(`/api/generations/${id}`, { method: "DELETE" }),

  // 자동 태그(별도 네임스페이스) — 필터 사이드바 +버튼/×
  createAutoTag: (name: string) =>
    jsonFetch<{ ok: boolean; name: string }>(`/api/auto-tags`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  deleteAutoTag: (name: string) =>
    jsonFetch<{ removed: number }>(`/api/auto-tags/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),

  setColor: (id: string, color: string | null) =>
    jsonFetch<Generation>(`/api/generations/${id}/color`, {
      method: "PUT",
      body: JSON.stringify({ color }),
    }),

  // 소스 라이브러리 등록/해제(@이름)
  setSource: (id: string, name: string | null, is_source = true) =>
    jsonFetch<Generation>(`/api/generations/${id}/source`, {
      method: "PUT",
      body: JSON.stringify({ name, is_source }),
    }),

  setComment: (id: string, comment: string | null) =>
    jsonFetch<Generation>(`/api/generations/${id}/comment`, {
      method: "PUT",
      body: JSON.stringify({ comment }),
    }),

  // 생성본 코멘트 스레드(공유, 에셋과 별개) — 글·답글. 팀 공유 대상.
  genComments: (genId: string) =>
    jsonFetch<import("./types").GenComment[]>(
      `/api/generations/${encodeURIComponent(genId)}/comments`,
    ),
  addGenComment: (
    genId: string,
    text: string,
    parent_id?: string | null,
    muted = false,
  ) =>
    jsonFetch<{ id: string }>(`/api/generations/${encodeURIComponent(genId)}/comments`, {
      method: "POST",
      body: JSON.stringify({ text, parent_id: parent_id ?? null, muted }),
    }),
  editGenComment: (commentId: string, text: string) =>
    jsonFetch<{ ok: boolean }>(`/api/generation-comments/${commentId}`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),
  deleteGenComment: (commentId: string) =>
    jsonFetch<{ ok: boolean }>(`/api/generation-comments/${commentId}`, { method: "DELETE" }),
  markGenCommentsRead: (genId: string) =>
    jsonFetch<{ ok: boolean }>(
      `/api/generations/${encodeURIComponent(genId)}/comments/read`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  // 스포트라이트 @/# 피커: 소스를 이름(query) 또는 태그(tag)로 검색.
  // assetProject/assetDir 를 주면 에셋 파트 소스(그 폴더로 스코프)도 합류한다.
  searchSources: (query?: string, tag?: string, assetProject?: string, assetDir?: string) => {
    const q = new URLSearchParams();
    if (query) q.set("query", query);
    if (tag) q.set("tag", tag);
    if (assetProject) q.set("asset_project", assetProject);
    if (assetDir) q.set("asset_dir", assetDir);
    return jsonFetch<Generation[]>(`/api/sources?${q.toString()}`);
  },

  publish: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${id}/publish`, {
      method: "POST",
      body: JSON.stringify({ visibility: "team" }),
    }),

  // 팀 공유 해제(내가 공유한 것 되돌리기)
  unpublish: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${id}/unpublish`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  importToWorkspace: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${id}/import`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  // Assets(구성) 패널
  assetProjects: () => jsonFetch<ProjectsInfo>("/api/assets/projects"),

  assetTree: (project: string) =>
    jsonFetch<AssetTree>(`/api/assets/tree?project=${encodeURIComponent(project)}`),

  // 파일 URL (원본/미리보기). 프록시를 통해 백엔드가 서빙.
  assetFileUrl: (project: string, path: string) =>
    `/api/assets/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`,

  // 리사이즈 썸네일 URL(이미지 전용) — 그리드/리스트 스크롤 성능용. 디스크 캐시.
  assetThumbUrl: (project: string, path: string, w = 512) =>
    `/api/assets/thumb?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}&w=${w}`,

  // 외부 파일 가져오기(드롭 업로드) → 현재 폴더(dir)에 저장. multipart 라 jsonFetch 미사용.
  uploadAssets: async (project: string, dir: string, files: File[]) => {
    const fd = new FormData();
    fd.append("project", project);
    fd.append("dir", dir);
    for (const f of files) fd.append("files", f);
    const res = await fetch("/api/assets/upload", { method: "POST", body: fd });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        detail = (await res.json()).detail || detail;
      } catch {
        /* ignore */
      }
      throw new Error(`${res.status}: ${detail}`);
    }
    return res.json() as Promise<{ saved: string[]; skipped: string[] }>;
  },

  // OS 파일 탐색기에서 원본 위치 열기(해당 파일 선택)
  revealAsset: (project: string, path: string) =>
    jsonFetch<{ ok: boolean }>(`/api/assets/reveal`, {
      method: "POST",
      body: JSON.stringify({ project, path }),
    }),

  // 로컬 보관된 결과물/소스(/media/...)의 원본 위치를 탐색기에서 열기
  revealMedia: (path: string) =>
    jsonFetch<{ ok: boolean }>(`/api/reveal-media`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  // 분리 창 파일별 메타데이터 (미확인 뱃지는 코멘트별 muted 플래그를 따름)
  assetMeta: (project: string) =>
    jsonFetch<Record<string, AssetMeta>>(
      `/api/assets/meta?project=${encodeURIComponent(project)}`,
    ),

  // 파일 코멘트 스레드(공유)
  assetComments: (project: string, path: string) =>
    jsonFetch<AssetComment[]>(
      `/api/assets/comments?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`,
    ),
  addAssetComment: (
    project: string,
    path: string,
    text: string,
    parent_id?: string | null,
    muted = false,
  ) =>
    jsonFetch<{ id: string }>(`/api/assets/comments`, {
      method: "POST",
      body: JSON.stringify({ project, path, text, parent_id: parent_id ?? null, muted }),
    }),
  editAssetComment: (id: string, text: string) =>
    jsonFetch<{ ok: boolean }>(`/api/assets/comments/${id}`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),
  deleteAssetComment: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/assets/comments/${id}`, { method: "DELETE" }),
  markCommentsRead: (project: string, path: string) =>
    jsonFetch<{ ok: boolean }>(`/api/assets/comments/read`, {
      method: "POST",
      body: JSON.stringify({ project, path }),
    }),
  setAssetSource: (project: string, path: string, name: string | null, is_source: boolean) =>
    jsonFetch(`/api/assets/source`, {
      method: "PUT",
      body: JSON.stringify({ project, path, name, is_source }),
    }),
  setAssetTags: (project: string, path: string, tags: string[]) =>
    jsonFetch(`/api/assets/tags`, {
      method: "PUT",
      body: JSON.stringify({ project, path, tags }),
    }),
  setAssetComment: (project: string, path: string, comment: string | null) =>
    jsonFetch(`/api/assets/comment`, {
      method: "PUT",
      body: JSON.stringify({ project, path, comment }),
    }),
  setAssetColor: (project: string, path: string, color: string | null) =>
    jsonFetch(`/api/assets/color`, {
      method: "PUT",
      body: JSON.stringify({ project, path, color }),
    }),
};

// WebSocket 진행률 구독. 끊기면 자동 재연결(백오프)하고, (재)연결될 때마다
// onReconnect 로 알린다 → 끊긴 동안 놓친 상태 전이를 reload 로 따라잡게 한다.
export function connectProgress(
  onMessage: (m: import("./types").ProgressMessage) => void,
  onReconnect?: () => void,
): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws: WebSocket | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;
  let closed = false;

  const connect = () => {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      backoff = 1000;
      onReconnect?.(); // 연결/재연결 시 최신 상태로 동기화
    };
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (ping) clearInterval(ping);
      if (closed) return;
      backoff = Math.min(backoff * 1.6, 15000);
      retry = setTimeout(connect, backoff); // 백엔드 재시작/네트워크 끊김 → 재연결
    };
    // 일부 프록시는 idle 연결을 끊으므로 keepalive ping
    ping = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 25000);
  };
  connect();

  return () => {
    closed = true;
    if (ping) clearInterval(ping);
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
