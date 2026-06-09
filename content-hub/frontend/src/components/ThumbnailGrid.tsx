// 썸네일 그리드 (DESIGN.md §4). react-window FixedSizeGrid 로 가상 스크롤.
// 컨테이너 폭을 측정해 auto-fit minmax(180px) 에 가깝게 컬럼 수를 계산한다.
import { useEffect, useRef, useState } from "react";
import { FixedSizeGrid, type GridChildComponentProps } from "react-window";
import type { Generation } from "../types";
import { GenerationCard } from "./GenerationCard";

const CELL_W = 200; // 카드 폭 + 간격 목표
const CELL_H = 250; // 카드 높이

interface Props {
  generations: Generation[];
  tab: "my" | "team";
  onRegenerate: (g: Generation) => void;
  onPublish: (g: Generation) => void;
  onImport: (g: Generation) => void;
  onColor: (g: Generation, color: string | null) => void;
  onTags: (g: Generation) => void;
}

export function ThumbnailGrid(props: Props) {
  const { generations } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const columnCount = Math.max(1, Math.floor(size.width / CELL_W));
  const rowCount = Math.ceil(generations.length / columnCount);

  return (
    <div ref={ref} className="grid-wrap">
      {size.width > 0 && generations.length > 0 && (
        <FixedSizeGrid
          columnCount={columnCount}
          rowCount={rowCount}
          columnWidth={Math.floor(size.width / columnCount)}
          rowHeight={CELL_H}
          width={size.width}
          height={size.height}
        >
          {({ columnIndex, rowIndex, style }: GridChildComponentProps) => {
            const idx = rowIndex * columnCount + columnIndex;
            if (idx >= generations.length) return <div style={style} />;
            return (
              <div style={style} className="grid-cell">
                <GenerationCard gen={generations[idx]} {...props} />
              </div>
            );
          }}
        </FixedSizeGrid>
      )}
      {generations.length === 0 && (
        <div className="empty">
          항목이 없습니다. 우측 상단 <b>동기화</b>로 기존 생성 이력을 불러오거나{" "}
          <b>+ 새 생성</b>으로 시작하세요.
        </div>
      )}
    </div>
  );
}
