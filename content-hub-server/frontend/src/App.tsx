// 앱 루트: 탭·필터 상태, 데이터 로딩, WebSocket 진행률, 액션 오케스트레이션.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, connectProgress, setAuthToken, getAuthToken, GEN_PAGE } from "./api";
import { AdminWindow } from "./components/AdminWindow";
import { CompareModal } from "./components/CompareModal";
import { HistoryBoard } from "./components/HistoryBoard";
import { LoginScreen } from "./components/LoginScreen";
import { FilterSidebar } from "./components/FilterSidebar";
import { GenCommentPanel } from "./components/GenCommentPanel";
import { InfoPopup } from "./components/InfoPopup";
import { HistoryPanel } from "./components/HistoryPanel";
import { LibraryToolbar } from "./components/LibraryToolbar";
import { MediaPreview } from "./components/MediaPreview";
import { ProjectAssignMenu } from "./components/ProjectAssignMenu";
import { SpotlightPrompt } from "./components/SpotlightPrompt";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { TopBar } from "./components/TopBar";
import { useT } from "./lib/i18n";
import { useAskPrompt } from "./lib/prompt";
import { makeStore } from "./lib/storage";
import type {
  Account,
  AuthConfig,
  Facets,
  Filters,
  GenQuery,
  GenStats,
  Generation,
  History,
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

// 계정 전환 시 개인 설정(어셋 폴더·필터·프롬프트 기록 등)이 다음 사용자에게 새지 않도록 정리.
// 'ch.' 개인 키만 제거하고, 테마(ch_accent/ch_lang/…)·활성계정 마커는 보존한다.
function clearPersonalSettings() {
  // 보존: 활성계정 마커 + 로그인 토큰(새 계정 토큰을 지우면 새로고침 시 로그아웃된다).
  const KEEP = new Set(["ch.activeAccount", "ch.auth.token"]);
  const remove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("ch.") && !KEEP.has(k)) remove.push(k);
  }
  remove.forEach((k) => localStorage.removeItem(k));
}

