// 썸네일 그리드 (DESIGN.md §4). 에셋 파트(AssetsView)와 동일한 선택 시스템:
//  · 카드 클릭 = 단일 선택, Shift/Ctrl 클릭 = 추가/토글
//  · 빈 공간 드래그 = 마퀴(러버밴드) 다중 선택
//  · 더블클릭 = 미리보기. (카드 드래그는 프롬프트 재사용 — 마퀴 대신 네이티브 드래그)
// 선택 상태는 App 이 Set<string>(id) 로 보유 — 일괄 작업/select-bar 가 의존.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Generation, InfoTarget, PreviewTarget } from "../types";
import { GenerationCard } from "./GenerationCard";

interface Props {
  generations: Generation[];
  tab: "my" | "team";
  scale: number; // 카드 크기 배율 (그리드 모드)
  fill: boolean; // 썸네일 cover(꽉) ↔ contain(비율)
  layout: "grid" | "list";
  selectedIds: Set<string>;
  onSelectedChange: (next: Set<string>) => void; // 마퀴/클릭 선택 결과(전체 치환)
  onToggleSelect: (id: string) => void; // 리스트 모드 체크박스
  onSetSource: (g: Generation, name: string | null, isSource: boolean) => void;
  onSetTags: (g: Generation, tags: string[]) => void;
  onOpenComments: (g: Generation) => void; // C/c → 공유 코멘트 스레드 패널
  onRegenerate: (g: Generation) => void;
  onPublish: (g: Generation) => void;
  onUnpublish: (g: Generation) => void;
  onImport: (g: Generation) => void;
  onColor: (g: Generation, color: string | null) => void;
  onTags: (g: Generation) => void;
  onInfo: (t: InfoTarget) => void;
  onPreview: (t: PreviewTarget) => void;
}

