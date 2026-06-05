// =====================================================================
// 사이드바 탭 전환 (트리 / 즐겨찾기 / 생성)
// - 모듈 로드 시 tabBtns 에 click 핸들러 자동 등록
// - 탭별로 사이드바 패널 표시 + 미리보기 영역 그리드 갱신
// =====================================================================
import {
    tabBtns, tabTree, tabFavorites, tabGenerated, tabViewer,
    viewerStage, previewContent,
} from "./dom.js";
import {
    currentProject, currentDir, rootTree,
    activeTab, setActiveTab, activeTagFilter,
    sidebarOpen, setSidebarOpen, setLastFocusArea,
    setCurrentDir, getTreeLastDirForProject,
} from "./state.js";
import {
    renderFavorites,
    updateFavCount, updateCardNewBadges,
} from "./favorites.js";
import { showFolderGrid, showSourceGrid, showGeneratedGrid } from "./grid.js";
import { refreshQueue } from "./queue.js";
import { showViewer, hideViewer } from "./viewer-tab.js";
import { findNodeByPath } from "./utils.js";

const sidebar = document.querySelector("aside.sidebar");
const previewSection = document.querySelector("section.preview");
const spotlightEl = document.getElementById("spotlight");

// =====================================================================
// 탭별 DOM 보존 — previewContent 의 children 을 DocumentFragment 로 detach 해서
// 캐시. 같은 탭+같은 key 재방문 시 통째로 다시 attach (재렌더 0).
// invalidatePaneCache() 로 외부에서 무효화.
// =====================================================================
const _paneCache = new Map();   // key → DocumentFragment
let _lastPaneKey = null;
let _mo = null;

function _currentPaneKey() {
    if (activeTab === "tree")      return `tree|${currentProject}|${currentDir}`;
    if (activeTab === "favorites") return `favorites|${currentProject}|${activeTagFilter}`;
    if (activeTab === "generated") return `gen|${currentProject}`;
    if (activeTab === "viewer")    return `gen|${currentProject}`;  // viewer 도 같은 그리드
    return `${activeTab}|${currentProject}`;
}

function _detachCurrentPane() {
    if (!_lastPaneKey || !previewContent || !previewContent.firstChild) return;
    const frag = document.createDocumentFragment();
    while (previewContent.firstChild) frag.appendChild(previewContent.firstChild);
    _paneCache.set(_lastPaneKey, frag);
    if (_mo) _mo.takeRecords();   // 자체 mutation 흡수 — MO 가 lastPaneKey 안 건드리게
}

function _restorePane(key) {
    const frag = _paneCache.get(key);
    if (!frag) return false;
    while (previewContent.firstChild) previewContent.removeChild(previewContent.firstChild);
    previewContent.appendChild(frag);
    _paneCache.delete(key);       // 일회용 — 다음 detach 가 다시 저장
    if (_mo) _mo.takeRecords();
    return true;
}

/** 외부 무효화 — pv:project-changed, file CRUD, 데이터 변경 시 호출.
 *  predicate(key) 가 truthy 인 cache 만 삭제. predicate 없으면 전부. */
export function invalidatePaneCache(predicate) {
    if (!predicate) { _paneCache.clear(); return; }
    for (const key of Array.from(_paneCache.keys())) {
        if (predicate(key)) _paneCache.delete(key);
    }
}

// show* 가 previewContent 를 직접 갱신하면 (예: 폴더 진입) MO 가 감지해서
// _lastPaneKey 를 최신 _currentPaneKey() 로 다시 묶고, 그 탭의 stale cache 삭제.
function _initPaneCache() {
    if (!previewContent) return;
    _mo = new MutationObserver(() => {
        _lastPaneKey = _currentPaneKey();
        _paneCache.delete(_lastPaneKey);
    });
    _mo.observe(previewContent, { childList: true });
    _lastPaneKey = _currentPaneKey();
}
_initPaneCache();

// 프로젝트 바뀌면 모든 cache 무효 — 다른 프로젝트 데이터.
window.addEventListener("pv:project-changed", () => invalidatePaneCache());

// 코멘트 변경 (추가/삭제/파일 삭제 동기화 등) 시 모든 pane cache 무효 —
// 카드의 코멘트 배지가 stale 캐시 DOM 에 박혀있으면 갱신 안 됨.
window.addEventListener("pv:comments-changed", () => invalidatePaneCache());

