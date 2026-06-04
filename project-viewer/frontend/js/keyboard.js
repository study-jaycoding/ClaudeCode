// =====================================================================
// 전역 키보드 단축키 — Windows 탐색기 패턴
//
// 영역(area): "tree" | "favorites" | "queue" | "grid"
//   - lastFocusArea 가 정해진 영역이면 그쪽
//   - 미정("") 이면 활성 탭으로 결정 (favorites → favorites, generated → queue, 그 외 → tree)
//
// 영역별 키 — 좌측/우측 영역이 별개로 작동 (화살표가 영역 간 점프 안 함).
// 영역 전환은 Tab 으로만.
//   ↑↓        : active 항목 이동 (currentDir 안 바뀜)
//   shift+↑↓ : range 다중 선택
//   ←         : (트리) 펴진 폴더 접기, 아니면 부모로 active. (그리드) 좌측 카드. 영역 점프 X.
//   →         : (트리) 접힌 폴더 펴기, 펴진 폴더면 첫 자식 active. (그리드) 우측 카드. 영역 점프 X.
//   Home/End  : 첫/마지막 항목
//   Tab       : 영역 전환 (좌측 ↔ 우측)
//   Enter     : (트리/그리드) 폴더 진입 또는 파일 열기. (큐) 항목 활성.
//   Backspace : 부모 폴더 (currentDir 변경)
//   Alt+↑     : 부모 폴더 (Windows 탐색기 표준)
//   F2        : 이름 변경
//   Delete    : 선택 항목 삭제 (큐 포함 다중)
//   Ctrl+A    : 그리드 전체 선택
//   Ctrl+Z    : Undo
//   Ctrl+Shift+N : 현재 폴더에 새 폴더
//   Esc       : 라이트박스/팝업/메뉴 닫기 → 또는 그리드 선택 해제
//   첫 글자(a-z, 0-9) : 그 글자로 시작하는 다음 항목으로 점프
//   R / G / B : 그리드 선택 카드에 빨강/초록/파랑 컬러 마커. 같은 색 다시 누르면 해제.
//               생성탭 그리드 상단 컬러 필터 칩으로 색별 필터 가능.
// =====================================================================
import { lightbox, contextPopup, treeMenu, previewContent } from "./dom.js";
import { closeLightbox, openLightbox } from "./lightbox.js";
import {
    clearSelection, getSelectedPaths, selectCard,
    syncTreeSelection, refreshDraggable, markSelectedCardsSeen,
} from "./selection.js";
import {
    currentProject, currentDir, rootTree, setCurrentDir, setLastSelectedCard,
    lastFocusArea, lastSelectedCard, setLastFocusArea,
    activeTab,
    shiftAnchorTreePath, setShiftAnchorTreePath,
} from "./state.js";
import { undoLast } from "./undo.js";
import { findNodeByPath, cssQueryEscape } from "./utils.js";
import {
    renameFilePrompt, deleteFilesConfirm,
    createDefaultFolderInside, startInlineRenameForPath,
} from "./menus.js";
import { showFolderGrid, preview } from "./grid.js";
import { closeContextPopup } from "./popup.js";
import { moveFavoritesFocus } from "./favorites.js";
import { setActiveLabelByPath } from "./tree.js";
import { moveQueueFocus, activateSelectedQueueItem, deleteSelectedQueueItems } from "./queue.js";
import { apiSetColors } from "./api.js";
import { colors as cardColors, setColors } from "./state.js";

// ──────────────────────────────────────────────────────────────────────
// 공통 유틸
// ──────────────────────────────────────────────────────────────────────

function openPath(project, path) {
    if (!rootTree) return;
    const node = findNodeByPath(rootTree, path);
    if (!node) return;
    closeContextPopup();
    if (node.type === "dir") {
        setCurrentDir(node.path);
        showFolderGrid(project, node);
    } else if (node.kind === "image" || node.kind === "video") {
        openLightbox(project, node);
    } else {
        preview(project, node);
    }
}

/** 현재 활성 영역 — lastFocusArea 가 활성 탭과 호환될 때만 신뢰.
 *  사이드바 영역(tree/favorites/queue)은 활성 탭과 매칭돼야 stale 아님.
 *  "grid" 는 활성 탭과 무관 (어느 탭이든 우측 그리드 존재). */
