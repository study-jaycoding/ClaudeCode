// 좌측 필터 사이드바 (~150px, DESIGN.md §4): 컬러 / 태그 / 작업자 / 상태.
import type { Facets, Filters } from "../types";

interface Props {
  facets: Facets;
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
}

export function FilterSidebar({ facets, filters, onChange }: Props) {
  const toggle = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onChange({ [key]: filters[key] === value ? undefined : value } as Partial<Filters>);

  return (
    <aside className="sidebar">
      <section>
        <h4>컬러</h4>
        <div className="color-dots">
          {facets.colors.length === 0 && <span className="muted">없음</span>}
          {facets.colors.map((c) => (
            <button
              key={c}
              className={"color-dot" + (filters.color === c ? " on" : "")}
              style={{ background: c }}
              title={c}
              onClick={() => toggle("color", c)}
            />
          ))}
        </div>
      </section>

      <section>
        <h4>태그</h4>
        <div className="chips">
          {facets.tags.length === 0 && <span className="muted">없음</span>}
          {facets.tags.map((t) => (
            <button
              key={t}
              className={"chip" + (filters.tag === t ? " on" : "")}
              onClick={() => toggle("tag", t)}
            >
              {t}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h4>작업자</h4>
        <div className="chips">
          {facets.workers.map((w) => (
            <button
              key={w.id}
              className={"chip" + (filters.worker_id === w.id ? " on" : "")}
              onClick={() => toggle("worker_id", w.id)}
            >
              {w.name}
            </button>
          ))}
        </div>
      </section>

      {filters.tab === "my" && (
        <section>
          <h4>상태</h4>
          <label className="toggle">
            <input
              type="checkbox"
              checked={!!filters.shared_only}
              onChange={(e) => onChange({ shared_only: e.target.checked || undefined })}
            />
            공유한 것만
          </label>
        </section>
      )}
    </aside>
  );
}
