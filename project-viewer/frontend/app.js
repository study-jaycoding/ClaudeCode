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
const tagFilterBar = document.getElementById("tag-filter-bar");
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
let currentProject = "";
let currentDir = "";
let rootTree = null;
let favorites = [];          // in-memory cache — 서버에서 로드, 변경마다 POST 동기화
let activeTagFilter = null;  // null = 전체, string = 해당 태그만

// =====================================================================
// 헬퍼
// =====================================================================

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

function humanSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function kindIcon(kind) {
    return kind === "image" ? "🖼️" : kind === "video" ? "🎬" : kind === "text" ? "📄" : "📦";
}

function findNodeByPath(tree, path) {
    if (!tree) return null;
    if (path === "" || path == null) return tree;
    let node = tree;
    for (const part of path.split("/")) {
        if (!node.children) return null;
        const next = node.children.find((c) => c.name === part);
        if (!next) return null;
        node = next;
    }
    return node;
}

function kindFromPath(path) {
    const ext = (path.split(".").pop() || "").toLowerCase();
    if (["png","jpg","jpeg","gif","webp","svg","bmp","ico"].includes(ext)) return "image";
    if (["mp4","webm","mov","mkv","avi","m4v"].includes(ext)) return "video";
    return "other";
}

function cssQueryEscape(s) {
    return String(s).replace(/(["\\])/g, "\\$1");
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// =====================================================================
// 즐겨찾기 — 서버 저장 + in-memory cache
// =====================================================================

async function initFavorites() {
    try {
        const res = await fetch("/api/favorites");
        const data = await res.json();
        favorites = Array.isArray(data.favorites) ? data.favorites
                  : Array.isArray(data) ? data : [];
        // 기존 데이터에 id 없으면 보충
        for (const f of favorites) {
            if (!f.id) f.id = generateId();
            if (!f.tags) f.tags = [];
            if (!f.note) f.note = "";
        }
    } catch {
        favorites = [];
    }
    updateFavCount();
}

function persistFavorites() {
    fetch("/api/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(favorites),
    }).catch(() => {});
}

function isFavorite(project, path) {
    return favorites.some((f) => f.project === project && f.path === path);
}

function getFavorite(project, path) {
    return favorites.find((f) => f.project === project && f.path === path);
}

function toggleFavorite(project, path) {
    const idx = favorites.findIndex((f) => f.project === project && f.path === path);
    if (idx >= 0) {
        favorites.splice(idx, 1);
    } else {
        favorites.push({
            id: generateId(),
            project,
            path,
            tags: [],
            note: "",
            addedAt: Date.now(),
        });
    }
    persistFavorites();
    updateFavCount();
    renderFavorites();
    return idx < 0;
}

function updateFavCount() {
    favCountEl.textContent = String(favorites.length);
}

// --- 태그 관리 ---

function addTag(favId, tag) {
    const fav = favorites.find((f) => f.id === favId);
    if (!fav) return;
    tag = tag.trim();
    if (!tag || fav.tags.includes(tag)) return;
    fav.tags.push(tag);
    persistFavorites();
    renderFavorites();
    updateStarsInGrid();
}

function removeTag(favId, tag) {
    const fav = favorites.find((f) => f.id === favId);
    if (!fav) return;
    fav.tags = fav.tags.filter((t) => t !== tag);
    persistFavorites();
    renderFavorites();
}

function getAllTags() {
    const set = new Set();
    favorites.forEach((f) => (f.tags || []).forEach((t) => set.add(t)));
    return [...set].sort();
}

// --- 태그 필터 바 ---

function renderTagFilterBar() {
    const tags = getAllTags();
    tagFilterBar.innerHTML = "";
    if (tags.length === 0 && favorites.length === 0) return;

    const allChip = document.createElement("button");
    allChip.type = "button";
    allChip.className = "tag-chip" + (activeTagFilter === null ? " active" : "");
    allChip.textContent = `전체 (${favorites.length})`;
    allChip.addEventListener("click", () => {
        activeTagFilter = null;
        renderTagFilterBar();
        renderFavoritesItems();
    });
    tagFilterBar.appendChild(allChip);

    tags.forEach((tag) => {
        const count = favorites.filter((f) => (f.tags || []).includes(tag)).length;
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "tag-chip" + (activeTagFilter === tag ? " active" : "");
        chip.textContent = `#${tag} (${count})`;
        chip.addEventListener("click", () => {
            activeTagFilter = activeTagFilter === tag ? null : tag;
            renderTagFilterBar();
            renderFavoritesItems();
        });
        tagFilterBar.appendChild(chip);
    });
}

// --- 즐겨찾기 목록 렌더 ---

function renderFavorites() {
    renderTagFilterBar();
    renderFavoritesItems();
}

function renderFavoritesItems() {
    let filtered = [...favorites];
    if (activeTagFilter) {
        filtered = filtered.filter((f) => (f.tags || []).includes(activeTagFilter));
    }
    filtered.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

    if (filtered.length === 0) {
        favoritesList.innerHTML = `<li class="empty">${
            activeTagFilter
                ? `"#${escapeHtml(activeTagFilter)}" 태그가 없습니다`
                : "즐겨찾기가 비어 있습니다"
        }</li>`;
        return;
    }

    favoritesList.innerHTML = "";
    for (const fav of filtered) {
        favoritesList.appendChild(renderFavItem(fav));
    }
}

function renderFavItem(fav) {
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

    // 태그 칩 HTML
    const tagsHtml = (fav.tags || [])
        .map((t) => `<span class="tag-chip small" data-tag="${escapeHtml(t)}">#${escapeHtml(t)} <span class="tag-x">✕</span></span>`)
        .join("");

    li.innerHTML = `
        <div class="fav-thumb ${kind !== "image" && kind !== "video" ? "fav-thumb-other" : ""}">${thumbHtml}</div>
        <div class="fav-body">
            <div class="fav-info">
                <div class="fav-project">${escapeHtml(fav.project)}</div>
                <div class="fav-path">${escapeHtml(fav.path)}</div>
                <div class="fav-id">ID: ${escapeHtml(fav.id)}</div>
            </div>
            <div class="fav-tags">
                ${tagsHtml}
                <button class="tag-add-btn" type="button" title="태그 추가">+</button>
            </div>
        </div>
        <button class="fav-remove" type="button" title="즐겨찾기 해제">⭐</button>`;

    // 썸네일 클릭 → 라이트박스
    li.querySelector(".fav-thumb").addEventListener("click", () => {
        const node = { name: fav.path.split("/").pop(), path: fav.path, kind, size: 0 };
        if (kind === "image" || kind === "video") {
            openLightbox(fav.project, node);
        } else if (rootTree && currentProject === fav.project) {
            const tn = findNodeByPath(rootTree, fav.path);
            if (tn) preview(fav.project, tn);
        }
    });

    // 태그 칩 ✕ 클릭
    li.querySelectorAll(".tag-chip.small").forEach((chip) => {
        chip.querySelector(".tag-x").addEventListener("click", (e) => {
            e.stopPropagation();
            removeTag(fav.id, chip.dataset.tag);
        });
    });

    // + 버튼 → 인라인 input
    li.querySelector(".tag-add-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        const tagsDiv = li.querySelector(".fav-tags");
        const btn = li.querySelector(".tag-add-btn");
        // 이미 input 있으면 focus
        if (tagsDiv.querySelector(".tag-input")) {
            tagsDiv.querySelector(".tag-input").focus();
            return;
        }
        const input = document.createElement("input");
        input.type = "text";
        input.className = "tag-input";
        input.placeholder = "태그 입력";
        input.maxLength = 20;
        tagsDiv.insertBefore(input, btn);
        input.focus();

        const commitTag = () => {
            const val = input.value.trim();
            if (val) addTag(fav.id, val);
            else { input.remove(); }
        };
        input.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); commitTag(); }
            if (ev.key === "Escape") input.remove();
        });
        input.addEventListener("blur", commitTag);
    });

    // ⭐ 해제
    li.querySelector(".fav-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFavorite(fav.project, fav.path);
        updateStarsInGrid();
    });

    return li;
}

