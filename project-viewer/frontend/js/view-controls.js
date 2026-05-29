// =====================================================================
// 뷰 컨트롤 — 카드/리스트 토글, 카드 크기 슬라이더, 정렬 (이름/종류/크기/수정일)
// 모두 localStorage 에 영구 저장. UI 이벤트는 모듈 로드 시 자동 등록.
//
// 다른 모듈에서 정렬/뷰 변경 후 현재 그리드를 다시 그리기 위해
// setRefreshGridCallback() 으로 callback 을 등록한다 (app.js 가 호출).
// =====================================================================
import {
    currentView, setCurrentView,
    currentSortKey, setCurrentSortKey,
    currentSortDir, setCurrentSortDir,
} from "./state.js";
import {
    viewBtns, cardSizeSlider, cardSizeValueEl,
    sortSelect, sortDirBtn, previewContent,
} from "./dom.js";

const VIEW_KEY = "viewer.view";
const SIZE_KEY = "viewer.cardSize";
const SORT_KEY = "viewer.sortKey";
const SORT_DIR_KEY = "viewer.sortDir";

let _refreshGrid = () => {};

/** 현재 활성 그리드를 다시 그리기 위한 callback 등록 (app.js 가 호출). */
export function setRefreshGridCallback(fn) {
    _refreshGrid = typeof fn === "function" ? fn : () => {};
}

// --- 카드/리스트 뷰 ---
export function applyView(view) {
    setCurrentView((view === "list") ? "list" : "grid");
    viewBtns.forEach((b) => b.classList.toggle("active", b.dataset.view === currentView));
    previewContent.querySelectorAll(".grid").forEach((g) =>
        g.classList.toggle("list-view", currentView === "list")
    );
    try { localStorage.setItem(VIEW_KEY, currentView); } catch {}
}

// --- 카드 크기 ---
export function applyCardSize(px) {
    const n = Math.max(80, Math.min(400, parseInt(px) || 160));
    document.documentElement.style.setProperty("--card-size", n + "px");
    if (cardSizeValueEl) cardSizeValueEl.textContent = String(n);
    try { localStorage.setItem(SIZE_KEY, String(n)); } catch {}
}

// --- 정렬 ---
/** 트리 노드 / favorite 양쪽 모두에 적용 가능한 정렬. 폴더는 항상 위로. */
export function sortItems(items) {
    if (!Array.isArray(items)) return items;
    const mul = currentSortDir === "desc" ? -1 : 1;
    const getName = (x) => (x.name || (x.path || "").split("/").pop() || "").toLowerCase();
    const getMtime = (x) => x.mtime || (x.addedAt ? x.addedAt / 1000 : 0);
    const firstTag = (x) => ((x.tags && x.tags[0]) || "").toLowerCase();
    return [...items].sort((a, b) => {
        const aDir = a.type === "dir", bDir = b.type === "dir";
        if (aDir && !bDir) return -1;
        if (!aDir && bDir) return 1;
        let cmp = 0;
        switch (currentSortKey) {
            case "kind":
                cmp = (a.kind || "").localeCompare(b.kind || "");
                if (cmp === 0) cmp = getName(a).localeCompare(getName(b), undefined, { numeric: true });
                break;
            case "size":
                cmp = (a.size || 0) - (b.size || 0);
                break;
            case "mtime":
                cmp = getMtime(a) - getMtime(b);
                break;
            case "addedAt":
                cmp = (a.addedAt || 0) - (b.addedAt || 0);
                if (cmp === 0) cmp = getName(a).localeCompare(getName(b), undefined, { numeric: true });
                break;
            case "tag": {
                const at = firstTag(a), bt = firstTag(b);
                // 태그 없는 항목은 뒤로
                if (!at && bt) cmp = 1;
                else if (at && !bt) cmp = -1;
                else cmp = at.localeCompare(bt);
                if (cmp === 0) cmp = getName(a).localeCompare(getName(b), undefined, { numeric: true });
                break;
            }
            case "name":
            default:
                cmp = getName(a).localeCompare(getName(b), undefined, { numeric: true });
        }
        return cmp * mul;
    });
}

function _refreshSortUI() {
    if (sortSelect) sortSelect.value = currentSortKey;
    if (sortDirBtn) {
        sortDirBtn.textContent = currentSortDir === "asc" ? "↑" : "↓";
        sortDirBtn.title = currentSortDir === "asc"
            ? "오름차순 — 클릭하면 내림차순"
            : "내림차순 — 클릭하면 오름차순";
    }
}

export function applySort(key, dir) {
    if (key) setCurrentSortKey(key);
    if (dir) setCurrentSortDir(dir);
    _refreshSortUI();
    try {
        localStorage.setItem(SORT_KEY, currentSortKey);
        localStorage.setItem(SORT_DIR_KEY, currentSortDir);
    } catch {}
    _refreshGrid();
}

// --- UI 이벤트 자동 등록 ---
if (viewBtns.length) {
    viewBtns.forEach((btn) => {
        btn.addEventListener("click", () => applyView(btn.dataset.view));
    });
}
if (cardSizeSlider) {
    cardSizeSlider.addEventListener("input", () => applyCardSize(cardSizeSlider.value));
}
if (sortSelect) {
    sortSelect.addEventListener("change", () => applySort(sortSelect.value, null));
}
if (sortDirBtn) {
    sortDirBtn.addEventListener("click", () => applySort(null, currentSortDir === "asc" ? "desc" : "asc"));
}

// --- 시작 시 localStorage 복원 ---
try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "grid" || v === "list") {
        setCurrentView(v);
        viewBtns.forEach((b) => b.classList.toggle("active", b.dataset.view === currentView));
    }
    const s = parseInt(localStorage.getItem(SIZE_KEY)) || 160;
    if (cardSizeSlider) cardSizeSlider.value = String(s);
    applyCardSize(s);

    const sk = localStorage.getItem(SORT_KEY);
    if (["name", "kind", "size", "mtime", "addedAt", "tag"].includes(sk)) setCurrentSortKey(sk);
    const sd = localStorage.getItem(SORT_DIR_KEY);
    if (sd === "asc" || sd === "desc") setCurrentSortDir(sd);
    _refreshSortUI();
} catch {}
