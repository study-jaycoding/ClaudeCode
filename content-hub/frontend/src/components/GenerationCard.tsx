// 썸네일 카드 (DESIGN.md §4): 썸네일 + 컬러 마커 + 타입 배지 + 프롬프트 + 태그 + 액션.
import type { Generation } from "../types";

const STATUS_LABEL: Record<string, string> = {
  pending: "대기",
  running: "생성중",
  done: "완료",
  failed: "실패",
};

interface Props {
  gen: Generation;
  tab: "my" | "team";
  onRegenerate: (g: Generation) => void;
  onPublish: (g: Generation) => void;
  onImport: (g: Generation) => void;
  onColor: (g: Generation, color: string | null) => void;
  onTags: (g: Generation) => void;
}

export function GenerationCard({
  gen,
  tab,
  onRegenerate,
  onPublish,
  onImport,
  onColor,
  onTags,
}: Props) {
  const asset = gen.assets[0];
  const isVideo = asset?.type === "video";
  const thumb = asset?.thumbnail_path || (!isVideo ? asset?.file_path : null);

  return (
    <div className="card">
      <div className="card-thumb">
        {gen.color && (
          <span
            className="color-marker"
            style={{ background: gen.color }}
            title={gen.color}
          />
        )}
        <span className="type-badge">{isVideo ? "🎬 영상" : "🖼 이미지"}</span>
        {thumb ? (
          <img src={thumb} loading="lazy" alt={gen.prompt} />
        ) : isVideo && asset ? (
          <video src={asset.file_path} muted preload="metadata" />
        ) : (
          <div className={`thumb-placeholder status-${gen.status}`}>
            {STATUS_LABEL[gen.status] || gen.status}
          </div>
        )}
        {gen.status !== "done" && (
          <span className={`status-pill status-${gen.status}`}>
            {STATUS_LABEL[gen.status] || gen.status}
          </span>
        )}
      </div>

      <div className="card-body">
        <div className="card-prompt" title={gen.prompt}>
          {gen.prompt}
        </div>
        <div className="card-tags">
          {gen.tags.slice(0, 3).map((t) => (
            <span key={t} className="tag-chip">
              {t}
            </span>
          ))}
        </div>
        <div className="card-foot">
          <span className="worker" title={gen.worker_name || gen.worker_id}>
            {(gen.worker_name || "?").slice(0, 1)}
          </span>
          <div className="card-actions">
            {tab === "team" ? (
              <button title="내 워크스페이스로 가져오기" onClick={() => onImport(gen)}>
                ⬇ 가져오기
              </button>
            ) : (
              <>
                <button title="컬러 마커" onClick={() => onColor(gen, pickColor())}>
                  ●
                </button>
                <button title="태그 편집" onClick={() => onTags(gen)}>
                  #
                </button>
                <button title="재생성" onClick={() => onRegenerate(gen)}>
                  ↻
                </button>
                {gen.status === "done" && !gen.shared && (
                  <button title="팀에 공유" onClick={() => onPublish(gen)}>
                    ↗
                  </button>
                )}
                {gen.shared && <span className="shared-badge" title="공유됨">✓공유</span>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const PALETTE = ["#ff5722", "#ffc107", "#4caf50", "#2196f3", "#9c27b0", null];
function pickColor(): string | null {
  // 간단한 순환 선택(클릭마다 다음 색). 실제 UI 에선 팔레트 팝오버로 확장 가능.
  const idx = Math.floor(Math.random() * PALETTE.length);
  return PALETTE[idx];
}
