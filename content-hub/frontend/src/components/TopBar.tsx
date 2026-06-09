// 상단 바 (DESIGN.md §4): 로고 + 탭 + 검색 + 동기화 + 새 생성.
import { useState } from "react";
import type { Filters } from "../types";

interface Props {
  filters: Filters;
  onTab: (tab: "my" | "team" | "compose") => void;
  onSearch: (q: string) => void;
  onSync: () => void;
  syncing: boolean;
  onOpenSpotlight: () => void;
}

export function TopBar({
  filters,
  onTab,
  onSearch,
  onSync,
  syncing,
  onOpenSpotlight,
}: Props) {
  const [q, setQ] = useState(filters.search || "");

  return (
    <header className="topbar">
      <div className="brand">⬡ Content Hub</div>

      <nav className="tabs">
        <button
          className={filters.tab === "my" ? "on" : ""}
          onClick={() => onTab("my")}
        >
          내 작업
        </button>
        <button
          className={filters.tab === "team" ? "on" : ""}
          onClick={() => onTab("team")}
        >
          팀 공유
        </button>
        <button
          className={filters.tab === "compose" ? "on" : ""}
          onClick={() => onTab("compose")}
        >
          구성
        </button>
      </nav>

      <input
        className="search"
        value={q}
        placeholder="프롬프트·태그 검색"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSearch(q)}
      />

      <button className="sync" onClick={onSync} disabled={syncing}>
        {syncing ? "동기화 중…" : "↺ 동기화"}
      </button>

      {/* 스포트라이트 트리거: '새 생성' 버튼 대신 커맨드 바 형태 */}
      <button className="spotlight-trigger" onClick={onOpenSpotlight}>
        <span className="st-icon">✦</span>
        <span className="st-label">프롬프트로 생성…</span>
        <kbd>Ctrl K</kbd>
      </button>
    </header>
  );
}
