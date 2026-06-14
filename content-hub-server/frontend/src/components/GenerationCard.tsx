// 결과 카드 — Higgsfield식 상호작용:
//  · 영상 썸네일 호버 시 자동 재생(음소거 루프), 벗어나면 정지
//  · 미디어 위 호버 오버레이 액션(정보·다운로드·미리보기·재생성·공유/가져오기)
//  · 좌상단 선택 체크박스(다중 선택 → 상단 일괄 작업 바)
// 그리드 모드 = 세로 카드, 리스트 모드 = 좌측 큰 썸네일 + 우측 상세 패널.
import { useRef, useState } from "react";
import type { Generation, InfoTarget, PreviewTarget } from "../types";
import { buildPromptParts, refSrc } from "../lib/promptParts";

const ME = "me"; // 현재 작업자(DEFAULT_WORKER_ID) — 팀 탭에서 내 것/남의 것 구분

const STATUS_LABEL: Record<string, string> = {
  pending: "대기",
  running: "생성중",
  done: "완료",
  failed: "실패",
};

interface Props {
  gen: Generation;
  tab: "my" | "team";
  layout?: "grid" | "list";
  fill?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  onSetSource: (g: Generation, name: string | null, isSource: boolean) => void; // 인라인 소스 등록
  onSetTags: (g: Generation, tags: string[]) => void; // 인라인 태그 저장
  onOpenComments: (g: Generation) => void; // C → 공유 코멘트 스레드 패널 열기
  // 인라인 편집 — 그리드가 소유(버튼·단축키 공통). 이 카드가 편집 대상이면 field, 아니면 null.
  editingField?: "source" | "tag" | null;
  onRequestEdit: (g: Generation, field: "source" | "tag") => void;
  onEditDone: () => void;
  onRegenerate: (g: Generation) => void;
  onPublish: (g: Generation) => void;
  onUnpublish: (g: Generation) => void;
  onImport: (g: Generation) => void;
  onColor: (g: Generation, color: string | null) => void;
  onTags: (g: Generation) => void;
  onInfo: (t: InfoTarget) => void;
  onPreview: (t: PreviewTarget) => void;
}