function currentArea() {
    if (lastFocusArea === "grid") return "grid";
    if (lastFocusArea === "queue" && activeTab === "generated") return "queue";
    if (lastFocusArea === "favorites" && activeTab === "favorites") return "favorites";
    if (lastFocusArea === "tree" && activeTab !== "favorites" && activeTab !== "generated") return "tree";
    // fallback — 활성 탭 기반 (stale lastFocusArea 무시)
    if (activeTab === "favorites") return "favorites";
    if (activeTab === "generated") return "queue";
    return "tree";
}

/** 영역 간 점프 helpers. */
function jumpFocusToGrid() {
    const cards = previewContent.querySelectorAll(".card");
    if (cards.length === 0) return;
    setLastFocusArea("grid");
    const target = lastSelectedCard && previewContent.contains(lastSelectedCard)
        ? lastSelectedCard : cards[0];
    selectCard(target);
    target.scrollIntoView({ block: "nearest" });
}

function jumpFocusToSidebar() {
    if (activeTab === "favorites") {
        setLastFocusArea("favorites");
        moveFavoritesFocus(1, false);
        return;
    }
    if (activeTab === "generated") {
        setLastFocusArea("queue");
        moveQueueFocus(1, false);
        return;
    }
    setLastFocusArea("tree");
    const active = document.querySelector(".tree .active[data-path]");
    if (active) active.scrollIntoView({ block: "nearest" });
    else moveTreeFocus(1, false);
}

// ──────────────────────────────────────────────────────────────────────
// 트리 navigation — Windows 표준
// ──────────────────────────────────────────────────────────────────────

/** 현재 보이는 트리 라벨. collapsed 폴더 *안* 항목 제외 (자기 li 의 collapsed 는 자식만 가림). */
function visibleTreeLabels() {
    const all = document.querySelectorAll(".tree .dir-label, .tree .file-label");
    return Array.from(all).filter((el) => {
        if (!el.offsetParent) return false;
        const selfLi = el.closest("li");
        for (let p = selfLi ? selfLi.parentElement : el.parentElement; p; p = p.parentElement) {
            if (p.classList?.contains("tree")) break;
            if (p.classList?.contains("collapsed")) return false;
        }
        return true;
    });
}

/** active 라벨 한 곳으로 설정 (currentDir 안 바꿈). */
function setTreeActiveOnly(label) {
    document.querySelectorAll(".tree .active").forEach((el) => el.classList.remove("active"));
    document.querySelectorAll(".tree .file-label.selected, .tree .dir-label.selected")
        .forEach((el) => el.classList.remove("selected"));
    label.classList.add("active");
    label.scrollIntoView({ block: "nearest" });
}

/** 트리 ↑↓ — active 이동. shift = range 다중 선택. currentDir 안 바뀜. */
function moveTreeFocus(direction, shift) {
    const labels = visibleTreeLabels();
    if (labels.length === 0) return;
    const active = document.querySelector(".tree .active[data-path]");
    let idx = active ? labels.indexOf(active) : -1;
    let next;
    if (idx === -1) next = direction > 0 ? 0 : labels.length - 1;
    else next = Math.max(0, Math.min(labels.length - 1, idx + direction));
    const target = labels[next];
    if (!target) return;
    setLastFocusArea("tree");
    if (!shift) {
        setShiftAnchorTreePath("");
        setTreeActiveOnly(target);
        return;
    }
    // shift+↑↓ — anchor~target range
    let anchorPath = shiftAnchorTreePath;
    if (!anchorPath || !labels.find((l) => l.dataset.path === anchorPath)) {
        anchorPath = active ? active.dataset.path : target.dataset.path;
        setShiftAnchorTreePath(anchorPath);
    }
    const aIdx = labels.findIndex((l) => l.dataset.path === anchorPath);
    const bIdx = labels.indexOf(target);
    const [lo, hi] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
    document.querySelectorAll(".tree .file-label.selected, .tree .dir-label.selected")
        .forEach((l) => l.classList.remove("selected"));
    for (let i = lo; i <= hi; i++) labels[i].classList.add("selected");
    document.querySelectorAll(".tree .active").forEach((el) => el.classList.remove("active"));
    target.classList.add("active");
    target.scrollIntoView({ block: "nearest" });
    syncGridFromTreeSelection();
}