/** grid 카드의 별 활성 상태를 동기화. */
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
    document.querySelectorAll(".tree .active").forEach((el) => el.classList.remove("active"));
    label.classList.add("active");
}

// =====================================================================
// 폴더 그리드
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

        card.addEventListener("click", (e) => {
            if (e.target.closest(".star-btn")) return;
            selectCard(card);
            const cls = child.type === "dir" ? "dir-label" : "file-label";
            const treeLabel = document.querySelector(
                `.tree .${cls}[data-path="${cssQueryEscape(child.path)}"]`
            );
            if (treeLabel) setActiveLabel(treeLabel);
        });

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

    const star = card.querySelector(".star-btn");
    star.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFavorite(project, child.path);
        updateStarsInGrid();
    });
    star.addEventListener("dblclick", (e) => e.stopPropagation());

    return card;
}

// =====================================================================
// 파일 단일 미리보기
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
// 라이트박스
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
    lightboxStage.innerHTML = "";
    lightbox.classList.add("hidden");
}

lightboxClose.addEventListener("click", closeLightbox);
lightbox.addEventListener("click", (e) => { if (e.target === lightbox) closeLightbox(); });
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !lightbox.classList.contains("hidden")) closeLightbox();
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
    if (dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.add("hidden"); }
});
document.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.add("hidden");
    if (!currentProject) { alert("프로젝트를 먼저 선택하세요."); return; }
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    await uploadFiles(currentProject, currentDir, files);
});

async function uploadFiles(project, dir, files) {
    const total = files.length;
    let done = 0, fails = 0;
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
            if (!res.ok) fails += 1;
        } catch { fails += 1; }
    }
    const stayDir = currentDir;
    await reloadTreeAndShow(project, stayDir);
    previewInfo.textContent = fails > 0
        ? `업로드: ${total - fails}/${total} 성공, ${fails} 실패`
        : `📁 ${stayDir || "(루트)"} · 업로드 ${total}개 완료`;
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
    } catch (err) { console.error(err); }
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

// 서버에서 즐겨찾기 로드 후 프로젝트 목록 로드
initFavorites().then(() => loadProjects());