export function GenerationCard({
  gen,
  tab,
  layout,
  fill = true,
  selected = false,
  onToggleSelect,
  onSetSource,
  onSetTags,
  onOpenComments,
  editingField,
  onRequestEdit,
  onEditDone,
  onRegenerate,
  onPublish,
  onUnpublish,
  onImport,
  onInfo,
  onPreview,
}: Props) {
  const asset = gen.assets[0];
  const isVideo = asset?.type === "video";
  const thumb = asset?.thumbnail_path || (!isVideo ? asset?.file_path : null);
  const isList = layout === "list";
  const videoRef = useRef<HTMLVideoElement>(null);
  // T 버튼 → 적용된 태그 목록 팝업(보기/✕삭제). 태그 '입력'은 # 키(editingField) 로만 — 에셋과 동일.
  const [showTags, setShowTags] = useState(false);

  const params = (gen.params || {}) as Record<string, unknown>;

  const previewName = gen.prompt.slice(0, 50) || "(제목 없음)";
  const openPreview = () => {
    if (asset) onPreview({ url: asset.file_path, type: asset.type, name: previewName });
  };
  // 카드를 프롬프트로 드래그 → 그 프롬프트+옵션 재사용(SpotlightPrompt 드롭). gen id 만 실음.
  const onCardDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("application/x-ch-gen", gen.id);
    e.dataTransfer.effectAllowed = "copy";
  };
  const onEnter = () => {
    const v = videoRef.current;
    if (v) v.play().catch(() => {});
  };
  const onLeave = () => {
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.currentTime = 0;
    }
  };

  const thumbBox = (
    <div
      className="card-thumb"
      // 리스트: 미디어 종횡비와 무관하게 행 높이를 꽉 채우는 정사각(에셋 리스트와 동일 — 이미지·영상 동일 크기)
      style={isList ? { aspectRatio: "1 / 1" } : undefined}
      title={isList ? "클릭 = 미리보기 · 휠클릭 = 정보" : "클릭 = 선택 · 더블클릭 = 미리보기 · 휠클릭 = 정보"}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={isList ? openPreview : undefined}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault(); // 휠클릭 자동스크롤 방지
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onInfo({ kind: "generation", gen, x: e.clientX, y: e.clientY });
        }
      }}
    >
      {thumb && isVideo ? (
        // 영상: 포스터(썸네일) 위에 호버 시 재생할 video 를 올려둠
        <video
          ref={videoRef}
          src={asset!.file_path}
          poster={thumb}
          muted
          loop
          playsInline
          preload="none"
          draggable={false}
        />
      ) : thumb ? (
        <img src={thumb} loading="lazy" alt={gen.prompt} draggable={false} />
      ) : isVideo && asset ? (
        <video ref={videoRef} src={asset.file_path} muted loop playsInline preload="metadata" draggable={false} />
      ) : (
        <div
          className={`thumb-placeholder status-${gen.status}`}
          title={gen.status === "failed" && gen.error ? gen.error : undefined}
        >
          {STATUS_LABEL[gen.status] || gen.status}
        </div>
      )}

      {gen.is_source && (
        <span className="source-badge" title="소스로 등록됨">
          @{gen.source_name || "source"}
        </span>
      )}
      {!gen.is_mine && (
        <span
          className="creator-badge"
          title={`다른 작업자가 생성: ${gen.creator_name || gen.creator_uid || ""}`}
        >
          👤 {gen.creator_name || "팀원"}
        </span>
      )}
      {isVideo && <span className="play-badge">▶</span>}
      {gen.status !== "done" && (
        <span
          className={`status-pill status-${gen.status}`}
          title={gen.status === "failed" && gen.error ? gen.error : undefined}
        >
          {STATUS_LABEL[gen.status] || gen.status}
        </span>
      )}

      {/* 호버 오버레이 액션 */}
      <div className="thumb-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="ov-top">
          {onToggleSelect && isList && (
            <label className="ov-check" title="선택">
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onToggleSelect(gen.id)}
              />
            </label>
          )}
          <button
            className="ov-icon"
            style={{ marginLeft: "auto" }} // 정보 버튼은 항상 우측 상단(체크박스 유무 무관)
            title="정보"
            onClick={(e) =>
              onInfo({ kind: "generation", gen, x: e.clientX, y: e.clientY })
            }
          >
            ⓘ
          </button>
        </div>
        <div className="ov-bottom">
          {asset && (
            <button
              className="ov-icon"
              title="다운로드"
              onClick={() => download(asset.file_path, downloadName(gen, asset.type))}
            >
              ⤓
            </button>
          )}
          {tab === "team" ? (
            gen.worker_id === ME ? (
              // 팀 공유 폴더의 내 생성물 → 공유 해제
              <button
                className="ov-icon ov-icon-on"
                title="팀 공유 해제하기"
                onClick={() => onUnpublish(gen)}
              >
                ⤫
              </button>
            ) : (
              // 다른 작업자의 생성물 → 내 워크스페이스로 가져오기
              <button className="ov-icon" title="내 워크스페이스로 가져오기" onClick={() => onImport(gen)}>
                ⬇
              </button>
            )
          ) : (
            <>
              <button className="ov-icon" title="재생성" onClick={() => onRegenerate(gen)}>
                ↻
              </button>
              {gen.status === "done" &&
                (gen.shared ? (
                  <button
                    className="ov-icon ov-icon-on"
                    title="팀 공유 해제하기"
                    onClick={() => onUnpublish(gen)}
                  >
                    ⤫
                  </button>
                ) : (
                  <button className="ov-icon" title="팀에 공유" onClick={() => onPublish(gen)}>
                    ↗
                  </button>
                ))}
            </>
          )}
        </div>
      </div>
    </div>
  );

  // 상태 표시줄: S(소스)·T(태그)·C(코멘트). 회색 기본, 적용되면 컬러.
  // r/g/b 로 지정한 카드 컬러(gen.color)는 이 줄 전체를 틴트한다(그리드는 진하게).
  const statusBar = (
    <div
      className="card-status"
      style={!isList && gen.color ? { background: gen.color + "80" } : undefined}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {editingField ? (
        <input
          className="cs-tag-input"
          autoFocus
          defaultValue={editingField === "source" ? gen.source_name || "" : gen.tags.join(", ")}
          placeholder={editingField === "source" ? "소스 이름 @이름 ⏎" : "태그(쉼표 구분) ⏎"}
          onKeyDown={(e) => {
            e.stopPropagation();
            const v = (e.target as HTMLInputElement).value;
            if (e.key === "Enter") {
              if (editingField === "source") onSetSource(gen, v.trim() || null, true);
              else onSetTags(gen, v.split(",").map((s) => s.trim()).filter(Boolean));
              onEditDone();
            } else if (e.key === "Escape") {
              onEditDone();
            }
          }}
          onBlur={onEditDone}
        />
      ) : (
        <>
          <button
            className={"cs-btn s" + (gen.is_source ? " on" : "")}
            title={gen.is_source ? `소스: @${gen.source_name || ""} · 클릭=해제` : "소스로 등록 (s)"}
            onClick={() => (gen.is_source ? onSetSource(gen, null, false) : onRequestEdit(gen, "source"))}
          >
            S
          </button>
          <button
            className={"cs-btn t" + (gen.tags.length ? " on" : "") + (showTags ? " active" : "")}
            title={gen.tags.length ? `태그 ${gen.tags.length}개: ${gen.tags.join(", ")}` : "적용된 태그 없음 (# 키로 추가)"}
            onClick={() => setShowTags((v) => !v)}
          >
            T
          </button>
          <button
            className={"cs-btn c" + (gen.has_unread ? " on" : "")}
            title={
              gen.has_unread
                ? `새 코멘트 · 총 ${gen.comment_count}개 (c)`
                : gen.comment_count
                  ? `코멘트 ${gen.comment_count}개 (c)`
                  : "코멘트 스레드 열기 (c)"
            }
            onClick={() => onOpenComments(gen)}
          >
            C
          </button>
          {showTags && (
            <div className="cs-tagpop" onClick={(e) => e.stopPropagation()}>
              <div className="cs-tagpop-head">
                <span className="cs-tagpop-title">태그 {gen.tags.length}</span>
                <button className="cs-tagpop-close" title="닫기" onClick={() => setShowTags(false)}>
                  ×
                </button>
              </div>
              <div className="cs-tagpop-body">
                {gen.tags.length ? (
                  gen.tags.map((t) => (
                    <span className="cs-tag-chip" key={t}>
                      {t}
                      <button
                        className="cs-tag-x"
                        title="태그 제거"
                        onClick={() => onSetTags(gen, gen.tags.filter((x) => x !== t))}
                      >
                        ×
                      </button>
                    </span>
                  ))
                ) : (
                  <span className="cs-tag-empty">태그 없음 · 카드 선택 후 # 키로 추가</span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );

  // ── 리스트 모드 ──
  if (isList) {
    const resolution = typeof params.resolution === "string" ? params.resolution : undefined;
    const duration =
      typeof params.duration === "number"
        ? `${params.duration.toFixed(1)}s`
        : typeof params.duration === "string"
          ? params.duration
          : undefined;
    const aspect = typeof params.aspect_ratio === "string" ? params.aspect_ratio : undefined;
    const ref = gen.references[0];
    const refThumb = ref?.thumbnail_path || ref?.file_path;
    // 프롬프트의 @소스 토큰을 레퍼런스 썸네일 칩으로 치환(InfoPopup 과 동일 로직)
    const promptParts = buildPromptParts(gen.display_prompt || "", gen.references);
    const promptHasInlineRefs = promptParts.some((p) => p.t === "chip");

    return (
      <div
        className={"card list" + (fill ? "" : " contain") + (selected ? " selected" : "")}
        draggable
        onDragStart={onCardDragStart}
      >
        {thumbBox}
        {gen.color && <div className="list-color-bar" style={{ background: gen.color }} />}
        <div className="card-detail">
          <div className="cd-model">
            <ModelIcon />
            {modelLabel(gen.model)}
          </div>
          {promptHasInlineRefs ? (
            // 프롬프트의 @소스 자리를 실제 레퍼런스 썸네일로 인라인 표시(어떤 이미지가 어디 들어갔는지)
            <div className="cd-prompt cd-prompt-rich" title={gen.display_prompt || gen.prompt}>
              {promptParts.map((p, i) =>
                p.t === "text" ? (
                  <span key={i}>{p.v}</span>
                ) : (
                  <button
                    key={i}
                    type="button"
                    className="inline-ref inline-ref-static inline-ref-btn"
                    title={`${p.ref.name} — 크게 보기`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onPreview({
                        url: refSrc(p.ref.file_path) || p.ref.thumb,
                        type: p.ref.type,
                        name: p.ref.name,
                      });
                    }}
                  >
                    {p.ref.thumb && <img src={p.ref.thumb} alt="" />}
                    <span className="inline-ref-name">{p.ref.name}</span>
                  </button>
                ),
              )}
            </div>
          ) : (
            <>
              <div className="cd-prompt" title={gen.display_prompt || gen.prompt}>
                {gen.display_prompt || gen.prompt || "(프롬프트 없음)"}
              </div>
              {refThumb && (
                <div className="cd-refs">
                  <img src={refThumb} className="cd-ref-thumb" title={ref?.role || "레퍼런스"} alt="reference" />
                </div>
              )}
            </>
          )}
          <div className="cd-meta">
            {resolution && (
              <span className="cd-chip">
                <GemIcon /> {resolution}
              </span>
            )}
            {duration && (
              <span className="cd-chip">
                <ClockIcon /> {duration}
              </span>
            )}
            {aspect && (
              <span className="cd-chip">
                <FrameIcon /> {aspect}
              </span>
            )}
          </div>
          <div className="cd-foot">
            <span className="cd-date">{fmtDate(gen.created_at)}</span>
          </div>
          {statusBar}
        </div>
      </div>
    );
  }

  // ── 그리드 모드 ── 정사각 썸네일 + 하단 컬러/S·T·C 바(에셋 파트와 동일). 액션은 호버 오버레이.
  return (
    <div
      className={"card card-grid" + (fill ? "" : " contain") + (selected ? " selected" : "")}
      draggable
      onDragStart={onCardDragStart}
    >
      {thumbBox}
      {statusBar}
    </div>
  );
}

// ── 헬퍼 ──
function download(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  if (url.startsWith("/")) {
    // 로컬 보관본(같은 출처) → 실제 파일 다운로드
    a.download = name;
  } else {
    // 원격 URL → 다운로드 속성이 무시되므로 새 탭으로(앱 이탈 방지)
    a.target = "_blank";
    a.rel = "noopener";
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadName(gen: Generation, type: string): string {
  const base = (gen.prompt || gen.id).slice(0, 40).replace(/[\\/:*?"<>|]+/g, "_").trim();
  const ext = type === "video" ? "mp4" : "png";
  return `${base || gen.id}.${ext}`;
}

// "seedance_2_0" → "Seedance 2.0", "seedance_2_0_fast" → "Seedance 2.0 Fast"
function modelLabel(m: string | null): string {
  if (!m) return "—";
  const words: string[] = [];
  let nums: string[] = [];
  for (const part of m.split("_")) {
    if (/^\d+$/.test(part)) {
      nums.push(part);
    } else {
      if (nums.length) {
        words.push(nums.join("."));
        nums = [];
      }
      words.push(part.charAt(0).toUpperCase() + part.slice(1));
    }
  }
  if (nums.length) words.push(nums.join("."));
  return words.join(" ");
}

function fmtDate(s: string): string {
  const d = new Date(s.replace(" ", "T"));
  if (isNaN(d.getTime())) return s.slice(0, 10);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

const ICON = {
  viewBox: "0 0 24 24",
  width: 13,
  height: 13,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
function ModelIcon() {
  return (
    <svg {...ICON} width={14} height={14}>
      <line x1="6" y1="20" x2="6" y2="13" />
      <line x1="12" y1="20" x2="12" y2="8" />
      <line x1="18" y1="20" x2="18" y2="4" />
    </svg>
  );
}
function GemIcon() {
  return (
    <svg {...ICON}>
      <polygon points="12 3 19 9 12 21 5 9 12 3" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg {...ICON}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  );
}
function FrameIcon() {
  return (
    <svg {...ICON}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
    </svg>
  );
}

