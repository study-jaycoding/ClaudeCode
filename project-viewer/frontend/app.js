"use strict";

// =====================================================================
// DOM 참조
// =====================================================================
const projectSelect = document.getElementById("project-select");
const refreshBtn = document.getElementById("refresh-btn");
const fileTree = document.getElementById("file-tree");
const previewInfo = document.getElementById("preview-info");
const previewContent = document.getElementById("preview-content");
const dropOverlay = document.getElementById("drop-overlay");
const dropTargetEl = document.getElementById("drop-target");
const favoritesList = document.getElementById("favorites-list");
const favCountEl = document.getElementById("fav-count");
const tabBtns = document.querySelectorAll(".tab-btn");
const tabTree = document.getElementById("tab-tree");
const tabFavorites = document.getElementById("tab-favorites");
const lightbox = document.getElementById("lightbox");
const lightboxStage = document.getElementById("lightbox-stage");
const lightboxCaption = document.getElementById("lightbox-caption");
const lightboxClose = document.querySelector(".lightbox-close");

// =====================================================================
// 전역 상태
// =====================================================================
let currentProject = "";   // 현재 선택된 프로젝트 이름
let currentDir = "";       // 현재 미리보기 폴더의 상대경로 ("" = 루트)
let rootTree = null;       // 마지막 트리 (재렌더링용)

// =====================================================================
// 헬퍼
// =====================================================================

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[c]));
}

function humanSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function kindIcon(kind) {
    return kind === "image" ? "🖼️"
         : kind === "video" ? "🎬"
         : kind === "text"  ? "📄"
         :                    "📦";
}

/** 트리에서 상대경로로 노드 찾기. */
function findNodeByPath(tree, path) {
    if (!tree) return null;
    if (path === "" || path == null) return tree;
    const parts = path.split("/");
    let node = tree;
    for (const part of parts) {
        if (!node.children) return null;
        const next = node.children.find((c) => c.name === part);
        if (!next) return null;
        node = next;
    }
    return node;
}

/** 확장자로 kind 를 추정 (favorites 패널에서 트리 노드 정보가 없을 때 사용). */
function kindFromPath(path) {
    const ext = (path.split(".").pop() || "").toLowerCase();
    const IMG = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"];
    const VID = ["mp4", "webm", "mov", "mkv", "avi", "m4v"];
    if (IMG.includes(ext)) return "image";
    if (VID.includes(ext)) return "video";
    return "other";
}

