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
    colors, getColorFilter, getKindFilter,
    getGeneratedLastDirForProject,
} from "./state.js";
import { apiGetTree, apiGetFile } from "./api.js";
import {
    sourceFavorites, toggleSource, markCardSeen,
    updateFavCount, updateCardNewBadges, updateTreeLabelColors,
    getDerivedOf, getFavorite, renderFavoritesItems,
    addTag, removeTag, attachTagAutocomplete,
    renderTagFilterBar,
} from "./favorites.js";
import {
    selectCard, getSelectedPaths,
    syncTreeSelection, refreshDraggable,
} from "./selection.js";
import { renderTree, setActiveLabelByPath } from "./tree.js";
import { attachLongPress, closeContextPopup } from "./popup.js";
import { openTreeMenu, moveFile } from "./menus.js";
import { openLightbox } from "./lightbox.js";
import { sortItems, groupLabelFor } from "./view-controls.js";
import { currentSortKey, activeTab, activeTagFilter } from "./state.js";
import { makeCardDraggable } from "./upload.js";
import { hasComments, unseenCommentCount, commentCount, openCommentsModal, loadComments } from "./comments.js";
import { lazyScan } from "./lazy-media.js";

const RESULT_DIR = "Result";

// 트랙 위치 맵 제공자 — viewer-tab.js 가 init 시점에 자기 getTrackPositionMap 을 주입.
// grid.js 가 viewer-tab.js 를 import 하지 않게 해 순환 의존성을 끊는다.
let _trackMapProvider = null;
export function setTrackMapProvider(fn) { _trackMapProvider = fn; }

/** dragstart 가 setData 한 트리 path 들 추출. 다중(text/x-tree-paths) 우선, 없으면 단일(text/x-tree-path). */
export function _extractDraggedPaths(e) {
    const multi = e.dataTransfer.getData("text/x-tree-paths");
    if (multi) return multi.split("\n").filter(Boolean);
    const single = e.dataTransfer.getData("text/x-tree-path");
    return single ? [single] : [];
}

// viewer 트랙 위치 라벨 — provider 가 등록돼 있을 때만 동작. 카드 렌더 시점과 트랙 변경 시점 모두 최신 값.
function _applyTrackBadge(card, path) {
    if (!card) return;
    let badge = card.querySelector(".card-track-badge");
    const map = _trackMapProvider ? _trackMapProvider() : {};
    const positions = path ? map[path] : null;
    if (positions && positions.length > 0) {
        if (!badge) {
            badge = document.createElement("span");
            badge.className = "card-track-badge";
            card.appendChild(badge);
        }
        badge.textContent = positions.join(", ");
    } else if (badge) {
        badge.remove();
    }
}
// 트랙 변경 시 보이는 카드 전부 갱신
window.addEventListener("pv:viewer-track-changed", () => {
    previewContent.querySelectorAll(".card[data-path]")
        .forEach((card) => _applyTrackBadge(card, card.dataset.path));
});

// 코멘트 배지 — path 에 코멘트가 있으면 썸네일 하단 중앙에 작은 C 표시.
// 새 코멘트가 있으면 파란색, 모두 본 상태면 회색.
// 클릭 = 코멘트 모달 열기 (selectCard 트리거 방지를 위해 stopPropagation).
function _applyCommentBadge(card, path) {
    if (!card) return;
    // 썸네일 컨테이너 안에 위치 — 카드가 아닌 .thumb 의 child 로 부착
    const thumb = card.querySelector(".thumb");
    let badge = card.querySelector(".card-comment-badge");
    if (path && hasComments(path) && thumb) {
        if (!badge) {
            badge = document.createElement("button");
            badge.className = "card-comment-badge";
            badge.type = "button";
            badge.addEventListener("click", (e) => {
                e.stopPropagation();
                openCommentsModal(path);
            });
            badge.addEventListener("mousedown", (e) => e.stopPropagation());
            badge.addEventListener("dblclick", (e) => e.stopPropagation());
            thumb.appendChild(badge);
        }
        const total = commentCount(path);
        const unseen = unseenCommentCount(path);
        const hasNew = unseen > 0;
        badge.classList.toggle("ccb-unseen", hasNew);
        badge.classList.toggle("ccb-seen", !hasNew);
        badge.title = hasNew
            ? `새 코멘트 ${unseen}개 (총 ${total}개) — 클릭해 확인`
            : `코멘트 ${total}개 — 클릭해 보기`;
        // unseen 수만 빨강 숫자로 (1, 2, 3...) — 다 확인하면 회색 "C"
        badge.textContent = hasNew ? String(unseen) : "C";
    } else if (badge) {
        badge.remove();
    }
}
window.addEventListener("pv:comments-changed", () => {
    previewContent.querySelectorAll(".card[data-path]")
        .forEach((card) => _applyCommentBadge(card, card.dataset.path));
});

