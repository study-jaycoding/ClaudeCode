// =====================================================================
// 전역 mutable state — ES module 의 live binding 활용
// 사용처는 변수명 그대로 import 해서 읽으면 항상 최신값.
// 재할당이 필요한 곳에서만 setter 함수를 호출한다.
// (push/splice/property 변경 같은 mutation 은 setter 없이 그대로 가능)
// =====================================================================

// --- 프로젝트 / 트리 ---
// 마지막 선택 프로젝트는 localStorage 에 영구 저장 (재실행 시 자동 복원).
const PROJECT_KEY = "viewer.lastProject";
export let currentProject = "";
export function setCurrentProject(v) {
    currentProject = v;
    try {
        if (v) localStorage.setItem(PROJECT_KEY, v);
        else localStorage.removeItem(PROJECT_KEY);
    } catch {}
    // spotlight 가 자동으로 같은 프로젝트로 따라오도록 알림
    try { window.dispatchEvent(new CustomEvent("pv:project-changed", { detail: { project: v } })); } catch {}
}
export function getLastProject() {
    try { return localStorage.getItem(PROJECT_KEY) || ""; } catch { return ""; }
}

// 프로젝트별 마지막 선택 폴더를 localStorage 에 저장 — 새로고침/재실행 후 복원.
const DIR_KEY = "viewer.lastDirByProject";
function _readDirMap() {
    try { return JSON.parse(localStorage.getItem(DIR_KEY) || "{}") || {}; }
    catch { return {}; }
}
function _writeDirMap(m) {
    try { localStorage.setItem(DIR_KEY, JSON.stringify(m)); } catch {}
}
// 탭별 마지막 본 폴더 별도 저장 — 탭 전환 시 각자 위치 복원.
//   "Result/..." 시작 → 생성 탭 / 그 외 → 구성 탭
const GEN_DIR_KEY = "viewer.generatedLastDirByProject";
const TREE_DIR_KEY = "viewer.treeLastDirByProject";
function _readMap(key) {
    try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; }
    catch { return {}; }
}
function _writeMap(key, m) {
    try { localStorage.setItem(key, JSON.stringify(m)); } catch {}
}

export let currentDir = "";
export function setCurrentDir(v) {
    currentDir = v || "";
    if (!currentProject) return;
    // 전체 마지막 (호환) — 기존 lastDirByProject
    const m = _readDirMap();
    m[currentProject] = currentDir;
    _writeDirMap(m);
    // 탭별 분리 저장
    if (currentDir.startsWith("Result")) {
        const gm = _readMap(GEN_DIR_KEY);
        gm[currentProject] = currentDir;
        _writeMap(GEN_DIR_KEY, gm);
    } else {
        const tm = _readMap(TREE_DIR_KEY);
        tm[currentProject] = currentDir;
        _writeMap(TREE_DIR_KEY, tm);
    }
}
export function getLastDirForProject(project) {
    if (!project) return "";
    return _readDirMap()[project] || "";
}
export function getGeneratedLastDirForProject(project) {
    if (!project) return "";
    return _readMap(GEN_DIR_KEY)[project] || "";
}
export function getTreeLastDirForProject(project) {
    if (!project) return "";
    return _readMap(TREE_DIR_KEY)[project] || "";
}

export let rootTree = null;
export function setRootTree(v) { rootTree = v; }

// 카드 컬러 마커 — {path: "red"|"green"|"blue"}. 프로젝트 변경 시 새로 로드.
// 활성 컬러 필터 — "" (전체), "red", "green", "blue" 중 하나.
// 활성 종류 필터 — "" (전체), "image", "video" 중 하나.
// 두 필터는 직교적으로 적용 (color AND kind). 그리드.js 가 둘 다 체크.
export let colors = {};
export function setColors(c) { colors = c || {}; }

// kind/color 필터는 탭별로 분리 — 각 탭에서 설정한 값이 그 탭에서만 적용되고 기억됨.
// localStorage 에 영구 저장. activeTab 키로 색인.
const KIND_FILTERS_KEY = "viewer.kindFilters";
const COLOR_FILTERS_KEY = "viewer.colorFilters";
function _readFilterMap(key) {
    try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; }
    catch { return {}; }
}
function _writeFilterMap(key, m) {
    try { localStorage.setItem(key, JSON.stringify(m)); } catch {}
}
export function getKindFilter() {
    return _readFilterMap(KIND_FILTERS_KEY)[activeTab] || "";
}
export function getColorFilter() {
    return _readFilterMap(COLOR_FILTERS_KEY)[activeTab] || "";
}
export function setKindFilter(v) {
    const m = _readFilterMap(KIND_FILTERS_KEY);
    if (v) m[activeTab] = v; else delete m[activeTab];
    _writeFilterMap(KIND_FILTERS_KEY, m);
}
export function setColorFilter(v) {
    const m = _readFilterMap(COLOR_FILTERS_KEY);
    if (v) m[activeTab] = v; else delete m[activeTab];
    _writeFilterMap(COLOR_FILTERS_KEY, m);
}

// --- 즐겨찾기 (favorites.json 캐시) ---
export let favorites = [];
export function setFavorites(v) { favorites = v; }

export let firstFavoritesLoad = true;
export function setFirstFavoritesLoad(v) { firstFavoritesLoad = v; }

