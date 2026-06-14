// 스포트라이트 프롬프트(항상 하단 도킹) — PV 스타일.
//  · contentEditable 프롬프트 + 선택 소스를 인라인 이미지 칩으로 삽입
//  · @ → 소스 피커, # → 태그 목록 피커. 태그 선택 시 tagFilter 고정 + @ 피커가 그 태그로 필터되어 열림
//  · Esc → 피커 닫기 / tagFilter 해제. 제출 시 본문 텍스트 + 칩→references 직렬화.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api";
import { buildPromptParts, refsToChips } from "../lib/promptParts";
import {
  countImageChips,
  detectMention,
  hasContent,
  insertChip,
  insertTextAtCaret,
  loadHistory,
  partsText,
  placeCaretAtEnd,
  restoreParts,
  saveHistory,
  serialize,
  serializeParts,
  stripQuery,
  HIST_MAX,
} from "../lib/promptEditor";
import type { ChipRef, HistEntry } from "../lib/promptEditor";
import { useAccountStatus } from "../lib/useAccountStatus";
import { useModels, ALLOWED, HIDDEN_PARAMS } from "../lib/useModels";
import type { Generation } from "../types";

const MAX_COUNT = 4; // 한 번에 생성할 최대 장수(배치)

interface Props {
  // created: 방금 만든 pending 생성본들 — 즉시 '대기' 카드로 띄우게(optimistic). 없으면 그냥 리로드.
  onCreated: (created?: Generation[]) => void;
  armedAutoTags: string[]; // 무장된 자동 태그 — 생성 시 결과물에 자동 적용(별도 네임스페이스)
  topSlot?: ReactNode; // 도크 상단(프롬프트 바로 위)에 끼우는 슬롯 — 멀티 선택 바
  activeProjectId?: string; // 현재 보고 있는 프로젝트 — 생성 시 자동 귀속(로드맵 §0-4)
}

// 노출 모델 화이트리스트(ALLOWED)·숨김 파라미터(HIDDEN_PARAMS)·모델/파라미터/비용 로직은
// useModels 훅으로 추출. onPanelDrop 에서 쓰는 상수만 훅 모듈에서 import 해 재사용.

// duration 초 범위 — CLI 스키마(model get)에 min/max 가 없어 `generate cost` 로 검증한 값으로 보강.
//  seedance_2_0: CLI 가 "duration >= 4" 강제(min=4). 상한은 CLI 가 막지 않으나 실용/비용상 12s 로 둠.
const DURATION_RANGE: Record<string, { min: number; max: number }> = {
  seedance_2_0: { min: 4, max: 12 },
};
function durRange(model: string, def: number): { min: number; max: number } {
  return DURATION_RANGE[model] || { min: 1, max: Math.max(12, def * 2) };
}

// 에셋 파트(분리창)가 localStorage 에 쓴 현재 프로젝트/폴더 — 생성 피커 소스 스코프.
function readAssetCtx(): { project: string; dir: string } {
  try {
    return {
      project: localStorage.getItem("ch.assets.project") || "",
      dir: localStorage.getItem("ch.assets.dir") || "",
    };
  } catch {
    return { project: "", dir: "" };
  }
}