export default function App() {
  const t = useT();
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
  const [compareGens, setCompareGens] = useState<Generation[] | null>(null); // DAM 버전 비교
  const [history, setHistory] = useState<History | null>(null); // 히스토리(가계) 패널 대상
  const [boardFocusId, setBoardFocusId] = useState<string | null>(null); // 구성탭 히스토리 트리 포커스
  const [boardSignal, setBoardSignal] = useState(0); // 구성탭 트리 refetch 신호(생성·재생성·동기화 시 ++)
  const bumpBoard = useCallback(() => setBoardSignal((s) => s + 1), []);
  const [boardArrange, setBoardArrange] = useState(0); // '구성에서 보기' 진입 시 자동 정렬(히스토리 패널 미니 트리와 동일 배치)
  const [boardSelected, setBoardSelected] = useState<Generation[]>([]); // 구성탭 선택 노드(부모·선택바용)
  const boardSelectedRef = useRef<Generation[]>([]);
  boardSelectedRef.current = boardSelected;
  // 보드가 보고하는 노드 수(타입필터 기준)·줌% → 상단 LibraryToolbar 표시용.
  const [boardStats, setBoardStats] = useState({ count: 0, zoomPct: 100, viewMoved: false });
  // 상단 크기 슬라이더 → 보드 줌 직접 제어(imperative). 보드가 zoomTo 를 여기에 등록.
  const boardControl = useRef<{ zoomTo: (v: number) => void } | null>(null);
  const boardFocusIdRef = useRef<string | null>(null); // 진입(포커스) 카드 — 선택 없을 때 기본 부모
  boardFocusIdRef.current = boardFocusId;
  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [caching, setCaching] = useState(false);
  const [info, setInfo] = useState<InfoTarget | null>(null); // 휠클릭 정보 팝업
  const [commentGenId, setCommentGenId] = useState<string | null>(null); // 공유 코멘트 스레드 패널 대상
  const [syncTick, setSyncTick] = useState(0); // WS 'synced' 수신 카운터 — 열린 코멘트 패널 실시간 갱신용
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
  // 그리드에서 힉스필드 날짜별로 구분(섹션 헤더) — 그리드 버튼을 한 번 더 누르면 토글
  const [groupByDate, setGroupByDate] = useState(() => LS.get("groupByDate", "0") === "1");
  const [selected, setSelected] = useState<Set<string>>(new Set()); // 다중 선택
  // 에셋 파트와 동일한 인스턴트 필터(툴바) — 로드된 gens 를 클라이언트 측에서 즉시 거른다.
  const [colorFilter, setColorFilter] = useState<Set<string>>(() => LS.loadSet("colorFilter"));
  const [sharedOnly, setSharedOnly] = useState(() => LS.get("sharedOnly", "0") === "1");
  const [tagFilter, setTagFilter] = useState<Set<string>>(() => LS.loadSet("tagFilter"));
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  const [commentOnly, setCommentOnly] = useState(() => LS.get("commentOnly", "0") === "1"); // C 필터: 미확인 코멘트만
  const [finalOnly, setFinalOnly] = useState(() => LS.get("finalOnly", "0") === "1"); // 골드 필터: 최종(골드)만
  // 전역 태그 — 사이드바에서 '무장'한 것들. 다음 생성에 자동 적용(별도 네임스페이스).
  const [armedAutoTags, setArmedAutoTags] = useState<Set<string>>(() => LS.loadSet("armedAutoTags"));
  // 프로젝트(작업 묶음) — App 단일 소스. 사이드바 필터 + 선택바 귀속이 공유.
  const [projects, setProjects] = useState<Project[]>([]);
  const [unassignedCount, setUnassignedCount] = useState(0);
  const [archivedCount, setArchivedCount] = useState(0); // 보관 프로젝트 수(지연 로딩 판단)
  const projectsLoadedRef = useRef(false); // 첫 로드 완료 전엔 stale 가드 비활성(오해제 방지)
  const [adminOpen, setAdminOpen] = useState(false); // 관리자 창(로고 클릭)
  const askPrompt = useAskPrompt(); // 플로팅 입력(네이티브 prompt 대체)
  // 인증(보안) — AUTH_ENABLED 서버일 때만 게이트. config 로드 전엔 null(스플래시).
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [authChecked, setAuthChecked] = useState(false); // 토큰 검증(me) 완료 여부 — 새로고침 깜빡임 방지
  // 내가 최종(골드) 지정 가능한 프로젝트(supervisor/PM). '*' = 전역 모드(전체 가능).
  const [finalizeProjects, setFinalizeProjects] = useState<Set<string>>(new Set());
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

  // 흩어진 필터 상태(filters + 인스턴트 필터)를 서버 쿼리 하나로 합친다.
  // 서버가 모두 거르므로 클라이언트 전량 로드 없이 무한 스크롤로 페이지만 받는다.
  const genQuery = useMemo<GenQuery>(
    () => ({
      tab: filters.tab === "compose" ? "my" : filters.tab,
      worker_id: filters.worker_id,
      share_dir: filters.share_dir,
      local_only: filters.local_only,
      creator_uid: filters.creator_uid,
      project_id: filters.project_id,
      search: filters.search,
      include_deleted: filters.include_deleted,
      deleted_only: filters.deleted_only,
      media_type: typeFilter === "all" ? undefined : typeFilter,
      colors: [...colorFilter],
      tags: [...tagFilter],
      auto_tags: [...armedAutoTags],
      shared_only: sharedOnly || undefined,
      comment_only: commentOnly || undefined,
      final_only: finalOnly || undefined,
    }),
    [filters, typeFilter, colorFilter, tagFilter, armedAutoTags, sharedOnly, commentOnly, finalOnly],
  );
  const genQueryRef = useRef(genQuery);
  genQueryRef.current = genQuery;
  const [hasMore, setHasMore] = useState(false); // 다음 서버 페이지 존재 여부
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [stats, setStats] = useState<GenStats>({ failed_count: 0, has_unread: false });

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
      // 휴지통 모드(지운 것만 보기)면 별도 DB(/api/trash)에서, 아니면 메인에서 첫 페이지.
      const trashMode = !!filtersRef.current.deleted_only;
      const [g, st, f, pr] = await Promise.all([
        trashMode
          ? api.listTrash(genQueryRef.current.search, 0)
          : api.listGenerations(genQueryRef.current, null), // 첫 페이지(커서 없음)
        api.generationStats(), // 실패 수·미확인(전역 파생값)
        api.facets(),
        api.projects(),
      ]);
      setGens(g);
      setHasMore(g.length >= GEN_PAGE);
      setStats(st);
      setFacets(f);
      setProjects(pr.projects);
      setUnassignedCount(pr.unassigned);
      setArchivedCount(pr.archived_count ?? 0);
      projectsLoadedRef.current = true;
    } catch (e) {
      flash("로드 실패: " + String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 무한 스크롤: 다음 페이지를 받아 뒤에 이어 붙인다(중복 id 머지 — offset 경계 안전).
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !authReadyRef.current) return;
    if (filtersRef.current.tab === "compose") return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      // 휴지통은 trashed_at 순(offset), 메인은 sort_ts 키셋 커서.
      const trashMode = !!filtersRef.current.deleted_only;
      let batch: Generation[];
      if (trashMode) {
        batch = await api.listTrash(genQueryRef.current.search, gensRef.current.length);
      } else {
        // 키셋 커서 = 직전 페이지 마지막 행(sort_ts, id). OFFSET 없이 그 뒤부터 받는다.
        const last = gensRef.current[gensRef.current.length - 1];
        const cursor = last ? { ts: last.sort_ts ?? 0, id: last.id } : null;
        batch = await api.listGenerations(genQueryRef.current, cursor);
      }
      setGens((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...batch.filter((x) => !seen.has(x.id))];
      });
      setHasMore(batch.length >= GEN_PAGE);
    } catch {
      /* 다음 스크롤에 재시도 */
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, []);

  // 프로젝트 목록만 가볍게 갱신(사이드바 생성·이름변경·삭제 후 — 그리드 재조회 불필요).
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

  // 모든 필터(project_id·컬러·태그·타입 포함)가 서버 쿼리에 들어가므로, 무엇이 바뀌든
  // 첫 페이지부터 다시 받는다(무한 스크롤 누적 초기화). 서버가 거르니 누락 없이 정확.
  const serverFilterKey = useMemo(() => JSON.stringify(genQuery), [genQuery]);
  useEffect(() => {
    reload();
  }, [serverFilterKey, reload]);

  // 인증 부트스트랩: 서버 모드(auth_enabled) 확인 + 기존 토큰으로 세션 복원.
  useEffect(() => {
    api
      .authConfig()
      .then((cfg) => {
        setAuthConfig(cfg);
        if (cfg.auth_enabled && getAuthToken()) {
          // 토큰 검증이 끝날 때까지 authReady=false → 그동안 화면을 보류(로그인 화면 깜빡임 방지).
          api
            .me()
            .then(setAccount)
            .catch(() => setAuthToken(null))
            .finally(() => setAuthChecked(true));
        } else {
          setAuthChecked(true);
        }
      })
      .catch(() => {
        setAuthConfig({ auth_enabled: false, has_accounts: false });
        setAuthChecked(true);
      });
  }, []);

  // 401(세션 만료/무효) → 로그인 화면으로. api 가 토큰을 이미 비웠다.
  useEffect(() => {
    const onAuthReq = () => setAccount(null);
    window.addEventListener("ch:auth-required", onAuthReq);
    return () => window.removeEventListener("ch:auth-required", onAuthReq);
  }, []);

  // 표시이름 등 내 계정 변경 → account 재조회(전체 UI 의 표시이름 반영).
  useEffect(() => {
    const onUpd = () => api.me().then(setAccount).catch(() => {});
    window.addEventListener("ch:account-updated", onUpd);
    return () => window.removeEventListener("ch:account-updated", onUpd);
  }, []);

  // 계정 전환 감지 → 이전 사용자의 개인 설정(어셋 폴더·필터 등) 정리(같은 브라우저 공유 방지).
  useEffect(() => {
    if (!account?.email) return;
    const prev = localStorage.getItem("ch.activeAccount");
    if (prev && prev !== account.email) {
      // 실제 계정 전환 — localStorage 만 비우면 이미 마운트된 인메모리 state(필터·색·태그 등)에
      // 이전 사용자 값이 남는다. 새 계정 기준으로 확실히 리셋하려고 한 번 새로고침(토큰은 보존).
      clearPersonalSettings();
      localStorage.setItem("ch.activeAccount", account.email);
      window.location.reload();
      return;
    }
    localStorage.setItem("ch.activeAccount", account.email);
  }, [account?.email]);

  // 내가 최종 지정 가능한 프로젝트(supervisor/PM) 로드 → 카드 더블클릭(최종) 활성 판단.
  useEffect(() => {
    if (authConfig?.auth_enabled && !account) {
      setFinalizeProjects(new Set());
      return;
    }
    // 빠른 재전환 시 이전 계정의 응답이 늦게 도착해 새 계정 권한을 덮어쓰지 않도록 가드.
    let ignore = false;
    api
      .myFinalizeRoles()
      .then((r) => {
        if (!ignore) setFinalizeProjects(new Set(r.project_ids));
      })
      .catch(() => {
        if (!ignore) setFinalizeProjects(new Set());
      });
    return () => {
      ignore = true;
    };
  }, [account, authConfig?.auth_enabled]);
  const canFinalize = (g: Generation) =>
    finalizeProjects.has("*") ||
    (!!g.project_id && finalizeProjects.has(g.project_id)) ||
    // 프로젝트 미배정 = Supervisor 개념이 없음 → 본인 것이면 최종 가능(백엔드 require_edit 와 일치).
    (!g.project_id && !!g.is_mine);

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
          bumpBoard(); // 구성탭 트리도 따라잡기
          setSyncTick((t) => t + 1); // 열린 코멘트 패널이 스레드를 다시 불러오게(새 글·삭제 즉시 반영)
          return;
        }
        if (!m.status) return;
        setGens((prev) =>
          prev.map((g) =>
            g.id === m.generation_id ? { ...g, status: m.status! } : g,
          ),
        );
        // 완료되면 전체 새로고침으로 asset/썸네일 반영
        if (m.status === "done") {
          // 구성탭에선 reload 가 라이브러리 조회를 생략하므로, 완료된 잡 1건을 직접 머지해
          // my work 로 돌아갔을 때 asset/썸네일이 즉시 보이게 한다(완료 반영 지연 제거).
          if (m.generation_id) {
            api
              .getGeneration(m.generation_id)
              .then((g) =>
                setGens((prev) =>
                  prev.some((x) => x.id === g.id) ? prev.map((x) => (x.id === g.id ? g : x)) : prev,
                ),
              )
              .catch(() => {});
          }
          reload();
          bumpBoard(); // 구성탭 트리에 완성된 결과 반영
        }
      },
      () => reload(), // (재)연결 시 동기화
    );
    return off;
  }, [reload, bumpBoard]);

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
  useEffect(() => LS.set("groupByDate", groupByDate ? "1" : "0"), [groupByDate]);

  // ── 선택 항목 대상 단축키 작업 (s=소스 / #=태그 / r·g·b=컬러) ──
  const colorSelected = async (ids: string[], color: string) => {
    // 토글: 선택한 카드가 모두 이미 그 색이면 해제(null), 아니면 그 색으로 지정.
    const idSet = new Set(ids);
    const sel = gensRef.current.filter((g) => idSet.has(g.id));
    const allSame = sel.length > 0 && sel.every((g) => g.color === color);
    const next = allSame ? null : color;
    for (const id of ids) {
      try {
        await api.setColor(id, next);
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

  // 정보(ⓘ) 버튼: 복수 선택 상태에서 선택된 카드의 정보를 누르면 비교창, 그 외엔 단일 정보창.
  const handleInfo = (target: InfoTarget) => {
    if (target.kind === "generation" && selected.size >= 2 && selected.has(target.gen.id)) {
      const sel = [...selected]
        .map((id) => gens.find((g) => g.id === id))
        .filter(Boolean) as Generation[];
      if (sel.length >= 2) {
        setCompareGens(sel);
        return;
      }
    }
    setInfo(target);
  };

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
      colorFilter, sharedOnly, commentOnly, finalOnly, tagFilter]);

  // 툴바 인스턴트 필터 영속화.
  useEffect(() => LS.set("colorFilter", JSON.stringify([...colorFilter])), [colorFilter]);
  useEffect(() => LS.set("sharedOnly", sharedOnly ? "1" : "0"), [sharedOnly]);
  useEffect(() => LS.set("commentOnly", commentOnly ? "1" : "0"), [commentOnly]);
  useEffect(() => LS.set("finalOnly", finalOnly ? "1" : "0"), [finalOnly]);
  useEffect(() => LS.set("tagFilter", JSON.stringify([...tagFilter])), [tagFilter]);
  useEffect(() => LS.set("armedAutoTags", JSON.stringify([...armedAutoTags])), [armedAutoTags]);

  // 전역 태그(별도 네임스페이스) — 클릭=무장 토글(다음 생성에 자동 적용), +=추가, ×=전역 삭제.
  const toggleArmedAutoTag = (t: string) =>
    setArmedAutoTags((prev) => {
      const n = new Set(prev);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  const addAutoTag = async () => {
    const name = (await askPrompt("전역 태그 이름", "", "태그 이름 입력 후 Enter"))?.trim();
    if (!name) return;
    try {
      await api.createAutoTag(name);
      await reload();
    } catch (e) {
      flash("전역 태그 추가 실패: " + String(e));
    }
  };
  const removeAutoTag = async (t: string) => {
    if (!window.confirm(`전역 태그 "${t}" 를 삭제할까요?`)) return;
    try {
      await api.deleteAutoTag(t);
      setArmedAutoTags((prev) => {
        const n = new Set(prev);
        n.delete(t);
        return n;
      });
      await reload();
    } catch (e) {
      flash("전역 태그 삭제 실패: " + String(e));
    }
  };

  // 서버가 모든 필터를 이미 적용했으므로 로드된 페이지가 곧 화면 결과(클라이언트 재필터 없음).
  const visibleGens = gens;

  // 미확인 코멘트 여부·실패 수는 전역 파생값 → 서버 stats 에서(전량 로드 대체).
  const hasAnyUnread = stats.has_unread;
  const failedCount = stats.failed_count;
  const clearFailed = async () => {
    if (
      !window.confirm(
        `실패·차단된 생성물 ${failedCount}건을 모두 휴지통으로 보낼까요?\n` +
          `(실패·NSFW 차단 등 — 화면에서 치워지되 '휴지통 보기'에서 복원 가능, 힉스필드 원본엔 영향 없음)`,
      )
    )
      return;
    try {
      const r = await api.clearFailed();
      flash(`${r.removed}건을 휴지통으로 보냈습니다.`);
      await reload();
    } catch (e) {
      flash("정리 오류: " + String(e));
    }
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
  //  ⚠️ 같은 이름("contenthub-assets")의 창은 브라우저가 재사용만 하고 새로고침을 안 해
  //     옛 빌드(CSS)가 남는다 → URL 에 버전값을 붙여 매번 최신 index.html(=최신 CSS 해시)을 받게 한다.
  const openAssetsWindow = () => {
    const url = `/?embed=assets&v=${Date.now()}`;
    const w = window.open(url, "contenthub-assets", "popup=yes,width=1180,height=780,left=140,top=80");
    // 이름 고정 창은 재사용 시 리로드를 안 해 옛 빌드가 남는다 → 핸들을 잡아 강제로 최신 URL 로 이동(리로드).
    try {
      if (w) {
        w.location.href = url;
        w.focus();
      }
    } catch {
      /* 교차출처 아님(동일 출처)이라 정상 동작 — 방어적 try */
    }
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

  // 히스토리 뱃지 → 가계 패널 열기(조상+파생본 조회)
  const onShowHistory = async (g: Generation) => {
    try {
      setHistory(await api.history(g.id));
    } catch (e) {
      flash("가계 조회 실패: " + String(e));
    }
  };
  // 브라우저 뒤로가기를 앱 내 화면 전환으로 처리 — '구성에서 보기'로 들어간 뒤 뒤로가기 시
  // 이전 화면(이전 탭 + 열려있던 히스토리 패널/미리보기)으로 복귀(앱 밖의 404/API 페이지로 이탈 방지).
  const tabRef = useRef(filters.tab);
  tabRef.current = filters.tab;
  // 보드(구성탭)에 들어오기 직전의 '복귀 대상' 화면(탭·열려있던 패널·미리보기). 진입 때 캡처.
  //  - tab 은 절대 'compose' 로 두지 않는다(보드 안에서 또 진입해도 뒤로가기가 보드를 확실히 닫게).
  const boardReturnRef = useRef<{
    tab: Filters["tab"];
    hist: History | null;
    preview: PreviewTarget | null;
  } | null>(null);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const st = e.state as { chBoard?: boolean; genId?: string } | null;
      if (st && st.chBoard) {
        // 보드 엔트리로 이동(앞으로 가기, 또는 board→board 뒤로) → 그 genId 로 보드 열기.
        setHistory(null);
        setPreview(null);
        setBoardFocusId(st.genId ?? null);
        setBoardArrange((v) => v + 1);
        setFilters((f) => (f.tab === "compose" ? f : { ...f, tab: "compose" }));
      } else if (filtersRef.current.tab === "compose") {
        // 비보드 엔트리로 이동(보드에서 빠져나감) → 보드가 열려 있을 때만 복귀 화면으로 닫는다.
        const ret = boardReturnRef.current;
        setBoardFocusId(null);
        setFilters((f) => ({ ...f, tab: ret?.tab ?? "my" })); // compose 가 아닌 탭으로 → 보드 닫힘
        setHistory(ret?.hist ?? null);
        setPreview(ret?.preview ?? null);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // 공통: 결과물 id 로 구성탭 히스토리 트리 열기. 같은 URL 에 히스토리 엔트리만 추가(state 에 genId).
  //  진입 직전 화면을 boardReturnRef 에 캡처 → 뒤로가기로 그 화면 복원, 앞으로가기로 보드 재진입.
  const enterBoard = (genId: string) => {
    const curTab = filters.tab;
    boardReturnRef.current = {
      tab: curTab === "compose" ? "my" : curTab, // 보드에서 또 진입해도 복귀 탭은 비-compose
      hist: history,
      preview,
    };
    window.history.pushState({ chBoard: true, genId }, "");
    setHistory(null);
    setPreview(null);
    setBoardFocusId(genId);
    setBoardArrange((v) => v + 1); // 진입 시 자동 정렬 → 패널 미니 트리와 같은 깔끔한 트리로 보이게
    setFilters((f) => ({ ...f, tab: "compose" }));
  };

  // 히스토리 패널 '구성에서 보기' → 구성탭 트리(뒤로가기로 직전 화면 복원).
  const onOpenInBoard = (g: Generation) => enterBoard(g.id);

  // 미리보기(크게 보기) '구성에서 보기' → 구성탭 트리(뒤로가기로 직전 화면 복원).
  const onOpenInBoardFromPreview = (genId: string) => enterBoard(genId);

  const onRegenerate = async (g: Generation) => {
    try {
      // 무장된 자동태그를 재생성 결과물에도 적용(생성 흐름과 동일).
      await api.regenerate(g.id, { auto_tags: [...armedAutoTags] });
      flash("재생성 잡을 큐에 등록했습니다.");
      await reload();
      bumpBoard(); // 구성탭 트리에 새 파생(pending) 즉시 표시
    } catch (e) {
      flash("재생성 실패: " + String(e));
    }
  };

  const onPublish = async (g: Generation) => {
    try {
      await api.publish(g.id);
      flash("팀에 공유했습니다.");
      await reload();
      bumpBoard();
    } catch (e) {
      flash("공유 실패: " + String(e));
    }
  };

  const onUnpublish = async (g: Generation) => {
    try {
      await api.unpublish(g.id);
      flash("팀 공유를 해제했습니다.");
      await reload();
      bumpBoard();
    } catch (e) {
      flash("공유 해제 실패: " + String(e));
    }
  };

  // v02 CMS — Supervisor 최종(골드) 지정/해제. 카드 S 더블클릭에서 확인 후 호출.
  const onFinalize = async (g: Generation) => {
    try {
      await api.finalize(g.id);
      flash("최종(골드)으로 지정했습니다.");
      await reload();
    } catch (e) {
      flash("최종 지정 실패: " + String(e));
    }
  };
  const onUnfinalize = async (g: Generation) => {
    try {
      await api.unfinalize(g.id);
      flash("최종 지정을 해제했습니다.");
      await reload();
    } catch (e) {
      flash("최종 해제 실패: " + String(e));
    }
  };

  // ── 구성탭(히스토리 보드) 선택바 일괄 작업 — My Work 선택바와 동일 동작(선택 노드 기준) ──
  const boardShare = async (sel: Generation[]) => {
    const targets = sel.filter((g) => g.is_mine && g.status === "done" && !g.shared);
    if (!targets.length) {
      flash("공유할 항목이 없습니다(내 완료·미공유만).");
      return;
    }
    try {
      await Promise.all(targets.map((g) => api.publish(g.id)));
      flash(`${targets.length}개 팀에 공유했습니다.`);
      await reload();
      bumpBoard();
    } catch (e) {
      flash("공유 실패: " + String(e));
    }
  };
  const boardAssign = async (sel: Generation[], projectId: string | null) => {
    const ids = sel.map((g) => g.id);
    if (!ids.length) return;
    try {
      const r = await api.assignProject(ids, projectId);
      await reload();
      bumpBoard();
      flash(`${r.updated}개를 ${projectId ? "프로젝트에 담음" : "미분류로 뺌"}`);
    } catch (e) {
      flash("귀속 실패: " + String(e));
    }
  };
  const boardCreateAssign = async (sel: Generation[], name: string) => {
    try {
      const p = await api.createProject(name);
      await boardAssign(sel, p.id);
    } catch (e) {
      flash("프로젝트 생성 실패: " + String(e));
    }
  };
  const boardDelete = async (sel: Generation[]) => {
    const ids = sel.map((g) => g.id);
    if (!ids.length) return;
    if (
      !window.confirm(
        `선택한 ${ids.length}개를 휴지통으로 보낼까요?\n` +
          `메인 라이브러리에서 빠지고 별도 휴지통 DB로 이동합니다(힉스필드 원본엔 영향 없음).`,
      )
    )
      return;
    try {
      await Promise.all(ids.map((id) => api.deleteGeneration(id)));
      setBoardSelected([]);
      await reload();
      bumpBoard();
      flash(`${ids.length}개를 휴지통으로 보냈습니다.`);
    } catch (e) {
      flash("삭제 실패: " + String(e));
    }
  };

  // 휴지통(soft delete) — 우리 카탈로그에서만 숨김. 힉스필드 원본엔 영향 없음.
  const bulkDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (
      !window.confirm(
        `선택한 ${ids.length}개를 휴지통으로 보낼까요?\n` +
          `메인 라이브러리에서 빠지고 별도 휴지통 DB로 이동합니다(힉스필드 원본엔 영향 없음).\n` +
          `사이드바 '휴지통 보기'에서 검색·복원할 수 있습니다.`,
      )
    )
      return;
    try {
      await Promise.all(ids.map((id) => api.deleteGeneration(id)));
      clearSelect();
      await reload();
      flash(`${ids.length}개를 휴지통으로 보냈습니다.`);
    } catch (e) {
      flash("삭제 실패: " + String(e));
    }
  };

  const bulkRestore = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    try {
      await Promise.all(ids.map((id) => api.restoreGeneration(id)));
      clearSelect();
      await reload();
      flash(`${ids.length}개를 복구했습니다.`);
    } catch (e) {
      flash("복구 실패: " + String(e));
    }
  };

  // 휴지통에서 영구 삭제(복원 불가). 휴지통 DB 에서 완전히 제거.
  const bulkPurge = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (
      !window.confirm(
        `선택한 ${ids.length}개를 영구 삭제할까요?\n` +
          `휴지통에서 완전히 사라지며 복원할 수 없습니다.\n` +
          `(힉스필드 원본·이미 보관된 미디어 파일엔 영향 없음)`,
      )
    )
      return;
    try {
      await Promise.all(ids.map((id) => api.purgeTrashed(id)));
      clearSelect();
      await reload();
      flash(`${ids.length}개를 영구 삭제했습니다.`);
    } catch (e) {
      flash("영구 삭제 실패: " + String(e));
    }
  };

  const onRestore = async (g: Generation) => {
    try {
      await api.restoreGeneration(g.id);
      await reload();
      flash("복구했습니다.");
    } catch (e) {
      flash("복구 실패: " + String(e));
    }
  };

  const onImport = async (g: Generation) => {
    try {
      await api.importToWorkspace(g.id);
      flash("내 워크스페이스로 가져왔습니다 (history 기록).");
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
    const input = await askPrompt("태그 (쉼표 구분)", g.tags.join(", "), "태그1, 태그2, …");
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

  // 인증 검증이 끝나기 전(authConfig 로딩 중 또는 토큰 me 검증 중)에는 화면을 보류한다.
  // → 새로고침 시 메인(전역 provider 이름)·로그인 화면이 잠깐 깜빡이는 것을 방지.
  if (!authChecked && (authConfig === null || getAuthToken())) {
    return null;
  }
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
          <main className="main">
            {/* 구성탭에도 라이브러리 툴바 — 타입/컬러/태그/공유/코멘트 필터(노드 dim) +
                fill(블랙바↔꽉채우기) + scale(보드 확대)을 히스토리 보드에 그대로 적용. */}
            <LibraryToolbar
              typeFilter={typeFilter}
              onTypeFilter={setTypeFilter}
              scale={scale}
              onScale={setScale}
              fill={fill}
              onToggleFill={() => setFill((v) => !v)}
              layout={layout}
              onLayout={setLayout}
              groupByDate={groupByDate}
              onToggleGroupByDate={() => setGroupByDate((v) => !v)}
              filtersOpen={showFilters}
              onToggleFilters={() => setShowFilters((v) => !v)}
              count={boardStats.count}
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
              sharedOnly={sharedOnly}
              onToggleShared={() => setSharedOnly((v) => !v)}
              commentOnly={commentOnly}
              onToggleComment={() => setCommentOnly((v) => !v)}
              finalOnly={finalOnly}
              onToggleFinal={() => setFinalOnly((v) => !v)}
              hasUnread={hasAnyUnread}
              tags={facets.tags}
              tagFilter={tagFilter}
              onSelectTag={selectTagFilter}
              onDeleteTag={deleteTagEverywhere}
              onClearTags={clearTagFilter}
              tagPanelOpen={tagPanelOpen}
              onToggleTagPanel={toggleTagPanel}
              zoomValue={boardStats.zoomPct / 100}
              onZoomValue={(v) => boardControl.current?.zoomTo(v)}
              boardMode
            />
            <HistoryBoard
              focusId={boardFocusId}
              reloadSignal={boardSignal}
              arrangeSignal={boardArrange}
              onPreview={setPreview}
              onInfo={setInfo}
              onRegenerate={onRegenerate}
              onPublish={onPublish}
              onUnpublish={onUnpublish}
              onFinalize={onFinalize}
              onUnfinalize={onUnfinalize}
              canFinalize={canFinalize}
              onSelectionChange={setBoardSelected}
              onStats={setBoardStats}
              controlRef={boardControl}
              fill={fill}
              scale={1}
              typeFilter={typeFilter}
              colorFilter={colorFilter}
              tagFilter={tagFilter}
              sharedOnly={sharedOnly}
              commentOnly={commentOnly}
              finalOnly={finalOnly}
            />
          </main>
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
                finalOnly={finalOnly}
                onToggleFinal={() => setFinalOnly((v) => !v)}
                armedAutoTags={armedAutoTags}
                onToggleAutoTag={toggleArmedAutoTag}
                onAddAutoTag={addAutoTag}
                onDeleteAutoTag={removeAutoTag}
                onCreatorChanged={reload}
                projects={projects}
                unassignedCount={unassignedCount}
                archivedCount={archivedCount}
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
                groupByDate={groupByDate}
                onToggleGroupByDate={() => setGroupByDate((v) => !v)}
                filtersOpen={showFilters}
                onToggleFilters={() => setShowFilters((v) => !v)}
                count={visibleGens.length}
                countMore={hasMore}
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
                sharedOnly={sharedOnly}
                onToggleShared={() => setSharedOnly((v) => !v)}
                commentOnly={commentOnly}
                onToggleComment={() => setCommentOnly((v) => !v)}
                finalOnly={finalOnly}
                onToggleFinal={() => setFinalOnly((v) => !v)}
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
                    groupByDate={groupByDate}
                    selectedIds={selected}
                    onSelectedChange={setSelected}
                    onToggleSelect={toggleSelect}
                    onSetSource={onSetSource}
                    onSetTags={onSetTags}
                    onOpenComments={(g) => setCommentGenId(g.id)}
                    onRegenerate={onRegenerate}
                    onPublish={onPublish}
                    onUnpublish={onUnpublish}
                    onFinalize={onFinalize}
                    onUnfinalize={onUnfinalize}
                    canFinalize={canFinalize}
                    onImport={onImport}
                    onRestore={onRestore}
                    dimDeleted={!filters.deleted_only}
                    onColor={onColor}
                    onTags={onTags}
                onInfo={handleInfo}
                onPreview={setPreview}
                onShowHistory={onShowHistory}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadMore={loadMore}
              />
            </main>
          </>
        )}
      </div>

      {/* 프롬프트 입력바 — 구성탭에서도 표시(트리에서 바로 생성) */}
      {true && (
        <SpotlightPrompt
          armedAutoTags={[...armedAutoTags]}
          activeProjectId={
            filters.project_id && filters.project_id !== "none"
              ? filters.project_id
              : undefined
          }
          topSlot={
            filters.tab === "compose" ? (
              // 구성탭(히스토리 보드) 선택바도 다른 탭처럼 프롬프트 위에 — 보드 선택 노드 기준.
              boardSelected.length > 0 ? (
                <div className="select-bar">
                  <span className="sb-count">
                    {boardSelected.length}
                    {t("개 선택")}
                  </span>
                  <button onClick={() => boardShare(boardSelected)}>
                    {t("↗ 팀에 공유")}
                  </button>
                  {boardSelected.length >= 2 && (
                    <button
                      onClick={() => setCompareGens(boardSelected)}
                      title="선택한 결과물들을 나란히 비교(프롬프트·파라미터 차이 색칠)"
                    >
                      ⊞ 비교
                    </button>
                  )}
                  <ProjectAssignMenu
                    count={boardSelected.length}
                    projects={projects}
                    onAssign={(pid) => boardAssign(boardSelected, pid)}
                    onCreateAndAssign={(name) => boardCreateAssign(boardSelected, name)}
                  />
                  <button
                    className="sb-del"
                    onClick={() => boardDelete(boardSelected)}
                    title="휴지통으로 보내기"
                  >
                    🗑 삭제
                  </button>
                </div>
              ) : undefined
            ) : selected.size > 0 ? (
              <div className="select-bar">
                <span className="sb-count">{selected.size}{t("개 선택")}</span>
                {filters.tab === "my" && (
                  <button onClick={bulkPublish}>{t("↗ 팀에 공유")}</button>
                )}
                {selected.size >= 2 && (
                  <button
                    onClick={() => {
                      const sel = [...selected]
                        .map((id) => gens.find((g) => g.id === id))
                        .filter(Boolean) as Generation[];
                      if (sel.length >= 2) setCompareGens(sel);
                    }}
                    title="선택한 버전들을 나란히 비교(프롬프트·파라미터 차이 색칠)"
                  >
                    ⊞ 비교
                  </button>
                )}
                <ProjectAssignMenu
                  count={selected.size}
                  projects={projects}
                  onAssign={assignSelectedToProject}
                  onCreateAndAssign={createAndAssign}
                />
                {(() => {
                  // 선택 항목의 삭제 상태에 따라 삭제/복구 노출(둘 다 섞이면 둘 다)
                  const sel = [...selected]
                    .map((id) => gens.find((g) => g.id === id))
                    .filter(Boolean) as Generation[];
                  return (
                    <>
                      {sel.some((g) => !g.deleted) && (
                        <button className="sb-del" onClick={bulkDelete} title="휴지통으로 보내기">
                          🗑 삭제
                        </button>
                      )}
                      {sel.some((g) => g.deleted) && (
                        <button onClick={bulkRestore} title="휴지통에서 복구">
                          ↺ {t("복구")}
                        </button>
                      )}
                      {sel.some((g) => g.deleted) && (
                        <button
                          className="sb-del"
                          onClick={bulkPurge}
                          title="휴지통에서 영구 삭제(복원 불가)"
                        >
                          ⨯ {t("영구삭제")}
                        </button>
                      )}
                    </>
                  );
                })()}
              </div>
            ) : undefined
          }
          onCreated={async (created, dragParentId) => {
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
            // 자동 히스토리(원본→파생) 부모 모으기(합집합):
            //  · 드래그해서 불러온 원본(dragParentId)은 **어느 탭에서든** 부모로 — '드래그→수정→생성'이
            //    곧 그 원본의 파생본이 되게(생성 순서/뎁스가 쌓임).
            //  · 구성탭이면 추가로 보드에서 선택한 노드(없으면 진입 포커스 카드)도 부모로.
            const parents = new Set<string>();
            if (dragParentId) parents.add(dragParentId);
            if (filtersRef.current.tab === "compose") {
              const selIds = boardSelectedRef.current.map((g) => g.id);
              (selIds.length > 0
                ? selIds
                : boardFocusIdRef.current
                  ? [boardFocusIdRef.current]
                  : []
              ).forEach((p) => parents.add(p));
            }
            if (parents.size && created?.length) {
              // 후보 부모를 한 번에 넘기면 서버가 전이 축소 — 이미 다른 부모를 거쳐 도달 가능한
              // 조상에는 직접 엣지를 안 만든다(원본→중간→자식 체인 유지). 실패는 무시(생성은 유지).
              await Promise.all(
                created.map((c) =>
                  api.deriveFrom(c.id, [...parents]).catch(() => {}),
                ),
              );
            }
            reload();
            bumpBoard(); // 구성탭 트리에 새 생성(연결되면) 반영
          }}
        />
      )}
      {commentGenId && (
        <GenCommentPanel
          genId={commentGenId}
          label={
            (gens.find((g) => g.id === commentGenId)?.prompt || "").slice(0, 40) || "생성본"
          }
          myId={account?.creator_uid || "me"}
          syncTick={syncTick}
          onClose={() => setCommentGenId(null)}
          onChanged={reload}
        />
      )}
      {info && (
        <InfoPopup
          target={info}
          onClose={() => setInfo(null)}
          onPreview={setPreview}
          projects={projects}
          onOpenInBoard={(g) => {
            setInfo(null);
            onOpenInBoard(g);
          }}
        />
      )}
      {preview && (
        <MediaPreview
          target={preview}
          onClose={() => setPreview(null)}
          onOpenInBoard={onOpenInBoardFromPreview}
        />
      )}
      {adminOpen && (
        <AdminWindow
          account={account}
          onClose={() => {
            setAdminOpen(false);
            reload(); // 등급·프로젝트 변경이 라이브러리/필터에 반영되게
          }}
        />
      )}
      {compareGens && (
        <CompareModal gens={compareGens} onClose={() => setCompareGens(null)} />
      )}
      {history && (
        <HistoryPanel
          history={history}
          onClose={() => setHistory(null)}
          onPreview={setPreview}
          onInfo={setInfo}
          onCompare={setCompareGens}
          onChanged={reload}
          onOpenInBoard={onOpenInBoard}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
