export interface Store {
  get(key: string, fallback: string): string;
  set(key: string, value: string): void;
  loadSet(key: string): Set<string>;
}
export function makeStore(prefix: string): Store {
  return {
    get(key, fallback) { try { return localStorage.getItem(prefix + key) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(prefix + key, value); } catch { /* ignore */ } },
    loadSet(key) {
      try { const r = JSON.parse(localStorage.getItem(prefix + key) || "[]"); return new Set(Array.isArray(r) ? (r as string[]) : []); }
      catch { return new Set(); }
    },
  };
}