// 모델 옵션 칩 라벨 → 아이콘(텍스트 라벨이 길어 두 줄 되는 것 방지). 이름 키워드로 매칭, 폴백=슬라이더.
function OptIcon({ name }: { name: string }) {
  const n = name.toLowerCase();
  const p = {
    width: 13, height: 13, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 2,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  if (n.includes("aspect") || n.includes("ratio") || n.includes("frame"))
    return <svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /></svg>;
  if (n.includes("duration") || n.includes("time") || n.includes("length") || n.includes("second"))
    return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
  if (n.includes("resolution") || n.includes("quality") || n.includes("size"))
    return <svg {...p}><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" /></svg>;
  if (n.includes("genre") || n.includes("style") || n.includes("preset"))
    return <svg {...p}><path d="M3 7l9-4 9 4-9 4-9-4z" /><path d="M3 12l9 4 9-4" /></svg>;
  if (n.includes("fps") || n.includes("motion") || n.includes("frame_rate"))
    return <svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 5v14M17 5v14" /></svg>;
  if (n.includes("seed"))
    return <svg {...p}><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="1" /><circle cx="15" cy="15" r="1" /></svg>;
  if (n.includes("mode"))
    return <svg {...p}><circle cx="8" cy="8" r="2" /><circle cx="16" cy="16" r="2" /><path d="M8 10v8M16 6v8" /></svg>;
  // 폴백: 슬라이더(일반 설정)
  return <svg {...p}><path d="M5 8h14M5 16h14" /><circle cx="10" cy="8" r="2.4" fill="currentColor" stroke="none" /><circle cx="15" cy="16" r="2.4" fill="currentColor" stroke="none" /></svg>;
}

export function SpotlightPrompt({ onCreated, armedAutoTags, topSlot, activeProjectId }: Props) {
  // 모델/파라미터/비용 로직은 useModels 훅으로 추출(동작 100% 보존). 로드 실패는 setError 로 보고.
  const { type, setType, model, setModel, tunable, typeModels, modelName,
          optionValues, setOptionValues, setOpt, cost, costLoading, pendingOptsRef, setOpenRef } =
    useModels((msg) => setError(msg));
  const [count, setCount] = useState(1); // 한 번에 N장 생성(배치)
  const [open, setOpen] = useState<string | null>(null); // 열린 드롭다운 키(파라미터명 또는 'model')
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // setOpt 가 옵션 선택 후 드롭다운을 닫도록 훅에 setOpen 등록(open/setOpen 은 UI 상태로 컴포넌트에 잔류).
  setOpenRef.current = setOpen;
  // 계정·CLI 연결 상태(하단 상태줄) — 데이터 도메인 훅으로 분리(IME·에디터 무관).
  const { cli, account, acctLoading, checkAccount } = useAccountStatus();
  // @/# 피커
  const [mention, setMention] = useState<{ kind: "@" | "#"; query: string } | null>(null);
  const [allSources, setAllSources] = useState<Generation[]>([]);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [hIdx, setHIdx] = useState(0);
  const [assetCtx, setAssetCtx] = useState(readAssetCtx);
  const editorRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  // 프롬프트 기록(쉘식 ↑↓): historyRef=제출 기록(오래된→최신), histIdxRef=탐색 위치(-1=라이브)
  const historyRef = useRef<HistEntry[]>(loadHistory());
  const histIdxRef = useRef(-1);

  const updatePlaceholder = () => {
    const ed = editorRef.current;
    if (ed) ed.toggleAttribute("data-empty", !hasContent(ed));
  };

  useEffect(() => {
    editorRef.current?.focus();
    updatePlaceholder();
  }, []);

  // Ctrl/⌘+K(또는 툴바 버튼) → 프롬프트로 포커스만.
  useEffect(() => {
    const focus = () => editorRef.current?.focus();
    window.addEventListener("ch:focus-prompt", focus);
    return () => window.removeEventListener("ch:focus-prompt", focus);
  }, []);

  // 에셋 파트(분리창) 프로젝트 변경 알림 → 컨텍스트 갱신.
  // 값이 실제로 바뀐 경우에만 갱신(스크롤 저장 등 다른 ch.assets.* 쓰기로 인한 재요청 폭주 방지).
  useEffect(() => {
    const update = () =>
      setAssetCtx((prev) => {
        const next = readAssetCtx();
        return next.project === prev.project && next.dir === prev.dir ? prev : next;
      });
    const bc = "BroadcastChannel" in window ? new BroadcastChannel("ch-assets") : null;
    bc?.addEventListener("message", update);
    window.addEventListener("storage", update);
    return () => {
      bc?.removeEventListener("message", update);
      bc?.close();
      window.removeEventListener("storage", update);
    };
  }, []);

  // 피커가 열리면 현재 에셋 프로젝트의 모든 S 소스를 로드(폴더 무관 — 클라서 이름/태그 필터).
  useEffect(() => {
    if (!mention) return;
    let alive = true;
    api
      .searchSources(undefined, undefined, assetCtx.project)
      .then((r) => alive && setAllSources(r))
      .catch(() => alive && setAllSources([]));
    return () => {
      alive = false;
    };
  }, [mention?.kind, assetCtx.project]);

  // 태그 목록(개수 포함) — # 피커. mention.query 로 필터.
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of allSources) for (const t of s.tags) m.set(t, (m.get(t) || 0) + 1);
    return m;
  }, [allSources]);
  const tagList = useMemo(() => {
    let tags = [...tagCounts.keys()];
    const q = mention?.kind === "#" ? mention.query.toLowerCase() : "";
    if (q) tags = tags.filter((t) => t.toLowerCase().includes(q));
    return tags.sort((a, b) => a.localeCompare(b));
  }, [tagCounts, mention]);

  // 소스 목록 — @ 피커. tagFilter 로 거른 뒤 이름 필터.
  const sourceList = useMemo(() => {
    let base = allSources;
    if (tagFilter) base = base.filter((s) => s.tags.includes(tagFilter));
    const q = mention?.kind === "@" ? mention.query.toLowerCase() : "";
    if (q) base = base.filter((s) => (s.source_name || "").toLowerCase().includes(q));
    return base;
  }, [allSources, tagFilter, mention]);

  // 멘션/리스트 바뀌면 하이라이트 0 으로.
  useEffect(() => setHIdx(0), [mention?.kind, mention?.query, tagFilter, allSources]);

  // 방향키로 하이라이트 이동 시 그 항목이 보이게 리스트 스크롤(↓ 로 내려가면 함께 이동).
  useEffect(() => {
    listRef.current
      ?.querySelector(".sl-mention-item.on")
      ?.scrollIntoView({ block: "nearest" });
  }, [hIdx]);

  // 실제 입력(내용 변경) — 기록 탐색 종료(사용자가 편집 시작).
  const onEditorInput = () => {
    const ed = editorRef.current;
    if (!ed) return;
    histIdxRef.current = -1;
    updatePlaceholder();
    setMention(composingRef.current ? null : detectMention(ed));
  };
  // 캐럿 이동(keyup/click) — 멘션만 재감지(기록 탐색·placeholder 는 건드리지 않음).
  const onCaretMove = () => {
    const ed = editorRef.current;
    if (ed && !composingRef.current) setMention(detectMention(ed));
  };

  const selectTag = (tag: string) => {
    const ed = editorRef.current;
    if (ed) {
      stripQuery(ed, "#");
      insertTextAtCaret(ed, "@"); // 그 태그로 필터된 @ 소스 피커 자동 오픈
      updatePlaceholder();
    }
    setTagFilter(tag);
    setMention({ kind: "@", query: "" });
    ed?.focus();
  };

  const selectSource = (s: Generation) => {
    const ed = editorRef.current;
    if (!ed) return;
    const a = s.assets[0];
    if (!a) return;
    const isVid = a.type === "video";
    const ref: ChipRef = {
      file_path: a.source_url || a.file_path,
      type: a.type,
      role: isVid ? "@Video" : `@Image${countImageChips(ed) + 1}`,
      name: s.source_name || "source",
      thumb: a.thumbnail_path || a.file_path,
    };
    insertChip(ed, ref);
    updatePlaceholder();
    setMention(null);
    ed.focus();
  };

  const clearTagFilter = () => setTagFilter(null);

  // ── 카드 → 프롬프트 드롭: 그 생성의 프롬프트+옵션 그대로 불러와 재사용 ──
  const onPanelDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-ch-gen")) {
      e.preventDefault(); // drop 허용 + contentEditable 기본 삽입 차단
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onPanelDrop = async (e: React.DragEvent) => {
    const id = e.dataTransfer.getData("application/x-ch-gen");
    if (!id) return;
    e.preventDefault();
    try {
      const g = await api.getGeneration(id);
      const t: "image" | "video" = g.assets[0]?.type === "video" ? "video" : "image";
      // 원래 모델이 화이트리스트에 있으면 유지, 아니면 타입 기본(첫째)로 클램프
      const useModel = ALLOWED[t].includes(g.model || "") ? (g.model as string) : ALLOWED[t][0];
      // 표시 옵션만 추려 임시 보관(프롬프트·미디어 등 내부 파라미터 제외).
      const opts: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(g.params || {})) {
        if (!HIDDEN_PARAMS.has(k) && (typeof v === "string" || typeof v === "number")) {
          opts[k] = v;
        }
      }
      setType(t);
      if (useModel === model) {
        // 모델 동일 → [model] effect 안 돎. 옵션을 직접 병합.
        setOptionValues((prev) => ({ ...prev, ...opts }));
      } else {
        pendingOptsRef.current = opts; // effect 가 기본값 위에 덮어 적용
        setModel(useModel);
      }
      // 프롬프트(칩+텍스트) 복원. display_prompt 로 칩 위치를 살리되,
      // 매칭 칩이 하나도 없고 레퍼런스가 있으면(옛 생성) 말미에 칩으로 붙인다.
      let parts = buildPromptParts(g.display_prompt || g.prompt || "", g.references);
      if (!parts.some((p) => p.t === "chip") && g.references.length) {
        parts = [...parts, ...refsToChips(g.references)];
      }
      const ed = editorRef.current;
      if (ed) {
        restoreParts(ed, parts);
        updatePlaceholder();
        ed.focus();
      }
      setMention(null);
      histIdxRef.current = -1;
    } catch (err) {
      setError(String(err));
    }
  };

  const submit = async () => {
    setError(null);
    const ed = editorRef.current;
    if (!ed) return;
    const { text, refs } = serialize(ed);
    if (!text && refs.length === 0) {
      setError("프롬프트를 입력하세요.");
      ed.focus();
      return;
    }
    if (!model) {
      setError("모델을 선택하세요.");
      return;
    }
    // 표시용 프롬프트(칩 자리에 @소스명) — CLI 본문(text)과 분리해 저장.
    const parts = serializeParts(ed);
    const displayPrompt = partsText(parts);
    setBusy(true);
    try {
      const body = {
        prompt: text || "(no text)",
        display_prompt: displayPrompt || undefined,
        model,
        params: optionValues,
        auto_tags: armedAutoTags, // 무장된 자동 태그를 결과물에 자동 적용
        references: refs.map((r) => ({
          file_path: r.file_path,
          type: r.type,
          role: r.role,
          name: r.name, // 칩 이름(@소스명) — 정보팝업 인라인 칩 매칭
          thumbnail: r.thumb, // 표시용 썸네일(에셋 소스도 정보팝업에서 이미지로 보이게)
        })),
        project_id: activeProjectId, // 보던 프로젝트로 자동 귀속(없으면 미분류)
      };
      // 배치: 같은 설정으로 N장 동시 생성(각각 별도 잡).
      const created = await Promise.all(
        Array.from({ length: Math.max(1, count) }, () => api.create(body)),
      );
      onCreated(created); // 방금 만든 pending 들을 즉시 '대기' 카드로(optimistic) + 리로드
      // 프롬프트 기록에 추가 — 텍스트+칩 구조 보존. 같은 내용은 전부 제거 후 최신으로,
      // 최근 HIST_MAX(20)개만 유지.
      const key = displayPrompt; // 텍스트+@칩 까지 반영한 중복 판정 키
      if (key) {
        const filtered = historyRef.current.filter((h) => h.text !== key);
        filtered.push({ parts, text: key });
        historyRef.current = filtered.slice(-HIST_MAX);
        saveHistory(historyRef.current);
      }
      histIdxRef.current = -1;
      // 도크는 항상 떠 있음 — 비우고 연속 생성.
      ed.innerHTML = "";
      updatePlaceholder();
      setMention(null);
      setBusy(false);
      requestAnimationFrame(() => ed.focus());
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  // 드롭다운(model/ratio) Esc 닫기 — 도크 자체는 항상 떠 있음.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const onEditorKeyDown = (e: React.KeyboardEvent) => {
    // Shift+Backspace: 프롬프트 전체 비우기(PV). 한글 조합 중에도 무조건 — 조합 가드보다 먼저.
    const isBackspace =
      e.key === "Backspace" || e.code === "Backspace" || e.nativeEvent.keyCode === 8;
    if (isBackspace && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const ed = editorRef.current;
      if (ed) {
        ed.blur(); // 조합 강제 종료 후 clear — IME 잔존 방지
        ed.innerHTML = "";
        composingRef.current = false;
        updatePlaceholder();
        setMention(null);
        histIdxRef.current = -1;
        requestAnimationFrame(() => ed.focus());
      }
      return;
    }

    // Esc: 멘션 피커 닫기(+토큰 제거) → tagFilter 해제
    if (e.key === "Escape") {
      const ed = editorRef.current;
      if (mention) {
        e.preventDefault();
        if (ed) {
          stripQuery(ed, mention.kind);
          updatePlaceholder();
        }
        setMention(null);
      } else if (tagFilter) {
        e.preventDefault();
        clearTagFilter();
      }
      return;
    }

    const composing = composingRef.current || e.nativeEvent.isComposing;

    // 프롬프트 기록(쉘식 ↑↓) — 피커 닫힘 + (비었거나 이미 기록 탐색 중)일 때만.
    if (!mention && !composing && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const ed = editorRef.current;
      const hist = historyRef.current;
      const navigating = histIdxRef.current >= 0;
      const empty = ed ? !hasContent(ed) : true;
      if (hist.length && (navigating || empty)) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          const idx = navigating ? Math.max(0, histIdxRef.current - 1) : hist.length - 1;
          histIdxRef.current = idx;
          if (ed) {
            restoreParts(ed, hist[idx].parts);
            updatePlaceholder();
          }
          return;
        }
        // ArrowDown — 기록 탐색 중일 때만(빈 라이브 상태에선 무시)
        if (navigating) {
          e.preventDefault();
          const idx = histIdxRef.current + 1;
          if (idx >= hist.length) {
            histIdxRef.current = -1;
            if (ed) {
              ed.innerHTML = "";
              updatePlaceholder();
              placeCaretAtEnd(ed);
            }
          } else {
            histIdxRef.current = idx;
            if (ed) {
              restoreParts(ed, hist[idx].parts);
              updatePlaceholder();
            }
          }
          return;
        }
      }
    }

    // # 태그 피커 네비
    if (mention?.kind === "#" && tagList.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHIdx((i) => Math.min(i + 1, tagList.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !composing) {
        e.preventDefault();
        selectTag(tagList[Math.max(0, hIdx)]);
        return;
      }
    }

    // @ 소스 피커 네비
    if (mention?.kind === "@" && sourceList.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHIdx((i) => Math.min(i + 1, sourceList.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !composing) {
        e.preventDefault();
        selectSource(sourceList[Math.max(0, hIdx)]);
        return;
      }
    }

    // 평상시 Enter → 생성 (Shift+Enter = 줄바꿈)
    if (e.key === "Enter" && !e.shiftKey && !composing && !mention) {
      e.preventDefault();
      if (!busy) submit();
    }
  };

  return (
    <div className="sl-dockbar">
      <div className="sl-dock">
        {topSlot}
        <div className="sl-panel" onDragOver={onPanelDragOver} onDrop={onPanelDrop}>
          {/* @/# 피커 드롭다운 */}
          {mention && (
            <div className="sl-mention">
              <div className="sl-mention-head">
                {mention.kind === "@" ? "소스 (@이름)" : "태그 (#)"}
                <span className="sl-mention-hint">↑↓ 이동 · Enter 선택 · Esc 닫기</span>
              </div>
              <div className="sl-mention-list" ref={listRef}>
                {mention.kind === "#" ? (
                  tagList.length === 0 ? (
                    <div className="sl-mention-empty">
                      {assetCtx.project ? "태그가 없습니다" : "에셋 창을 열어 프로젝트를 선택하세요"}
                    </div>
                  ) : (
                    tagList.map((t, i) => (
                      <button
                        key={t}
                        className={"sl-mention-item sl-tag-item" + (i === hIdx ? " on" : "")}
                        onMouseEnter={() => setHIdx(i)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectTag(t);
                        }}
                      >
                        <span className="sl-tag-hash">#</span>
                        <span className="sl-mention-name">{t}</span>
                        <span className="sl-tag-count">{tagCounts.get(t)}</span>
                      </button>
                    ))
                  )
                ) : sourceList.length === 0 ? (
                  <div className="sl-mention-empty">
                    {assetCtx.project
                      ? tagFilter
                        ? `'#${tagFilter}' 소스가 없습니다`
                        : "소스가 없습니다 (에셋/그리드에서 S 등록)"
                      : "에셋 창을 열어 프로젝트를 선택하세요"}
                  </div>
                ) : (
                  sourceList.map((s, i) => {
                    const a = s.assets[0];
                    const thumb = a?.thumbnail_path || a?.file_path;
                    return (
                      <button
                        key={s.id}
                        className={"sl-mention-item" + (i === hIdx ? " on" : "")}
                        onMouseEnter={() => setHIdx(i)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectSource(s);
                        }}
                      >
                        {thumb ? <img src={thumb} alt="" /> : <span className="sl-mention-ph" />}
                        <span className="sl-mention-name">@{s.source_name || "source"}</span>
                        <span className="sl-mention-tags">
                          {s.tags.map((t) => (
                            <span key={t} className="sl-mention-tag">
                              #{t}
                            </span>
                          ))}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* 프롬프트 행 */}
          <div className={"sl-prompt-row" + (tagFilter ? " tag-active" : "")}>
            {tagFilter && (
              <span className="sl-tag-badge" title="태그 필터 (Esc 또는 × 로 해제)">
                #{tagFilter}
                <button onMouseDown={(e) => { e.preventDefault(); clearTagFilter(); }}>×</button>
              </span>
            )}
            <div
              ref={editorRef}
              className="sl-prompt"
              contentEditable
              suppressContentEditableWarning
              data-placeholder="Describe the scene you imagine --- @Source, #Tag"
              onInput={onEditorInput}
              onKeyUp={onCaretMove}
              onClick={onCaretMove}
              onKeyDown={onEditorKeyDown}
              onCompositionStart={() => (composingRef.current = true)}
              onCompositionEnd={() => {
                composingRef.current = false;
                onEditorInput();
              }}
            />
          </div>

          {/* 컨트롤 행 */}
          <div className="sl-controls">
            <div className="sl-left">
              <div className="sl-type">
                <button
                  className={"sl-type-btn" + (type === "image" ? " active" : "")}
                  onClick={() => setType("image")}
                >
                  Image
                </button>
                <button
                  className={"sl-type-btn" + (type === "video" ? " active" : "")}
                  onClick={() => setType("video")}
                >
                  Video
                </button>
              </div>

              <div className="sl-chip-wrap">
                <button
                  className={"sl-chip" + (open === "model" ? " active" : "")}
                  onClick={() => setOpen(open === "model" ? null : "model")}
                >
                  <span className="sl-dot" />
                  <span className="sl-chip-label">{modelName}</span>
                  <span className="sl-caret">›</span>
                </button>
                {open === "model" && (
                  <div className="sl-dropdown">
                    <div className="sl-dd-title">{type === "video" ? "영상" : "이미지"} 모델</div>
                    <div className="sl-dd-scroll">
                      {typeModels.map((m) => (
                        <button
                          key={m.job_set_type}
                          className={"sl-dd-item" + (m.job_set_type === model ? " sel" : "")}
                          onClick={() => {
                            setModel(m.job_set_type);
                            setOpen(null);
                          }}
                        >
                          {m.display_name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* 모델별 CLI 조절 옵션(동적) — duration=슬라이더, enum=드롭다운, 정수=숫자 입력 */}
              {tunable.map((p) => {
                // 듀레이션 → 슬라이더(enum 이면 그 값들에 스냅, 정수면 1..최댓값 범위)
                if (/duration|length/i.test(p.name)) {
                  if (p.enum?.length) {
                    const vals = p.enum;
                    const cur = String(optionValues[p.name] ?? p.default ?? vals[0]);
                    const idx = Math.max(0, vals.indexOf(cur));
                    return (
                      <div className="sl-chip sl-opt-slider" key={p.name} title={p.name}>
                        <span className="sl-opt-ic"><OptIcon name={p.name} /></span>
                        <input
                          type="range"
                          min={0}
                          max={vals.length - 1}
                          step={1}
                          value={idx}
                          onChange={(e) => setOpt(p.name, vals[Number(e.target.value)])}
                        />
                        <span className="sl-opt-val">{cur}s</span>
                      </div>
                    );
                  }
                  const def = Number(p.default) || 5;
                  const { min: dmin, max: dmax } = durRange(model, def);
                  const raw = Number(optionValues[p.name] ?? def) || def;
                  const cur = Math.min(dmax, Math.max(dmin, raw)); // 범위 밖 값 클램프
                  return (
                    <div className="sl-chip sl-opt-slider" key={p.name} title={`${p.name} (${dmin}~${dmax}s)`}>
                      <span className="sl-opt-ic"><OptIcon name={p.name} /></span>
                      <input
                        type="range"
                        min={dmin}
                        max={dmax}
                        step={1}
                        value={cur}
                        onChange={(e) =>
                          setOptionValues((prev) => ({ ...prev, [p.name]: Number(e.target.value) }))
                        }
                      />
                      <span className="sl-opt-val">{cur}s</span>
                    </div>
                  );
                }
                return p.enum?.length ? (
                  <div className="sl-chip-wrap" key={p.name}>
                    <button
                      className={"sl-chip sl-opt-chip" + (open === p.name ? " active" : "")}
                      onClick={() => setOpen(open === p.name ? null : p.name)}
                      title={p.name}
                    >
                      <span className="sl-opt-ic"><OptIcon name={p.name} /></span>
                      <span>{String(optionValues[p.name] ?? p.default ?? "")}</span>
                      <span className="sl-caret">›</span>
                    </button>
                    {open === p.name && (
                      <div className="sl-dropdown">
                        <div className="sl-dd-scroll">
                          {p.enum.map((v) => (
                            <button
                              key={v}
                              className={"sl-dd-item" + (optionValues[p.name] === v ? " sel" : "")}
                              onClick={() => setOpt(p.name, v)}
                            >
                              {v}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : p.type === "integer" ? (
                  <label className="sl-chip sl-opt-num" key={p.name} title={p.name}>
                    <span className="sl-opt-ic"><OptIcon name={p.name} /></span>
                    <input
                      type="number"
                      value={String(optionValues[p.name] ?? p.default ?? "")}
                      onChange={(e) =>
                        setOptionValues((prev) => ({
                          ...prev,
                          [p.name]: e.target.value === "" ? "" : Number(e.target.value),
                        }))
                      }
                    />
                  </label>
                ) : null;
              })}

              {/* 배치: 한 번에 N장 (1/4) */}
              <div className="sl-count" title="한 번에 생성할 장수">
                <button
                  className="sl-count-btn"
                  onClick={() => setCount((c) => Math.max(1, c - 1))}
                  disabled={count <= 1}
                >
                  −
                </button>
                <span className="sl-count-val">
                  {count}/{MAX_COUNT}
                </span>
                <button
                  className="sl-count-btn"
                  onClick={() => setCount((c) => Math.min(MAX_COUNT, c + 1))}
                  disabled={count >= MAX_COUNT}
                >
                  +
                </button>
              </div>
            </div>

            <button className="sl-gen" disabled={busy} onClick={submit}>
              {busy ? "생성 중…" : count > 1 ? `Generate ${count}` : "Generate"}{" "}
              <span className="sl-sparkle">✦</span>
              {costLoading ? (
                <span className="sl-cost loading">…</span>
              ) : (
                cost != null && cost > 0 && <span className="sl-cost">{cost * count}</span>
              )}
            </button>
          </div>
        </div>

        {error && <div className="sl-error">{error}</div>}

        <button
          type="button"
          className="sl-status"
          title="클릭 — 연결·크레딧 수동 확인"
          onClick={checkAccount}
        >
          <span className={"sl-status-dot" + (cli ? " on" : "")} />
          <span>
            {acctLoading
              ? "확인 중…"
              : cli == null
                ? "클릭해 연결 확인"
                : cli
                  ? "연결됨"
                  : "미연결"}
          </span>
          {account?.credits != null && (
            <>
              <span className="sl-status-sep">·</span>
              <span className="sl-status-credits">
                {account.credits.toLocaleString(undefined, { maximumFractionDigits: 2 })} credits
              </span>
            </>
          )}
          {account?.email && (
            <>
              <span className="sl-status-sep">·</span>
              <span className="sl-status-user" title={account.email}>
                {account.email}
              </span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
