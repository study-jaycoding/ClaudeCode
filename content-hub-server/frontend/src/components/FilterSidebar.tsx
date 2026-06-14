// 좌측 필터 사이드바 (~150px, DESIGN.md §4): 프로젝트 / 컬러 / 자동태그 / 생성자 / 공유.
import { useEffect, useState } from "react";
import { api } from "../api";
import type { Creator, Facets, Filters, Project } from "../types";

// 프로젝트(작업 묶음) 필터 + 생성·이름변경·삭제. 선택하면 그 안 결과물만 보인다.
// 로드맵 §0-4: 프로젝트는 공유·이동 단위(개인필터인 태그·컬러와 다름).
function ProjectSection({
  projects,
  unassignedCount,
  activeId,
  onFilter,
  onReload,
}: {
  projects: Project[];
  unassignedCount: number;
  activeId?: string;
  onFilter: (projectId?: string) => void;
  onReload: () => void;
}) {
  const create = async () => {
    const name = window.prompt("새 프로젝트 이름:");
    if (name === null || !name.trim()) return;
    await api.createProject(name.trim());
    onReload();
  };
  const rename = async (p: Project) => {
    const name = window.prompt("프로젝트 이름:", p.name);
    if (name === null || !name.trim()) return;
    await api.updateProject(p.id, { name: name.trim() });
    onReload();
  };
  const remove = async (p: Project) => {
    if (
      !window.confirm(
        `프로젝트 '${p.name}' 삭제?\n결과물은 지워지지 않고 '미분류'로 돌아갑니다.`,
      )
    )
      return;
    await api.deleteProject(p.id);
    if (activeId === p.id) onFilter(undefined); // 보던 프로젝트면 필터 해제
    onReload();
  };
  return (
    <section>
      <h4 className="auto-tag-head">
        프로젝트
        <button className="auto-tag-add" title="새 프로젝트" onClick={create}>
          +
        </button>
      </h4>
      <div className="proj-list">
        <button
          className={"proj-row" + (!activeId ? " on" : "")}
          onClick={() => onFilter(undefined)}
        >
          <span className="proj-name">전체</span>
        </button>
        {projects.map((p) => (
          <div key={p.id} className={"proj-row-wrap" + (activeId === p.id ? " on" : "")}>
            <button
              className={"proj-row" + (activeId === p.id ? " on" : "")}
              onClick={() => onFilter(activeId === p.id ? undefined : p.id)}
              title={p.name}
            >
              <span className="proj-name">{p.name}</span>
              <span className="proj-count">{p.count}</span>
            </button>
            <button className="proj-edit" title="이름 변경" onClick={() => rename(p)}>
              ✎
            </button>
            <button className="proj-edit" title="삭제" onClick={() => remove(p)}>
              ✕
            </button>
          </div>
        ))}
        <button
          className={"proj-row proj-unassigned" + (activeId === "none" ? " on" : "")}
          onClick={() => onFilter(activeId === "none" ? undefined : "none")}
          title="아직 프로젝트에 담기지 않은 결과물"
        >
          <span className="proj-name">미분류</span>
          <span className="proj-count">{unassignedCount}</span>
        </button>
      </div>
    </section>
  );
}

// 생성자(팀 워크스페이스 작성자) 필터 + 이름붙이기 + '나로 지정'. 자체 fetch.
function CreatorSection({
  activeUid,
  onFilter,
  onChanged,
}: {
  activeUid?: string;
  onFilter: (uid?: string) => void;
  onChanged: () => void; // 라이브러리 새로고침(is_mine·이름이 카드에 반영되게)
}) {
  const [creators, setCreators] = useState<Creator[]>([]);
  const load = () => api.creators().then(setCreators).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  if (creators.length <= 1) return null; // 나 혼자면 숨김(팀원 있을 때만)
  const rename = async (c: Creator) => {
    const name = window.prompt("이 작업자의 이름:", c.name || "");
    if (name === null) return;
    await api.renameCreator(c.uid, name);
    load();
    onChanged();
  };
  // 팀 워크스페이스 동기화 데이터만으론 내 작업을 못 가름 → 이 작성자가 나라고 1회 지정.
  const claim = async (c: Creator) => {
    if (!window.confirm(`이 작성자(${c.name || c.uid.slice(0, 14)})를 '나'로 지정할까요?\n이 작성자의 작업이 모두 '내 작업'으로 잡힙니다.`))
      return;
    await api.claimCreator(c.uid);
    load();
    onChanged();
  };
  return (
    <section>
      <h4>생성자</h4>
      {creators.map((c) => (
        <div key={c.uid} className={"creator-row" + (activeUid === c.uid ? " on" : "")}>
          <button
            className="creator-pick"
            onClick={() => onFilter(activeUid === c.uid ? undefined : c.uid)}
            title={c.uid}
          >
            <span
              className="creator-dot"
              style={{ background: c.is_mine ? "var(--accent)" : "#4ade80" }}
            />
            <span className="creator-name">{c.is_mine ? "나" : c.name || "팀원"}</span>
            <span className="creator-count">{c.count}</span>
          </button>
          {!c.is_mine && (
            <>
              <button
                className="creator-edit"
                title="이 작성자를 '나'로 지정 (내 작업으로 인식)"
                onClick={() => claim(c)}
              >
                나
              </button>
              <button className="creator-edit" title="이름 붙이기" onClick={() => rename(c)}>
                ✎
              </button>
            </>
          )}
        </div>
      ))}
    </section>
  );
}

