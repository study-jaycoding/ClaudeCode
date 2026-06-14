// 미디어 미리보기 — 이미지/동영상 클릭 시 떠오르는 플로팅 창(정보 팝업과 같은 구성).
// 새 브라우저 탭을 열지 않고 이 창에서 보여주고, 영상은 재생한다.
// 헤더를 잡고 드래그해 옮긴다. Esc/바깥 클릭으로 닫음.
import { useEffect, useRef, useState } from "react";
import type { PreviewTarget } from "../types";

interface Props {
  target: PreviewTarget;
  onClose: () => void;
}

export function MediaPreview({ target, onClose }: Props) {
  const [pos, setPos] = useState({ x: 0, y: 0 }); // 화면 중앙 기준 오프셋
  const drag = useRef<{ ox: number; oy: number; sx: number; sy: number } | null>(null);

  useEffect(() => {
    // 크게 보기는 정보팝업 위에 떠 있으므로 Esc 를 캡처 단계에서 먼저 가로채
    // 자기만 닫는다(stopPropagation) → 뒤의 정보팝업 Esc 핸들러는 발동 안 함.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const onDragStart = (e: React.PointerEvent) => {
    drag.current = { ox: pos.x, oy: pos.y, sx: e.clientX, sy: e.clientY };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
  };
  const onDragMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setPos({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) });
  };
  const onDragEnd = () => {
    drag.current = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
  };

  return (
    <div className="preview-backdrop" onMouseDown={onClose}>
      <div
        className="media-preview"
        style={{ transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="info-head" onPointerDown={onDragStart}>
          <span className="info-title" title={target.name}>
            {target.type === "video" ? "▶ " : "🖼 "}
            {target.name}
          </span>
          <button className="assets-x" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>
        <div className="media-preview-body">
          {target.type === "video" ? (
            <video src={target.url} controls autoPlay loop />
          ) : (
            <img src={target.url} alt={target.name} draggable={false} />
          )}
        </div>
      </div>
    </div>
  );
}
