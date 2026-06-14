// 앱 루트: 탭·필터 상태, 데이터 로딩, WebSocket 진행률, 액션 오케스트레이션.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, connectProgress, setAuthToken, getAuthToken } from "./api";
import { AdminWindow } from "./components/AdminWindow";
import { CompositionBoard } from "./components/CompositionBoard";
import { LoginScreen } from "./components/LoginScreen";
import { FilterSidebar } from "./components/FilterSidebar";
import { GenCommentPanel } from "./components/GenCommentPanel";
import { InfoPopup } from "./components/InfoPopup";
import { LibraryToolbar } from "./components/LibraryToolbar";
import { MediaPreview } from "./components/MediaPreview";
import { ProjectAssignMenu } from "./components/ProjectAssignMenu";
import { SpotlightPrompt } from "./components/SpotlightPrompt";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { TopBar } from "./components/TopBar";
import { makeStore } from "./lib/storage";
import type {
  Account,
  AuthConfig,
  Facets,
  Filters,
  Generation,
  InfoTarget,
  PreviewTarget,
  Project,
} from "./types";

const EMPTY_FACETS: Facets = { colors: [], tags: [], auto_tags: [], workers: [] };

// History 버튼 미디어 타입 필터(전체/이미지/영상/음성)
type MediaFilter = "all" | "image" | "video" | "audio";

// r/g/b 단축키 → 컬러(기존 팔레트·필터와 동일한 색 필드에 매핑)
const KEY_COLORS: Record<string, string> = {
  r: "#ff5722",
  g: "#4caf50",
  b: "#2196f3",
};

// 마지막으로 보던 라이브러리 상태 영속화(탭·서브탭·필터·크기·레이아웃 등)
const LS = makeStore("ch.lib.");

