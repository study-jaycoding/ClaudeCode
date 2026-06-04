// =====================================================================
// 사이드바 탭 전환 (트리 / 즐겨찾기 / 생성)
// - 모듈 로드 시 tabBtns 에 click 핸들러 자동 등록
// - 탭별로 사이드바 패널 표시 + 미리보기 영역 그리드 갱신
// =====================================================================
import {
    tabBtns, tabTree, tabFavorites, tabGenerated, tabViewer,
    viewerStage,
} from "./dom.js";
import {
    currentProject, currentDir, rootTree,
    activeTab, setActiveTab, activeTagFilter,
    sidebarOpen, setSidebarOpen, setLastFocusArea,
    setCurrentDir, getTreeLastDirForProject,
} from "./state.js";
import {
    initFavorites, renderFavorites,
    updateFavCount, updateCardNewBadges,
} from "./favorites.js";
import { showFolderGrid, showSourceGrid, showGeneratedGrid } from "./grid.js";
import { refreshQueue } from "./queue.js";
import { showViewer, hideViewer } from "./viewer-tab.js";
import { findNodeByPath } from "./utils.js";

const sidebar = document.querySelector("aside.sidebar");
const previewSection = document.querySelector("section.preview");
const spotlightEl = document.getElementById("spotlight");

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

/** 활성 탭의 그리드/리스트를 그린다. (탭이 진짜 바뀐 경우에만 호출) */
function renderForActiveTab() {
    if (activeTab === "favorites") {
        renderFavorites();
        showSourceGrid(activeTagFilter);
    } else if (activeTab === "generated") {
        showGeneratedGrid();
        initFavorites();
        refreshQueue();
    } else if (activeTab === "viewer") {
        // 위: 생성 결과물 그리드 (showGeneratedGrid) + 아래: viewer-stage 의 split 레이아웃.
        // 그리드에서 카드를 드래그/클릭으로 트랙에 추가 가능.
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
