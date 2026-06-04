// =====================================================================
// 보기 탭의 미디어 picker 모달.
//
// 트랙에 슬롯/레이어를 추가하기 위한 폴더 트리 + 카드 그리드 UI.
// 자기완결적 모달 — viewer-tab.js 와는 initPicker() 콜백으로만 결합.
//
// 의존성 방향:
//   viewer-tab.js  →  viewer-picker.js  (단방향)
//
// 키보드 Esc, 외부 클릭, 정렬/필터, 드래그 시작은 모두 이 파일 안에서 처리.
// =====================================================================
import {
    viewerPicker, viewerPickerTree, viewerPickerGrid, viewerPickerClose,
    viewerPickerBc, viewerPickerAdded,
    viewerPickerSort, viewerPickerSortDir, viewerPickerKind, viewerPickerColor,
    viewerAddBtn,
} from "./dom.js";
import { currentProject, rootTree, colors } from "./state.js";
import { escapeHtml, kindFromPath, findNodeByPath } from "./utils.js";
import { showWarn } from "./info-toast.js";

const PICKER_SORT_KEY = "viewer.pickerSort";
const PICKER_SORT_DIR_KEY = "viewer.pickerSortDir";

// === 내부 상태 ===
let _pickerDir = "";
let _pickerKind = "";
let _pickerColor = "";
let _pickerSort = (() => { try { return localStorage.getItem(PICKER_SORT_KEY) || "name"; } catch { return "name"; } })();
let _pickerSortDir = (() => { try { return localStorage.getItem(PICKER_SORT_DIR_KEY) || "asc"; } catch { return "asc"; } })();

// === viewer-tab 으로부터 주입받는 콜백 ===
//  addPath(path) -> boolean  : 트랙에 path 추가, 성공 여부 반환
//  getCounts()   -> { slots, layers } : 현재 트랙의 슬롯/레이어 카운트
let _addPath = null;
let _getCounts = null;

function _collectMediaUnder(node, out = []) {
    if (!node) return out;
    if (node.type === "dir" || node.children) {
        (node.children || []).forEach((c) => _collectMediaUnder(c, out));
    } else {
        const k = node.kind || kindFromPath(node.path || "");
        if (k === "image" || k === "video") out.push(node);
    }
    return out;
}

function _sortMedia(items) {
    const mul = _pickerSortDir === "desc" ? -1 : 1;
    const getName = (x) => (x.name || (x.path || "").split("/").pop() || "").toLowerCase();
    const getMtime = (x) => x.mtime || 0;
    return [...items].sort((a, b) => {
        let cmp = 0;
        switch (_pickerSort) {
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
            case "name":
            default:
                cmp = getName(a).localeCompare(getName(b), undefined, { numeric: true });
        }
        return cmp * mul;
    });
}

export function openPicker() {
    if (!viewerPicker) return;
    if (!currentProject || !rootTree) {
        showWarn("프로젝트를 먼저 선택하세요");
        return;
    }
    _pickerDir = "";
    viewerPicker.classList.remove("hidden");
    if (viewerPickerAdded) viewerPickerAdded.textContent = "";
    _syncPickerToolbar();
    _renderPickerTree();
    _renderPickerGrid();
}

export function closePicker() {
    if (!viewerPicker) return;
    viewerPicker.classList.add("hidden");
}

export function isPickerOpen() {
    return !!(viewerPicker && !viewerPicker.classList.contains("hidden"));
}

function _syncPickerToolbar() {
    if (viewerPickerSort) viewerPickerSort.value = _pickerSort;
    if (viewerPickerSortDir) viewerPickerSortDir.textContent = _pickerSortDir === "asc" ? "↑" : "↓";
    if (viewerPickerKind) viewerPickerKind.value = _pickerKind;
    if (viewerPickerColor) {
        viewerPickerColor.querySelectorAll(".vp-color-btn").forEach((b) => {
            b.classList.toggle("active", (b.dataset.color || "") === _pickerColor);
        });
    }
}

function _renderPickerTree() {
    if (!viewerPickerTree || !rootTree) return;
    viewerPickerTree.innerHTML = "";
    const rootLi = document.createElement("li");
    rootLi.className = "vp-tree-item" + (_pickerDir === "" ? " active" : "");
    rootLi.style.paddingLeft = "8px";
    rootLi.textContent = "🏠 (전체)";
    rootLi.addEventListener("click", () => {
        _pickerDir = "";
        _renderPickerTree();
        _renderPickerGrid();
    });
    viewerPickerTree.appendChild(rootLi);
    function walk(node, depth) {
        const dirs = (node.children || []).filter((c) => c.type === "dir");
        dirs.forEach((c) => {
            const li = document.createElement("li");
            li.className = "vp-tree-item" + (_pickerDir === c.path ? " active" : "");
            li.style.paddingLeft = (8 + depth * 12) + "px";
            li.textContent = "📁 " + c.name;
            li.addEventListener("click", () => {
                _pickerDir = c.path || "";
                _renderPickerTree();
                _renderPickerGrid();
            });
            viewerPickerTree.appendChild(li);
            walk(c, depth + 1);
        });
    }
    walk(rootTree, 0);
}