// 태그 필터도 localStorage 영구 저장 — Chrome 재시작 후에도 마지막 필터 유지.
const TAG_FILTER_KEY = "viewer.activeTagFilter";
export let activeTagFilter = (() => {
    try {
        const v = localStorage.getItem(TAG_FILTER_KEY);
        return v && v !== "null" ? v : null;
    } catch { return null; }
})();
export function setActiveTagFilter(v) {
    activeTagFilter = v;
    try {
        if (v) localStorage.setItem(TAG_FILTER_KEY, v);
        else localStorage.removeItem(TAG_FILTER_KEY);
    } catch {}
}

// --- 사이드바 탭 (localStorage 영구 저장) ---
const ACTIVE_TAB_KEY = "viewer.activeTab";
export let activeTab = (() => {
    try {
        const v = localStorage.getItem(ACTIVE_TAB_KEY);
        if (v === "tree" || v === "favorites" || v === "generated" || v === "viewer") return v;
        // 옛 "queue" 값은 생성 탭으로 fallback (큐 탭이 생성 탭에 흡수됨)
        if (v === "queue") return "generated";
    } catch {}
    return "tree";
})();
export function setActiveTab(v) {
    activeTab = v;
    try { localStorage.setItem(ACTIVE_TAB_KEY, v); } catch {}
}

// --- 보기 탭 — 프로젝트별 트랙 (localStorage 영구 저장).
// 항목: { id, project, path, kind: "image"|"video", duration: 초 (image=4, video=메타 로드 시 채움) }
const VIEWER_TRACKS_KEY = "viewer.viewerTracksByProject";
function _readTracksMap() {
    try { return JSON.parse(localStorage.getItem(VIEWER_TRACKS_KEY) || "{}") || {}; }
    catch { return {}; }
}
function _writeTracksMap(m) {
    try { localStorage.setItem(VIEWER_TRACKS_KEY, JSON.stringify(m)); } catch {}
}
export function getViewerTrackForProject(project) {
    if (!project) return [];
    const m = _readTracksMap();
    return Array.isArray(m[project]) ? m[project] : [];
}
export function setViewerTrackForProject(project, items) {
    if (!project) return;
    const m = _readTracksMap();
    m[project] = Array.isArray(items) ? items : [];
    _writeTracksMap(m);
}

// 사이드바 panel 열림/닫힘 — 같은 탭 다시 클릭 시 토글. localStorage 영구 저장.
const SIDEBAR_OPEN_KEY = "viewer.sidebarOpen";
export let sidebarOpen = (() => {
    try {
        const v = localStorage.getItem(SIDEBAR_OPEN_KEY);
        return v === null ? true : v === "1";
    } catch { return true; }
})();
export function setSidebarOpen(v) {
    sidebarOpen = !!v;
    try { localStorage.setItem(SIDEBAR_OPEN_KEY, sidebarOpen ? "1" : "0"); } catch {}
}

// --- 뷰 컨트롤 (카드/리스트, 정렬) ---
export let currentView = "grid";  // "grid" | "list"
export function setCurrentView(v) { currentView = v; }

// 기본: 수정일 + 내림차순 = 최근에 생성/수정된 파일이 위로.
export let currentSortKey = "mtime";  // name | kind | size | mtime | addedAt | tag
export function setCurrentSortKey(v) { currentSortKey = v; }

export let currentSortDir = "desc";  // asc | desc — 기본 내림 (최신 위)
export function setCurrentSortDir(v) { currentSortDir = v; }

// --- 선택 / lasso ---
export let lastSelectedCard = null;
export function setLastSelectedCard(v) { lastSelectedCard = v; }

// 키보드 방향키 네비게이션이 따라갈 영역. 마지막 마우스 인터랙션 위치로 갱신.
export let lastFocusArea = "";  // "" | "tree" | "grid" | "favorites" | "queue"
export function setLastFocusArea(v) { lastFocusArea = v; }

// shift+방향키 / shift-click 시 range 시작점 (anchor).
// 단일/ctrl 클릭으로 새로 선택하면 null 로 리셋. shift 첫 발동 시 마지막 단일 선택 카드로 설정.
export let shiftAnchorCard = null;
export function setShiftAnchorCard(v) { shiftAnchorCard = v; }

// 트리에서 shift+방향키 range 시작점 (path).
export let shiftAnchorTreePath = "";
export function setShiftAnchorTreePath(v) { shiftAnchorTreePath = v; }

export let lassoStart = null;
export function setLassoStart(v) { lassoStart = v; }

export let lassoActive = false;
export function setLassoActive(v) { lassoActive = v; }

export let lassoPreSelected = null;
export function setLassoPreSelected(v) { lassoPreSelected = v; }

export let suppressClickUntil = 0;
export function setSuppressClickUntil(v) { suppressClickUntil = v; }

// --- 우클릭 메뉴 타깃 ---
export let treeMenuTarget = null;  // { project, paths: string[], lastMx, lastMy }
export function setTreeMenuTarget(v) { treeMenuTarget = v; }

// --- 드래그앤드롭 카운터 ---
export let dragDepth = 0;
export function setDragDepth(v) { dragDepth = v; }

// --- SSE EventSource ---
export let sseSource = null;
export function setSseSource(v) { sseSource = v; }

// --- Undo 스택 ---
export const undoStack = [];   // const but mutable (push/pop/shift)