/** querySelector 안전 이스케이프 */
function cssQueryEscape(s) {
    return String(s).replace(/(["\\])/g, "\\$1");
}

// =====================================================================
// 즐겨찾기 (localStorage 기반)
// =====================================================================
const FAV_KEY = "viewer.favorites";

function loadFavorites() {
    try {
        return JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
    } catch {
        return [];
    }
}

function saveFavorites(favs) {
    localStorage.setItem(FAV_KEY, JSON.stringify(favs));
    fetch("/api/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(favs),
    }).catch(() => {});
}

function isFavorite(project, path) {
    return loadFavorites().some((f) => f.project === project && f.path === path);
}

/** 토글. 반환값: 새로 추가했으면 true, 해제했으면 false. */
function toggleFavorite(project, path) {
    const favs = loadFavorites();
    const idx = favs.findIndex((f) => f.project === project && f.path === path);
    if (idx >= 0) {
        favs.splice(idx, 1);
    } else {
        favs.push({ project, path, addedAt: Date.now() });
    }
    saveFavorites(favs);
    updateFavCount();
    renderFavorites();
    return idx < 0;
}

function updateFavCount() {
    favCountEl.textContent = String(loadFavorites().length);
}

function renderFavorites() {
    const favs = loadFavorites();
    if (favs.length === 0) {
        favoritesList.innerHTML = `<li class="empty">즐겨찾기가 비어 있습니다</li>`;
        return;
    }
    // 최신순으로 정렬
    const sorted = [...favs].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    favoritesList.innerHTML = "";
    for (const fav of sorted) {
        const kind = kindFromPath(fav.path);
        const url = `/media?project=${encodeURIComponent(fav.project)}&path=${encodeURIComponent(fav.path)}`;
        const li = document.createElement("li");
        li.className = "fav-item";

        let thumbHtml;
        if (kind === "image") {
            thumbHtml = `<img src="${url}" loading="lazy" alt="" />`;
        } else if (kind === "video") {
            thumbHtml = `<video src="${url}" preload="metadata" muted></video>`;
        } else {
            thumbHtml = `<span>📄</span>`;
        }

        li.innerHTML = `
            <div class="fav-thumb ${kind === "image" || kind === "video" ? "" : "fav-thumb-other"}">${thumbHtml}</div>
            <div class="fav-info">
                <div class="fav-project">${escapeHtml(fav.project)}</div>
                <div class="fav-path">${escapeHtml(fav.path)}</div>
            </div>
            <button class="fav-remove" type="button" title="즐겨찾기 해제">⭐</button>`;

        // 항목 클릭 → 라이트박스 (이미지/영상) 또는 단일 미리보기 (텍스트)
        li.addEventListener("click", () => {
            const node = { name: fav.path.split("/").pop(), path: fav.path, kind, size: 0 };
            if (kind === "image" || kind === "video") {
                openLightbox(fav.project, node);
            } else {
                // 텍스트나 미지원: 해당 프로젝트로 이동 후 미리보기
                if (currentProject !== fav.project) {
                    projectSelect.value = fav.project;
                    loadTree(fav.project).then(() => {
                        const tn = findNodeByPath(rootTree, fav.path);
                        if (tn) preview(fav.project, tn);
                    });
                } else if (rootTree) {
                    const tn = findNodeByPath(rootTree, fav.path);
                    if (tn) preview(fav.project, tn);
                }
            }
        });

        // 별 해제 (이벤트 버블 방지)
        li.querySelector(".fav-remove").addEventListener("click", (e) => {
            e.stopPropagation();
            toggleFavorite(fav.project, fav.path);
        });

        favoritesList.appendChild(li);
    }
}

/** 현재 표시중인 grid 카드들의 별 활성 상태를 다시 계산. */
function updateStarsInGrid() {
    document.querySelectorAll(".card .star-btn[data-path]").forEach((btn) => {
        const path = btn.dataset.path;
        const active = isFavorite(currentProject, path);
        btn.classList.toggle("active", active);
        btn.textContent = active ? "★" : "☆";
        btn.title = active ? "즐겨찾기 해제" : "즐겨찾기 추가";
    });
}

// =====================================================================
// 사이드바 탭 전환
// =====================================================================
tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
        tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
        const which = btn.dataset.tab;
        tabTree.classList.toggle("hidden", which !== "tree");
        tabFavorites.classList.toggle("hidden", which !== "favorites");
        if (which === "favorites") renderFavorites();
    });
});

// =====================================================================
// 프로젝트 / 트리 로드
// =====================================================================

async function loadProjects() {
    try {
        const res = await fetch("/api/projects");
        const data = await res.json();
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
        currentProject = "";
        currentDir = "";
        rootTree = null;
    } catch (err) {
        projectSelect.innerHTML = `<option value="">(불러오기 실패)</option>`;
        console.error(err);
    }
}

async function loadTree(project) {
    if (!project) {
        fileTree.innerHTML = `<li class="empty">프로젝트를 선택하세요</li>`;
        clearPreview();
        currentProject = "";
        currentDir = "";
        rootTree = null;
        return;
    }
    fileTree.innerHTML = `<li class="empty">불러오는 중...</li>`;
    try {
        const res = await fetch(`/api/tree?project=${encodeURIComponent(project)}`);
        const data = await res.json();
        if (!res.ok) {
            fileTree.innerHTML = `<li class="empty">${escapeHtml(data.error || "오류")}</li>`;
            return;
        }
        currentProject = project;
        rootTree = data.tree;
        renderTree(rootTree, project);
        currentDir = "";
        showFolderGrid(project, rootTree);
    } catch (err) {
        fileTree.innerHTML = `<li class="empty">트리 로드 실패</li>`;
        console.error(err);
    }
}

// =====================================================================
// 사이드바 트리 렌더링
// =====================================================================

function renderTree(rootNode, project) {
    fileTree.innerHTML = "";
    if (rootNode.children.length === 0) {
        fileTree.innerHTML = `<li class="empty">폴더가 비어있습니다</li>`;
        return;
    }
    for (const child of rootNode.children) {
        fileTree.appendChild(renderNode(child, project));
    }
}