/** DOM 가시성(탭 + sidebar collapsed) 을 현재 state 에 맞춰 동기화. */
function applySidebarState() {
    tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === activeTab));
    tabTree.classList.toggle("hidden", activeTab !== "tree");
    tabFavorites.classList.toggle("hidden", activeTab !== "favorites");
    if (tabGenerated) tabGenerated.classList.toggle("hidden", activeTab !== "generated");
    if (tabViewer) tabViewer.classList.toggle("hidden", activeTab !== "viewer");
    if (sidebar) sidebar.classList.toggle("collapsed", !sidebarOpen);
    // 보기 탭이면 우측 .preview 영역 전체에 viewer-stage 가 absolute 로 덮음.
    // .preview.viewer-mode 가 view-controls/preview-info/preview-content 를 숨겨
    // 스크롤/배치 충돌을 막는다.
    const isViewer = activeTab === "viewer";
    if (previewSection) previewSection.classList.toggle("viewer-mode", isViewer);
    if (viewerStage) viewerStage.classList.toggle("hidden", !isViewer);
    if (spotlightEl) spotlightEl.classList.toggle("hidden-by-tab", isViewer);
}

/** 활성 탭의 그리드/리스트를 그린다. cache hit 면 DOM 통째로 복원, miss 면 render.
 *  탭 전환 클릭 핸들러에서 호출. 같은 (탭+key) 재방문은 즉시. */
function renderForActiveTab() {
    const newKey = _currentPaneKey();
    if (newKey === _lastPaneKey && previewContent && previewContent.firstChild) {
        // 이미 그 탭의 그 key 가 화면에 있음 — 아무 것도 안 함
        return;
    }

    // 이전 탭 콘텐츠 detach 해서 cache 에 보관
    _detachCurrentPane();
    _lastPaneKey = newKey;

    // 새 탭에 cache 가 있으면 통째로 복원 — render 없음.
    if (_restorePane(newKey)) {
        // 사이드바 부수 처리만 (count / new badge — 가벼움)
        updateFavCount();
        updateCardNewBadges();
        // viewer 탭은 stage 도 켜야 함 (showViewer 가 항상 호출되어야 재생 상태 복원)
        if (activeTab === "viewer") showViewer();
        // queue 사이드바도 항상 최신 (cheap)
        if (activeTab === "generated") refreshQueue();
        return;
    }

    // cache miss — 평소처럼 render
    if (activeTab === "favorites") {
        renderFavorites();
        showSourceGrid(activeTagFilter);
    } else if (activeTab === "generated") {
        showGeneratedGrid();
        refreshQueue();
        // initFavorites 는 프로젝트 변경/SSE 시 자동 갱신 → 탭 전환마다 재호출 불필요
    } else if (activeTab === "viewer") {
        // 위: 생성 결과물 그리드 (showGeneratedGrid) + 아래: viewer-stage 의 split 레이아웃.
        showGeneratedGrid();
        showViewer();
    } else {
        // 구성 탭 — 그 탭에서 마지막 본 폴더 복원 (생성탭에서 Result/cut001 로 갔다 와도
        // 구성탭은 원래 자기 폴더 그대로 보여야 함).
        if (currentProject && rootTree) {
            const savedDir = getTreeLastDirForProject(currentProject);
            const node = (savedDir && findNodeByPath(rootTree, savedDir))
                || findNodeByPath(rootTree, currentDir)
                || rootTree;
            setCurrentDir(node.path || "");
            showFolderGrid(currentProject, node);
        }
    }
    updateFavCount();
    updateCardNewBadges();
}

tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
        const wantTab = btn.dataset.tab;
        if (wantTab === activeTab) {
            // 같은(이미 active) 탭 클릭 → panel 열림/닫힘 토글. 그리드 재렌더 불필요.
            setSidebarOpen(!sidebarOpen);
            applySidebarState();
            return;
        }
        // 다른 탭 클릭 → 그 탭으로 전환만. sidebarOpen 상태는 사용자가 명시적으로
        // 같은 탭을 다시 클릭해야 토글됨 (자동 펼침 안 함).
        // 보기 탭을 떠나는 경우 영상 일시정지.
        if (activeTab === "viewer" && wantTab !== "viewer") hideViewer();
        setActiveTab(wantTab);
        // 키보드 방향키가 새 탭을 따라가게 lastFocusArea 도 동기화.
        // (사용자가 카드를 다시 클릭하지 않아도 바로 화살표가 새 탭에서 동작)
        if (wantTab === "favorites") setLastFocusArea("favorites");
        else if (wantTab === "generated") setLastFocusArea("queue");
        else if (wantTab === "viewer") setLastFocusArea("");
        else setLastFocusArea("tree");
        applySidebarState();
        renderForActiveTab();
    });
});

// 시작 시 저장된 active 탭 + sidebar 열림 상태 복원.
// 그리드 렌더는 프로젝트 로드 후 별도 흐름에서 진행됨.
applySidebarState();
