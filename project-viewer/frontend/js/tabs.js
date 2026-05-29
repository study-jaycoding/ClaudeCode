// =====================================================================
// 사이드바 탭 전환 (트리 / 즐겨찾기 / 생성)
// - 모듈 로드 시 tabBtns 에 click 핸들러 자동 등록
// - 탭별로 사이드바 패널 표시 + 미리보기 영역 그리드 갱신
// =====================================================================
import { tabBtns, tabTree, tabFavorites, tabGenerated } from "./dom.js";
import {
    currentProject, currentDir, rootTree,
    activeTab, setActiveTab, activeTagFilter,
} from "./state.js";
import {
    initFavorites, renderFavorites,
    updateFavCount, updateCardNewBadges,
} from "./favorites.js";
import { showFolderGrid, showSourceGrid, showGeneratedGrid } from "./grid.js";
import { findNodeByPath } from "./utils.js";

tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
        tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
        setActiveTab(btn.dataset.tab);
        tabTree.classList.toggle("hidden", activeTab !== "tree");
        tabFavorites.classList.toggle("hidden", activeTab !== "favorites");
        if (tabGenerated) tabGenerated.classList.toggle("hidden", activeTab !== "generated");

        if (activeTab === "favorites") {
            renderFavorites();
            showSourceGrid(activeTagFilter);
        } else if (activeTab === "generated") {
            showGeneratedGrid();
            initFavorites();
        } else {
            // 트리 탭으로 돌아가면 현재 폴더 그리드 복원
            if (currentProject && rootTree) {
                const node = findNodeByPath(rootTree, currentDir) || rootTree;
                showFolderGrid(currentProject, node);
            }
        }
        updateFavCount();
        updateCardNewBadges();
    });
});
