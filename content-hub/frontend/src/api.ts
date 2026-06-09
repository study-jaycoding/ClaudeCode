// 타입 안전 API 클라이언트. 모든 호출은 /api 프록시를 통해 로컬 백엔드로.
import type {
  Facets,
  Filters,
  Generation,
  ModelInfo,
} from "./types";

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
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
  if (filters.shared_only) q.set("shared_only", "true");
  if (filters.search) q.set("search", filters.search);
  return q.toString();
}

export const api = {
  listGenerations: (filters: Filters) =>
    jsonFetch<Generation[]>(`/api/generations?${buildQuery(filters)}`),

  getGeneration: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${id}`),

  facets: () => jsonFetch<Facets>("/api/facets"),

  models: () => jsonFetch<ModelInfo[]>("/api/models"),

  sync: () =>
    jsonFetch<{ fetched: number; inserted: number; updated: number }>(
      "/api/sync",
      { method: "POST" },
    ),

  create: (body: {
    prompt: string;
    model: string;
    params?: Record<string, unknown>;
    color?: string | null;
    tags?: string[];
    references?: { file_path: string; type: string; role: string }[];
  }) =>
    jsonFetch<Generation>("/api/generations", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  regenerate: (id: string, body: { prompt?: string; color?: string | null }) =>
    jsonFetch<Generation>(`/api/generations/${id}/regenerate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  setTags: (id: string, tags: string[]) =>
    jsonFetch<Generation>(`/api/generations/${id}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tags }),
    }),

  setColor: (id: string, color: string | null) =>
    jsonFetch<Generation>(`/api/generations/${id}/color`, {
      method: "PUT",
      body: JSON.stringify({ color }),
    }),

  publish: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${id}/publish`, {
      method: "POST",
      body: JSON.stringify({ visibility: "team" }),
    }),

  importToWorkspace: (id: string) =>
    jsonFetch<Generation>(`/api/generations/${id}/import`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
};

// WebSocket 진행률 구독. 메시지 콜백 등록 후 정리 함수 반환.
export function connectProgress(
  onMessage: (m: import("./types").ProgressMessage) => void,
): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  };
  // 일부 프록시는 idle 연결을 끊으므로 keepalive ping
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send("ping");
  }, 25000);
  return () => {
    clearInterval(ping);
    ws.close();
  };
}
