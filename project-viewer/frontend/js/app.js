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
    projectSelect, refreshBtn, fileTree, previewContent,
} from "./dom.js";
import { apiListProjects, apiGetTree } from "./api.js";

import { setRefreshGridCallback } from "./view-controls.js";
import {
    initFavorites,
    setPreviewCallback, setSourceGridCallback,
} from "./favorites.js";
import { setCloseContextPopupCallback } from "./selection.js";
import {
    renderTree,
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
    setGenTreeContextOpener,
} from "./grid.js";
import {
    setReloadTreeAndShowCallback as setUploadReloadTreeAndShowCallback,
} from "./upload.js";
import { startSSE, setSSECallback } from "./sse.js";

// 사이드 효과 전용 (handler 등록만) — import 만으로 동작
import "./keyboard.js";
import "./tabs.js";

import {
    currentProject, setCurrentProject,
    currentDir, setCurrentDir,
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
    } else if (currentProject && rootTree) {
        const node = findNodeByPath(rootTree, currentDir) || rootTree;
        showFolderGrid(currentProject, node);
    }
}
setRefreshGridCallback(refreshCurrentGrid);

// favorites 모듈에 외부 의존성 주입
setPreviewCallback((project, node) => preview(project, node));
setSourceGridCallback((tag) => showSourceGrid(tag));

// selection / tree / popup / menus / upload 모듈에 외부 의존성 주입
setCloseContextPopupCallback(() => closeContextPopup());
setTreeShowFolderGridCallback((project, node) => showFolderGrid(project, node));
setOpenTreeMenuCallback((mx, my, project, paths, opts) => openTreeMenu(mx, my, project, paths, opts));
setMoveFileCallback((project, fromPath, toDir) => moveFile(project, fromPath, toDir));
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
setSSECallback(() => {
    if (activeTab === "generated") showGeneratedGrid();
    if (activeTab === "favorites") { renderFavorites(); showSourceGrid(activeTagFilter); }
    initFavorites();
});
startSSE();

// =====================================================================
// 프로젝트 / 트리 로드
// =====================================================================

async function loadProjects() {
    try {
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
        // 프로젝트가 바뀌었으니 사이드바 즐겨찾기 + 활성 탭 그리드 모두 갱신.
        renderFavorites();
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
        setCurrentDir("");
        showFolderGrid(project, rootTree);
        // 소스 탭에 있을 때 다른 프로젝트로 바꾸면 그리드도 새 프로젝트 기준으로.
        renderFavorites();
        if (activeTab === "favorites" || activeTab === "generated") {
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


refreshBtn.addEventListener("click", async () => {
    const current = projectSelect.value;
    await loadProjects();
    if (current) {
        projectSelect.value = current;
        loadTree(current);
    }
});

// 이전 버전의 activeSource localStorage 잔재 정리 (1회성)
try { localStorage.removeItem("viewer.activeSource"); } catch {}

// 서버에서 즐겨찾기 로드 후 프로젝트 목록 로드
initFavorites().then(() => loadProjects());