function renderNode(node, project) {
    const li = document.createElement("li");

    if (node.type === "dir") {
        li.className = "dir";

        const row = document.createElement("div");
        row.className = "dir-row";

        const chev = document.createElement("span");
        chev.className = "chevron";
        chev.textContent = node.children.length > 0 ? "▼" : "·";
        if (node.children.length > 0) {
            chev.addEventListener("click", (e) => {
                e.stopPropagation();
                const collapsed = li.classList.toggle("collapsed");
                chev.textContent = collapsed ? "▶" : "▼";
            });
        }
        row.appendChild(chev);

        const label = document.createElement("span");
        label.className = "dir-label";
        label.textContent = "📁 " + node.name;
        label.dataset.path = node.path;
        label.addEventListener("click", () => {
            setActiveLabel(label);
            currentDir = node.path;
            showFolderGrid(project, node);
        });
        row.appendChild(label);
        li.appendChild(row);

        const ul = document.createElement("ul");
        for (const child of node.children) {
            ul.appendChild(renderNode(child, project));
        }
        li.appendChild(ul);
    } else {
        li.className = "file kind-" + node.kind;
        const label = document.createElement("span");
        label.className = "file-label";
        label.textContent = kindIcon(node.kind) + " " + node.name;
        label.title = `${node.path} · ${humanSize(node.size)}`;
        label.dataset.path = node.path;
        label.addEventListener("click", () => {
            setActiveLabel(label);
            const slash = node.path.lastIndexOf("/");
            currentDir = slash >= 0 ? node.path.substring(0, slash) : "";
            preview(project, node);
        });
        li.appendChild(label);
    }
    return li;
}

function setActiveLabel(label) {
    document.querySelectorAll(".tree .active")
        .forEach((el) => el.classList.remove("active"));
    label.classList.add("active");
}

// =====================================================================
// 폴더 그리드 미리보기
// =====================================================================

function showFolderGrid(project, node) {
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
    grid.className = "grid";

    node.children.forEach((child) => {
        const card = renderGridCard(project, child);

        // 클릭: 카드 선택 (즉시 반응)
        card.addEventListener("click", (e) => {
            // 별 버튼 클릭은 별도 처리
            if (e.target.closest(".star-btn")) return;
            selectCard(card);
            // 트리에서도 활성화
            const cls = child.type === "dir" ? "dir-label" : "file-label";
            const treeLabel = document.querySelector(
                `.tree .${cls}[data-path="${cssQueryEscape(child.path)}"]`
            );
            if (treeLabel) setActiveLabel(treeLabel);
        });

        // 더블클릭: 폴더는 들어가기 / 이미지·영상은 라이트박스 / 텍스트·기타는 미리보기 영역
        card.addEventListener("dblclick", (e) => {
            if (e.target.closest(".star-btn")) return;
            if (child.type === "dir") {
                currentDir = child.path;
                showFolderGrid(project, child);
            } else if (child.kind === "image" || child.kind === "video") {
                openLightbox(project, child);
            } else {
                preview(project, child);
            }
        });

        grid.appendChild(card);
    });

    previewContent.innerHTML = "";
    previewContent.appendChild(grid);
    updateStarsInGrid();
}

function selectCard(card) {
    document.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
    card.classList.add("selected");
}

function renderGridCard(project, child) {
    const card = document.createElement("div");
    card.className = "card";

    if (child.type === "dir") {
        card.classList.add("card-dir");
        card.title = child.path;
        card.innerHTML = `
            <div class="thumb thumb-dir">📁</div>
            <div class="card-name">${escapeHtml(child.name)}</div>
            <div class="card-meta">${child.children.length}개 항목</div>`;
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

    // 별 버튼은 이미지/영상에만 노출 (텍스트도 즐겨찾기 가능하게 둘 수 있지만
    // 사용자 요청 흐름이 이미지 위주이므로 모든 파일에 노출하는 것으로 통일)
    const isFav = isFavorite(project, child.path);

    card.innerHTML = `
        <div class="thumb thumb-${child.kind}">
            ${thumbInner}
            <button class="star-btn ${isFav ? "active" : ""}" type="button"
                    data-path="${escapeHtml(child.path)}"
                    title="${isFav ? "즐겨찾기 해제" : "즐겨찾기 추가"}">${isFav ? "★" : "☆"}</button>
        </div>
        <div class="card-name">${escapeHtml(child.name)}</div>
        <div class="card-meta">${humanSize(child.size)}</div>`;

    // 별 버튼 클릭 (카드 클릭 이벤트 전파 차단)
    const star = card.querySelector(".star-btn");
    star.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFavorite(project, child.path);
        updateStarsInGrid();
    });
    // 별 더블클릭이 카드 더블클릭으로 번지지 않게
    star.addEventListener("dblclick", (e) => e.stopPropagation());

    return card;
}

// =====================================================================
// 파일 단일 미리보기 (미리보기 영역에 인라인 표시)
// =====================================================================

function clearPreview() {
    previewInfo.textContent = "프로젝트를 선택하거나 파일을 끌어다 놓으세요";
    previewContent.innerHTML = "";
}

