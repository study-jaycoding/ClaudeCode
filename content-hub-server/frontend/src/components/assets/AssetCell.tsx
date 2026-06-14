// Assets 그리드/리스트의 단일 셀(메모이제이션) — 미디어 썸네일 + 호버 오버레이 + S·T·C 상태줄.
// 핸들러는 path 인자를 받는 안정 참조로만 받아 React.memo 가 변화 없는 셀을 건너뛴다.
import { memo, useRef, useState } from "react";
import { api } from "../../api";
import type { AssetMeta, AssetNode, InfoTarget } from "../../types";

export const AssetCell = memo(function AssetCell({
  project,
  node,
  idx,
  layout,
  scale,
  fit,
  selected,
  focused,
  meta,
  editingTag,
  onS,
  onC,
  onTagCommit,
  onTagCancel,
  onTagRemove,
  onInfo,
  onExportDrag,
}: {
  project: string;
  node: AssetNode;
  idx: number;
  layout: "grid" | "list";
  scale: number;
  fit: "cover" | "contain";
  selected: boolean;
  focused: boolean;
  meta: AssetMeta;
  editingTag: boolean;
  onS: (path: string) => void;
  onC: (path: string) => void;
  onTagCommit: (path: string, tags: string[]) => void;
  onTagCancel: () => void;
  onTagRemove: (path: string, tag: string) => void;
  onInfo: (t: InfoTarget) => void;
  // 네이티브 파일 드래그 시작 → 부모가 선택 상태를 보고 단일/다중(zip) DownloadURL 설정 + 마퀴 취소
  onExportDrag: (path: string, dt: DataTransfer) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [showTags, setShowTags] = useState(false); // # 버튼 클릭 시 적용된 태그 목록 표시
  const url = api.assetFileUrl(project, node.path);
  const isVideo = node.type === "video";
  const isAudio = node.type === "audio";
  const isList = layout === "list";
  // 이미지는 리사이즈 썸네일로(풀해상도 디코딩 렉 방지). 영상/오디오는 원본 사용.
  const imgSrc = node.type === "image" ? api.assetThumbUrl(project, node.path, 512) : url;

  // list: 행 높이를 슬라이더로 고정(메인 라이브러리식) → 썸네일이 행 높이를 꽉 채우는 정사각.
  // grid: padding-bottom 트릭으로 정사각.
  const rowH = Math.round(200 * scale); // 리스트 행 높이(=썸네일 한 변)
  const cellStyle: React.CSSProperties | undefined = isList ? { height: rowH } : undefined;
  const mediaStyle: React.CSSProperties = isList
    ? { width: rowH, height: "100%" } // 셀 높이(rowH)를 꽉 채우는 정사각
    : { position: "relative", width: "100%", height: 0, paddingBottom: "100%", boxSizing: "content-box" };
  const fillStyle: React.CSSProperties = isList
    ? { width: "100%", height: "100%", objectFit: fit }
    : { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: fit };

  const onEnter = () => {
    (videoRef.current || audioRef.current)?.play().catch(() => {});
  };
  const onLeave = () => {
    const m = videoRef.current || audioRef.current;
    if (m) {
      m.pause();
      m.currentTime = 0;
    }
  };
  const info = (x: number, y: number) =>
    onInfo({ kind: "file", project, node, meta, x, y });

  // OS·외부 앱으로 카드를 끌어다 놓으면 파일이 그 위치에 그대로 저장됨(브라우저 네이티브 다운로드 드래그).
  // 단일/다중(zip) 판단은 현재 선택을 아는 부모가 처리. 이미지 표시는 썸네일이지만 내보내는 건 항상 원본.
  const onMediaDragStart = (e: React.DragEvent) => {
    onExportDrag(node.path, e.dataTransfer);
  };

  // 상태줄: 컬러 레이어(배경) 위에 S·#·C 버튼이 불투명하게 올라가 컬러 영향 안 받음.
  // 태그 입력은 키보드 # (선택 카드)로만. # 버튼 클릭은 적용된 태그 목록을 펼쳐 보여줌.
  const statusBar = (
    <div
      className="card-status"
      style={!isList && meta.color ? { background: meta.color + "80" } : undefined}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {editingTag ? (
        <input
          className="cs-tag-input"
          autoFocus
          placeholder="태그 입력(쉼표) ⏎"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              const add = (e.target as HTMLInputElement).value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              onTagCommit(node.path, add);
            } else if (e.key === "Escape") {
              onTagCancel();
            }
          }}
          onBlur={onTagCancel}
        />
      ) : (
        <>
          <button
            className={"cs-btn s" + (meta.is_source ? " on" : "")}
            title={meta.is_source ? `소스: @${meta.source_name || ""} · 클릭=해제` : "소스로 등록 (s)"}
            onClick={() => onS(node.path)}
          >
            S
          </button>
          <button
            className={"cs-btn t" + (meta.tags.length ? " on" : "") + (showTags ? " active" : "")}
            title={meta.tags.length ? `태그 ${meta.tags.length}개: ${meta.tags.join(", ")}` : "적용된 태그 없음"}
            onClick={() => setShowTags((v) => !v)}
          >
            T
          </button>
          <button
            className={"cs-btn c" + (meta.has_unread ? " on" : "")}
            title={
              meta.comment_count
                ? `코멘트 ${meta.comment_count}개${meta.has_unread ? " · 미확인" : ""}`
                : "코멘트 (c)"
            }
            onClick={() => onC(node.path)}
          >
            C
          </button>
          {showTags && (
            <div className="cs-tagpop" onClick={(e) => e.stopPropagation()}>
              <div className="cs-tagpop-head">
                <span className="cs-tagpop-title">태그 {meta.tags.length}</span>
                <button className="cs-tagpop-close" title="닫기 (#)" onClick={() => setShowTags(false)}>
                  ×
                </button>
              </div>
              <div className="cs-tagpop-body">
                {meta.tags.length ? (
                  meta.tags.map((t) => (
                    <span className="cs-tag-chip" key={t}>
                      {t}
                      <button className="cs-tag-x" title="태그 제거" onClick={() => onTagRemove(node.path, t)}>
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

  // 선택/마퀴/키보드는 그리드 컨테이너에서 위임 처리(data-idx 로 식별).
  return (
    <div
      className={
        "asset-cell" +
        (isList ? " list" : "") +
        (selected ? " selected" : "") +
        (focused ? " focused" : "")
      }
      style={cellStyle}
      data-idx={idx}
    >
      <div
        className="asset-media"
        style={mediaStyle}
        title={node.name}
        draggable
        onDragStart={onMediaDragStart}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        {isVideo ? (
          <video ref={videoRef} src={url} muted loop playsInline preload="metadata" draggable={false} style={fillStyle} />
        ) : isAudio ? (
          <div className="audio-tile" style={fillStyle}>
            <span className="audio-glyph">🎵</span>
            <audio ref={audioRef} src={url} loop preload="none" />
          </div>
        ) : (
          <img
            src={imgSrc}
            loading="lazy"
            decoding="async"
            draggable={false}
            alt={node.name}
            style={fillStyle}
          />
        )}
        {isVideo && <span className="play-badge">▶</span>}
        {isAudio && <span className="play-badge">♪</span>}

        <div
          className="thumb-overlay"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <div className="ov-top">
            <button className="ov-icon" title="정보" onClick={(e) => info(e.clientX, e.clientY)}>
              ⓘ
            </button>
          </div>
          <div className="ov-bottom">
            {!isList && <span className="ov-name">{node.name}</span>}
            <button className="ov-icon" title="다운로드" onClick={() => download(url, node.name)}>
              ⤓
            </button>
          </div>
        </div>
      </div>

      {isList && meta.color && (
        <div className="list-color-bar" style={{ background: meta.color }} />
      )}
      {isList ? (
        <div className="card-detail">
          <div className="cd-model">
            <span className="cd-type-ic">{isVideo ? "🎬" : isAudio ? "🎵" : "🖼"}</span>
            {node.name}
          </div>
          <button
            className="info-path-btn cd-path"
            title="원본 위치 열기 (탐색기)"
            onClick={(e) => {
              e.stopPropagation();
              api.revealAsset(project, node.path).catch((err) => alert(`원본 위치 열기 실패: ${err}`));
            }}
          >
            <span className="info-path">{node.path}</span>
            <span className="info-path-icon">↗</span>
          </button>
          <div className="cd-meta">
            <span className="cd-chip">{isVideo ? "영상" : isAudio ? "오디오" : "이미지"}</span>
            {meta.tags.length > 0 && <span className="cd-chip"># {meta.tags.join(", ")}</span>}
            {meta.is_source && <span className="cd-chip">@{meta.source_name || "소스"}</span>}
          </div>
          {statusBar}
        </div>
      ) : (
        statusBar
      )}
    </div>
  );
});

// 다운로드: 로컬 서빙 URL 은 download 속성, 외부 URL 은 새 탭.
function download(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  if (url.startsWith("/")) a.download = name;
  else {
    a.target = "_blank";
    a.rel = "noopener";
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
}