export default function App() {
  const [filters, setFilters] = useState<Filters>(() => {
    try {
      const raw = LS.get("filters", "");
      if (raw) return JSON.parse(raw) as Filters;
    } catch {
      /* ignore */
    }
    return { tab: "my" };
  });
  const [gens, setGens] = useState<Generation[]>([]);
  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [caching, setCaching] = useState(false);
  const [info, setInfo] = useState<InfoTarget | null>(null); // 휠클릭 정보 팝업
  const [commentGenId, setCommentGenId] = useState<string | null>(null); // 공유 코멘트 스레드 패널 대상
  const [preview, setPreview] = useState<PreviewTarget | null>(null); // 클릭 미리보기
  const [toast, setToast] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<MediaFilter>(
    () => (LS.get("typeFilter", "all") as MediaFilter) || "all",
  ); // History 버튼: 전체/이미지/영상/음성
  const [scale, setScale] = useState(() => Number(LS.get("scale", "1")) || 1); // 카드 크기 배율
  const [fill, setFill] = useState(() => LS.get("fill", "1") !== "0"); // cover ↔ contain
  const [layout, setLayout] = useState<"grid" | "list">(() =>
    LS.get("layout", "grid") === "list" ? "list" : "grid",
  );
  const [showFilters, setShowFilters] = useState(() => LS.get("showFilters", "1") !== "0");
  const [selected, setSelected] = useState<Set<string>>(new Set()); // 다중 선택
  // 에셋 파트와 동일한 인스턴트 필터(툴바) — 로드된 gens 를 클라이언트 측에서 즉시 거른다.
  const [colorFilter, setColorFilter] = useState<Set<string>>(() => LS.loadSet("colorFilter"));
  const [sourceOnly, setSourceOnly] = useState(() => LS.get("sourceOnly", "0") === "1");
  const [tagFilter, setTagFilter] = useState<Set<string>>(() => LS.loadSet("tagFilter"));
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  const [commentOnly, setCommentOnly] = useState(() => LS.get("commentOnly", "0") === "1"); // C 필터: 미확인 코멘트만
  const [muteOwn, setMuteOwn] = useState(() => LS.get("muteOwn", "1") !== "0"); // 내 코멘트 알림 끄기
  // 자동 태그 — 사이드바에서 '무장'한 것들. 다음 생성에 자동 적용(별도 네임스페이스).
  const [armedAutoTags, setArmedAutoTags] = useState<Set<string>>(() => LS.loadSet("armedAutoTags"));
  // 프로젝트(작업 묶음) — App 단일 소스. 사이드바 필터 + 선택바 귀속이 공유.
  const [projects, setProjects] = useState<Project[]>([]);
  const [unassignedCount, setUnassignedCount] = useState(0);
  const projectsLoadedRef = useRef(false); // 첫 로드 완료 전엔 stale 가드 비활성(오해제 방지)
  const [adminOpen, setAdminOpen] = useState(false); // 관리자 창(로고 클릭)
  // 인증(보안) — AUTH_ENABLED 서버일 때만 게이트. config 로드 전엔 null(스플래시).
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  // 인증 게이트 통과 여부(=차단 off 이거나 로그인됨). reload 가 이걸 보고 조회 시작.
  const authReady = !authConfig || !authConfig.auth_enabled || !!account;
  const authReadyRef = useRef(authReady);
  authReadyRef.current = authReady;

  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  // 키보드 핸들러가 항상 최신 값을 보도록 ref 로 보관(리스너 재바인딩 최소화)
  const gensRef = useRef(gens);
  gensRef.current = gens;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2500);
  };

  const reload = useCallback(async () => {
    // 인증 게이트: 로그인 필요한데 아직 미로그인이면 조회하지 않는다(401 소음 방지).
    if (!authReadyRef.current) return;
    // 구성 탭은 라이브러리 조회가 아니라 보드 작업 공간이므로 로드 생략.
    if (filtersRef.current.tab === "compose") {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [g, f, pr] = await Promise.all([
        api.listGenerations(filtersRef.current),
        api.facets(),
        api.projects(),
      ]);
      setGens(g);
      setFacets(f);
      setProjects(pr.projects);
      setUnassignedCount(pr.unassigned);
      projectsLoadedRef.current = true;
    } catch (e) {
      flash("로드 실패: " + String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 프로젝트 목록만 가볍게 갱신(사이드바 생성·이름변경·삭제 후 — 그리드 재조회 불필요).
  const reloadProjects = useCallback(async () => {
    try {
      const pr = await api.projects();
      setProjects(pr.projects);
      setUnassignedCount(pr.unassigned);
      projectsLoadedRef.current = true;
    } catch {
      /* ignore */
    }
  }, []);

  // 선택한 결과물들을 프로젝트에 귀속(projectId=null → 미분류). 그리드+카운트 갱신.
  const assignSelectedToProject = async (projectId: string | null) => {
    const ids = [...selectedRef.current];
    if (ids.length === 0) return;
    try {
      const r = await api.assignProject(ids, projectId);
      await reload();
      flash(`${r.updated}개를 ${projectId ? "프로젝트에 담음" : "미분류로 뺌"}`);
    } catch (e) {
      flash("귀속 실패: " + String(e));
    }
  };

  // 새 프로젝트 생성 후 선택 항목을 곧장 그 프로젝트로 귀속.
  const createAndAssign = async (name: string) => {
    try {
      const p = await api.createProject(name);
      await assignSelectedToProject(p.id);
    } catch (e) {
      flash("프로젝트 생성 실패: " + String(e));
    }
  };

  useEffect(() => {
    reload();
  }, [filters, reload]);

  // 인증 부트스트랩: 서버 모드(auth_enabled) 확인 + 기존 토큰으로 세션 복원.
  useEffect(() => {
    api
      .authConfig()
      .then((cfg) => {
        setAuthConfig(cfg);
        if (cfg.auth_enabled && getAuthToken()) {
          api.me().then(setAccount).catch(() => setAuthToken(null));
        }
      })
      .catch(() => setAuthConfig({ auth_enabled: false, has_accounts: false }));
  }, []);

  // 401(세션 만료/무효) → 로그인 화면으로. api 가 토큰을 이미 비웠다.
  useEffect(() => {
    const onAuthReq = () => setAccount(null);
    window.addEventListener("ch:auth-required", onAuthReq);
    return () => window.removeEventListener("ch:auth-required", onAuthReq);
  }, []);

  // 인증 게이트를 통과(로그인 완료/차단 off)하면 데이터 로드 시작.
  useEffect(() => {
    if (authReady) reload();
  }, [authReady, reload]);

  // WebSocket 진행률: 상태 전이 메시지를 받으면 해당 카드만 갱신.
  // 끊겼다 재연결되면 reload 로 놓친 전이를 따라잡는다(백엔드 재시작 대비).
  useEffect(() => {
    const off = connectProgress(
      (m) => {
        // 주기 동기화로 다른 기기/웹 잡이 들어옴 → 전체 새로고침
        if (m.type === "synced") {
          reload();
          return;
        }
        if (!m.status) return;
        setGens((prev) =>
          prev.map((g) =>
            g.id === m.generation_id ? { ...g, status: m.status! } : g,
          ),
        );
        // 완료되면 전체 새로고침으로 asset/썸네일 반영
        if (m.status === "done") reload();
      },
      () => reload(), // (재)연결 시 동기화
    );
    return off;
  }, [reload]);

  // 폴링 폴백: 진행중(pending/running) 잡이 있으면 4초마다 reload.
  // WS 메시지를 놓쳐도 워커가 DB 를 갱신하면 UI 가 결국 따라잡는다.
  const hasActiveJob = gens.some((g) => g.status === "pending" || g.status === "running");
  useEffect(() => {
    if (!hasActiveJob) return;
    const id = setInterval(() => reload(), 4000);
    return () => clearInterval(id);
  }, [hasActiveJob, reload]);

  // 탭 재포커스 시 즉시 새로고침 — 백그라운드 탭 throttling 으로 놓친 WS 'synced'(웹/타기기
  // 생성)를 따라잡는다. 다른 탭에서 작업하다 돌아오면 항상 최신을 보장(WS 끊김 안전망).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [reload]);

  // 프롬프트는 항상 도킹돼 있으므로 Ctrl/⌘+K 는 '열기'가 아니라 프롬프트로 '포커스'.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("ch:focus-prompt"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 마지막으로 보던 상태 저장 → 다음에 열 때 복원
  useEffect(() => LS.set("filters", JSON.stringify(filters)), [filters]);
  useEffect(() => LS.set("typeFilter", typeFilter), [typeFilter]);
  useEffect(() => LS.set("scale", String(scale)), [scale]);
  useEffect(() => LS.set("fill", fill ? "1" : "0"), [fill]);
  useEffect(() => LS.set("layout", layout), [layout]);
  useEffect(() => LS.set("showFilters", showFilters ? "1" : "0"), [showFilters]);

  // ── 선택 항목 대상 단축키 작업 (s=소스 / #=태그 / r·g·b=컬러) ──
  const colorSelected = async (ids: string[], color: string) => {
    for (const id of ids) {
      try {
        await api.setColor(id, color);
      } catch {
        /* skip */
      }
    }
    await reload();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 입력 포커스(프롬프트·검색·태그창)에서는 무시
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const ids = [...selectedRef.current];
      if (ids.length === 0) return;
      const k = e.key.toLowerCase();
      // s/#/c 는 그리드(ThumbnailGrid)가 포커스 카드에서 인라인으로 처리 — 에셋 파트와 동일.
      // r/g/b(컬러)·Escape 만 전역(선택 항목 일괄).
      if (k === "r" || k === "g" || k === "b") {
        e.preventDefault();
        colorSelected(ids, KEY_COLORS[k]);
      } else if (e.key === "Escape") {
        clearSelect();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // 핸들러는 ref 로 최신값을 보므로 한 번만 바인딩
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (p: Partial<Filters>) => setFilters((f) => ({ ...f, ...p }));

  // stale 프로젝트 필터 자동 해제 — 보던 프로젝트가 (다른 기기/세션에서) 삭제됐는데
  // localStorage 에 id 가 남아 재방문 시 빈 화면이 되는 것 방지. 'none'(미분류)은 항상 유효.
  useEffect(() => {
    if (!projectsLoadedRef.current) return; // 첫 로드 전엔 판단 보류
    const pid = filters.project_id;
    if (pid && pid !== "none" && !projects.some((p) => p.id === pid)) {
      patch({ project_id: undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearSelect = () => setSelected(new Set());

  // 필터/검색/서브탭이 바뀌면(목록이 달라지면) 선택 초기화 — 에셋 파트와 동일.
  useEffect(() => {
    setSelected(new Set());
  }, [filters.search, filters.color, filters.tag, filters.share_dir, typeFilter,
      colorFilter, sourceOnly, commentOnly, tagFilter]);

  // 툴바 인스턴트 필터 영속화.
  useEffect(() => LS.set("colorFilter", JSON.stringify([...colorFilter])), [colorFilter]);
  useEffect(() => LS.set("sourceOnly", sourceOnly ? "1" : "0"), [sourceOnly]);
  useEffect(() => LS.set("commentOnly", commentOnly ? "1" : "0"), [commentOnly]);
  useEffect(() => LS.set("tagFilter", JSON.stringify([...tagFilter])), [tagFilter]);
  useEffect(() => LS.set("armedAutoTags", JSON.stringify([...armedAutoTags])), [armedAutoTags]);

  // 자동 태그(별도 네임스페이스) — 클릭=무장 토글(다음 생성에 자동 적용), +=추가, ×=전역 삭제.
  const toggleArmedAutoTag = (t: string) =>
    setArmedAutoTags((prev) => {
      const n = new Set(prev);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  const addAutoTag = async () => {
    const name = window.prompt("자동 태그 이름")?.trim();
    if (!name) return;
    try {
      await api.createAutoTag(name);
      await reload();
    } catch (e) {
      flash("자동 태그 추가 실패: " + String(e));
    }
  };
  const removeAutoTag = async (t: string) => {
    if (!window.confirm(`자동 태그 "${t}" 를 삭제할까요?`)) return;
    try {
      await api.deleteAutoTag(t);
      setArmedAutoTags((prev) => {
        const n = new Set(prev);
        n.delete(t);
        return n;
      });
      await reload();
    } catch (e) {
      flash("자동 태그 삭제 실패: " + String(e));
    }
  };

  // 컬러/소스/태그 인스턴트 필터 + 컬러순 정렬을 로드된 gens 에 적용(에셋 파트와 동일한 즉시 필터).
  const visibleGens = useMemo(() => {
    let g = gens;
    // 자산이 아직 없는 진행중(대기/생성중) 카드는 타입이 미정이라 image/video 필터에 가리지 않는다.
    if (typeFilter !== "all")
      g = g.filter((x) => !x.assets.length || x.assets[0]?.type === typeFilter);
    if (colorFilter.size) g = g.filter((x) => x.color != null && colorFilter.has(x.color));
    if (sourceOnly) g = g.filter((x) => x.is_source);
    // C 필터: 코멘트가 하나라도 있는 생성본(읽음 여부 무관). 미확인 강조는 호박색 알림이 담당.
    if (commentOnly) g = g.filter((x) => x.comment_count > 0);
    if (tagFilter.size) g = g.filter((x) => x.tags.some((t) => tagFilter.has(t)));
    // 무장된 자동 태그 = 필터(그 자동 태그를 가진 결과물만) — 동시에 다음 생성 자동 적용도 됨.
    if (armedAutoTags.size)
      g = g.filter((x) => x.auto_tags.some((t) => armedAutoTags.has(t)));
    return g;
  }, [gens, typeFilter, colorFilter, sourceOnly, commentOnly, tagFilter, armedAutoTags]);

  // 미확인 코멘트가 있는 생성본이 하나라도 있나 → 툴바 C 자동 알림(호박색).
  const hasAnyUnread = useMemo(() => gens.some((g) => g.has_unread), [gens]);

  // 실패 항목 수(유령 실패 정리 버튼 노출용)
  const failedCount = useMemo(() => gens.filter((g) => g.status === "failed").length, [gens]);
  const clearFailed = async () => {
    if (
      !window.confirm(
        "힉스필드에 올라가지 않은 실패 항목을 정리할까요?\n(힉스필드에서 실패로 돌아온 실제 항목은 보존됩니다)",
      )
    )
      return;
    try {
      const r = await api.clearFailed();
      flash(`실패 ${r.removed}건을 정리했습니다.`);
      await reload();
    } catch (e) {
      flash("실패 정리 오류: " + String(e));
    }
  };

  // '내 알림 끄기'는 이제 코멘트 작성 시점에 캡처되는 기본값(전역 필터 아님).
  // 토글은 기존 코멘트에 소급 적용되지 않으므로 reload 불필요 — 다음 작성에만 영향.
  const toggleMuteOwn = () => {
    setMuteOwn((v) => {
      const nv = !v;
      LS.set("muteOwn", nv ? "1" : "0");
      return nv;
    });
  };

  const toggleColorFilter = (hex: string) =>
    setColorFilter((prev) => {
      const n = new Set(prev);
      if (n.has(hex)) n.delete(hex);
      else n.add(hex);
      return n;
    });
  // 에셋 T 와 동일: 일반 클릭=그 태그만(단독이면 해제), Shift/Ctrl=다중 토글.
  const selectTagFilter = (t: string, additive: boolean) =>
    setTagFilter((prev) => {
      const n = new Set(prev);
      if (additive) {
        if (n.has(t)) n.delete(t);
        else n.add(t);
        return n;
      }
      if (n.has(t) && n.size === 1) return new Set();
      return new Set([t]);
    });
  const clearTagFilter = () => setTagFilter(new Set());
  // 태그 전역 삭제(모든 생성본에서) — 에셋 T 패널 ✕ 와 동일.
  const deleteTagEverywhere = async (t: string) => {
    const affected = gensRef.current.filter((g) => g.tags.includes(t)).length;
    if (!window.confirm(`태그 "#${t}" 를 ${affected}건에서 삭제할까요?`)) return;
    try {
      await api.deleteTag(t);
      setTagFilter((prev) => {
        const n = new Set(prev);
        n.delete(t);
        return n;
      });
      reload(); // gens + facets 재조회 → 태그 사라짐
    } catch (e) {
      flash("태그 삭제 실패: " + String(e));
    }
  };
  // T 패널 닫을 때 태그 필터도 해제(에셋 T 와 동일).
  const toggleTagPanel = () =>
    setTagPanelOpen((open) => {
      if (open) setTagFilter(new Set());
      return !open;
    });

  // 선택 항목 일괄 팀 공유 (내 작업 · 완료 · 미공유만)
  const bulkPublish = async () => {
    const ids = [...selected];
    let n = 0;
    for (const id of ids) {
      const g = gens.find((x) => x.id === id);
      if (g && !g.shared && g.status === "done") {
        try {
          await api.publish(id);
          n++;
        } catch {
          /* skip */
        }
      }
    }
    flash(`${n}개 팀에 공유했습니다.`);
    clearSelect();
    await reload();
  };

  const onSync = async () => {
    setSyncing(true);
    try {
      const r = await api.sync();
      flash(`동기화 완료: ${r.fetched}건 (신규 ${r.inserted})`);
      await reload();
    } catch (e) {
      flash("동기화 실패: " + String(e));
    } finally {
      setSyncing(false);
    }
  };

  // Assets 를 분리된 브라우저 창으로 연다(project-viewer 의 ?embed 방식).
  const openAssetsWindow = () => {
    window.open(
      "/?embed=assets",
      "contenthub-assets",
      "popup=yes,width=1180,height=780,left=140,top=80",
    );
  };

  const onCache = async () => {
    setCaching(true);
    try {
      const r = await api.cacheAll();
      flash(`로컬 보관 완료: ${r.cached}개 파일 (${r.generations}개 생성물)${r.failed ? ` · 실패 ${r.failed}` : ""}`);
      await reload();
    } catch (e) {
      flash("보관 실패: " + String(e));
    } finally {
      setCaching(false);
    }
  };

  const onRegenerate = async (g: Generation) => {
    try {
      // 무장된 자동태그를 재생성 결과물에도 적용(생성 흐름과 동일).
      await api.regenerate(g.id, { auto_tags: [...armedAutoTags] });
      flash("재생성 잡을 큐에 등록했습니다.");
      await reload();
    } catch (e) {
      flash("재생성 실패: " + String(e));
    }
  };

  const onPublish = async (g: Generation) => {
    try {
      await api.publish(g.id);
      flash("팀에 공유했습니다.");
      await reload();
    } catch (e) {
      flash("공유 실패: " + String(e));
    }
  };

  const onUnpublish = async (g: Generation) => {
    try {
      await api.unpublish(g.id);
      flash("팀 공유를 해제했습니다.");
      await reload();
    } catch (e) {
      flash("공유 해제 실패: " + String(e));
    }
  };

  const onImport = async (g: Generation) => {
    try {
      await api.importToWorkspace(g.id);
      flash("내 워크스페이스로 가져왔습니다 (lineage 기록).");
      setFilters((f) => ({ ...f, tab: "my" }));
    } catch (e) {
      flash("가져오기 실패: " + String(e));
    }
  };

  // 카드 하단 S 버튼: 소스 등록/해제 토글(등록 시 @이름 입력)
  const onColor = async (g: Generation, color: string | null) => {
    try {
      await api.setColor(g.id, color);
      await reload();
    } catch (e) {
      flash("컬러 변경 실패: " + String(e));
    }
  };

  const onTags = async (g: Generation) => {
    const input = window.prompt("태그 (쉼표 구분)", g.tags.join(", "));
    if (input === null) return;
    const tags = input.split(",").map((t) => t.trim()).filter(Boolean);
    try {
      await api.setTags(g.id, tags);
      await reload();
    } catch (e) {
      flash("태그 변경 실패: " + String(e));
    }
  };

  // 카드 S·T·C 인라인 입력용 직접 setter(브라우저 prompt 안 씀) — 에셋 파트와 동일한 UX.
  const onSetSource = async (g: Generation, name: string | null, isSource: boolean) => {
    try {
      await api.setSource(g.id, name, isSource);
      reload();
    } catch (e) {
      flash("소스 변경 실패: " + String(e));
    }
  };
  const onSetTags = async (g: Generation, tags: string[]) => {
    try {
      await api.setTags(g.id, tags);
      reload();
    } catch (e) {
      flash("태그 변경 실패: " + String(e));
    }
  };

  const onLogout = () => {
    api.logout().catch(() => {});
    setAuthToken(null);
    setAccount(null);
    setGens([]); // 로그아웃 즉시 데이터 비우기
  };

  // 인증 게이트: 로그인 필요(서버 모드)한데 미로그인 → 앱 전체를 로그인 화면으로 가린다.
  if (authConfig?.auth_enabled && !account) {
    return <LoginScreen config={authConfig} onAuthed={setAccount} />;
  }

  return (
    <div className="app">
      <TopBar
        filters={filters}
        onTab={(tab) => {
          setFilters({ tab });
          clearSelect();
        }}
        onSearch={(q) => patch({ search: q || undefined })}
        onSync={onSync}
        syncing={syncing}
        onCache={onCache}
        caching={caching}
        onWorkspaceSwitched={async () => {
          await reload();
          flash("워크스페이스 전환 — 라이브러리를 갱신했습니다.");
        }}
        onImported={async (msg) => {
          await reload();
          flash(msg);
        }}
        onOpenSpotlight={() => window.dispatchEvent(new CustomEvent("ch:focus-prompt"))}
        onOpenAssets={openAssetsWindow}
        onOpenAdmin={() => setAdminOpen(true)}
        account={account}
        onLogout={onLogout}
      />
      <div className="body">
        {filters.tab === "compose" ? (
          <CompositionBoard />
        ) : (
          <>
            {showFilters && (
              <FilterSidebar
                facets={facets}
                filters={filters}
                onChange={patch}
                colorDots={[
                  { k: "r", hex: KEY_COLORS.r },
                  { k: "g", hex: KEY_COLORS.g },
                  { k: "b", hex: KEY_COLORS.b },
                ]}
                colorFilter={colorFilter}
                onToggleColor={toggleColorFilter}
                armedAutoTags={armedAutoTags}
                onToggleAutoTag={toggleArmedAutoTag}
                onAddAutoTag={addAutoTag}
                onDeleteAutoTag={removeAutoTag}
                onCreatorChanged={reload}
                projects={projects}
                unassignedCount={unassignedCount}
                onReloadProjects={reloadProjects}
              />
            )}
            <main className="main">
              <LibraryToolbar
                typeFilter={typeFilter}
                onTypeFilter={setTypeFilter}
                scale={scale}
                onScale={setScale}
                fill={fill}
                onToggleFill={() => setFill((v) => !v)}
                layout={layout}
                onLayout={setLayout}
                filtersOpen={showFilters}
                onToggleFilters={() => setShowFilters((v) => !v)}
                count={visibleGens.length}
                loading={loading}
                failedCount={failedCount}
                onClearFailed={clearFailed}
                colorDots={[
                  { k: "r", hex: KEY_COLORS.r },
                  { k: "g", hex: KEY_COLORS.g },
                  { k: "b", hex: KEY_COLORS.b },
                ]}
                colorFilter={colorFilter}
                onToggleColor={toggleColorFilter}
                sourceOnly={sourceOnly}
                onToggleSource={() => setSourceOnly((v) => !v)}
                commentOnly={commentOnly}
                onToggleComment={() => setCommentOnly((v) => !v)}
                hasUnread={hasAnyUnread}
                tags={facets.tags}
                tagFilter={tagFilter}
                onSelectTag={selectTagFilter}
                onDeleteTag={deleteTagEverywhere}
                onClearTags={clearTagFilter}
                tagPanelOpen={tagPanelOpen}
                onToggleTagPanel={toggleTagPanel}
              />
              <ThumbnailGrid
                    generations={visibleGens}
                    tab={filters.tab}
                    scale={scale}
                    fill={fill}
                    layout={layout}
                    selectedIds={selected}
                    onSelectedChange={setSelected}
                    onToggleSelect={toggleSelect}
                    onSetSource={onSetSource}
                    onSetTags={onSetTags}
                    onOpenComments={(g) => setCommentGenId(g.id)}
                    onRegenerate={onRegenerate}
                    onPublish={onPublish}
                    onUnpublish={onUnpublish}
                    onImport={onImport}
                    onColor={onColor}
                    onTags={onTags}
                onInfo={setInfo}
                onPreview={setPreview}
              />
            </main>
          </>
        )}
      </div>

      {filters.tab !== "compose" && (
        <SpotlightPrompt
          armedAutoTags={[...armedAutoTags]}
          activeProjectId={
            filters.project_id && filters.project_id !== "none"
              ? filters.project_id
              : undefined
          }
          topSlot={
            selected.size > 0 ? (
              <div className="select-bar">
                <span className="sb-count">{selected.size}개 선택</span>
                {filters.tab === "my" && (
                  <button onClick={bulkPublish}>↗ 팀에 공유</button>
                )}
                <ProjectAssignMenu
                  count={selected.size}
                  projects={projects}
                  onAssign={assignSelectedToProject}
                  onCreateAndAssign={createAndAssign}
                />
              </div>
            ) : undefined
          }
          onCreated={(created) => {
            // 즉시 '대기' 카드 표시(optimistic) — DB 라운드트립/WS 기다리지 않고 바로 뜬다.
            // 같은 id 라 이후 reload·WS 가 자연스럽게 같은 카드를 갱신(중복 없음).
            if (created?.length) {
              setGens((prev) => {
                const ids = new Set(prev.map((g) => g.id));
                const fresh = created.filter((g) => !ids.has(g.id));
                return fresh.length ? [...fresh, ...prev] : prev;
              });
              // 무자산 pending 카드는 visibleGens 가 타입필터와 무관하게 보여주므로 필터를
              // 건드리지 않는다(사용자가 고른 image/video 필터 보존).
            }
            flash("생성 잡을 시작했습니다.");
            reload();
          }}
        />
      )}
      {commentGenId && (
        <GenCommentPanel
          genId={commentGenId}
          label={
            (gens.find((g) => g.id === commentGenId)?.prompt || "").slice(0, 40) || "생성본"
          }
          onClose={() => setCommentGenId(null)}
          onChanged={reload}
          muteOwn={muteOwn}
          onToggleMute={toggleMuteOwn}
        />
      )}
      {info && (
        <InfoPopup
          target={info}
          onClose={() => setInfo(null)}
          onPreview={setPreview}
          projects={projects}
          onSetProject={async (genId, projectId) => {
            try {
              await api.assignProject([genId], projectId);
              await reload();
            } catch (e) {
              flash("프로젝트 변경 실패: " + String(e));
            }
          }}
        />
      )}
      {preview && (
        <MediaPreview target={preview} onClose={() => setPreview(null)} />
      )}
      {adminOpen && (
        <AdminWindow
          onClose={() => {
            setAdminOpen(false);
            reload(); // 등급·프로젝트 변경이 라이브러리/필터에 반영되게
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