// 카드의 img/video 가 로드 실패 (파일 삭제됨 등) 시 "파일 없음" 표시로 교체.
// 호출자: renderFileCard / renderSourceCard / showGeneratedGrid 의 카드 생성 직후.
function _attachThumbErrorHandler(card) {
    const thumb = card.querySelector(".thumb");
    if (!thumb) return;
    const media = thumb.querySelector("img, video");
    if (!media) return;
    const onError = () => {
        if (card.classList.contains("card-missing")) return;  // 중복 호출 방지
        card.classList.add("card-missing");
        // 기존 img/video 와 play-badge 제거 후 missing placeholder 삽입
        thumb.querySelectorAll("img, video, .play-badge, .thumb-icon").forEach((el) => el.remove());
        const ph = document.createElement("div");
        ph.className = "thumb-missing";
        ph.innerHTML = `<div class="thumb-missing-icon">🗎</div><div class="thumb-missing-label">파일 없음</div>`;
        thumb.insertBefore(ph, thumb.firstChild);
    };
    if (media.tagName === "IMG") {
        // src 가 비어있으면 lazy-media.js 가 IO 진입 시 setting 할 예정 — 즉시
        // 판단 금지 (src 없는 img 는 complete=true + naturalWidth=0 이라 false-positive).
        if (media.src && media.complete && media.naturalWidth === 0) onError();
        else media.addEventListener("error", onError);
    } else {
        media.addEventListener("error", onError);
    }
}

// 그리드에 정렬 키 기반 그룹 헤더를 삽입. 헤더는 grid-column: 1/-1 로 한 줄 차지.
function _renderWithGroupHeaders(grid, items, renderItem) {
    const labels = items.map((it) => groupLabelFor(it, currentSortKey));
    // 그룹화 안 함 (name 정렬 등) → 그냥 카드만 렌더
    if (labels.every((l) => l === null)) {
        items.forEach((it) => grid.appendChild(renderItem(it)));
        return;
    }
    // 그룹별 개수 집계
    const counts = {};
    labels.forEach((l) => {
        const k = l ?? "(기타)";
        counts[k] = (counts[k] || 0) + 1;
    });
    let lastLabel = undefined;
    items.forEach((it, i) => {
        const label = labels[i] ?? "(기타)";
        if (label !== lastLabel) {
            const header = document.createElement("div");
            header.className = "grid-group-header";
            header.textContent = `${label} (${counts[label]})`;
            grid.appendChild(header);
            lastLabel = label;
        }
        grid.appendChild(renderItem(it));
    });
}

// =====================================================================
// 폴더 그리드
// =====================================================================

// Windows Explorer 스타일 breadcrumb — [프로젝트] › 폴더 › 하위... · N개 항목.
// 각 segment 는 클릭으로 그 폴더 진입.
function _renderBreadcrumb(project, node, itemCount) {
    const segs = (node.path || "").split("/").filter(Boolean);
    const parts = [{ label: project || "(프로젝트)", path: "" }];
    let acc = "";
    for (const seg of segs) {
        acc = acc ? acc + "/" + seg : seg;
        parts.push({ label: seg, path: acc });
    }
    const segHtml = parts.map((p, i) => {
        const isLast = i === parts.length - 1;
        const label = escapeHtml(p.label);
        if (isLast) return `<span class="bc-current">${label}</span>`;
        return `<a class="bc-seg" data-path="${escapeHtml(p.path)}" role="button">${label}</a>`;
    }).join(`<span class="bc-sep">›</span>`);
    return `<span class="breadcrumb">📁 ${segHtml}</span>`
         + `<span class="bc-meta"> · ${itemCount}개 항목</span>`;
}