/** 트리 ← — 펴진 폴더 접기, 그 외 부모로 active. currentDir 안 바뀜. */
function treeLeft() {
    const active = document.querySelector(".tree .active[data-path]");
    if (!active) return;
    const li = active.closest("li");
    if (!li) return;
    const isDir = active.classList.contains("dir-label");
    const chev = li.querySelector(":scope > .dir-row > .chevron");
    const hasChildren = !!li.querySelector(":scope > ul > li");

    if (isDir && !li.classList.contains("collapsed") && chev && hasChildren) {
        // 펴진 폴더 → 접기
        chev.click();
        return;
    }
    // 접힌 폴더 / 파일 → 부모 active (currentDir 안 바뀜)
    const path = active.dataset.path;
    const slash = path.lastIndexOf("/");
    if (slash < 0) return;  // 최상위 항목 — 더 위 없음
    const parentPath = path.substring(0, slash);
    const parent = document.querySelector(
        `.tree .dir-label[data-path="${cssQueryEscape(parentPath)}"]`
    );
    if (parent) {
        setShiftAnchorTreePath("");
        setTreeActiveOnly(parent);
    }
}

/** 트리 → — 접힌 폴더 펴기, 펴진 폴더면 첫 자식. currentDir 안 바뀜.
 *  영역 간 점프 안 함 (좌↔우 전환은 Tab 으로만). */
function treeRight() {
    const active = document.querySelector(".tree .active[data-path]");
    if (!active) return;
    const li = active.closest("li");
    if (!li) return;
    const isDir = active.classList.contains("dir-label");
    const chev = li.querySelector(":scope > .dir-row > .chevron");
    const hasChildren = !!li.querySelector(":scope > ul > li");

    if (isDir && li.classList.contains("collapsed") && chev && hasChildren) {
        chev.click();  // 펴기만
        return;
    }
    if (isDir && hasChildren) {
        // 이미 펴진 폴더 — 첫 자식 active
        const child = li.querySelector(
            ":scope > ul > li > .dir-row > .dir-label, :scope > ul > li > .file-label"
        );
        if (child) {
            setShiftAnchorTreePath("");
            setTreeActiveOnly(child);
        }
        return;
    }
    // 파일 또는 빈 폴더 — 트리 우측 경계, 무동작
}

/** Home/End — 트리 첫/마지막 라벨로 active. */
function moveTreeToEnd(which) {
    const labels = visibleTreeLabels();
    if (labels.length === 0) return;
    setLastFocusArea("tree");
    setShiftAnchorTreePath("");
    setTreeActiveOnly(which === "home" ? labels[0] : labels[labels.length - 1]);
}

// ──────────────────────────────────────────────────────────────────────
// 트리 → 그리드 다중선택 동기화
// ──────────────────────────────────────────────────────────────────────

function syncGridFromTreeSelection() {
    const paths = new Set(
        Array.from(document.querySelectorAll(
            ".tree .file-label.selected, .tree .dir-label.selected"
        )).map((l) => l.dataset.path)
    );
    let last = null;
    previewContent.querySelectorAll(".card").forEach((card) => {
        const matched = paths.has(card.dataset.path);
        card.classList.toggle("selected", matched);
        if (matched) last = card;
    });
    if (last) setLastSelectedCard(last);
    refreshDraggable();
    markSelectedCardsSeen();
}

// ──────────────────────────────────────────────────────────────────────
// 그리드 navigation
// ──────────────────────────────────────────────────────────────────────

/** 그리드 카드들을 offsetTop 기준 행(row)별로 묶음. */
function buildGridRows() {
    const cards = Array.from(previewContent.querySelectorAll(".card"));
    if (cards.length === 0) return [];
    const rows = [];
    let row = [];
    let top = -1;
    for (const c of cards) {
        if (c.offsetTop !== top) {
            if (row.length) rows.push(row);
            row = [];
            top = c.offsetTop;
        }
        row.push(c);
    }
    if (row.length) rows.push(row);
    return rows;
}

