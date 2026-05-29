// =====================================================================
// 그리드 렌더링 (폴더/소스/생성) + 단일 파일 미리보기 + 트리 재로드
// - showFolderGrid: 폴더 노드의 children 을 카드 그리드로
// - showSourceGrid: isSource=true 즐겨찾기를 카드 그리드로 (태그 필터)
// - showGeneratedGrid: Result/ 폴더 자동 표시
// - preview / clearPreview: 단일 파일 inline 미리보기
// - reloadTreeAndShow: 트리 재로드 후 특정 폴더 그리드 복원
// =====================================================================
import { previewInfo, previewContent, genTree } from "./dom.js";
import {
    escapeHtml, humanSize, kindIcon, kindFromPath,
    cssQueryEscape, findNodeByPath, isGeneratedPath,
} from "./utils.js";
import {
    currentProject, currentDir, currentView,
    favorites, rootTree,
    setCurrentDir, setRootTree, setLastSelectedCard,
} from "./state.js";
import { apiGetTree, apiGetFile } from "./api.js";
import {
    sourceFavorites, toggleSource, markCardSeen,
    updateFavCount, updateCardNewBadges, updateTreeLabelColors,
} from "./favorites.js";
import {
    selectCard, getSelectedPaths,
    syncTreeSelection, refreshDraggable,
} from "./selection.js";
import { renderTree, setActiveLabel } from "./tree.js";
import { attachLongPress, closeContextPopup } from "./popup.js";
import { openTreeMenu, moveFile } from "./menus.js";
import { openLightbox } from "./lightbox.js";
import { sortItems } from "./view-controls.js";
import { makeCardDraggable } from "./upload.js";

const RESULT_DIR = "Result";

// =====================================================================
// 폴더 그리드
// =====================================================================

export function showFolderGrid(project, node) {
    previewInfo.textContent = `📁 ${node.path || "(루트)"} · ${node.children.length}개 항목`;

    if (node.children.length === 0) {
        previewContent.innerHTML = `
            <div class="unsupported">
                폴더가 비어 있습니다.<br/>
                <small>파일을 끌어다 놓으면 여기에 업로드됩니다.</small>
            </div>`;
        return;
    }

    const grid = document.createElement("div");
    grid.className = "grid" + (currentView === "list" ? " list-view" : "");

    sortItems(node.children).forEach((child) => {
        const card = renderGridCard(project, child);

        card.addEventListener("click", (e) => {
            if (e.target.closest(".card-marker")) return;
            selectCard(card, e);
            const cls = child.type === "dir" ? "dir-label" : "file-label";
            const treeLabel = document.querySelector(
                `.tree .${cls}[data-path="${cssQueryEscape(child.path)}"]`
            );
            if (treeLabel) setActiveLabel(treeLabel);
            // 카드를 클릭하면 NEW 표시 dismiss (그 카드만)
            if (markCardSeen(project, child.path)) {
                updateFavCount();
                updateCardNewBadges();
                updateTreeLabelColors();
            }
            // 정보 팝업은 long-press(0.35초) 로만 발동. 짧은 클릭은 선택만.
            // 다중 선택 모드면 떠 있던 팝업도 닫기.
            if (e.shiftKey || e.ctrlKey || e.metaKey) closeContextPopup();
        });

        attachLongPress(card, project, child);

        card.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            // 우클릭 위치의 카드가 selected 안 되어 있으면 단일 선택으로 전환 (탐색기 패턴)
            if (!card.classList.contains("selected")) {
                previewContent.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
                card.classList.add("selected");
                setLastSelectedCard(card);
                syncTreeSelection();
                refreshDraggable();
                const cls = child.type === "dir" ? "dir-label" : "file-label";
                const treeLabel = document.querySelector(
                    `.tree .${cls}[data-path="${cssQueryEscape(child.path)}"]`
                );
                if (treeLabel) setActiveLabel(treeLabel);
            }
            const paths = getSelectedPaths().length ? getSelectedPaths() : [child.path];
            openTreeMenu(e.clientX, e.clientY, project, paths);
        });

        card.addEventListener("dblclick", () => {
            closeContextPopup();
            if (child.type === "dir") {
                setCurrentDir(child.path);
                showFolderGrid(project, child);
            } else if (child.kind === "image" || child.kind === "video" || child.kind === "text") {
                openLightbox(project, child);
            } else {
                preview(project, child);
            }
        });

        grid.appendChild(card);
    });

    previewContent.innerHTML = "";
    previewContent.appendChild(grid);
    updateCardNewBadges();
}

