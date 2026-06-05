// =====================================================================
// 엔트리 — 모듈 wiring + 프로젝트/트리 로드 + 시작
// 실제 로직은 각 ./*.js 모듈에 분산:
//   utils / dom / api / state — 기반
//   lightbox / undo / sse / view-controls / favorites — 독립 기능
//   selection / tree / popup / menus / grid / upload — 상호 callback
//   keyboard / tabs — 사이드 효과 (모듈 로드만으로 핸들러 등록)
// =====================================================================
import { escapeHtml } from "./utils.js";
import {
    projectSelect, fileTree, previewContent,
} from "./dom.js";
import { apiListProjects, apiGetTree, apiGetColors } from "./api.js";
import { setColors } from "./state.js";

/** 프로젝트의 카드 컬러 마커를 backend 에서 로드해 state.colors 에 cache. */
async function initColors(project) {
    try {
        const data = await apiGetColors(project);
        setColors(data?.colors || {});
    } catch {
        setColors({});
    }
}

import { setRefreshGridCallback } from "./view-controls.js";
import {
    initFavorites, updateFavCount, updateCardNewBadges, isOwnPersistRecent,
    setPreviewCallback, setSourceGridCallback,
} from "./favorites.js";
import { setCloseContextPopupCallback } from "./selection.js";
import {
    renderTree, setActiveLabelByPath,
    setShowFolderGridCallback as setTreeShowFolderGridCallback,
    setOpenTreeMenuCallback, setMoveFileCallback, setCreateFolderInsideCallback,
} from "./tree.js";
import {
    closeContextPopup,
    setOpenTreeMenuForPopupCallback,
} from "./popup.js";
import {
    openTreeMenu, moveFile, createFolderPrompt, createDefaultFolderInside,
    setShowFolderGridCallback as setMenusShowFolderGridCallback,
    setReloadTreeAndShowCallback as setMenusReloadTreeAndShowCallback,
    setLoadTreeCallback,
} from "./menus.js";
import {
    showFolderGrid, showSourceGrid, showGeneratedGrid,
    preview, clearPreview, reloadTreeAndShow,
    setGenTreeContextOpener, setColorRefreshGridCallback,
} from "./grid.js";
import {
    setReloadTreeAndShowCallback as setUploadReloadTreeAndShowCallback,
} from "./upload.js";
import { startSSE, setSSECallback, setJobsSSECallback } from "./sse.js";
import { refreshQueue } from "./queue.js";
import { invalidatePaneCache } from "./tabs.js";

// 사이드 효과 전용 (handler 등록만) — import 만으로 동작
import "./keyboard.js";
import "./viewer-tab.js";
import "./comments.js";
import "./tabs.js";
import "./panel-search.js";
import "./sidebar-resize.js";

import {
    currentProject, setCurrentProject, getLastProject,
    currentDir, setCurrentDir, getLastDirForProject,
    rootTree, setRootTree,
    activeTagFilter,
    activeTab,
} from "./state.js";
import { findNodeByPath } from "./utils.js";
import { renderFavorites } from "./favorites.js";

// =====================================================================
// 그리드 재갱신 callback — 현재 활성 탭/폴더에 맞춰 다시 그린다
// =====================================================================

function refreshCurrentGrid() {
    if (activeTab === "favorites") {
        showSourceGrid(activeTagFilter);
    } else if (activeTab === "generated") {
        showGeneratedGrid();
    } else if (activeTab === "queue") {
        refreshQueue();
    } else if (activeTab === "viewer") {
        // 보기 탭은 split — 위: 생성 그리드 (showGeneratedGrid) / 아래: viewer-stage.
        // 필터 변경 시 둘 다 다시 그려야 함.
        showGeneratedGrid();
        import("./viewer-tab.js").then(({ showViewer }) => showViewer());
    } else if (currentProject && rootTree) {
        const node = findNodeByPath(rootTree, currentDir) || rootTree;
        showFolderGrid(currentProject, node);
    }
}
setRefreshGridCallback(refreshCurrentGrid);
setColorRefreshGridCallback(refreshCurrentGrid);

// favorites 모듈에 외부 의존성 주입
setPreviewCallback((project, node) => preview(project, node));
setSourceGridCallback((tag) => showSourceGrid(tag));

// selection / tree / popup / menus / upload 모듈에 외부 의존성 주입
setCloseContextPopupCallback(() => closeContextPopup());
setTreeShowFolderGridCallback((project, node) => showFolderGrid(project, node));
setOpenTreeMenuCallback((mx, my, project, paths, opts) => openTreeMenu(mx, my, project, paths, opts));
setMoveFileCallback((project, fromPath, toDir, silent) => moveFile(project, fromPath, toDir, silent));
setCreateFolderInsideCallback((project, dirPath) => createDefaultFolderInside(project, dirPath));