async function preview(project, node) {
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
            const url = `/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(node.path)}`;
            const res = await fetch(url);
            const data = await res.json();
            if (!res.ok) {
                previewContent.innerHTML = `<pre class="error">${escapeHtml(data.error || "오류")}</pre>`;
                return;
            }
            const note = data.truncated
                ? `<p class="warn">⚠ 파일이 너무 커서 처음 1MB 만 표시합니다 (전체 ${humanSize(data.size)})</p>`
                : "";
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
// 라이트박스 (이미지/영상 확대)
// =====================================================================

function openLightbox(project, node) {
    const url = `/media?project=${encodeURIComponent(project)}&path=${encodeURIComponent(node.path)}`;
    let content;
    if (node.kind === "image") {
        content = `<img src="${url}" alt="${escapeHtml(node.name)}" />`;
    } else if (node.kind === "video") {
        content = `<video src="${url}" controls autoplay></video>`;
    } else {
        content = `<div style="color:#cdd3df">미리보기를 지원하지 않는 형식입니다.</div>`;
    }
    lightboxStage.innerHTML = content;
    lightboxCaption.textContent = `${project} / ${node.path}`;
    lightbox.classList.remove("hidden");
}

function closeLightbox() {
    // video element 를 비워 자동 정지
    lightboxStage.innerHTML = "";
    lightbox.classList.add("hidden");
}

lightboxClose.addEventListener("click", closeLightbox);

// 배경(stage 바깥) 클릭 시 닫기
lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
});

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !lightbox.classList.contains("hidden")) {
        closeLightbox();
    }
});

// =====================================================================
// 드래그앤드롭 업로드
// =====================================================================

let dragDepth = 0;

function setDropTargetLabel() {
    if (!currentProject) {
        dropTargetEl.textContent = "⚠ 프로젝트를 먼저 선택하세요";
        dropTargetEl.classList.add("warn");
    } else {
        dropTargetEl.textContent = `🎯 ${currentProject}/${currentDir || ""}`;
        dropTargetEl.classList.remove("warn");
    }
}

function hasFiles(e) {
    return e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
}

document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    setDropTargetLabel();
    dropOverlay.classList.remove("hidden");
});

document.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = currentProject ? "copy" : "none";
});

document.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth -= 1;
    if (dragDepth <= 0) {
        dragDepth = 0;
        dropOverlay.classList.add("hidden");
    }
});

document.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.add("hidden");

    if (!currentProject) {
        alert("프로젝트를 먼저 선택하세요.");
        return;
    }
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    await uploadFiles(currentProject, currentDir, files);
});

async function uploadFiles(project, dir, files) {
    const total = files.length;
    let done = 0;
    let fails = 0;
    const errors = [];
    for (const file of files) {
        done += 1;
        previewInfo.textContent = `업로드 중 ${done}/${total}: ${file.name} (${humanSize(file.size)})...`;
        try {
            const url = `/api/upload?project=${encodeURIComponent(project)}&dir=${encodeURIComponent(dir)}`;
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "X-File-Name": encodeURIComponent(file.name),
                    "Content-Type": file.type || "application/octet-stream",
                },
                body: file,
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                fails += 1;
                errors.push(`${file.name}: ${data.error || res.status}`);
            }
        } catch (err) {
            fails += 1;
            errors.push(`${file.name}: ${err.message}`);
        }
    }
    const stayDir = currentDir;
    await reloadTreeAndShow(project, stayDir);
    if (fails > 0) {
        previewInfo.textContent = `업로드 완료: ${total - fails}/${total} 성공, ${fails} 실패`;
        console.warn("업로드 실패:", errors);
    } else {
        previewInfo.textContent = `📁 ${stayDir || "(루트)"} · 업로드 ${total}개 완료`;
    }
}

async function reloadTreeAndShow(project, showDir) {
    try {
        const res = await fetch(`/api/tree?project=${encodeURIComponent(project)}`);
        const data = await res.json();
        if (!res.ok) return;
        rootTree = data.tree;
        renderTree(rootTree, project);
        const node = findNodeByPath(rootTree, showDir) || rootTree;
        currentDir = node.path;
        showFolderGrid(project, node);
    } catch (err) {
        console.error(err);
    }
}

// =====================================================================
// 이벤트 바인딩 + 시작
// =====================================================================

projectSelect.addEventListener("change", (e) => loadTree(e.target.value));

refreshBtn.addEventListener("click", async () => {
    const current = projectSelect.value;
    await loadProjects();
    if (current) {
        projectSelect.value = current;
        loadTree(current);
    }
});

updateFavCount();
renderFavorites();
loadProjects();

// 기존 localStorage 즐겨찾기를 서버에 동기화
(function syncInitialFavorites() {
    const favs = loadFavorites();
    if (favs.length > 0) {
        fetch("/api/favorites", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(favs),
        }).catch(() => {});
    }
})();
