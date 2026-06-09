// 앱 루트: 탭·필터 상태, 데이터 로딩, WebSocket 진행률, 액션 오케스트레이션.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, connectProgress } from "./api";
import { CompositionBoard } from "./components/CompositionBoard";
import { FilterSidebar } from "./components/FilterSidebar";
import { SpotlightPrompt } from "./components/SpotlightPrompt";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { TopBar } from "./components/TopBar";
import type { Facets, Filters, Generation } from "./types";

const EMPTY_FACETS: Facets = { colors: [], tags: [], workers: [] };

export default function App() {
  const [filters, setFilters] = useState<Filters>({ tab: "my" });
  const [gens, setGens] = useState<Generation[]>([]);
  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showSpotlight, setShowSpotlight] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2500);
  };

  const reload = useCallback(async () => {
    // 구성 탭은 라이브러리 조회가 아니라 보드 작업 공간이므로 로드 생략.
    if (filtersRef.current.tab === "compose") {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [g, f] = await Promise.all([
        api.listGenerations(filtersRef.current),
        api.facets(),
      ]);
      setGens(g);
      setFacets(f);
    } catch (e) {
      flash("로드 실패: " + String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [filters, reload]);

  // WebSocket 진행률: 상태 전이 메시지를 받으면 해당 카드만 갱신.
  useEffect(() => {
    const off = connectProgress((m) => {
      if (!m.status) return;
      setGens((prev) =>
        prev.map((g) =>
          g.id === m.generation_id ? { ...g, status: m.status! } : g,
        ),
      );
      // 완료되면 전체 새로고침으로 asset/썸네일 반영
      if (m.status === "done") reload();
    });
    return off;
  }, [reload]);

  // Ctrl/⌘+K 로 스포트라이트 열기 (전역 단축키)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowSpotlight(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const patch = (p: Partial<Filters>) => setFilters((f) => ({ ...f, ...p }));

  const onSync = async () => {
    setSyncing(true);
    try {
      const r = await api.sync();
      flash(`동기화 완료: ${r.fetched}건 (신규 ${r.inserted})`);
      await reload();
    } catch (e) {
      flash("동기화 실패: " + String(e));
    } finally {
      setSyncing(false);
    }
  };

  const onRegenerate = async (g: Generation) => {
    try {
      await api.regenerate(g.id, {});
      flash("재생성 잡을 큐에 등록했습니다.");
      await reload();
    } catch (e) {
      flash("재생성 실패: " + String(e));
    }
  };

  const onPublish = async (g: Generation) => {
    try {
      await api.publish(g.id);
      flash("팀에 공유했습니다.");
      await reload();
    } catch (e) {
      flash("공유 실패: " + String(e));
    }
  };

  const onImport = async (g: Generation) => {
    try {
      await api.importToWorkspace(g.id);
      flash("내 워크스페이스로 가져왔습니다 (lineage 기록).");
      setFilters((f) => ({ ...f, tab: "my" }));
    } catch (e) {
      flash("가져오기 실패: " + String(e));
    }
  };

  const onColor = async (g: Generation, color: string | null) => {
    try {
      await api.setColor(g.id, color);
      await reload();
    } catch (e) {
      flash("컬러 변경 실패: " + String(e));
    }
  };

  const onTags = async (g: Generation) => {
    const input = window.prompt("태그 (쉼표 구분)", g.tags.join(", "));
    if (input === null) return;
    const tags = input.split(",").map((t) => t.trim()).filter(Boolean);
    try {
      await api.setTags(g.id, tags);
      await reload();
    } catch (e) {
      flash("태그 변경 실패: " + String(e));
    }
  };

  return (
    <div className="app">
      <TopBar
        filters={filters}
        onTab={(tab) => setFilters({ tab })}
        onSearch={(q) => patch({ search: q || undefined })}
        onSync={onSync}
        syncing={syncing}
        onOpenSpotlight={() => setShowSpotlight(true)}
      />
      <div className="body">
        {filters.tab === "compose" ? (
          <CompositionBoard />
        ) : (
          <>
            <FilterSidebar facets={facets} filters={filters} onChange={patch} />
            <main className="main">
              <div className="main-head">
                <span>
                  {filters.tab === "my" ? "내 작업" : "팀 공유"} · {gens.length}건
                  {loading && " · 로딩…"}
                </span>
              </div>
              <ThumbnailGrid
                generations={gens}
                tab={filters.tab}
                onRegenerate={onRegenerate}
                onPublish={onPublish}
                onImport={onImport}
                onColor={onColor}
                onTags={onTags}
              />
            </main>
          </>
        )}
      </div>

      {showSpotlight && (
        <SpotlightPrompt
          onClose={() => setShowSpotlight(false)}
          onCreated={() => {
            flash("생성 잡을 시작했습니다.");
            reload();
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