/** 그리드 ↑↓←→. shift = range 다중. ← col 0 → 좌측 영역 점프. */
function moveGridFocus(key, shift) {
    const rows = buildGridRows();
    if (rows.length === 0) return;

    let row = -1, col = -1;
    if (lastSelectedCard) {
        for (let r = 0; r < rows.length; r++) {
            const c = rows[r].indexOf(lastSelectedCard);
            if (c !== -1) { row = r; col = c; break; }
        }
    }
    if (row === -1) {
        const first = rows[0][0];
        selectCard(first, shift ? { shiftKey: true } : undefined);
        first.scrollIntoView({ block: "nearest" });
        return;
    }

    let target = null;
    if (key === "ArrowLeft") {
        if (col > 0) target = rows[row][col - 1];
        else if (shift && row > 0) target = rows[row - 1][rows[row - 1].length - 1];
        // col 0 일 때 ← 무동작 (좌측 panel 점프 안 함 — Tab 으로만 전환)
    } else if (key === "ArrowRight") {
        if (col < rows[row].length - 1) target = rows[row][col + 1];
        else if (row < rows.length - 1) target = rows[row + 1][0];
    } else if (key === "ArrowUp") {
        if (row > 0) {
            const prev = rows[row - 1];
            target = prev[Math.min(col, prev.length - 1)];
        }
    } else if (key === "ArrowDown") {
        if (row < rows.length - 1) {
            const next = rows[row + 1];
            target = next[Math.min(col, next.length - 1)];
        }
    }
    if (target) {
        selectCard(target, shift ? { shiftKey: true } : undefined);
        target.scrollIntoView({ block: "nearest" });
    }
}

/** Home/End — 그리드 첫/마지막 카드. */
function moveGridToEnd(which) {
    const cards = Array.from(previewContent.querySelectorAll(".card"));
    if (cards.length === 0) return;
    setLastFocusArea("grid");
    const target = which === "home" ? cards[0] : cards[cards.length - 1];
    selectCard(target);
    target.scrollIntoView({ block: "nearest" });
}

// ──────────────────────────────────────────────────────────────────────
// 부모 폴더 (Backspace / Alt+↑)
// ──────────────────────────────────────────────────────────────────────

function goToParentFolder() {
    if (!currentProject || !currentDir) return;
    const slash = currentDir.lastIndexOf("/");
    const parentDir = slash >= 0 ? currentDir.substring(0, slash) : "";
    setCurrentDir(parentDir);
    const parentNode = parentDir ? findNodeByPath(rootTree, parentDir) : rootTree;
    if (parentNode) showFolderGrid(currentProject, parentNode);
    if (parentDir) setActiveLabelByPath(parentDir, true);
    else document.querySelectorAll(".tree .active").forEach((el) => el.classList.remove("active"));
}

// ──────────────────────────────────────────────────────────────────────
// 첫 글자 점프 (Windows Explorer "type-to-search")
// 마지막 타입 시점 기준 1.5초 안에 추가 키 누르면 prefix 검색, 아니면 단일 글자 cycle.
// ──────────────────────────────────────────────────────────────────────

const TYPE_RESET_MS = 1500;
let _typeBuffer = "";
let _typeLastAt = 0;