setOpenTreeMenuForPopupCallback((mx, my, project, paths, opts) => openTreeMenu(mx, my, project, paths, opts));

// 생성 탭의 gen-tree 빈 영역 우클릭 → Result/ 안에 바로 "새 폴더" 생성 + 인라인 rename
setGenTreeContextOpener(() => {
    if (!currentProject) return;
    createDefaultFolderInside(currentProject, "Result");
});

setMenusShowFolderGridCallback((project, node) => showFolderGrid(project, node));
setMenusReloadTreeAndShowCallback((project, dir) => reloadTreeAndShow(project, dir));
setLoadTreeCallback((project) => loadTree(project));

setUploadReloadTreeAndShowCallback((project, dir) => reloadTreeAndShow(project, dir));

// SSE — favorites / generated 자동 새로고침
// 짧은 시간 안의 연속 변경(다중 파일 저장 등) 은 합쳐서 한 번만 갱신 (디바운스 250ms)
// 자기 자신이 방금 persist 해서 발화된 SSE 는 무시 — 그렇지 않으면 fetch 가
// 진행 중인 다른 mutation 의 결과를 덮어쓸 수 있음 (seenAt 사라지는 race).
let _sseTimer = null;
setSSECallback(() => {
    if (_sseTimer) clearTimeout(_sseTimer);
    _sseTimer = setTimeout(() => {
        _sseTimer = null;
        if (isOwnPersistRecent()) return;
        if (activeTab === "generated") showGeneratedGrid();
        if (activeTab === "favorites") { renderFavorites(); showSourceGrid(activeTagFilter); }
        initFavorites();
        // spotlight 가 자체 cache.favorites 를 가지고 있으므로 함께 갱신해야
        // 드롭 시 isSource 판정이 정확. (없으면 source 카드를 ref 가 아닌
        // sidecar 복원 흐름으로 잘못 처리해 프롬프트가 덮어쓰여짐.)
        try { window.dispatchEvent(new CustomEvent("pv:favorites-changed")); } catch {}
    }, 250);
});
// jobs-changed: 큐 사이드바 + 트리/그리드 모두 갱신.
// 새 결과 파일이 디스크에 들어와도 트리가 stale 이면 generated 그리드에 안 보이는 버그.
// pane cache 도 invalidate — 다른 탭 갔다 와도 stale DOM 안 보임.
let _jobsTimer = null;
async function _refreshAfterJobsChange() {
    refreshQueue();
    // 트리 재조회 — 새 결과 파일이 트리에 반영되어야 그리드가 그것을 찾을 수 있음.
    if (currentProject) {
        try {
            const { ok, data } = await apiGetTree(currentProject);
            if (ok) setRootTree(data.tree);
        } catch {}
    }
    // 모든 탭 cache 무효 → 다음 진입 시 새 데이터 기준으로 다시 렌더
    invalidatePaneCache();
    // 현재 generated/viewer 탭이면 즉시 새로 그림 (사용자가 보고 있는 곳)
    if (activeTab === "generated" || activeTab === "viewer") {
        showGeneratedGrid();
    } else if (activeTab === "tree" && rootTree) {
        // 구성 탭에서 Result/ 하위를 보고 있을 수도 — 현재 폴더 그리드만 다시
        const node = findNodeByPath(rootTree, currentDir) || rootTree;
        showFolderGrid(currentProject, node);
    }
}
setJobsSSECallback(() => {
    if (_jobsTimer) clearTimeout(_jobsTimer);
    _jobsTimer = setTimeout(() => {
        _jobsTimer = null;
        _refreshAfterJobsChange();
    }, 200);
});
startSSE();

// =====================================================================
// 프로젝트 / 트리 로드
// =====================================================================

async function loadProjects() {
    try {
        // setCurrentProject("") 가 localStorage 값을 지우므로 먼저 읽어둠.
        const last = getLastProject();

        const data = await apiListProjects();
        const projects = data.projects || [];
        if (projects.length === 0) {
            projectSelect.innerHTML = `<option value="">(프로젝트 없음)</option>`;
        } else {
            const opts = [`<option value="">(프로젝트 선택)</option>`]
                .concat(projects.map((p) =>
                    `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`
                ));
            projectSelect.innerHTML = opts.join("");
        }
        fileTree.innerHTML = `<li class="empty">프로젝트를 선택하세요</li>`;
        clearPreview();
        setCurrentProject("");
        setCurrentDir("");
        setRootTree(null);

        // 직전에 작업하던 프로젝트가 있고 목록에도 있으면 자동 로드
        if (last && projects.some((p) => p.name === last)) {
            projectSelect.value = last;
            await loadTree(last);
        }
    } catch (err) {
        projectSelect.innerHTML = `<option value="">(불러오기 실패)</option>`;
        console.error(err);
    }
}

