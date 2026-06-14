// 라이브러리 툴바 (힉스필드식): History(미디어 타입 필터) + 필터 토글 +
// 썸네일 크기 조절 슬라이더 + List/Grid 레이아웃 토글.
import { useCallback, useEffect, useRef, useState } from "react";

type MediaFilter = "all" | "image" | "video" | "audio";

function loadJSON<T>(key: string): T | null {
  try {
    const r = localStorage.getItem(key);
    return r ? (JSON.parse(r) as T) : null;
  } catch {
    return null;
  }
}
const MEDIA_OPTS: { v: MediaFilter; label: string }[] = [
  { v: "all", label: "전체" },
  { v: "image", label: "이미지" },
  { v: "video", label: "영상" },
  { v: "audio", label: "오디오" },
];

interface Props {
  typeFilter: MediaFilter;
  onTypeFilter: (t: MediaFilter) => void;
  scale: number;
  onScale: (v: number) => void;
  fill: boolean;
  onToggleFill: () => void;
  layout: "grid" | "list";
  onLayout: (l: "grid" | "list") => void;
  filtersOpen: boolean;
  onToggleFilters: () => void;
  count: number;
  loading: boolean;
  failedCount: number; // 실패 항목 수(>0 이면 '실패 정리' 노출)
  onClearFailed: () => void;
  // 에셋 파트와 동일한 인스턴트 필터(컬러 dot · S · T)
  colorDots: { k: string; hex: string }[];
  colorFilter: Set<string>;
  onToggleColor: (hex: string) => void;
  sourceOnly: boolean;
  onToggleSource: () => void;
  commentOnly: boolean; // C 필터: 미확인 코멘트만 보기
  onToggleComment: () => void;
  hasUnread: boolean; // 미확인 코멘트 존재 → C 자동 알림(호박색)
  tags: string[];
  tagFilter: Set<string>;
  onSelectTag: (t: string, additive: boolean) => void; // 클릭=단일, Shift/Ctrl=다중(에셋과 동일)
  onDeleteTag: (t: string) => void; // ✕ 전역 삭제
  onClearTags: () => void; // 필터 해제
  tagPanelOpen: boolean;
  onToggleTagPanel: () => void;
}