function _renderPickerGrid() {
    if (!viewerPickerGrid) return;
    const scope = _pickerDir ? findNodeByPath(rootTree, _pickerDir) : rootTree;
    if (!scope) { viewerPickerGrid.innerHTML = `<div class="vp-empty">폴더를 찾을 수 없습니다</div>`; return; }
    if (viewerPickerBc) {
        const segs = (scope.path || "").split("/").filter(Boolean);
        const trail = ["🏠"].concat(segs).join(" › ");
        viewerPickerBc.textContent = trail + (_pickerKind || _pickerColor ? " · 필터 활성" : "");
    }
    let items = _collectMediaUnder(scope);
    if (_pickerKind) items = items.filter((it) => (it.kind || kindFromPath(it.path)) === _pickerKind);
    if (_pickerColor) items = items.filter((it) => colors[it.path] === _pickerColor);
    items = _sortMedia(items);
    if (items.length === 0) {
        viewerPickerGrid.innerHTML = `<div class="vp-empty">해당 조건의 미디어 없음</div>`;
        return;
    }
    viewerPickerGrid.innerHTML = "";
    items.forEach((node) => viewerPickerGrid.appendChild(_renderPickerCard(node)));
}

function _renderPickerCard(node) {
    const el = document.createElement("div");
    const color = colors[node.path];
    el.className = "vp-card vp-card-file" + (color ? " vp-color-" + color : "");
    el.draggable = true;
    el.dataset.path = node.path;
    const url = `/media?project=${encodeURIComponent(currentProject)}&path=${encodeURIComponent(node.path)}`;
    const thumb = node.kind === "video"
        ? `<video class="vp-thumb" src="${url}" preload="metadata" muted></video>`
        : `<img class="vp-thumb" src="${url}" alt="" loading="lazy" />`;
    const badge = node.kind === "video" ? "▶" : "🖼";
    el.innerHTML = `
        ${thumb}
        <span class="vp-badge">${badge}</span>
        <div class="vp-name" title="${escapeHtml(node.path)}">${escapeHtml(node.name)}</div>
    `;
    el.addEventListener("click", () => {
        const ok = _addPath ? _addPath(node.path) : false;
        if (ok) {
            el.classList.add("vp-added-flash");
            setTimeout(() => el.classList.remove("vp-added-flash"), 400);
            if (viewerPickerAdded && _getCounts) {
                const { slots, layers } = _getCounts();
                viewerPickerAdded.textContent = `${slots}개 슬롯 / 총 ${layers}개 레이어`;
            }
        }
    });
    el.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/x-tree-path", node.path);
        e.dataTransfer.setData("text/x-tree-paths", node.path);
        e.dataTransfer.effectAllowed = "copy";
        el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
    return el;
}

// viewer-tab.js 에서 1회 호출. 콜백 주입 + 모든 picker 관련 이벤트 바인딩.
export function initPicker({ addPath, getCounts } = {}) {
    _addPath = addPath || null;
    _getCounts = getCounts || null;

    viewerAddBtn?.addEventListener("click", openPicker);
    viewerPickerClose?.addEventListener("click", closePicker);
    viewerPicker?.addEventListener("click", (e) => { if (e.target === viewerPicker) closePicker(); });

    viewerPickerSort?.addEventListener("change", (e) => {
        _pickerSort = e.target.value;
        try { localStorage.setItem(PICKER_SORT_KEY, _pickerSort); } catch {}
        _renderPickerGrid();
    });
    viewerPickerSortDir?.addEventListener("click", () => {
        _pickerSortDir = _pickerSortDir === "asc" ? "desc" : "asc";
        try { localStorage.setItem(PICKER_SORT_DIR_KEY, _pickerSortDir); } catch {}
        _syncPickerToolbar();
        _renderPickerGrid();
    });
    viewerPickerKind?.addEventListener("change", (e) => {
        _pickerKind = e.target.value || "";
        _renderPickerGrid();
    });
    viewerPickerColor?.addEventListener("click", (e) => {
        const btn = e.target.closest(".vp-color-btn");
        if (!btn) return;
        const want = btn.dataset.color || "";
        _pickerColor = (_pickerColor === want) ? "" : want;
        _syncPickerToolbar();
        _renderPickerGrid();
    });
}