function renderGridCard(project, child) {
    const card = document.createElement("div");
    card.className = "card";

    if (child.type === "dir") {
        card.classList.add("card-dir");
        card.title = child.path;
        card.dataset.path = child.path;
        card.innerHTML = `
            <div class="thumb thumb-dir">📁</div>
            <div class="card-name">${escapeHtml(child.name)}</div>
            <div class="card-meta">${child.children.length}개 항목</div>`;

        // 폴더 카드 = 드롭 대상 (트리 row 와 동일 정책)
        //   1) 같은 트리 안 파일 이동 (text/x-tree-path)
        //   2) spotlight 결과 (application/x-hf-ref + /media URL) 이동
        const isAcceptedDrag = (e) => {
            if (!e.dataTransfer) return false;
            const t = Array.from(e.dataTransfer.types);
            return t.includes("text/x-tree-path") || t.includes("application/x-hf-ref");
        };
        card.addEventListener("dragover", (e) => {
            if (!isAcceptedDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            card.classList.add("drag-over");
        });
        card.addEventListener("dragleave", () => {
            card.classList.remove("drag-over");
        });
        card.addEventListener("drop", async (e) => {
            if (!isAcceptedDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            card.classList.remove("drag-over");

            // 1) 트리 내부 이동
            const fromTree = e.dataTransfer.getData("text/x-tree-path");
            if (fromTree) {
                const fromDir = fromTree.includes("/")
                    ? fromTree.substring(0, fromTree.lastIndexOf("/")) : "";
                if (fromDir === child.path) return;
                await moveFile(project, fromTree, child.path);
                return;
            }

            // 2) spotlight 결과 → 이 폴더로 이동
            const hfRef = e.dataTransfer.getData("application/x-hf-ref")
                || e.dataTransfer.getData("text/uri-list") || "";
            if (!hfRef) return;
            try {
                const u = new URL(hfRef.split(/\r?\n/)[0].trim(), location.origin);
                const dropProj = u.searchParams.get("project");
                const dropPath = u.searchParams.get("path");
                if (!dropPath || (dropProj && dropProj !== project)) return;
                const fromDir = dropPath.includes("/")
                    ? dropPath.substring(0, dropPath.lastIndexOf("/")) : "";
                if (fromDir === child.path) return;
                await moveFile(project, dropPath, child.path);
            } catch { /* ignore */ }
        });

        return card;
    }

    card.classList.add("card-file", "kind-" + child.kind);
    card.title = `${child.path} · ${humanSize(child.size)}`;
    const url = `/media?project=${encodeURIComponent(project)}&path=${encodeURIComponent(child.path)}`;

    let thumbInner;
    if (child.kind === "image") {
        thumbInner = `<img src="${url}" alt="" loading="lazy" />`;
    } else if (child.kind === "video") {
        thumbInner = `<video src="${url}" preload="metadata" muted></video>
                      <div class="play-badge">▶</div>`;
    } else if (child.kind === "text") {
        thumbInner = `<div class="thumb-icon">📄</div>`;
    } else {
        thumbInner = `<div class="thumb-icon">📦</div>`;
    }

    // 카드 우상단 마커 — Result/ 는 파란, 사용자 토글한 소스는 녹색
    const markerCls = isGeneratedPath(child.path)
        ? "generated"
        : (favorites.find((f) => f.project === project && f.path === child.path && f.isSource) ? "source" : "neutral");
    const markerTitle = markerCls === "generated" ? "자동 생성물 (Result/)"
        : (markerCls === "source" ? "소스 해제" : "소스로 표시");

    card.innerHTML = `
        <div class="thumb thumb-${child.kind}">
            ${thumbInner}
            <button class="card-marker ${markerCls}" type="button" data-path="${escapeHtml(child.path)}" title="${markerTitle}">●</button>
        </div>
        <div class="card-name">${escapeHtml(child.name)}</div>
        <div class="card-meta">${humanSize(child.size)}</div>`;

    // 카드의 data-path 는 lasso/tree 동기화 등에서 path 식별에 사용
    card.dataset.path = child.path;

    // 마커 클릭 = 소스 토글 (Result/ 는 무시)
    const marker = card.querySelector(".card-marker");
    marker.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isGeneratedPath(child.path)) return;
        toggleSource(project, child.path);
    });
    marker.addEventListener("dblclick", (e) => e.stopPropagation());
    marker.addEventListener("mousedown", (e) => e.stopPropagation());

    // 파일 카드를 외부 앱/바탕화면으로 드래그 가능하게
    if (child.type !== "dir") {
        makeCardDraggable(card, project, child.path, child.name);
    }

    return card;
}

// =====================================================================
// 소스 그리드 (즐겨찾기 탭)
// =====================================================================