export function LibraryToolbar({
  typeFilter,
  onTypeFilter,
  scale,
  onScale,
  fill,
  onToggleFill,
  layout,
  onLayout,
  filtersOpen,
  onToggleFilters,
  count,
  loading,
  failedCount,
  onClearFailed,
  colorDots,
  colorFilter,
  onToggleColor,
  sourceOnly,
  onToggleSource,
  commentOnly,
  onToggleComment,
  hasUnread,
  tags,
  tagFilter,
  onSelectTag,
  onDeleteTag,
  onClearTags,
  tagPanelOpen,
  onToggleTagPanel,
}: Props) {
  const typeLabel = MEDIA_OPTS.find((o) => o.v === typeFilter)?.label ?? "전체";
  const typeIndex = Math.max(0, MEDIA_OPTS.findIndex((o) => o.v === typeFilter));

  // 태그 패널 — 에셋 파트와 동일: 플로팅(헤더 드래그 이동) + CSS resize + 위치·크기 영속.
  const [tagPos, setTagPos] = useState<{ x: number; y: number } | null>(() =>
    loadJSON("ch.lib.tagPos"),
  );
  const [tagSize, setTagSize] = useState<{ w: number; h: number } | null>(() =>
    loadJSON("ch.lib.tagSize"),
  );
  const tagDragRef = useRef<{ dx: number; dy: number } | null>(null);
  const tagPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tagPos) localStorage.setItem("ch.lib.tagPos", JSON.stringify(tagPos));
  }, [tagPos]);
  useEffect(() => {
    if (tagSize) localStorage.setItem("ch.lib.tagSize", JSON.stringify(tagSize));
  }, [tagSize]);
  // 크기조절(CSS resize) → offset 측정해 영속.
  useEffect(() => {
    if (!tagPanelOpen) return;
    const el = tagPanelRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTagSize({ w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [tagPanelOpen]);

  const onTagDrag = useCallback((e: MouseEvent) => {
    const d = tagDragRef.current;
    if (!d) return;
    setTagPos({ x: e.clientX - d.dx, y: e.clientY - d.dy });
  }, []);
  const onTagDragUp = useCallback(() => {
    tagDragRef.current = null;
    window.removeEventListener("mousemove", onTagDrag);
    window.removeEventListener("mouseup", onTagDragUp);
  }, [onTagDrag]);
  const onTagHeadDown = (e: React.MouseEvent) => {
    const pos = tagPos || { x: 180, y: 150 };
    tagDragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    window.addEventListener("mousemove", onTagDrag);
    window.addEventListener("mouseup", onTagDragUp);
  };
  return (
    <div className="lib-toolbar">
      {/* 필터 사이드바 토글 — 열림=▢(사각), 닫힘=▷(삼각) */}
      <button
        className={"lib-filter lib-filter-ic" + (filtersOpen ? " on" : "")}
        onClick={onToggleFilters}
        title={filtersOpen ? "필터 사이드바 닫기" : "필터 사이드바 열기"}
      >
        {filtersOpen ? "▢" : "▷"}
      </button>
      {/* 미디어 타입 — 4개 점 슬라이더(전체·이미지·영상·오디오). 슬라이드/점클릭 모두 전환 */}
      <div className="lib-hist-slider" title="미디어 타입 — 슬라이드로 전환">
        <span className="lib-hist-label">{typeLabel}</span>
        <div className="lib-hist-range">
          <div className="lib-hist-ticks">
            {MEDIA_OPTS.map((o, i) => (
              <button
                key={o.v}
                type="button"
                className={"lib-hist-tick" + (i === typeIndex ? " on" : "")}
                title={o.label}
                onClick={() => onTypeFilter(o.v)}
              />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={MEDIA_OPTS.length - 1}
            step={1}
            value={typeIndex}
            onChange={(e) => onTypeFilter(MEDIA_OPTS[Number(e.target.value)].v)}
          />
        </div>
      </div>

      <span className="lib-count">
        {typeLabel} · {count}건{loading && " · 로딩…"}
      </span>
      {failedCount > 0 && (
        <button
          className="lib-clear-failed"
          title="힉스필드에 안 올라간 실패 항목 정리 (실제 힉스필드엔 영향 없음)"
          onClick={onClearFailed}
        >
          실패 정리
        </button>
      )}

      <div className="lib-tools">
        {/* 인스턴트 필터: 컬러 dot · S(소스만) · T(태그) — 에셋 파트와 동일 */}
        <div className="assets-filters">
          {colorDots.map(({ k, hex }) => {
            const on = colorFilter.has(hex);
            return (
              <button
                key={k}
                className={"af-dot" + (on ? " on" : "")}
                style={{
                  background: hex,
                  filter: on ? "brightness(1.2) saturate(1.25)" : "brightness(0.45) saturate(0.7)",
                  opacity: on ? 1 : 0.85,
                  borderColor: on ? "#fff" : "rgba(0,0,0,0.4)",
                  boxShadow: on ? `0 0 0 2px ${hex}, 0 0 11px ${hex}` : "none",
                }}
                title={`${k.toUpperCase()} 컬러만 보기`}
                onClick={() => onToggleColor(hex)}
              />
            );
          })}
          <button
            className={"af-btn" + (sourceOnly ? " on" : "")}
            title="소스로 등록된 것만 보기"
            onClick={onToggleSource}
          >
            S
          </button>
          <button
            className={"af-btn" + (tagPanelOpen || tagFilter.size ? " on" : "")}
            title="태그로 필터 (다시 누르면 닫힘 + 해제)"
            onClick={onToggleTagPanel}
          >
            T
          </button>
          <button
            className={
              "af-btn af-c" +
              (commentOnly ? " on" : "") +
              (hasUnread && !commentOnly ? " alert" : "")
            }
            title={
              hasUnread
                ? "코멘트가 있는 생성본만 보기 (미확인 코멘트 있음)"
                : "코멘트가 있는 생성본만 보기"
            }
            onClick={onToggleComment}
          >
            C
          </button>
          {tagPanelOpen && (
            <div
              className="tag-panel"
              ref={tagPanelRef}
              style={{
                left: (tagPos || { x: 180, y: 150 }).x,
                top: (tagPos || { x: 180, y: 150 }).y,
                width: tagSize?.w,
                height: tagSize?.h,
              }}
            >
              <div className="tag-panel-head" onMouseDown={onTagHeadDown}>
                <span>
                  등록된 태그 <span className="muted">({tags.length})</span>
                </span>
                {tagFilter.size > 0 && (
                  <button
                    className="tag-panel-clear"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={onClearTags}
                  >
                    필터 해제
                  </button>
                )}
              </div>
              <div className="tag-panel-list">
                {tags.length === 0 && (
                  <div className="tag-panel-empty">등록된 태그가 없습니다.</div>
                )}
                {tags.map((t) => (
                  <span key={t} className={"tag-pill" + (tagFilter.has(t) ? " on" : "")}>
                    <button
                      className="tag-pill-name"
                      title="클릭=이 태그만 · Shift/Ctrl+클릭=다중 선택"
                      onClick={(e) => onSelectTag(t, e.shiftKey || e.ctrlKey || e.metaKey)}
                    >
                      #{t}
                    </button>
                    <button
                      className="tag-pill-x"
                      title="이 태그를 모든 생성본에서 삭제"
                      onClick={() => onDeleteTag(t)}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 썸네일 꽉 채움(cover ▣) ↔ 비율 유지(contain ▢) 토글 — 에셋 파트와 동일 */}
        <button
          className={"fit-toggle" + (!fill ? " on" : "")}
          onClick={onToggleFill}
          title={
            fill
              ? "꽉 채우기(크롭) — 클릭 시 전체 보기"
              : "전체 보기(블랙바) — 클릭 시 꽉 채우기"
          }
        >
          {fill ? "▣" : "▢"}
        </button>

        {/* 썸네일 크기 조절 바 */}
        <div className="size-slider" title="카드 크기">
          <input
            type="range"
            min={0.7}
            max={1.7}
            step={0.05}
            value={scale}
            onChange={(e) => onScale(Number(e.target.value))}
          />
        </div>

        {/* List / Grid 토글 */}
        <div className="layout-toggle">
          <button
            className={layout === "list" ? "on" : ""}
            onClick={() => onLayout("list")}
            title="리스트"
          >
            <svg
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="9" y1="4" x2="9" y2="20" />
            </svg>
          </button>
          <button
            className={layout === "grid" ? "on" : ""}
            onClick={() => onLayout("grid")}
            title="그리드"
          >
            <svg
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