async function loadTree(project) {
    if (!project) {
        fileTree.innerHTML = `<li class="empty">프로젝트를 선택하세요</li>`;
        clearPreview();
        setCurrentProject("");
        setCurrentDir("");
        setRootTree(null);
        // 프로젝트가 바뀌었으니 사이드바 즐겨찾기 + 활성 탭 그리드 + 카운트 모두 갱신.
        renderFavorites();
        updateFavCount();
        updateCardNewBadges();
        refreshCurrentGrid();
        return;
    }
    fileTree.innerHTML = `<li class="empty">불러오는 중...</li>`;
    try {
        const { ok, data } = await apiGetTree(project);
        if (!ok) {
            fileTree.innerHTML = `<li class="empty">${escapeHtml(data.error || "오류")}</li>`;
            return;
        }
        setCurrentProject(project);
        setRootTree(data.tree);
        renderTree(rootTree, project);
        // 프로젝트별 분리된 favorites + colors 를 새로 로드 (이 프로젝트만)
        await Promise.all([initFavorites(), initColors(project)]);
        // 직전에 보던 폴더 복원 — 트리에 존재하지 않으면 루트.
        const savedDir = getLastDirForProject(project);
        const targetNode = (savedDir && findNodeByPath(rootTree, savedDir)) || rootTree;
        setCurrentDir(targetNode.path || "");
        showFolderGrid(project, targetNode);
        // 트리에서도 그 폴더에 active 표시
        if (targetNode.path) setActiveLabelByPath(targetNode.path, true);
        // 소스 탭에 있을 때 다른 프로젝트로 바꾸면 그리드도 새 프로젝트 기준으로.
        // NEW 카운트도 프로젝트별이라 같이 갱신.
        renderFavorites();
        updateFavCount();
        updateCardNewBadges();
        if (activeTab === "favorites" || activeTab === "generated" || activeTab === "viewer") {
            refreshCurrentGrid();
        }
    } catch (err) {
        fileTree.innerHTML = `<li class="empty">트리 로드 실패</li>`;
        console.error(err);
    }
}

// =====================================================================
// 이벤트 바인딩 + 시작
// =====================================================================

projectSelect.addEventListener("change", (e) => loadTree(e.target.value));

// ── Spotlight 결과를 현재 폴더(메인 미리보기 영역)로 드롭 → 이동 ──
// upload.js 의 document-level 핸들러는 내부 드래그를 거부하므로 여기서 별도 처리.
function _extractMediaPath(uri) {
    try {
        const u = new URL((uri.split(/\r?\n/)[0] || "").trim(), location.origin);
        return {
            project: u.searchParams.get("project"),
            path: u.searchParams.get("path"),
        };
    } catch { return { project: null, path: null }; }
}

previewContent.addEventListener("dragover", (e) => {
    const types = Array.from(e.dataTransfer?.types || []);
    if (!types.includes("application/x-hf-ref")) return;
    if (!currentProject) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    previewContent.classList.add("hf-drag-into");
});
previewContent.addEventListener("dragleave", (e) => {
    if (!previewContent.contains(e.relatedTarget)) {
        previewContent.classList.remove("hf-drag-into");
    }
});
previewContent.addEventListener("drop", async (e) => {
    const hfRef = e.dataTransfer.getData("application/x-hf-ref")
        || e.dataTransfer.getData("text/uri-list") || "";
    if (!hfRef) return;
    e.preventDefault();
    e.stopPropagation();
    previewContent.classList.remove("hf-drag-into");
    const { project: dropProj, path: dropPath } = _extractMediaPath(hfRef);
    if (!dropPath || dropProj !== currentProject) return;
    const fromDir = dropPath.includes("/") ? dropPath.substring(0, dropPath.lastIndexOf("/")) : "";
    if (fromDir === currentDir) return;
    await moveFile(currentProject, dropPath, currentDir);
});


// 이전 버전의 activeSource localStorage 잔재 정리 (1회성)
try { localStorage.removeItem("viewer.activeSource"); } catch {}

// 서버에서 즐겨찾기 로드 후 프로젝트 목록 로드
initFavorites().then(() => loadProjects());
// Queue 카운트/리스트 초기 로드 — currentProject 와 무관하게 즉시 호출 가능
refreshQueue();