export function showSourceGrid(filterTag) {
    let filtered = sourceFavorites();
    if (filterTag) {
        filtered = filtered.filter((f) => (f.tags || []).includes(filterTag));
    }
    filtered = sortItems(filtered);

    const label = filterTag ? `#${filterTag}` : "전체";
    previewInfo.textContent = `🔗 소스 · ${label} · ${filtered.length}개`;

    if (filtered.length === 0) {
        let msg;
        if (!currentProject) {
            msg = "프로젝트를 먼저 선택하세요.";
        } else if (filterTag) {
            msg = `"#${escapeHtml(filterTag)}" 태그의 소스가 없습니다.`;
        } else {
            msg = `'${escapeHtml(currentProject)}' 프로젝트에 등록된 소스가 없습니다.`;
        }
        previewContent.innerHTML = `<div class="unsupported">${msg}</div>`;
        return;
    }

    const grid = document.createElement("div");
    grid.className = "grid" + (currentView === "list" ? " list-view" : "");

    filtered.forEach((fav) => {
        const kind = kindFromPath(fav.path);
        const card = renderSourceCard(fav, kind);
        grid.appendChild(card);
    });

    previewContent.innerHTML = "";
    previewContent.appendChild(grid);
    updateCardNewBadges();
}

function renderSourceCard(fav, kind) {
    const card = document.createElement("div");
    card.className = "card card-file kind-" + kind;
    card.title = `${fav.path} · ID: ${fav.id}`;
    card.dataset.path = fav.path;

    const url = `/media?project=${encodeURIComponent(fav.project)}&path=${encodeURIComponent(fav.path)}`;
    let thumbInner;
    if (kind === "image") {
        thumbInner = `<img src="${url}" alt="" loading="lazy" />`;
    } else if (kind === "video") {
        thumbInner = `<video src="${url}" preload="metadata" muted></video><div class="play-badge">▶</div>`;
    } else {
        thumbInner = `<div class="thumb-icon">📄</div>`;
    }

    const tagsHtml = (fav.tags || []).length > 0
        ? `<div class="card-tags">${fav.tags.map((t) => `<span class="tag-chip small">#${escapeHtml(t)}</span>`).join(" ")}</div>`
        : "";

    const derived = favorites.filter((f) => (f.sourceIds || []).includes(fav.id));
    const derivedBadge = derived.length > 0
        ? `<span class="card-derived">→${derived.length}</span>`
        : "";

    card.innerHTML = `
        <div class="thumb thumb-${kind}">
            ${thumbInner}
            <button class="card-marker source" type="button" data-path="${escapeHtml(fav.path)}" title="소스 해제">●</button>
            ${derivedBadge}
        </div>
        <div class="card-name">${escapeHtml(fav.path.split("/").pop())}</div>
        ${tagsHtml}
        <div class="card-meta">ID: ${escapeHtml(fav.id.slice(0, 10))}</div>`;

    const marker = card.querySelector(".card-marker");
    marker.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSource(fav.project, fav.path);
    });
    marker.addEventListener("dblclick", (e) => e.stopPropagation());
    marker.addEventListener("mousedown", (e) => e.stopPropagation());

    // 클릭 = 선택만. 정보 팝업은 long-press 로 발동.
    card.addEventListener("click", (e) => {
        if (e.target.closest(".card-marker")) return;
        selectCard(card, e);
        // 카드 클릭 시 NEW dismiss
        if (markCardSeen(fav.project, fav.path)) {
            updateFavCount();
            updateCardNewBadges();
            updateTreeLabelColors();
        }
        if (e.shiftKey || e.ctrlKey || e.metaKey) closeContextPopup();
    });

    // long-press(0.35초) 로 정보 팝업
    {
        const sNode = { name: fav.path.split("/").pop(), path: fav.path, kind, size: 0, type: "file" };
        attachLongPress(card, fav.project, sNode);
    }

    // 더블클릭 = 라이트박스
    card.addEventListener("dblclick", () => {
        closeContextPopup();
        if (kind === "image" || kind === "video" || kind === "text") {
            openLightbox(fav.project, { name: fav.path.split("/").pop(), path: fav.path, kind, size: 0 });
        }
    });

    // 우클릭 = 컨텍스트 메뉴 (정보/이동/이름/삭제/원본위치)
    card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (!card.classList.contains("selected")) {
            previewContent.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
            card.classList.add("selected");
            setLastSelectedCard(card);
            syncTreeSelection();
            refreshDraggable();
        }
        const paths = getSelectedPaths().length ? getSelectedPaths() : [fav.path];
        openTreeMenu(e.clientX, e.clientY, fav.project, paths);
    });

    // 외부 앱/바탕화면으로 드래그
    makeCardDraggable(card, fav.project, fav.path, fav.path.split("/").pop());

    return card;
}

// =====================================================================
// 생성 그리드 (Result/ 폴더)
// =====================================================================