function isPrintableKey(e) {
    return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

function appendTypeBuffer(ch) {
    const now = performance.now();
    if (now - _typeLastAt > TYPE_RESET_MS) _typeBuffer = "";
    _typeBuffer += ch.toLowerCase();
    _typeLastAt = now;
    return _typeBuffer;
}

/** 트리 라벨 / 그리드 카드의 표시 이름 — 이모지 prefix 없이 path 마지막 segment 사용. */
function basename(el) {
    const p = el.dataset.path || "";
    return p.substring(p.lastIndexOf("/") + 1).toLowerCase();
}

/** prefix 로 다음 매칭 항목 찾아 active. 단일 글자면 현재 다음부터 cycle, 다중 글자면 처음부터. */
function _findAndActivate(items, startIdx, prefix, activateFn) {
    const single = prefix.length === 1;
    const startSearch = single ? startIdx + 1 : 0;
    const match = (i) => basename(items[i]).startsWith(prefix);
    for (let i = startSearch; i < items.length; i++) if (match(i)) { activateFn(items[i]); return true; }
    for (let i = 0; i < Math.min(startSearch, items.length); i++) if (match(i)) { activateFn(items[i]); return true; }
    return false;
}

function jumpByPrefix(area, prefix) {
    if (!prefix) return false;
    if (area === "tree") {
        const labels = visibleTreeLabels();
        if (labels.length === 0) return false;
        const active = document.querySelector(".tree .active[data-path]");
        const startIdx = active ? labels.indexOf(active) : -1;
        return _findAndActivate(labels, startIdx, prefix, (l) => {
            setLastFocusArea("tree");
            setTreeActiveOnly(l);
        });
    }
    if (area === "grid") {
        const cards = Array.from(previewContent.querySelectorAll(".card"));
        if (cards.length === 0) return false;
        const startIdx = lastSelectedCard ? cards.indexOf(lastSelectedCard) : -1;
        return _findAndActivate(cards, startIdx, prefix, (c) => {
            selectCard(c);
            c.scrollIntoView({ block: "nearest" });
        });
    }
    return false;
}

// ──────────────────────────────────────────────────────────────────────
// Tab 전환 (좌측 ↔ 우측)
// ──────────────────────────────────────────────────────────────────────

function cycleFocusArea() {
    // 두 영역만 있으므로 단순 토글 (shift+Tab 도 동일).
    if (currentArea() === "grid") jumpFocusToSidebar();
    else jumpFocusToGrid();
}

// ──────────────────────────────────────────────────────────────────────
// 메인 dispatch
// ──────────────────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
    // Esc — lightbox / 다중 선택 해제
    if (e.key === "Escape" && !lightbox.classList.contains("hidden")) {
        closeLightbox(); return;
    }
    if (e.key === "Escape"
        && lightbox.classList.contains("hidden")
        && contextPopup.classList.contains("hidden")
        && treeMenu.classList.contains("hidden")) {
        clearSelection(); return;
    }

    // input/textarea/contenteditable 포커스 시 단축키 무시
    const ae = document.activeElement;
    if (ae && (["INPUT", "TEXTAREA"].includes(ae.tagName) || ae.isContentEditable)) return;

    // 보기 탭은 자체 키보드 (viewer-tab.js) 가 Space/←/→/Delete 처리.
    // 여기서는 안 가로채야 한다 (탭 영역 외 단축키 Ctrl+? 만 통과).
    if (activeTab === "viewer") {
        // viewer-tab.js 가 처리하는 키들만 통과 — Backspace 는 제외 (부모 폴더로 이동 동작 유지)
        const isNav = e.key === " " || e.code === "Space"
            || e.key === "ArrowLeft" || e.key === "ArrowRight"
            || e.key === "ArrowUp" || e.key === "ArrowDown"
            || e.key === "Delete"
            || e.key === "Home" || e.key === "End"
            || e.key === "Enter" || e.key === "F2"
            || /^[mflMFL]$/.test(e.key);
        if (isNav && !e.ctrlKey && !e.metaKey) return;
    }

    // Ctrl+Z — Undo
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault(); undoLast(); return;
    }

    // Ctrl+Shift+N — 새 폴더
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "n") {
        if (!currentProject) return;
        e.preventDefault();
        const sel = getSelectedPaths();
        let parent = currentDir || "";
        if (sel.length === 1) {
            const node = findNodeByPath(rootTree, sel[0]);
            if (node && node.type === "dir") parent = sel[0];
        }
        createDefaultFolderInside(currentProject, parent);
        return;
    }

    // Ctrl+A — 그리드 전체 선택
    if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        const cards = previewContent.querySelectorAll(".card");
        if (cards.length > 0) {
            e.preventDefault();
            cards.forEach((c) => c.classList.add("selected"));
            setLastSelectedCard(cards[cards.length - 1]);
            syncTreeSelection();
            refreshDraggable();
            markSelectedCardsSeen();
        }
        return;
    }

    if (!currentProject) return;

    // Tab — 영역 전환 (좌↔우)
    if (e.key === "Tab") {
        e.preventDefault();
        cycleFocusArea(e.shiftKey);
        return;
    }

    // Alt+↑ — 부모 폴더
    if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        goToParentFolder();
        return;
    }

    // Home/End — 영역별 첫/마지막
    if (e.key === "Home" || e.key === "End") {
        const which = e.key === "Home" ? "home" : "end";
        const area = currentArea();
        if (area === "grid") { e.preventDefault(); moveGridToEnd(which); return; }
        if (area === "tree") { e.preventDefault(); moveTreeToEnd(which); return; }
        // favorites / queue 의 home/end 는 ↑↓ 와 동일 방향으로 한 번 끝까지.
        // 정확한 Home/End 는 추후 — 지금은 위/아래 navigation 으로 fallback.
        return;
    }

    // 방향키 — 영역별 dispatch
    if (e.key === "ArrowUp" || e.key === "ArrowDown"
        || e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        dispatchArrow(e.key, e.shiftKey);
        return;
    }

    // Backspace — 부모 폴더 (currentDir 변경)
    if (e.key === "Backspace") {
        if (!currentDir) return;
        e.preventDefault();
        goToParentFolder();
        return;
    }

    const sel = getSelectedPaths();

    // F2 — 이름 변경
    if (e.key === "F2") {
        let target = null;
        if (sel.length === 1) target = sel[0];
        else {
            const activeLabel = document.querySelector(".tree .active[data-path]");
            if (activeLabel) target = activeLabel.dataset.path;
        }
        if (target) {
            e.preventDefault();
            if (!startInlineRenameForPath(currentProject, target)) {
                renameFilePrompt(currentProject, target);
            }
            return;
        }
    }

    // Delete — 영역별 다중 삭제
    if (e.key === "Delete") {
        if (currentArea() === "queue") {
            e.preventDefault();
            deleteSelectedQueueItems();
            return;
        }
        if (sel.length > 0) {
            e.preventDefault();
            deleteFilesConfirm(currentProject, sel);
            return;
        }
    }

    // Enter — 영역별 활성/열기
    if (e.key === "Enter") {
        if (currentArea() === "queue") {
            if (activateSelectedQueueItem()) { e.preventDefault(); return; }
        }
        if (sel.length === 1) {
            e.preventDefault();
            openPath(currentProject, sel[0]);
            return;
        }
        // 트리 active 라벨이 있으면 그것 click (폴더 진입 / 파일 열기)
        const active = document.querySelector(".tree .active[data-path]");
        if (active && active.offsetParent && currentArea() === "tree") {
            e.preventDefault();
            active.click();
            return;
        }
    }

    // R/G/B — 그리드 선택 카드에 컬러 마커. 같은 색 다시 누르면 해제.
    // 첫 글자 점프보다 먼저 처리 (그리드에서 r/g/b 가 색 마커 우선).
    if (currentArea() === "grid" && isPrintableKey(e) && sel.length > 0) {
        const k = e.key.toLowerCase();
        const colorMap = { r: "red", g: "green", b: "blue" };
        if (colorMap[k]) {
            e.preventDefault();
            applyColorToSelection(sel, colorMap[k]);
            return;
        }
    }

    // 첫 글자 점프 (a-z, 0-9 등 한 글자) — 트리/그리드만 의미.
    if (isPrintableKey(e)) {
        const area = currentArea();
        if (area === "tree" || area === "grid") {
            const buf = appendTypeBuffer(e.key);
            if (jumpByPrefix(area, buf)) e.preventDefault();
        }
    }
});