// previewInfo 안의 .bc-seg 클릭 → 그 폴더로 이동 (delegation, 1회 등록)
previewInfo.addEventListener("click", (e) => {
    const seg = e.target.closest(".bc-seg");
    if (!seg) return;
    e.preventDefault();
    const targetPath = seg.dataset.path || "";
    const targetNode = targetPath ? findNodeByPath(rootTree, targetPath) : rootTree;
    if (!targetNode) return;
    setCurrentDir(targetPath);
    showFolderGrid(currentProject, targetNode);
    // 트리 라벨도 그 폴더로 active
    import("./tree.js").then(({ setActiveLabelByPath }) => {
        if (targetPath) setActiveLabelByPath(targetPath, true);
    });
});

// breadcrumb 의 부모/조부모 폴더 segment 도 drop 대상 — 카드 드래그해서 한 단계 위로 빠른 이동.
// 트리 폴더 drop 핸들러와 동일 패턴 (text/x-tree-path / paths).
function _bcDragAccepts(e) {
    if (!e.dataTransfer) return false;
    const t = Array.from(e.dataTransfer.types);
    return t.includes("text/x-tree-path") || t.includes("text/x-tree-paths");
}
previewInfo.addEventListener("dragover", (e) => {
    const seg = e.target.closest(".bc-seg");
    if (!seg || !_bcDragAccepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    seg.classList.add("bc-drag-over");
});
previewInfo.addEventListener("dragleave", (e) => {
    const seg = e.target.closest(".bc-seg");
    if (seg && !seg.contains(e.relatedTarget)) seg.classList.remove("bc-drag-over");
});
previewInfo.addEventListener("drop", async (e) => {
    const seg = e.target.closest(".bc-seg");
    if (!seg || !_bcDragAccepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    seg.classList.remove("bc-drag-over");
    const targetDir = seg.dataset.path || "";  // "" = 프로젝트 루트

    const paths = _extractDraggedPaths(e).filter((p) => {
        const fromDir = p.includes("/") ? p.substring(0, p.lastIndexOf("/")) : "";
        return fromDir !== targetDir;  // 같은 폴더로의 이동은 스킵
    });
    if (paths.length === 0 || !currentProject) return;
    for (let i = 0; i < paths.length; i++) {
        const isLast = i === paths.length - 1;
        await moveFile(currentProject, paths[i], targetDir, !isLast);
    }
});

// 폴더 node 의 모든 자손 *파일* 을 평면 리스트로 (폴더 자체는 제외).
// 컬러 필터 활성 시 자손까지 한눈에 보기 위한 helper.
function _flattenAllFiles(node, out = []) {
    if (!node || !node.children) return out;
    for (const c of node.children) {
        if (c.type === "dir") _flattenAllFiles(c, out);
        else out.push(c);
    }
    return out;
}

export function showFolderGrid(project, node) {
    previewInfo.innerHTML = _renderBreadcrumb(project, node, node.children.length);

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

    // 컬러 필터 + 종류 필터 — per-tab 필터, 현재 활성 탭의 값.
    // 컬러 필터 활성 시: 폴더 자손 *모두 평면화* — 폴더 안에 숨어있는 마킹 파일도 표시.
    //                  (요청 — 컬러로 작업 추적 시 위치 상관없이 한눈에).
    // 컬러 필터 없을 시: 기존대로 직접 children 만 (폴더 + 파일).
    const filterColor = getColorFilter();
    const filterKind = getKindFilter();
    let visibleChildren;
    if (filterColor) {
        visibleChildren = _flattenAllFiles(node).filter((c) => {
            if (colors[c.path] !== filterColor) return false;
            if (filterKind && c.kind !== filterKind) return false;
            return true;
        });
    } else if (filterKind) {
        visibleChildren = node.children.filter((c) => {
            if (c.type === "dir") return true;
            return c.kind === filterKind;
        });
    } else {
        visibleChildren = node.children;
    }

    _renderWithGroupHeaders(grid, sortItems(visibleChildren), (child) => {
        const card = renderGridCard(project, child);
        card.addEventListener("click", (e) => {
            if (e.target.closest(".card-marker")) return;
            selectCard(card, e);
            setActiveLabelByPath(child.path, child.type === "dir");
            if (markCardSeen(project, child.path)) {
                updateFavCount();
                updateCardNewBadges();
                updateTreeLabelColors();
                renderFavoritesItems();
            }
            if (e.shiftKey || e.ctrlKey || e.metaKey) closeContextPopup();
        });
        attachLongPress(card, project, child);
        card.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            if (!card.classList.contains("selected")) {
                previewContent.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
                card.classList.add("selected");
                setLastSelectedCard(card);
                syncTreeSelection();
                refreshDraggable();
                setActiveLabelByPath(child.path, child.type === "dir");
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
        return card;
    });

    previewContent.innerHTML = "";
    previewContent.appendChild(renderColorFilterBar());
    previewContent.appendChild(grid);
    updateCardNewBadges();
    lazyScan(grid);
}

// 그리드 상단 필터 bar — 종류 dropdown 항상, R/G/B 컬러 칩은 옵션 (소스탭 제외).
// 두 필터는 직교적으로 적용 (둘 다 만족하는 카드만 보임).
function renderColorFilterBar({ showColors = true } = {}) {
    const bar = document.createElement("div");
    bar.className = "color-filter-bar";

    // 종류 dropdown — 첫 칩 자리. 클릭 시 native dropdown 열림.
    const curKind = getKindFilter();
    const curColor = getColorFilter();
    const kindSel = document.createElement("select");
    kindSel.className = "kind-filter-select" + (curKind ? " active" : "");
    kindSel.title = "표시할 파일 종류 — 전체 / 이미지만 / 동영상만";
    [
        { v: "",      label: "전체" },
        { v: "image", label: "이미지" },
        { v: "video", label: "동영상" },
    ].forEach((o) => {
        const opt = document.createElement("option");
        opt.value = o.v;
        opt.textContent = o.label;
        if (curKind === o.v) opt.selected = true;
        kindSel.appendChild(opt);
    });
    kindSel.addEventListener("change", () => {
        import("./state.js").then(({ setKindFilter }) => {
            setKindFilter(kindSel.value);
            _refreshCurrentGridCallback();
        });
    });
    bar.appendChild(kindSel);

    if (!showColors) return bar;

    // R/G/B 컬러 칩 — 단일 선택 toggle. 같은 칩 다시 클릭 = 전체.
    const colorOpts = [
        { v: "red",   label: "🔴", cls: "red" },
        { v: "green", label: "🟢", cls: "green" },
        { v: "blue",  label: "🔵", cls: "blue" },
    ];
    for (const o of colorOpts) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "color-filter-chip color-chip-" + o.cls
            + (curColor === o.v ? " active" : "");
        btn.textContent = o.label;
        btn.dataset.color = o.v;
        btn.title = `${o.label} 마커 카드만 표시`;
        btn.addEventListener("click", () => {
            const next = getColorFilter() === o.v ? "" : o.v;
            import("./state.js").then(({ setColorFilter }) => {
                setColorFilter(next);
                _refreshCurrentGridCallback();
            });
        });
        bar.appendChild(btn);
    }
    return bar;
}

// 외부에서 주입하는 grid 재렌더 callback (app.js 가 등록).
// view-controls.js 와 동일 통로 — 필터 변경 시 활성 탭에 맞춰 재렌더.
let _refreshCurrentGridCallback = () => {};
export function setColorRefreshGridCallback(fn) {
    _refreshCurrentGridCallback = typeof fn === "function" ? fn : () => {};
}

function renderGridCard(project, child) {
    const card = document.createElement("div");
    card.className = "card";

    if (child.type === "dir") {
        card.classList.add("card-dir");
        card.title = child.path;
        card.dataset.path = child.path;
        const itemCount = (child.children || []).length;
        // 0 개면 배지 숨김 (시각 노이즈 회피)
        const countBadge = itemCount > 0
            ? `<span class="thumb-count">${itemCount}</span>`
            : "";
        card.innerHTML = `
            <div class="thumb thumb-dir">📁${countBadge}</div>
            <div class="card-name">${escapeHtml(child.name)}</div>
            <div class="card-meta">${itemCount}개 항목</div>`;

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

            // 1) 트리/그리드 내부 이동 (단일/다중)
            const paths = _extractDraggedPaths(e)
                .filter((p) => {
                    const fromDir = p.includes("/") ? p.substring(0, p.lastIndexOf("/")) : "";
                    return fromDir !== child.path;  // 같은 폴더 안은 스킵
                });
            if (paths.length > 0) {
                // 마지막 1개만 reload 표시 (silent=false) — 트리 재로드 1회로 처리
                for (let i = 0; i < paths.length; i++) {
                    const isLast = i === paths.length - 1;
                    await moveFile(project, paths[i], child.path, !isLast);
                }
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

        // 폴더 안에 코멘트가 있는 파일이 있으면 폴더 카드에도 배지 (자손 합산).
        // hasComments/commentCount/unseenCommentCount 가 path 자손까지 본다.
        _applyCommentBadge(card, child.path);

        return card;
    }

    card.classList.add("card-file", "kind-" + child.kind);
    // R/G/B 컬러 마커 — colors[path] 가 있으면 .color-<name> 클래스 추가 (CSS 가 테두리/dot 표시)
    const cardColor = colors[child.path];
    if (cardColor) card.classList.add("color-" + cardColor);
    card.title = `${child.path} · ${humanSize(child.size)}`;
    const url = `/media?project=${encodeURIComponent(project)}&path=${encodeURIComponent(child.path)}`;

    // 카드 썸네일은 서버 사전 생성 (/thumb endpoint). 원본 (/media) 은 재생/원본 보기용.
    // v= 는 cache buster — 같은 path 의 파일이 새로 들어와도 브라우저 캐시 격리.
    const _v = child.mtime ? `&v=${child.mtime}` : "";
    const thumbUrl = `/thumb?project=${encodeURIComponent(project)}&path=${encodeURIComponent(child.path)}${_v}`;
    let thumbInner;
    if (child.kind === "image") {
        thumbInner = `<img data-lazy-src="${thumbUrl}" alt="" loading="lazy" />`;
    } else if (child.kind === "video") {
        // 카드는 재생 X — poster 만 표시 → 디코드 0. viewport gate 는 lazy-media.js IO.
        thumbInner = `<video data-lazy-poster="${thumbUrl}" preload="none" muted></video>
                      <div class="play-badge">▶</div>`;
    } else if (child.kind === "text") {
        thumbInner = `<div class="thumb-icon">📄</div>`;
    } else {
        thumbInner = `<div class="thumb-icon">📦</div>`;
    }

    // 카드 우상단 마커
    // - 생성물(Result/): generated (파란)
    // - 소스 토글됨: source (녹색)
    // - 생성물 + 소스: generated source 둘 다 → 파란 점 + 녹색 링
    const isGen = isGeneratedPath(child.path);
    const _fav = getFavorite(project, child.path);
    const isSrc = !!(_fav && _fav.isSource);
    const markerClsList = ["card-marker"];
    if (isGen) markerClsList.push("generated");
    if (isSrc) markerClsList.push("source");
    if (!isGen && !isSrc) markerClsList.push("neutral");
    const markerTitle = isSrc
        ? (isGen ? "소스 해제 (생성물 + 소스)" : "소스 해제")
        : (isGen ? "소스로 표시 (생성물)" : "소스로 표시");

    card.innerHTML = `
        <div class="thumb thumb-${child.kind}">
            ${thumbInner}
            <button class="${markerClsList.join(" ")}" type="button" data-path="${escapeHtml(child.path)}" title="${markerTitle}">●</button>
        </div>
        <div class="card-name">${escapeHtml(child.name)}</div>
        <div class="card-meta">${humanSize(child.size)}</div>`;

    // 카드의 data-path 는 lasso/tree 동기화 등에서 path 식별에 사용
    card.dataset.path = child.path;

    // viewer 트랙에 포함된 파일이면 좌상단에 위치 배지 표시 (예: "1", "2_1")
    _applyTrackBadge(card, child.path);

    // 코멘트가 있으면 우하단에 C 배지 — 클릭 = 모달 열기
    _applyCommentBadge(card, child.path);

    // 파일이 삭제됐을 때 broken img/video 대신 "파일 없음" 표시
    _attachThumbErrorHandler(card);

    // 마커 클릭 = 소스 토글 (생성물도 가능)
    const marker = card.querySelector(".card-marker");
    marker.addEventListener("click", (e) => {
        e.stopPropagation();
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
    // #scratch 태그 활성 시에만 scratch fav 노출 — 격리 정책.
    const showScratch = filterTag === "scratch";
    let filtered = sourceFavorites({ includeScratch: showScratch });
    if (filterTag) {
        filtered = filtered.filter((f) => (f.tags || []).includes(filterTag));
    }
    // 종류 필터만 (소스탭은 RGB 색 마커 미지원). 폴더 그리드와는 다른 정책.
    // per-tab — 현재 활성 탭의 종류 필터 값.
    const curKind = getKindFilter();
    if (curKind) {
        filtered = filtered.filter((f) => kindFromPath(f.path) === curKind);
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
        } else if (curKind) {
            msg = "현재 필터에 해당하는 소스가 없습니다.";
        } else {
            msg = `'${escapeHtml(currentProject)}' 프로젝트에 등록된 소스가 없습니다.`;
        }
        previewContent.innerHTML = "";
        const emptyTagBar = document.createElement("div");
        emptyTagBar.id = "source-tag-filter-bar";
        emptyTagBar.className = "tag-filter-bar source-grid-tag-bar";
        const filterRow = document.createElement("div");
        filterRow.className = "filter-row";
        filterRow.appendChild(renderColorFilterBar({ showColors: false }));
        filterRow.appendChild(emptyTagBar);
        previewContent.appendChild(filterRow);
        const empty = document.createElement("div");
        empty.className = "unsupported";
        empty.innerHTML = msg;
        previewContent.appendChild(empty);
        renderTagFilterBar();  // 빈 상태에서도 태그 칩으로 다른 필터 시도 가능
        return;
    }

    const grid = document.createElement("div");
    grid.className = "grid" + (currentView === "list" ? " list-view" : "");

    // 정렬 키에 맞춰 그룹 헤더와 함께 렌더
    _renderWithGroupHeaders(grid, filtered, (fav) => {
        const kind = kindFromPath(fav.path);
        return renderSourceCard(fav, kind);
    });

    // 우측 그리드 상단에 태그 필터 chip bar (사이드바와 동일 콘텐츠)
    const tagBar = document.createElement("div");
    tagBar.id = "source-tag-filter-bar";
    tagBar.className = "tag-filter-bar source-grid-tag-bar";

    // 종류 dropdown + 태그 칩을 한 줄에 — flex row 로 묶음
    const filterRow = document.createElement("div");
    filterRow.className = "filter-row";
    filterRow.appendChild(renderColorFilterBar({ showColors: false }));  // 소스탭 = 종류만
    filterRow.appendChild(tagBar);

    previewContent.innerHTML = "";
    previewContent.appendChild(filterRow);
    previewContent.appendChild(grid);
    renderTagFilterBar();  // 사이드바 + 우측 둘 다 렌더
    updateCardNewBadges();
    lazyScan(grid);
}

function renderSourceCard(fav, kind) {
    const card = document.createElement("div");
    card.className = "card card-file kind-" + kind;
    // 소스탭은 R/G/B 마커 미지원 — 색 클래스 적용 안 함
    card.title = `${fav.path} · ID: ${fav.id}`;
    card.dataset.path = fav.path;

    const _fv = fav.addedAt || fav.id || "";
    const thumbUrl = `/thumb?project=${encodeURIComponent(fav.project)}&path=${encodeURIComponent(fav.path)}${_fv ? `&v=${_fv}` : ""}`;
    let thumbInner;
    if (kind === "image") {
        thumbInner = `<img data-lazy-src="${thumbUrl}" alt="" loading="lazy" />`;
    } else if (kind === "video") {
        thumbInner = `<video data-lazy-poster="${thumbUrl}" preload="none" muted></video><div class="play-badge">▶</div>`;
    } else {
        thumbInner = `<div class="thumb-icon">📄</div>`;
    }

    // 각 태그에 ✕ 버튼 + 끝에 "+" 추가 버튼 (사이드바 fav-item 과 동일 UX)
    const tagsHtml = (fav.tags || [])
        .map((t) => `<span class="tag-chip small" data-tag="${escapeHtml(t)}">#${escapeHtml(t)} <span class="tag-x">✕</span></span>`)
        .join("");

    const derived = getDerivedOf(fav.id);
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
        <div class="card-tags">
            ${tagsHtml}
            <button class="tag-add-btn" type="button" title="태그 추가">+</button>
        </div>
        <div class="card-meta">ID: ${escapeHtml(fav.id.slice(0, 10))}</div>`;

    _attachThumbErrorHandler(card);

    const marker = card.querySelector(".card-marker");
    marker.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSource(fav.project, fav.path);
    });
    marker.addEventListener("dblclick", (e) => e.stopPropagation());
    marker.addEventListener("mousedown", (e) => e.stopPropagation());

    // 태그 chip ✕ → 제거
    card.querySelectorAll(".tag-chip.small").forEach((chip) => {
        const x = chip.querySelector(".tag-x");
        if (!x) return;
        x.addEventListener("click", (e) => {
            e.stopPropagation();
            removeTag(fav.id, chip.dataset.tag);
        });
        chip.addEventListener("mousedown", (e) => e.stopPropagation());
    });
    // "+" → 인라인 input 으로 태그 추가 (사이드바 fav-item 과 동일 UX)
    const addBtn = card.querySelector(".tag-add-btn");
    if (addBtn) {
        addBtn.addEventListener("mousedown", (e) => e.stopPropagation());
        addBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const tagsDiv = card.querySelector(".card-tags");
            if (!tagsDiv) return;
            const existing = tagsDiv.querySelector(".tag-input");
            if (existing) { existing.focus(); return; }
            const input = document.createElement("input");
            input.type = "text";
            input.className = "tag-input";
            input.placeholder = "태그 입력";
            input.maxLength = 20;
            tagsDiv.insertBefore(input, addBtn);
            input.focus();
            attachTagAutocomplete(input);

            let committed = false;
            const commit = () => {
                if (committed) return;
                committed = true;
                const val = input.value.trim();
                if (val) addTag(fav.id, val);
                else input.remove();
            };
            input.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter") { ev.preventDefault(); commit(); }
                else if (ev.key === "Escape") { committed = true; input.remove(); }
                ev.stopPropagation();
            });
            input.addEventListener("click", (ev) => ev.stopPropagation());
            input.addEventListener("mousedown", (ev) => ev.stopPropagation());
            input.addEventListener("blur", commit);
        });
    }

    // 클릭 = 선택만. 정보 팝업은 long-press 로 발동. 태그 영역은 제외.
    card.addEventListener("click", (e) => {
        if (e.target.closest(".card-marker")) return;
        if (e.target.closest(".tag-chip")) return;
        if (e.target.closest(".tag-add-btn")) return;
        if (e.target.closest(".tag-input")) return;
        selectCard(card, e);
        // 카드 클릭 시 NEW dismiss (사이드바 fav-item 도 같이 갱신)
        if (markCardSeen(fav.project, fav.path)) {
            updateFavCount();
            updateCardNewBadges();
            updateTreeLabelColors();
            renderFavoritesItems();
        }
        if (e.shiftKey || e.ctrlKey || e.metaKey) closeContextPopup();
    });

    // long-press(0.35초) 로 정보 팝업
    {
        const sNode = { name: fav.path.split("/").pop(), path: fav.path, kind, size: 0, type: "file" };
        attachLongPress(card, fav.project, sNode);
    }

    // 더블클릭 = 라이트박스 (태그 영역 제외)
    card.addEventListener("dblclick", (e) => {
        if (e.target.closest(".tag-chip, .tag-add-btn, .tag-input")) return;
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
    // 생성 탭에서 마지막 본 폴더 복원 (예: Result/cut001). 없으면 Result/ 기본.
    let targetNode = resultNode;
    const savedGenDir = getGeneratedLastDirForProject(currentProject);
    if (savedGenDir && savedGenDir !== RESULT_DIR) {
        const found = findNodeByPath(rootTree, savedGenDir);
        if (found && found.type === "dir") targetNode = found;
    }
    setCurrentDir(targetNode.path);
    // showFolderGrid 가 breadcrumb (`v002 > Result > cut001 · N개 항목`) 을 그림.
    // 옛 코드는 그 위에 textContent 로 덮어써서 breadcrumb 가 사라졌는데, 이제 보존.
    showFolderGrid(currentProject, targetNode);
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
        // 트리 + 코멘트 cache 를 병렬 새로 — 파일 삭제 시 backend 가 코멘트 store
        // 도 정리하지만 frontend 의 _comments cache 가 stale 면 배지가 남는다.
        const [treeRes] = await Promise.all([apiGetTree(project), loadComments()]);
        const { ok, data } = treeRes;
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
        // 활성 탭에 맞는 우측 그리드 갱신 — favorites 탭에서 파일 삭제 후 우측이
        // 폴더 그리드로 튀던 회귀 방지.
        if (activeTab === "favorites") {
            showSourceGrid(activeTagFilter);
        } else if (activeTab === "generated" || activeTab === "viewer") {
            showGeneratedGrid();
        } else {
            showFolderGrid(project, node);
        }
    } catch (err) { console.error(err); }
}