interface Props {
  facets: Facets;
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  // 프로젝트(작업 묶음) — App 이 단일 소스로 보유, 사이드바와 선택바가 공유
  projects: Project[];
  unassignedCount: number;
  onReloadProjects: () => void;
  // 컬러 인스턴트 필터 — 툴바(LibraryToolbar)와 동일 상태 공유(연동: 같이 켜짐/꺼짐)
  colorDots: { k: string; hex: string }[];
  colorFilter: Set<string>;
  onToggleColor: (hex: string) => void;
  armedAutoTags: Set<string>; // 무장된 자동 태그(다음 생성에 자동 적용)
  onToggleAutoTag: (t: string) => void;
  onAddAutoTag: () => void;
  onDeleteAutoTag: (t: string) => void;
  onCreatorChanged: () => void; // 생성자 '나 지정'/이름변경 후 라이브러리 새로고침
}

export function FilterSidebar({
  facets,
  filters,
  onChange,
  colorDots,
  colorFilter,
  onToggleColor,
  armedAutoTags,
  onToggleAutoTag,
  onAddAutoTag,
  onDeleteAutoTag,
  onCreatorChanged,
  projects,
  unassignedCount,
  onReloadProjects,
}: Props) {
  const toggle = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onChange({ [key]: filters[key] === value ? undefined : value } as Partial<Filters>);

  return (
    <aside className="sidebar">
      <ProjectSection
        projects={projects}
        unassignedCount={unassignedCount}
        activeId={filters.project_id}
        onFilter={(pid) => onChange({ project_id: pid })}
        onReload={onReloadProjects}
      />

      <section>
        <h4>컬러</h4>
        <div className="color-dots">
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
        </div>
      </section>

      <section>
        <h4 className="auto-tag-head">
          자동 태그
          <button className="auto-tag-add" title="자동 태그 추가" onClick={onAddAutoTag}>
            +
          </button>
        </h4>
        <div className="chips">
          {facets.auto_tags.length === 0 && <span className="muted">없음</span>}
          {facets.auto_tags.map((t) => (
            <span key={t} className={"auto-tag-chip" + (armedAutoTags.has(t) ? " on" : "")}>
              <button
                className="auto-tag-name"
                title={armedAutoTags.has(t) ? "해제 (생성 시 자동 적용 중)" : "선택 — 다음 생성에 자동 적용"}
                onClick={() => onToggleAutoTag(t)}
              >
                {t}
              </button>
              <button
                className="auto-tag-x"
                title="자동 태그 삭제"
                onClick={() => onDeleteAutoTag(t)}
              >
                ✕
              </button>
            </span>
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

      <section>
        <h4>공유</h4>
        <label className="toggle">
          <input
            type="checkbox"
            checked={filters.share_dir === "mine"}
            onChange={(e) => onChange({ share_dir: e.target.checked ? "mine" : undefined })}
          />
          내보내기
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={filters.share_dir === "received"}
            onChange={(e) => onChange({ share_dir: e.target.checked ? "received" : undefined })}
          />
          가져오기
        </label>
      </section>

      <CreatorSection
        activeUid={filters.creator_uid}
        onFilter={(uid) => onChange({ creator_uid: uid })}
        onChanged={onCreatorChanged}
      />
    </aside>
  );
}