/** 선택된 그리드 카드들에 컬러 마커 적용. 모두 같은 색이면 해제. */
async function applyColorToSelection(paths, color) {
    if (!currentProject || paths.length === 0) return;
    const allSame = paths.every((p) => cardColors[p] === color);
    const newColor = allSame ? null : color;
    try {
        const res = await apiSetColors(currentProject, paths, newColor);
        if (res?.colors) {
            setColors(res.colors);
            // 현재 카드들에 즉시 클래스 반영 — refreshCurrentGrid 호출은 spotlight 필터 시
            // 사라질 수 있어서 in-place 클래스 토글이 더 안전. selection 도 보존.
            const set = new Set(paths);
            previewContent.querySelectorAll(".card").forEach((c) => {
                if (!set.has(c.dataset.path)) return;
                c.classList.remove("color-red", "color-green", "color-blue");
                if (newColor) c.classList.add("color-" + newColor);
            });
        }
    } catch (err) {
        console.error("[colors] apply failed:", err);
    }
}

/** 방향키 dispatch — 영역별 분기. 영역 간 점프는 안 함 (Tab 으로만). */
function dispatchArrow(key, shift) {
    const area = currentArea();
    if (area === "grid") return moveGridFocus(key, shift);
    if (area === "queue") {
        if (key === "ArrowUp") return moveQueueFocus(-1, shift);
        if (key === "ArrowDown") return moveQueueFocus(1, shift);
        return;  // ←/→ 무동작 (큐는 세로 단일 컬럼)
    }
    if (area === "favorites") {
        if (key === "ArrowUp") return moveFavoritesFocus(-1, shift);
        if (key === "ArrowDown") return moveFavoritesFocus(1, shift);
        return;  // ←/→ 무동작
    }
    // tree
    if (key === "ArrowUp") return moveTreeFocus(-1, shift);
    if (key === "ArrowDown") return moveTreeFocus(1, shift);
    if (key === "ArrowLeft") return treeLeft();
    if (key === "ArrowRight") return treeRight();
}
