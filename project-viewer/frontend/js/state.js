// =====================================================================
// 전역 mutable state — ES module 의 live binding 활용
// 사용처는 변수명 그대로 import 해서 읽으면 항상 최신값.
// 재할당이 필요한 곳에서만 setter 함수를 호출한다.
// (push/splice/property 변경 같은 mutation 은 setter 없이 그대로 가능)
// =====================================================================

// --- 프로젝트 / 트리 ---
export let currentProject = "";
export function setCurrentProject(v) { currentProject = v; }

export let currentDir = "";
export function setCurrentDir(v) { currentDir = v; }

export let rootTree = null;
export function setRootTree(v) { rootTree = v; }

// --- 즐겨찾기 (favorites.json 캐시) ---
export let favorites = [];
export function setFavorites(v) { favorites = v; }

export let firstFavoritesLoad = true;
export function setFirstFavoritesLoad(v) { firstFavoritesLoad = v; }

export let activeTagFilter = null;
export function setActiveTagFilter(v) { activeTagFilter = v; }

// --- 사이드바 탭 ---
export let activeTab = "tree";
export function setActiveTab(v) { activeTab = v; }

// --- 뷰 컨트롤 (카드/리스트, 정렬) ---
export let currentView = "grid";  // "grid" | "list"
export function setCurrentView(v) { currentView = v; }

export let currentSortKey = "name";  // name | kind | size | mtime
export function setCurrentSortKey(v) { currentSortKey = v; }

export let currentSortDir = "asc";  // asc | desc
export function setCurrentSortDir(v) { currentSortDir = v; }

// --- 선택 / lasso ---
export let lastSelectedCard = null;
export function setLastSelectedCard(v) { lastSelectedCard = v; }

export let lassoStart = null;
export function setLassoStart(v) { lassoStart = v; }

export let lassoActive = false;
export function setLassoActive(v) { lassoActive = v; }

export let lassoPreSelected = null;
export function setLassoPreSelected(v) { lassoPreSelected = v; }

export let suppressClickUntil = 0;
export function setSuppressClickUntil(v) { suppressClickUntil = v; }

// --- 카드 long-press 타이머 ---
export let longPressTimer = null;
export function setLongPressTimer(v) { longPressTimer = v; }

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
