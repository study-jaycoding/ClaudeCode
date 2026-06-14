// 상단 바 (DESIGN.md §4): 로고 + 워크스페이스 + 탭 + 검색 + 동기화 + JSON가져오기 + 새 생성.
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Filters } from "../types";
import { WorkspaceSelector } from "./WorkspaceSelector";

type Provider = { uid: string | null; name: string | null; email: string | null };

interface Props {
  filters: Filters;
  onTab: (tab: "my" | "team" | "compose") => void;
  onSearch: (q: string) => void;
  onSync: () => void;
  syncing: boolean;
  onCache: () => void;
  caching: boolean;
  onWorkspaceSwitched: () => void;
  onImported: (msg: string) => void; // JSON 가져오기 완료 후 라이브러리 리로드
  onOpenSpotlight: () => void;
  onOpenAssets: () => void;
  onOpenAdmin: () => void; // 좌측 상단 로고 클릭 → 관리자 창(로드맵 §4-5)
  account?: import("../types").Account | null; // 로그인 계정(AUTH 모드)
  onLogout?: () => void;
}

export function TopBar({
  filters,
  onTab,
  onSearch,
  onSync,
  syncing,
  onCache,
  caching,
  onWorkspaceSwitched,
  onImported,
  onOpenSpotlight,
  onOpenAssets,
  onOpenAdmin,
  account,
  onLogout,
}: Props) {
  const [q, setQ] = useState(filters.search || "");
  const fileRef = useRef<HTMLInputElement>(null);

  const [exporting, setExporting] = useState(false);
  const [receiving, setReceiving] = useState(false);

  // 제공자 신원 — CLI account status 이메일에서 잡힌 표시이름. 공유 파일명·작성자 표기 기준.
  const [provider, setProvider] = useState<Provider | null>(null);
  useEffect(() => {
    api.provider().then(setProvider).catch(() => {});
  }, []);

  // 표시이름 변경 → 이후 공유 파일명·작성자 표기에 반영(uid 앵커는 불변이라 병합 안 깨짐).
  const onRenameProvider = async () => {
    const cur = provider?.name || "";
    const name = window.prompt("내 표시이름 (공유 파일명·작성자 표기에 사용)", cur)?.trim();
    if (!name || name === cur) return;
    try {
      const p = await api.setProviderName(name);
      setProvider(p);
      onImported(`표시이름을 '${p.name}' 으로 변경했습니다.`);
    } catch (err) {
      onImported("이름 변경 실패: " + String(err));
    }
  };

  // 공유 받기 — shared 폴더의 남이 올린 share 파일을 내 라이브러리로 병합(in).
  const onReceive = async () => {
    setReceiving(true);
    try {
      const { items } = await api.receivedShares();
      if (!items.length) {
        onImported("받을 공유가 없습니다 (shared 폴더가 비어 있음).");
        return;
      }
      const summary = items
        .map((i) => `${i.provider.name || i.filename}(${i.count})`)
        .join(", ");
      if (!window.confirm(`받은 공유 ${items.length}건을 가져올까요?\n${summary}`)) return;
      const r = await api.importReceivedAll();
      onImported(
        `공유 받기: 신규 ${r.inserted} · 갱신 ${r.updated} · 중복 ${r.unchanged}`,
      );
    } catch (err) {
      onImported("공유 받기 실패: " + String(err));
    } finally {
      setReceiving(false);
    }
  };

  // JSON 가져오기 — content-hub 번들(사실+오버레이) 또는 원시 generate list 배열 자동 판별.
  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 같은 파일 다시 선택 가능
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const isBundle =
        data && !Array.isArray(data) && data.format === "content-hub-bundle";
      if (!isBundle && !Array.isArray(data))
        throw new Error("지원하지 않는 JSON (배열도 번들도 아님)");
      const res = isBundle
        ? await api.importBundle(data) // 레퍼런스 위치·코멘트까지 온전히 병합
        : await api.importJobs(data); // 옛 generate list export(사실만)
      onImported(
        `${isBundle ? "번들" : "JSON"} 가져오기: 신규 ${res.inserted} · 갱신 ${res.updated} · 중복 ${res.unchanged}${
          res.skipped ? ` · 건너뜀 ${res.skipped}` : ""
        }`,
      );
    } catch (err) {
      onImported("JSON 가져오기 실패: " + String(err));
    }
  };

  // 내 누적 DB 를 번들로 내보내 파일로 저장(팀원에게 전달). >100 제약을 누적 DB 로 우회.
  const onExport = async () => {
    setExporting(true);
    try {
      const bundle = await api.exportBundle(false); // 전체(나+가져온 팀원) 내보내기
      const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");
      a.href = url;
      a.download = `content-hub-bundle_${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);
      onImported(`번들 내보내기: ${bundle.generations.length}건 (다운로드 폴더)`);
    } catch (err) {
      onImported("번들 내보내기 실패: " + String(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <header className="topbar">
      <button
        className="brand"
        onClick={onOpenAdmin}
        title="관리자 — 멤버 등급·프로젝트 관리"
      >
        ⬡ Content Hub
      </button>

      <WorkspaceSelector onSwitched={onWorkspaceSwitched} />

      {/* 제공자 신원 — 클릭하면 표시이름 변경(공유 파일명·작성자 표기 기준) */}
      <button
        className="provider-chip"
        onClick={onRenameProvider}
        title={`내 표시이름: ${provider?.name ?? "(미설정)"}${
          provider?.email ? `\n계정: ${provider.email}` : ""
        }\n클릭해서 변경 — 공유 파일명·작성자 표기에 쓰입니다`}
      >
        👤 {provider?.name ?? "…"}
      </button>

      {/* 로그인 계정(AUTH 모드) — 클릭하면 로그아웃 */}
      {account && (
        <button
          className="account-chip"
          onClick={onLogout}
          title={`로그인: ${account.email} (${account.role})\n클릭해서 로그아웃`}
        >
          {account.name || account.email} · {account.role}
          <span className="account-logout">⏏</span>
        </button>
      )}

      <nav className="tabs">
        <button
          className={filters.tab === "my" ? "on" : ""}
          onClick={() => onTab("my")}
        >
          내 작업
        </button>
        <button
          className={filters.tab === "team" ? "on" : ""}
          onClick={() => onTab("team")}
        >
          팀 공유
        </button>
        <button
          className={filters.tab === "compose" ? "on" : ""}
          onClick={() => onTab("compose")}
        >
          구성
        </button>
      </nav>

      <input
        className="search"
        value={q}
        placeholder="프롬프트·태그 검색"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSearch(q)}
      />

      <button className="sync" onClick={onSync} disabled={syncing}>
        {syncing ? "동기화 중…" : "↺ 동기화"}
      </button>
      <button
        className="sync"
        onClick={onCache}
        disabled={caching}
        title="소스·결과물을 로컬로 보관 — 원격 URL 만료와 무관하게 출처 보존·재사용"
      >
        {caching ? "보관 중…" : "⤓ 보관"}
      </button>
      <button
        className="sync"
        onClick={onReceive}
        disabled={receiving}
        title="data/shared 폴더의 팀원 share 파일을 내 라이브러리로 받기 (UUID 병합 + 레퍼런스 위치·코멘트·작성자)"
      >
        {receiving ? "받는 중…" : "📥 공유 받기"}
      </button>
      <button
        className="sync"
        onClick={() => fileRef.current?.click()}
        title="다른 작업자의 번들/JSON export 를 파일로 직접 가져와 합치기 (UUID 병합 + 레퍼런스 위치·코멘트)"
      >
        ⬇ JSON 가져오기
      </button>
      <button
        className="sync"
        onClick={onExport}
        disabled={exporting}
        title="내 누적 DB 를 번들(사실+레퍼런스 위치·코멘트)로 내보내 팀원에게 전달"
      >
        {exporting ? "내보내는 중…" : "⬆ JSON 내보내기"}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={onPickFile}
      />

      {/* 스포트라이트 트리거: '새 생성' 버튼 대신 커맨드 바 형태 */}
      <button className="spotlight-trigger" onClick={onOpenSpotlight}>
        <span className="st-icon">✦</span>
        <span className="st-label">프롬프트로 생성…</span>
        <kbd>Ctrl K</kbd>
      </button>

      {/* Assets(구성) 버튼 — 분리된 브라우저 창으로 연다 */}
      <button className="assets-btn" onClick={onOpenAssets} title="Assets (구성) — 별도 창">
        <span className="assets-thumb" />
        <span className="assets-label">Assets ⧉</span>
      </button>
    </header>
  );
}