export function ThumbnailGrid(props: Props) {
  const { generations, scale, layout, selectedIds, onSelectedChange } = props;
  const isList = layout === "list";

  const gridRef = useRef<HTMLDivElement>(null);
  // 점진 렌더(무한스크롤) — 데이터는 전부 로드하되 DOM 은 보이는 만큼만. 클라이언트 필터와 호환.
  const PAGE = 60;
  const [shown, setShown] = useState(120);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || shown >= generations.length) return; // 더 없으면 관찰 안 함
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting)
          setShown((s) => Math.min(generations.length, s + PAGE));
      },
      { rootMargin: "800px" }, // 바닥 닿기 전에 미리 로드
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, generations.length]);
  const visible = generations.slice(0, shown);
  const hasMore = shown < generations.length;

  const [marquee, setMarquee] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const [focusIdx, setFocusIdx] = useState(-1); // 방향키 네비 앵커(그리드 포커스 시)
  // 카드 인라인 편집(S 이름·# 태그) — 버튼/단축키 공통 진실원. 한 번에 한 카드.
  // (C 코멘트는 인라인이 아니라 공유 스레드 패널 → onOpenComments)
  const [editTarget, setEditTarget] = useState<{ id: string; field: "source" | "tag" } | null>(null);
  const requestEdit = (g: Generation, field: "source" | "tag") =>
    setEditTarget({ id: g.id, field });
  const editDone = useCallback(() => setEditTarget(null), []);
  const dragRef = useRef<{
    x: number; y: number; base: Set<string>; additive: boolean; moved: boolean; cellId: string | null;
  } | null>(null);

  // 목록 길이가 줄면 포커스 인덱스를 범위 내로 클램프(매 렌더 리셋 방지 — 길이 변할 때만).
  useEffect(() => {
    setFocusIdx((f) => (f >= generations.length ? -1 : f));
  }, [generations.length]);

  // 최신 props 를 ref 로 — 드래그 콜백을 안정 참조로 유지(stale 방지).
  const opsRef = useRef({ generations, onSelectedChange, onPreview: props.onPreview });
  opsRef.current = { generations, onSelectedChange, onPreview: props.onPreview };

  const onDragMove = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    d.moved = true;
    // 카드 위에서 시작한 드래그는 마퀴 안 만듦(클릭선택 판정 또는 카드 네이티브 드래그=프롬프트 재사용).
    if (d.cellId) return;
    const grid = gridRef.current;
    if (!grid) return;
    const gr = grid.getBoundingClientRect();
    const x0 = Math.min(d.x, e.clientX), y0 = Math.min(d.y, e.clientY);
    const x1 = Math.max(d.x, e.clientX), y1 = Math.max(d.y, e.clientY);
    setMarquee({
      l: x0 - gr.left + grid.scrollLeft,
      t: y0 - gr.top + grid.scrollTop,
      w: x1 - x0,
      h: y1 - y0,
    });
    const hit = new Set<string>(d.additive ? d.base : []);
    grid.querySelectorAll(".gen-cell").forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.right >= x0 && r.left <= x1 && r.bottom >= y0 && r.top <= y1) {
        const id = (el as HTMLElement).dataset.id;
        if (id) hit.add(id);
      }
    });
    opsRef.current.onSelectedChange(hit);
  }, []);

  const onDragUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragUp);
    setMarquee(null);
    if (!d || d.moved) return;
    // 드래그 없이 클릭만 → 선택 처리(+ 방향키 앵커 갱신)
    if (d.cellId) {
      setFocusIdx(opsRef.current.generations.findIndex((g) => g.id === d.cellId));
      if (d.additive) {
        const n = new Set(d.base);
        if (n.has(d.cellId)) n.delete(d.cellId);
        else n.add(d.cellId);
        opsRef.current.onSelectedChange(n);
      } else {
        opsRef.current.onSelectedChange(new Set([d.cellId]));
      }
    } else if (!d.additive) {
      setFocusIdx(-1);
      opsRef.current.onSelectedChange(new Set());
    }
  }, [onDragMove]);

  // 방향키 이웃 셀(레이아웃 무관, 화면 좌표 기반 최근접 — 에셋 파트와 동일).
  const neighbor = (cur: number, key: string): number | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    const cells = Array.from(grid.querySelectorAll(".gen-cell")) as HTMLElement[];
    const curEl = cells.find((c) => Number(c.dataset.idx) === cur);
    if (!curEl) return cells.length ? Number(cells[0].dataset.idx) : null;
    const cr = curEl.getBoundingClientRect();
    const cx = (cr.left + cr.right) / 2, cy = (cr.top + cr.bottom) / 2;
    let best: number | null = null, bestScore = Infinity;
    for (const el of cells) {
      const idx = Number(el.dataset.idx);
      if (idx === cur) continue;
      const r = el.getBoundingClientRect();
      const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
      const dx = x - cx, dy = y - cy;
      let ok = false, primary = 0, secondary = 0;
      if (key === "ArrowRight") { ok = dx > 1; primary = dx; secondary = Math.abs(dy); }
      else if (key === "ArrowLeft") { ok = dx < -1; primary = -dx; secondary = Math.abs(dy); }
      else if (key === "ArrowDown") { ok = dy > 1; primary = dy; secondary = Math.abs(dx); }
      else if (key === "ArrowUp") { ok = dy < -1; primary = -dy; secondary = Math.abs(dx); }
      if (!ok) continue;
      const score = primary + secondary * 2;
      if (score < bestScore) { bestScore = score; best = idx; }
    }
    return best;
  };

  // 그리드 포커스 시에만 발동(프롬프트 입력 중엔 프롬프트가 ↑↓로 기록 탐색 — 포커스로 분리).
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    // 카드 인라인 입력 중엔 무시(타이핑이 그리드 네비/단축키로 새지 않게).
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (!generations.length) return;
    // s/#/c — 포커스 카드에서 인라인 편집(에셋 파트와 동일). 수식키 없을 때만.
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const fgen = generations[focusIdx];
      if (fgen) {
        if (e.key === "s" || e.key === "S") {
          e.preventDefault();
          if (fgen.is_source) props.onSetSource(fgen, null, false);
          else setEditTarget({ id: fgen.id, field: "source" });
          return;
        }
        if (e.key === "#") {
          e.preventDefault();
          setEditTarget({ id: fgen.id, field: "tag" });
          return;
        }
        if (e.key === "c" || e.key === "C") {
          e.preventDefault();
          props.onOpenComments(fgen);
          return;
        }
      }
    }
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const cur = focusIdx < 0 ? 0 : focusIdx;
      const nxt = focusIdx < 0 ? 0 : neighbor(cur, e.key);
      if (nxt == null) return;
      setFocusIdx(nxt);
      const nxtId = generations[nxt]?.id;
      if (e.shiftKey) {
        const n = new Set(selectedIds);
        const curId = generations[cur]?.id;
        if (curId) n.add(curId);
        if (nxtId) n.add(nxtId);
        onSelectedChange(n);
      } else if (nxtId) {
        onSelectedChange(new Set([nxtId]));
      }
      requestAnimationFrame(() =>
        gridRef.current
          ?.querySelector(`.gen-cell[data-idx="${nxt}"]`)
          ?.scrollIntoView({ block: "nearest" }),
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const g = generations[focusIdx];
      const a = g?.assets[0];
      if (g && a) onPreviewCell(g);
    } else if (e.key === " ") {
      e.preventDefault();
      const id = focusIdx >= 0 ? generations[focusIdx]?.id : undefined;
      if (id) {
        const n = new Set(selectedIds);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        onSelectedChange(n);
      }
    } else if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSelectedChange(new Set(generations.map((g) => g.id)));
    } else if (e.key === "Escape") {
      setFocusIdx(-1);
      onSelectedChange(new Set());
    }
  };

  const onPreviewCell = (g: Generation) => {
    const a = g.assets[0];
    if (a) props.onPreview({ url: a.file_path, type: a.type, name: g.prompt.slice(0, 50) || "(제목 없음)" });
  };

  const onGridMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault(); // 미들클릭 자동스크롤 방지(정보는 카드 auxclick 에서)
      return;
    }
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, label")) return; // 오버레이 컨트롤 제외
    gridRef.current?.focus(); // 그리드로 포커스 → 방향키 네비 활성(프롬프트와 분리)
    const cellEl = (e.target as HTMLElement).closest(".gen-cell") as HTMLElement | null;
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      base: new Set(selectedIds),
      additive: e.shiftKey || e.ctrlKey || e.metaKey,
      moved: false,
      cellId: cellEl?.dataset.id ?? null,
    };
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragUp);
  };

  const onGridDblClick = (e: React.MouseEvent) => {
    const cellEl = (e.target as HTMLElement).closest(".gen-cell") as HTMLElement | null;
    if (!cellEl) return;
    const g = opsRef.current.generations.find((x) => x.id === cellEl.dataset.id);
    if (g) onPreviewCell(g);
  };

  // 카드 네이티브 드래그(프롬프트 재사용) 시작 → 진행 중이던 마퀴 추적 취소.
  const onGridDragStart = () => {
    dragRef.current = null;
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragUp);
    setMarquee(null);
  };

  if (generations.length === 0) {
    return (
      <div className="grid-wrap">
        <div className="empty">
          항목이 없습니다. 우측 상단 <b>동기화</b>로 기존 생성 이력을 불러오거나{" "}
          <b>+ 새 생성</b>으로 시작하세요.
        </div>
      </div>
    );
  }

  if (isList) {
    return (
      <div className="grid-wrap">
        <div className="gen-list">
          {visible.map((g) => (
            <div
              className="gen-cell list"
              data-id={g.id}
              key={g.id}
              style={{ height: Math.round(300 * scale) }}
            >
              <GenerationCard
                {...props}
                gen={g}
                layout="list"
                selected={selectedIds.has(g.id)}
                editingField={editTarget?.id === g.id ? editTarget.field : null}
                onRequestEdit={requestEdit}
                onEditDone={editDone}
              />
            </div>
          ))}
          {hasMore && (
            <div ref={sentinelRef} className="grid-sentinel">
              더 불러오는 중… ({visible.length}/{generations.length})
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="grid-wrap">
      <div
        ref={gridRef}
        className={"gen-grid" + (props.fill ? "" : " fit-contain")}
        tabIndex={0}
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(180 * scale)}px, 1fr))` }}
        onMouseDown={onGridMouseDown}
        onDoubleClick={onGridDblClick}
        onDragStart={onGridDragStart}
        onKeyDown={onGridKeyDown}
      >
        {visible.map((g, i) => (
          <div
            className={"gen-cell" + (i === focusIdx ? " focused" : "")}
            data-id={g.id}
            data-idx={i}
            key={g.id}
          >
            <GenerationCard
              {...props}
              gen={g}
              layout="grid"
              selected={selectedIds.has(g.id)}
              editingField={editTarget?.id === g.id ? editTarget.field : null}
              onRequestEdit={requestEdit}
              onEditDone={editDone}
            />
          </div>
        ))}
        {hasMore && (
          <div ref={sentinelRef} className="grid-sentinel">
            더 불러오는 중… ({visible.length}/{generations.length})
          </div>
        )}
        {marquee && (
          <div
            className="assets-marquee"
            style={{ left: marquee.l, top: marquee.t, width: marquee.w, height: marquee.h }}
          />
        )}
      </div>
    </div>
  );
}