// gen-tree 빈 영역 / 컨테이너 우클릭 → Result/ 안에 새 폴더 생성 메뉴
function ensureGenTreeContextMenu() {
    if (!genTree || genTree.dataset.ctxBound === "1") return;
    genTree.dataset.ctxBound = "1";
    genTree.addEventListener("contextmenu", (e) => {
        // 자식 li 의 핸들러가 이미 처리했으면 (stopPropagation) 여기 안 옴
        e.preventDefault();
        e.stopPropagation();
        _openTreeMenuForGen(e.clientX, e.clientY);
    });
}

let _openTreeMenuForGen = () => {};
export function setGenTreeContextOpener(fn) {
    _openTreeMenuForGen = typeof fn === "function" ? fn : () => {};
}

export async function showGeneratedGrid() {
    if (!currentProject) {
        previewInfo.textContent = "프로젝트를 선택하세요";
        previewContent.innerHTML = "";
        if (genTree) genTree.innerHTML = "";
        return;
    }
    ensureGenTreeContextMenu();
    // 최신 트리 가져와서 Result 폴더만 표시
    try {
        const { ok, data } = await apiGetTree(currentProject);
        if (ok) {
            setRootTree(data.tree);
            renderTree(rootTree, currentProject);
        }
    } catch {}
    const resultNode = findNodeByPath(rootTree, RESULT_DIR);
    // 구성 탭처럼 Result/ 자체를 최상위 노드로 보여줌 (children 안 풀어 보여주기 위해 wrap).
    if (genTree) {
        const wrapped = { children: resultNode ? [resultNode] : [] };
        renderTree(wrapped, currentProject, genTree);
    }
    if (!resultNode) {
        previewInfo.textContent = `✨ 생성 — ${RESULT_DIR}/ 폴더가 아직 없습니다`;
        previewContent.innerHTML = `<div class="unsupported">스포트라이트에서 생성하면 자동으로 폴더가 만들어집니다.<br/><small>또는 사이드바에서 우클릭으로 빈 폴더를 미리 만들 수 있습니다.</small></div>`;
        return;
    }
    setCurrentDir(resultNode.path);
    showFolderGrid(currentProject, resultNode);
    previewInfo.textContent = `✨ 생성 · ${resultNode.children.length}개 — 새 파일은 자동으로 추가됩니다`;
}

// =====================================================================
// 단일 파일 미리보기
// =====================================================================

export function clearPreview() {
    previewInfo.textContent = "프로젝트를 선택하거나 파일을 끌어다 놓으세요";
    previewContent.innerHTML = "";
}

export async function preview(project, node) {
    previewInfo.textContent = `${kindIcon(node.kind)} ${node.path} · ${humanSize(node.size)}`;
    const mediaUrl = `/media?project=${encodeURIComponent(project)}&path=${encodeURIComponent(node.path)}`;

    if (node.kind === "image") {
        previewContent.innerHTML = `<img class="single" src="${mediaUrl}" alt="${escapeHtml(node.name)}" />`;
        return;
    }
    if (node.kind === "video") {
        previewContent.innerHTML = `<video class="single" src="${mediaUrl}" controls preload="metadata"></video>`;
        return;
    }
    if (node.kind === "text") {
        previewContent.innerHTML = `<pre class="loading">불러오는 중...</pre>`;
        try {
            const { ok, data } = await apiGetFile(project, node.path);
            if (!ok) {
                previewContent.innerHTML = `<pre class="error">${escapeHtml(data.error || "오류")}</pre>`;
                return;
            }
            const note = data.truncated
                ? `<p class="warn">⚠ 처음 1MB 만 표시합니다 (전체 ${humanSize(data.size)})</p>` : "";
            previewContent.innerHTML = note + `<pre class="text">${escapeHtml(data.content)}</pre>`;
        } catch (err) {
            previewContent.innerHTML = `<pre class="error">${escapeHtml(err.message)}</pre>`;
        }
        return;
    }
    previewContent.innerHTML = `
        <div class="unsupported">
            이 파일 형식은 미리보기를 지원하지 않습니다.<br />
            <small>${escapeHtml(node.name)}</small>
        </div>`;
}

// =====================================================================
// 트리 재로드 + 폴더 그리드 복원
// =====================================================================

export async function reloadTreeAndShow(project, showDir) {
    try {
        const { ok, data } = await apiGetTree(project);
        if (!ok) return;
        setRootTree(data.tree);
        renderTree(rootTree, project);
        // 생성 탭의 mini 트리도 함께 갱신 (Result/ 를 최상위 노드로)
        if (genTree) {
            const resultNode = findNodeByPath(rootTree, RESULT_DIR);
            const wrapped = { children: resultNode ? [resultNode] : [] };
            renderTree(wrapped, project, genTree);
        }
        const node = findNodeByPath(rootTree, showDir) || rootTree;
        setCurrentDir(node.path);
        showFolderGrid(project, node);
    } catch (err) { console.error(err); }
}
