// =====================================================================
// 보기 탭 — 이미지/영상을 순서대로 이어 재생하는 시퀀스 플레이어
//
// 데이터 모델:
//   _track : Slot[]
//   Slot   : { id, layers: Layer[], primaryIdx }  — 하나의 시간 슬롯, 여러 레이어를 쌓을 수 있음
//   Layer  : { id, project, path, kind, duration }
//   재생/타임라인은 항상 primary layer 기준.
//
// 드롭 영역 (트랙 아이템 위):
//   상단 25%  = 슬롯 앞에 새 슬롯 삽입
//   하단 25%  = 슬롯 뒤에 새 슬롯 삽입
//   중앙 50%  = 이 슬롯의 layer 로 추가 (스택)
//
// 우클릭 → context menu:
//   레이어 목록 (현재 대표 ✓) → 다른 레이어 클릭 = 그 레이어를 대표로 설정
//   레이어 제거 / 슬롯 제거
//
// 영상 끊김 제거: 두 개의 <video> 슬롯을 번갈아 활성화하고 다음 클립을 미리 로드.
// 프로젝트별 트랙은 localStorage 영구 저장.
// =====================================================================
import {
    viewerTrackList, viewerClearBtn, viewerTrackTotal,
    viewerStage, viewerScreen, viewerScreenEmpty,
    viewerV0, viewerV1, viewerImg,
    viewerPlayBtn, viewerPrevBtn, viewerNextBtn,
    viewerTimeCur, viewerTimeTotal, viewerClipLabel,
    viewerTimeline, viewerScrubbar, viewerScrubbarFill, viewerScrubbarHead,
    viewerLoopBtn, viewerVolBtn, viewerVolSlider, viewerFsBtn,
    previewContent,
} from "./dom.js";
import {
    currentProject, rootTree, activeTab,
    getViewerTrackForProject, setViewerTrackForProject,
    setCurrentDir,
    colors,
} from "./state.js";
import { escapeHtml, kindFromPath, findNodeByPath, generateId, cssQueryEscape } from "./utils.js";
import { showInfo, showWarn } from "./info-toast.js";
import { openLightbox } from "./lightbox.js";
import { openCommentsModal, hasComments, unseenCommentCount, commentCount } from "./comments.js";
import { showFolderGrid, setTrackMapProvider } from "./grid.js";
import { pushUndo } from "./undo.js";
import { initPicker, isPickerOpen, closePicker } from "./viewer-picker.js";
import "./viewer-split.js";  // side-effect: split-resize 이벤트 + MutationObserver 자동 등록

// 보기 탭의 상단 그리드 내에서 파일 위치 열기 — 구성 탭으로 전환하지 않고 그 자리에서 이동.
// 부모 폴더를 그리드에 그리고 그 파일 카드를 selected + scrollIntoView.
function _locateInViewerGrid(path) {
    if (!path || !currentProject || !rootTree) return;
    const parentPath = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
    const parentNode = parentPath ? findNodeByPath(rootTree, parentPath) : rootTree;
    if (!parentNode) return;
    setCurrentDir(parentPath);
    showFolderGrid(currentProject, parentNode);
    // 렌더 직후엔 DOM 갱신 시간 필요 — 다음 tick 에 카드 찾기
    setTimeout(() => {
        if (!previewContent) return;
        const card = previewContent.querySelector(`.card[data-path="${cssQueryEscape(path)}"]`);
        if (!card) return;
        previewContent.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
        card.classList.add("selected");
        card.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
}

const IMAGE_DEFAULT_SEC = 4;

// === 내부 상태 ===
let _track = [];                 // Slot[]
let _playing = false;
let _curIdx = -1;                // 재생 중인 슬롯 (active)
let _imgTimer = null;
let _tickTimer = null;
let _clipStartedAt = 0;

// 다중 선택 (탐색기 패턴) — Ctrl+Click 토글, Shift+Click 범위. Delete 로 일괄 제거.
// _curIdx (재생 위치) 와 별개. 재생은 그대로 두고 일괄 작업만 위해.
const _selectedSlots = new Set();
let _anchorIdx = -1;

function _clearSlotSelection() { _selectedSlots.clear(); _anchorIdx = -1; }
function _syncSlotSelectionDOM() {
    if (!viewerTrackList) return;
    viewerTrackList.querySelectorAll(".vt-item").forEach((el, k) => {
        el.classList.toggle("selected", _selectedSlots.has(k));
    });
}

const _vSlots = [
    { el: viewerV0, idx: -1 },
    { el: viewerV1, idx: -1 },
];
let _activeSlot = -1;

// === 모델 helpers ===

function _normalizeKind(k) { return k === "image" || k === "video" ? k : null; }

function _mkLayer(project, path) {
    const kind = _normalizeKind(kindFromPath(path));
    if (!kind) return null;
    return {
        id: generateId(),
        project,
        path,
        kind,
        duration: kind === "image" ? IMAGE_DEFAULT_SEC : null,
    };
}

function _mkSlot(layer) {
    return { id: generateId(), layers: [layer], primaryIdx: 0 };
}

function _primary(slot) {
    if (!slot || !slot.layers || slot.layers.length === 0) return null;
    return slot.layers[slot.primaryIdx] || slot.layers[0];
}

// 옛 포맷 (flat item) → 새 포맷 (slot with single layer) 마이그레이션.
function _migrateOnLoad(items) {
    if (!Array.isArray(items)) return [];
    return items.map((x) => {
        if (x && Array.isArray(x.layers)) {
            // 이미 새 포맷 — 안전화
            return {
                id: x.id || generateId(),
                layers: x.layers.filter(Boolean),
                primaryIdx: Math.max(0, Math.min(x.primaryIdx || 0, x.layers.length - 1)),
            };
        }
        // 옛 포맷 — flat layer
        const kind = _normalizeKind(x?.kind || kindFromPath(x?.path || ""));
        if (!kind || !x?.path) return null;
        const layer = {
            id: x.id || generateId(),
            project: x.project,
            path: x.path,
            kind,
            duration: typeof x.duration === "number" ? x.duration : (kind === "image" ? IMAGE_DEFAULT_SEC : null),
        };
        return { id: generateId(), layers: [layer], primaryIdx: 0 };
    }).filter(Boolean);
}

function _loadTrack() {
    const raw = currentProject ? getViewerTrackForProject(currentProject) : [];
    _track = _migrateOnLoad(raw);
    // 그리드 카드 배지 갱신 (프로젝트 전환 / 보기 탭 진입 시에도 발화)
    try { window.dispatchEvent(new CustomEvent("pv:viewer-track-changed")); } catch {}
}

function _saveTrack() {
    if (!currentProject) return;
    setViewerTrackForProject(currentProject, _track);
    // 그리드 카드의 트랙 배지 갱신 trigger
    try { window.dispatchEvent(new CustomEvent("pv:viewer-track-changed")); } catch {}
}

/** path → ["1", "2_1", ...] 위치 라벨 맵.
 *  - 단일 레이어 슬롯: "1", "2", ...
 *  - 여러 레이어 슬롯: "1_1" (primary), "1_2", ... — primary 가 항상 _1.
 *  - 같은 path 가 여러 위치에 있으면 모두 표시.
 */
function getTrackPositionMap() {
    const map = {};
    _track.forEach((slot, slotIdx) => {
        const sNum = slotIdx + 1;
        if (!slot.layers || slot.layers.length === 0) return;
        if (slot.layers.length === 1) {
            const path = slot.layers[0].path;
            (map[path] = map[path] || []).push(String(sNum));
            return;
        }
        const primaryIdx = slot.primaryIdx;
        // primary 먼저, 나머지는 본래 순서
        const order = [primaryIdx];
        slot.layers.forEach((_, li) => { if (li !== primaryIdx) order.push(li); });
        order.forEach((li, pos) => {
            const path = slot.layers[li].path;
            (map[path] = map[path] || []).push(`${sNum}_${pos + 1}`);
        });
    });
    return map;
}

function _layerMediaUrl(layer) {
    return `/media?project=${encodeURIComponent(layer.project)}&path=${encodeURIComponent(layer.path)}`;
}

function _layerName(layer) {
    const p = layer.path || "";
    const i = p.lastIndexOf("/");
    return i >= 0 ? p.substring(i + 1) : p;
}

function _layerDuration(layer) {
    if (!layer) return 0;
    if (layer.kind === "image") return IMAGE_DEFAULT_SEC;
    return typeof layer.duration === "number" && layer.duration > 0 ? layer.duration : 0;
}

function _slotDuration(slot) { return _layerDuration(_primary(slot)); }
function _totalDuration() { return _track.reduce((s, slot) => s + _slotDuration(slot), 0); }

function _fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const s = Math.round(sec);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
}

function _probeVideoDuration(layer) {
    if (layer.kind !== "video" || layer.duration) return;
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.src = _layerMediaUrl(layer);
    v.addEventListener("loadedmetadata", () => {
        const d = v.duration;
        if (isFinite(d) && d > 0) {
            layer.duration = d;
            _saveTrack();
            _renderAll();
        }
    }, { once: true });
    v.addEventListener("error", () => {
        layer.duration = 0;
        _renderAll();
    }, { once: true });
}

// === 사이드바 트랙 ===

function _renderSidebar() {
    if (!viewerTrackList) return;
    if (_track.length === 0) {
        viewerTrackList.innerHTML = `<li class="empty">+ 버튼을 눌러 항목 추가</li>`;
        if (viewerTrackTotal) viewerTrackTotal.textContent = `0:00 · 0개`;
        return;
    }
    viewerTrackList.innerHTML = "";
    _track.forEach((slot, i) => {
        const li = document.createElement("li");
        const layer = _primary(slot);
        // 다른 탭에서 입력한 RGB 컬러 마커 — colors[path] 가 "red"/"green"/"blue"
        const cardColor = colors[layer.path] || "";
        li.className = "vt-item"
            + (i === _curIdx ? " active" : "")
            + (_selectedSlots.has(i) ? " selected" : "")
            + (cardColor ? " vt-color-" + cardColor : "");
        li.dataset.idx = String(i);
        li.draggable = true;
        const layerCount = slot.layers.length;
        const thumb = layer.kind === "video"
            ? `<video class="vt-thumb" src="${_layerMediaUrl(layer)}" preload="metadata" muted></video>`
            : `<img class="vt-thumb" src="${_layerMediaUrl(layer)}" alt="" loading="lazy" />`;
        const durLabel = layer.kind === "video" && !layer.duration ? "…" : `${_fmtTime(_layerDuration(layer))}`;
        const stackBadge = layerCount > 1
            ? `<span class="vt-stack-badge" title="${layerCount}개 레이어 (우클릭 = 대표 선택)">📚 ${layerCount}</span>`
            : "";
        li.classList.add("vt-item-base");
        if (layerCount > 1) li.classList.add("vt-has-stack");
        li.innerHTML = `
            <span class="vt-index">${i + 1}</span>
            <span class="vt-thumb-wrap">
                ${thumb}
                <span class="vt-kind">${layer.kind === "video" ? "▶" : "🖼"}</span>
                ${stackBadge}
                <span class="vt-drop-plus">+</span>
            </span>
            <span class="vt-info">
                <span class="vt-name" title="${escapeHtml(layer.path)}">${escapeHtml(_layerName(layer))}</span>
                <span class="vt-dur">${durLabel}</span>
            </span>
            <button class="vt-remove" type="button" title="슬롯 제거">×</button>
        `;
        li.addEventListener("click", (e) => {
            if (e.target.closest(".vt-remove")) {
                // 다중 선택 중이면 선택된 모두 제거, 아니면 단일.
                if (_selectedSlots.has(i) && _selectedSlots.size > 1) {
                    _removeSlots(Array.from(_selectedSlots));
                } else {
                    _removeSlot(i);
                }
                e.stopPropagation();
                return;
            }
            if (e.target.closest(".vt-stack-badge")) {
                _openContextMenu(e.clientX, e.clientY, i);
                e.stopPropagation();
                return;
            }
            // 썸네일 클릭 = lightbox 로 크게 보기 (context menu 의 썸네일과 동일 동작)
            if (e.target.closest(".vt-thumb-wrap")) {
                e.stopPropagation();
                openLightbox(layer.project, {
                    project: layer.project,
                    path: layer.path,
                    name: _layerName(layer),
                    kind: layer.kind,
                });
                return;
            }
            // 탐색기 패턴 다중 선택:
            //   Ctrl/Cmd+Click → 토글 (anchor 갱신, 재생 위치 안 건드림)
            //   Shift+Click   → anchor~i 범위 (재생 위치 안 건드림)
            //   단순 Click    → 단일 선택 + seekTo (기존 동작)
            if (e.ctrlKey || e.metaKey) {
                if (_selectedSlots.has(i)) _selectedSlots.delete(i);
                else _selectedSlots.add(i);
                _anchorIdx = i;
                _syncSlotSelectionDOM();
                e.stopPropagation();
                return;
            }
            if (e.shiftKey && _anchorIdx >= 0) {
                _selectedSlots.clear();
                const lo = Math.min(_anchorIdx, i);
                const hi = Math.max(_anchorIdx, i);
                for (let k = lo; k <= hi; k++) _selectedSlots.add(k);
                _syncSlotSelectionDOM();
                e.stopPropagation();
                return;
            }
            // 단일 클릭 — 다중 선택 모두 해제 + 이 슬롯만 + 재생 위치 갱신
            _clearSlotSelection();
            _selectedSlots.add(i);
            _anchorIdx = i;
            _syncSlotSelectionDOM();
            _seekTo(i, false);
        });
        li.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            _openContextMenu(e.clientX, e.clientY, i);
        });
        // dragstart — 트랙 내 reorder 용 (text/x-vt-idx)
        li.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/x-vt-idx", String(i));
            e.dataTransfer.effectAllowed = "move";
            li.classList.add("dragging");
        });
        li.addEventListener("dragend", (e) => {
            li.classList.remove("dragging");
            _clearDropHints();
            // 트랙 밖으로 드래그 → 슬롯 제거
            if (e.dataTransfer.dropEffect === "none") {
                const rect = viewerTrackList.getBoundingClientRect();
                const inside = e.clientX >= rect.left && e.clientX <= rect.right
                            && e.clientY >= rect.top && e.clientY <= rect.bottom;
                if (!inside) {
                    _removeSlot(parseInt(li.dataset.idx, 10));
                    showInfo("트랙에서 제거", "info", 1500);
                }
            }
        });
        // dragover — zone 결정 (top/center/bottom)
        // stopPropagation 필수: upload.js 의 document-level dragover 가 dropEffect="none"
        // 으로 reset 하면 drop 자체가 cancel 됨.
        li.addEventListener("dragover", (e) => {
            const t = Array.from(e.dataTransfer?.types || []);
            const isInternal = t.includes("text/x-vt-idx");
            const isExternal = t.includes("text/x-tree-path") || t.includes("text/x-tree-paths");
            if (!isInternal && !isExternal) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = isInternal ? "move" : "copy";
            const zone = _zoneAt(li, e.clientY);
            _showDropHint(li, zone, isInternal);
        });
        li.addEventListener("dragleave", (e) => {
            if (!li.contains(e.relatedTarget)) _clearDropHints(li);
        });
        li.addEventListener("drop", (e) => {
            _clearDropHints();
            const t = Array.from(e.dataTransfer?.types || []);
            const isInternal = t.includes("text/x-vt-idx");
            const zone = _zoneAt(li, e.clientY);
            if (isInternal) {
                e.preventDefault();
                e.stopPropagation();
                const from = parseInt(e.dataTransfer.getData("text/x-vt-idx"), 10);
                let to = i + (zone === "bottom" ? 1 : 0);
                if (from < to) to -= 1;
                _moveSlot(from, to);
                return;
            }
            const paths = _extractTreePaths(e);
            if (paths.length === 0 || !currentProject) return;
            e.preventDefault();
            e.stopPropagation();
            if (zone === "center") {
                _addLayersToSlot(i, paths);
            } else {
                const insertAt = i + (zone === "bottom" ? 1 : 0);
                _insertSlotsAt(paths, insertAt);
            }
        });
        viewerTrackList.appendChild(li);
    });
    if (viewerTrackTotal) {
        viewerTrackTotal.textContent = `${_fmtTime(_totalDuration())} · ${_track.length}개`;
    }
}

function _zoneAt(li, clientY) {
    const r = li.getBoundingClientRect();
    const rel = (clientY - r.top) / r.height;
    if (rel < 0.28) return "top";
    if (rel > 0.72) return "bottom";
    return "center";
}

function _showDropHint(li, zone, isInternal) {
    _clearDropHints();
    if (zone === "center") {
        if (!isInternal) li.classList.add("vt-drop-center");
    } else if (zone === "top") {
        li.classList.add("vt-drop-top");
    } else {
        li.classList.add("vt-drop-bottom");
    }
}

function _clearDropHints(except) {
    viewerTrackList?.querySelectorAll(".vt-drop-top, .vt-drop-bottom, .vt-drop-center")
        .forEach((el) => {
            if (el === except) return;
            el.classList.remove("vt-drop-top", "vt-drop-bottom", "vt-drop-center");
        });
}

// === Context menu (우클릭) ===

let _ctxMenuEl = null;
let _ctxMenuSlotIdx = -1;

function _ensureCtxMenu() {
    if (_ctxMenuEl) return _ctxMenuEl;
    _ctxMenuEl = document.createElement("div");
    _ctxMenuEl.className = "vt-ctx-menu hidden";
    document.body.appendChild(_ctxMenuEl);
    document.addEventListener("click", (e) => {
        if (!_ctxMenuEl.contains(e.target)) _closeContextMenu();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !_ctxMenuEl.classList.contains("hidden")) _closeContextMenu();
    });
    return _ctxMenuEl;
}

function _openContextMenu(x, y, slotIdx) {
    const slot = _track[slotIdx];
    if (!slot) return;
    const menu = _ensureCtxMenu();
    _ctxMenuSlotIdx = slotIdx;
    const layers = slot.layers;
    const items = [];
    items.push(`<div class="vt-ctx-title">슬롯 ${slotIdx + 1} · 레이어 ${layers.length}개</div>`);
    layers.forEach((layer, li) => {
        const isPrimary = li === slot.primaryIdx;
        const url = _layerMediaUrl(layer);
        const thumb = layer.kind === "video"
            ? `<video class="vt-ctx-thumb" src="${url}" preload="metadata" muted></video>`
            : `<img class="vt-ctx-thumb" src="${url}" alt="" loading="lazy" />`;
        const dur = layer.kind === "video" && !layer.duration ? "…" : _fmtTime(_layerDuration(layer));
        // 코멘트 카운트 — 안 본 게 있으면 빨강 숫자, 다 본 상태면 회색 C, 없으면 회색 빈 💬
        const unseen = unseenCommentCount(layer.path);
        const total = commentCount(layer.path);
        let cmtLabel;
        if (unseen > 0) cmtLabel = `<span class="vt-ctx-cmt-n vt-ctx-cmt-unseen">${unseen}</span>`;
        else if (total > 0) cmtLabel = `<span class="vt-ctx-cmt-n vt-ctx-cmt-seen">${total}</span>`;
        else cmtLabel = "";
        items.push(`
            <div class="vt-ctx-layer${isPrimary ? " is-primary" : ""}" data-layer-idx="${li}">
                ${thumb}
                <span class="vt-ctx-layer-info">
                    <span class="vt-ctx-layer-name" title="${escapeHtml(layer.path)}">${escapeHtml(_layerName(layer))}</span>
                    <span class="vt-ctx-layer-dur">${dur}${isPrimary ? " · 대표" : ""}</span>
                </span>
                <div class="vt-ctx-layer-actions">
                    <button class="vt-ctx-locate" type="button" data-locate-layer="${li}" title="파일 위치로 이동 (보기 탭 상단 그리드)">📂</button>
                    <button class="vt-ctx-comments" type="button" data-comments-layer="${li}" title="코멘트 (/) ">💬${cmtLabel}</button>
                    ${isPrimary
                        ? `<span class="vt-ctx-primary-mark">★</span>`
                        : `<button class="vt-ctx-set-primary" type="button" data-set-primary="${li}" title="대표 영상으로">대표 영상</button>`}
                    ${layers.length > 1
                        ? `<button class="vt-ctx-remove-layer" type="button" data-remove-layer="${li}" title="이 레이어 제거">×</button>`
                        : ""}
                </div>
            </div>
        `);
    });
    items.push(`<div class="vt-ctx-sep"></div>`);
    items.push(`<button class="vt-ctx-action" type="button" data-action="remove-slot">슬롯 전체 제거</button>`);
    menu.innerHTML = items.join("");
    menu.classList.remove("hidden");
    // 위치 보정 (화면 밖 안 가게)
    const rect = { w: 320, h: menu.offsetHeight || 200 };
    const left = Math.min(x, window.innerWidth - rect.w - 8);
    const top = Math.min(y, window.innerHeight - rect.h - 8);
    menu.style.left = left + "px";
    menu.style.top = top + "px";

    menu.querySelectorAll(".vt-ctx-comments").forEach((b) => {
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            const li = parseInt(b.dataset.commentsLayer, 10);
            const layer = slot.layers[li];
            if (!layer) return;
            _closeContextMenu();
            openCommentsModal(layer.path);
        });
    });
    menu.querySelectorAll(".vt-ctx-locate").forEach((b) => {
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            const li = parseInt(b.dataset.locateLayer, 10);
            const layer = slot.layers[li];
            if (!layer) return;
            _closeContextMenu();
            _locateInViewerGrid(layer.path);
        });
    });
    menu.querySelectorAll(".vt-ctx-set-primary").forEach((b) => {
        b.addEventListener("click", () => {
            const li = parseInt(b.dataset.setPrimary, 10);
            _setPrimary(slotIdx, li);
            _closeContextMenu();
        });
    });
    menu.querySelectorAll(".vt-ctx-remove-layer").forEach((b) => {
        b.addEventListener("click", () => {
            const li = parseInt(b.dataset.removeLayer, 10);
            _removeLayer(slotIdx, li);
            _closeContextMenu();
        });
    });
    menu.querySelector('[data-action="remove-slot"]')?.addEventListener("click", () => {
        _removeSlot(slotIdx);
        _closeContextMenu();
    });
    menu.querySelectorAll(".vt-ctx-layer").forEach((row) => {
        const li = parseInt(row.dataset.layerIdx, 10);
        // 더블클릭 = 대표 영상으로 설정 (단축키)
        row.addEventListener("dblclick", () => {
            _setPrimary(slotIdx, li);
            _closeContextMenu();
        });
        // 썸네일 클릭 = lightbox 로 미리보기 (어떤 컨텐츠인지 확인)
        const thumb = row.querySelector(".vt-ctx-thumb");
        if (thumb) {
            thumb.style.cursor = "zoom-in";
            thumb.title = "클릭 = 크게 보기";
            thumb.addEventListener("click", (e) => {
                e.stopPropagation();
                const layer = slot.layers[li];
                if (!layer) return;
                openLightbox(layer.project, {
                    project: layer.project,
                    path: layer.path,
                    name: _layerName(layer),
                    kind: layer.kind,
                });
            });
        }
    });
}

function _closeContextMenu() {
    if (_ctxMenuEl) _ctxMenuEl.classList.add("hidden");
    _ctxMenuSlotIdx = -1;
}

function _setPrimary(slotIdx, layerIdx) {
    const slot = _track[slotIdx];
    if (!slot) return;
    if (layerIdx < 0 || layerIdx >= slot.layers.length) return;
    const slotId = slot.id;
    const prevPrimary = slot.primaryIdx;
    if (prevPrimary === layerIdx) return;
    slot.primaryIdx = layerIdx;
    _saveTrack();
    _vSlots.forEach((s) => { if (s.idx === slotIdx) s.idx = -1; });
    if (_curIdx === slotIdx) _renderClip(slotIdx, _playing);
    _renderAll();
    pushUndo(`대표 영상 변경`, () => {
        const s = _track.find((x) => x.id === slotId);
        if (!s) return;
        s.primaryIdx = prevPrimary;
        _vSlots.forEach((vs) => { if (vs.idx === slotIdx) vs.idx = -1; });
        _saveTrack();
        _renderAll();
    });
}

// === 우측 stage ===

function _renderStage() {
    if (!viewerStage) return;
    _renderTimeline();
    _updatePlayButton();
    if (_track.length === 0) {
        _showEmpty(true);
        _hideAllMedia();
        viewerClipLabel.textContent = "";
        viewerTimeCur.textContent = "0:00";
        viewerTimeTotal.textContent = "0:00";
        _renderPlayhead(0);
        return;
    }
    _showEmpty(false);
    viewerTimeTotal.textContent = _fmtTime(_totalDuration());
    if (_curIdx === -1) {
        _renderClip(0, false);
    }
}

function _showEmpty(show) {
    if (viewerScreenEmpty) viewerScreenEmpty.style.display = show ? "" : "none";
}

function _hideAllMedia() {
    viewerImg?.classList.remove("active");
    viewerV0?.classList.remove("active");
    viewerV1?.classList.remove("active");
    if (viewerImg) viewerImg.removeAttribute("src");
}

function _renderTimeline() {
    if (!viewerTimeline) return;
    viewerTimeline.innerHTML = "";  // 셀 모두 제거 (playhead 는 더 이상 timeline 안에 없음)
    if (_track.length === 0) {
        _renderPlayhead(0);
        return;
    }
    _track.forEach((slot, i) => {
        const layer = _primary(slot);
        const cell = document.createElement("div");
        cell.className = "vtl-cell" + (i === _curIdx ? " active" : "");
        cell.dataset.idx = String(i);
        cell.draggable = true;   // scrub 는 별도 scrub bar 에서 — 셀은 reorder 전용
        cell.style.flex = `${Math.max(1, _slotDuration(slot))} 1 0`;
        cell.title = `${i + 1}. ${_layerName(layer)} (${_fmtTime(_slotDuration(slot))}) · 클릭=선택, 끌기=순서 변경`;
        const thumb = layer.kind === "video"
            ? `<video src="${_layerMediaUrl(layer)}" preload="metadata" muted></video>`
            : `<img src="${_layerMediaUrl(layer)}" alt="" loading="lazy" />`;
        const stackBadge = slot.layers.length > 1 ? `<span class="vtl-stack">📚${slot.layers.length}</span>` : "";
        cell.innerHTML = `${thumb}<span class="vtl-dur">${_fmtTime(_slotDuration(slot))}</span>${stackBadge}<span class="vtl-drop-plus">+</span>`;
        cell.addEventListener("click", (e) => {
            if (e.target.closest(".vtl-stack")) {
                e.stopPropagation();
                _openContextMenu(e.clientX, e.clientY, i);
                return;
            }
            // 클릭 = 그 슬롯으로 선택 (자동재생 X). 재생은 ▶ 재생 버튼만.
            _seekTo(i, false);
        });
        cell.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            _openContextMenu(e.clientX, e.clientY, i);
        });
        // 셀 자체 dragstart — reorder
        cell.addEventListener("dragstart", (e) => {
            _scrubbing = false;
            e.dataTransfer.setData("text/x-vt-idx", String(i));
            e.dataTransfer.effectAllowed = "move";
            cell.classList.add("vtl-dragging");
        });
        cell.addEventListener("dragend", (e) => {
            cell.classList.remove("vtl-dragging");
            _clearTimelineHints();
            if (e.dataTransfer.dropEffect === "none" && viewerTimeline) {
                const rect = viewerTimeline.getBoundingClientRect();
                const inside = e.clientX >= rect.left && e.clientX <= rect.right
                            && e.clientY >= rect.top && e.clientY <= rect.bottom;
                if (!inside) {
                    _removeSlot(parseInt(cell.dataset.idx, 10));
                    showInfo("트랙에서 제거", "info", 1500);
                }
            }
        });
        // 타임라인 셀에도 드롭존 적용 — 좌측/우측 = 삽입, 중앙 = 레이어 추가
        cell.addEventListener("dragover", (e) => {
            const t = Array.from(e.dataTransfer?.types || []);
            const isInternal = t.includes("text/x-vt-idx");
            const isExternal = t.includes("text/x-tree-path") || t.includes("text/x-tree-paths");
            if (!isInternal && !isExternal) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = isInternal ? "move" : "copy";
            const zone = _zoneXAt(cell, e.clientX);
            _clearTimelineHints();
            if (zone === "center" && !isInternal) cell.classList.add("vtl-drop-center");
            else if (zone === "left") cell.classList.add("vtl-drop-left");
            else cell.classList.add("vtl-drop-right");
        });
        cell.addEventListener("dragleave", (e) => {
            if (!cell.contains(e.relatedTarget)) cell.classList.remove("vtl-drop-left", "vtl-drop-right", "vtl-drop-center");
        });
        cell.addEventListener("drop", (e) => {
            const t = Array.from(e.dataTransfer?.types || []);
            const isInternal = t.includes("text/x-vt-idx");
            const zone = _zoneXAt(cell, e.clientX);
            _clearTimelineHints();
            if (isInternal) {
                e.preventDefault();
                e.stopPropagation();
                const from = parseInt(e.dataTransfer.getData("text/x-vt-idx"), 10);
                let to = i + (zone === "right" ? 1 : 0);
                if (from < to) to -= 1;
                _moveSlot(from, to);
                return;
            }
            const paths = _extractTreePaths(e);
            if (paths.length === 0 || !currentProject) return;
            e.preventDefault();
            e.stopPropagation();
            if (zone === "center") _addLayersToSlot(i, paths);
            else _insertSlotsAt(paths, i + (zone === "right" ? 1 : 0));
        });
        viewerTimeline.appendChild(cell);
    });
}

function _zoneXAt(cell, clientX) {
    const r = cell.getBoundingClientRect();
    const rel = (clientX - r.left) / r.width;
    if (rel < 0.28) return "left";
    if (rel > 0.72) return "right";
    return "center";
}

function _clearTimelineHints() {
    viewerTimeline?.querySelectorAll(".vtl-drop-left, .vtl-drop-right, .vtl-drop-center")
        .forEach((el) => el.classList.remove("vtl-drop-left", "vtl-drop-right", "vtl-drop-center"));
    viewerTimeline?.classList.remove("vtl-drop-end");
}

// 모든 viewer 영역의 drop hint / dragging 상태를 한꺼번에 정리.
// dragend 누락 / 브라우저 cancel / 외부 drop 등으로 잔상이 남을 때 안전망.
function _clearAllDropArtifacts() {
    _clearTimelineHints();
    _clearDropHints();
    viewerTrackList?.classList.remove("drop-target");
    viewerScreen?.classList.remove("vs-drop-target");
    viewerTimeline?.querySelectorAll(".vtl-dragging").forEach((el) => el.classList.remove("vtl-dragging"));
    viewerTrackList?.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
}
// 글로벌 dragend / mouseup — 어디서든 drag 종료 시 잔상 제거.
document.addEventListener("dragend", _clearAllDropArtifacts, true);
document.addEventListener("drop", _clearAllDropArtifacts, true);

// === Timeline click/drag → seek to any time position ===
// 타임라인 strip 의 X 위치를 전체 duration 의 비율로 보고 절대 시간으로 변환,
// 해당 클립과 클립 내 offset 으로 seek.
function _seekToAbsTime(absSec) {
    if (_track.length === 0) return;
    const total = _totalDuration();
    if (total <= 0) return;
    absSec = Math.max(0, Math.min(absSec, total - 0.01));
    let acc = 0;
    for (let i = 0; i < _track.length; i++) {
        const d = _slotDuration(_track[i]);
        if (absSec < acc + d) {
            const offset = absSec - acc;
            _seekInSlot(i, offset, _playing);
            return;
        }
        acc += d;
    }
    // 끝
    _seekInSlot(_track.length - 1, _slotDuration(_track[_track.length - 1]), _playing);
}

// 특정 슬롯의 offset 위치에서 재생/일시정지. autoplay 여부는 호출자가 결정.
// 같은 클립 내 scrub 인 경우 _renderClip 안 부르고 currentTime/timer 만 갱신 (flicker 회피).
function _seekInSlot(i, offset, autoplay) {
    if (i < 0 || i >= _track.length) return;
    const sameClip = (i === _curIdx);
    const layer = _primary(_track[i]);
    if (!layer) return;
    _playing = !!autoplay;
    if (!sameClip) {
        _renderClip(i, autoplay);
    }
    if (layer.kind === "image") {
        _clipStartedAt = performance.now() - offset * 1000;
        _clearImgTimer();
        if (autoplay) {
            const remaining = Math.max(0, IMAGE_DEFAULT_SEC - offset);
            _imgTimer = setTimeout(() => _onClipEnded(), remaining * 1000);
        }
        _renderProgress(offset);
    } else if (_activeSlot >= 0) {
        const v = _vSlots[_activeSlot].el;
        if (v) {
            const apply = () => {
                try { v.currentTime = offset; } catch {}
                if (autoplay && v.paused) v.play().catch(() => {});
                else if (!autoplay && !v.paused) v.pause();
                _renderProgress(offset);
            };
            if (v.readyState >= 1) apply();
            else v.addEventListener("loadedmetadata", apply, { once: true });
        }
    }
    _updatePlayButton();
}

// scrub bar X → 절대 시간 변환
function _scrubXToAbsSec(clientX) {
    if (!viewerScrubbar) return 0;
    const r = viewerScrubbar.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - r.left, r.width));
    return (x / Math.max(1, r.width)) * _totalDuration();
}

// scrub 상태 — scrub bar 에서만 발생 (timeline 셀과는 충돌 없음)
let _scrubbing = false;
if (viewerScrubbar) {
    // 명시적으로 draggable 비활성 + 텍스트 선택 차단 (브라우저 native drag-select 회피)
    viewerScrubbar.setAttribute("draggable", "false");
    viewerScrubbar.addEventListener("dragstart", (e) => e.preventDefault());
    viewerScrubbar.addEventListener("selectstart", (e) => e.preventDefault());
    viewerScrubbar.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (_track.length === 0) return;
        _scrubbing = true;
        _clearAllDropArtifacts();  // 이전 drag 잔상 청소
        _seekToAbsTime(_scrubXToAbsSec(e.clientX));
        e.preventDefault();
        e.stopPropagation();
    });
}
document.addEventListener("mousemove", (e) => {
    if (!_scrubbing) return;
    _seekToAbsTime(_scrubXToAbsSec(e.clientX));
});
document.addEventListener("mouseup", () => { _scrubbing = false; });

function _renderAll() {
    _renderSidebar();
    _renderStage();
    _refreshSlotCommentBadges();
}

// 트랙(사이드바) 아이템 + 타임라인 셀에 코멘트 배지 in-place 갱신.
// 재생 중인 영상 element 를 건드리지 않기 위해 _renderAll 대신 이 함수만 호출.
function _refreshSlotCommentBadges() {
    document.querySelectorAll(".vt-item[data-idx]").forEach((el) => {
        const idx = parseInt(el.dataset.idx, 10);
        const slot = _track[idx];
        if (!slot) return;
        const primary = _primary(slot);
        if (!primary) return;
        // 사이드바: 썸네일 wrap 안에 badge 위치
        _applySlotCommentBadge(el.querySelector(".vt-thumb-wrap"), primary.path);
    });
    document.querySelectorAll(".vtl-cell[data-idx]").forEach((el) => {
        const idx = parseInt(el.dataset.idx, 10);
        const slot = _track[idx];
        if (!slot) return;
        const primary = _primary(slot);
        if (!primary) return;
        _applySlotCommentBadge(el, primary.path);
    });
}

function _applySlotCommentBadge(container, path) {
    if (!container) return;
    let badge = container.querySelector(".slot-cmt-badge");
    if (!path || !hasComments(path)) {
        if (badge) badge.remove();
        return;
    }
    if (!badge) {
        badge = document.createElement("button");
        badge.className = "slot-cmt-badge";
        badge.type = "button";
        const p = path;
        badge.addEventListener("click", (e) => {
            e.stopPropagation();
            openCommentsModal(p);
        });
        badge.addEventListener("mousedown", (e) => e.stopPropagation());
        badge.addEventListener("dblclick", (e) => e.stopPropagation());
        container.appendChild(badge);
    }
    const total = commentCount(path);
    const unseen = unseenCommentCount(path);
    const hasNew = unseen > 0;
    badge.classList.toggle("ccb-unseen", hasNew);
    badge.classList.toggle("ccb-seen", !hasNew);
    badge.textContent = hasNew ? String(unseen) : "C";
    badge.title = hasNew
        ? `새 코멘트 ${unseen}개 (총 ${total}개) — 클릭`
        : `코멘트 ${total}개 — 클릭`;
}

// 코멘트 변경 시 배지만 in-place 갱신 (재생 끊김 X)
window.addEventListener("pv:comments-changed", _refreshSlotCommentBadges);

// === 재생 ===

function _clearImgTimer() { if (_imgTimer) { clearTimeout(_imgTimer); _imgTimer = null; } }
function _clearTickTimer() { if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; } }

function _setClipLabel(i) {
    const slot = _track[i];
    if (!slot) { viewerClipLabel.textContent = ""; return; }
    const layer = _primary(slot);
    const extra = slot.layers.length > 1 ? ` (📚${slot.layers.length})` : "";
    viewerClipLabel.textContent = `${i + 1}/${_track.length} · ${_layerName(layer)}${extra}`;
}

function _updatePlayButton() {
    if (!viewerPlayBtn) return;
    viewerPlayBtn.classList.toggle("playing", _playing);
    viewerPlayBtn.title = _playing ? "일시정지 (Space)" : "재생 (Space)";
}

function _markActive(i) {
    _curIdx = i;
    viewerTrackList?.querySelectorAll(".vt-item").forEach((el, k) => el.classList.toggle("active", k === i));
    viewerTimeline?.querySelectorAll(".vtl-cell").forEach((el, k) => el.classList.toggle("active", k === i));
    const el = viewerTrackList?.querySelector(`.vt-item[data-idx="${i}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    _setClipLabel(i);
}

function _loadIntoSlot(slotIdx, clipIdx) {
    const slot = _vSlots[slotIdx];
    if (!slot || !slot.el) return;
    if (slot.idx === clipIdx) return;
    if (clipIdx < 0 || clipIdx >= _track.length) {
        slot.idx = -1;
        slot.el.removeAttribute("src");
        return;
    }
    const layer = _primary(_track[clipIdx]);
    if (!layer || layer.kind !== "video") {
        slot.idx = -1;
        slot.el.removeAttribute("src");
        return;
    }
    slot.idx = clipIdx;
    slot.el.src = _layerMediaUrl(layer);
    slot.el.currentTime = 0;
    slot.el.load();
}

function _findSlotFor(clipIdx) {
    if (clipIdx < 0) return -1;
    if (_vSlots[0].idx === clipIdx) return 0;
    if (_vSlots[1].idx === clipIdx) return 1;
    return -1;
}

function _preloadNext(curIdx) {
    const nextIdx = curIdx + 1;
    if (nextIdx >= _track.length) return;
    const next = _primary(_track[nextIdx]);
    if (!next || next.kind !== "video") return;
    const otherSlot = _activeSlot === 0 ? 1 : 0;
    _loadIntoSlot(otherSlot, nextIdx);
}

function _renderClip(i, autoplay) {
    if (i < 0 || i >= _track.length) return;
    _clearImgTimer();
    _clearTickTimer();
    _markActive(i);
    _showEmpty(false);
    const layer = _primary(_track[i]);
    if (!layer) return;

    if (layer.kind === "image") {
        _activeSlot = -1;
        viewerV0?.pause();
        viewerV1?.pause();
        viewerV0?.classList.remove("active");
        viewerV1?.classList.remove("active");
        if (viewerImg) {
            viewerImg.src = _layerMediaUrl(layer);
            viewerImg.classList.add("active");
        }
        _clipStartedAt = performance.now();
        if (autoplay) {
            _imgTimer = setTimeout(() => _onClipEnded(), IMAGE_DEFAULT_SEC * 1000);
            _startTick();
        } else {
            _renderProgress(0);
        }
        _preloadNext(i);
        return;
    }

    viewerImg?.classList.remove("active");
    let slotIdx = _findSlotFor(i);
    if (slotIdx === -1) {
        slotIdx = (_activeSlot === 0 ? 1 : 0);
        if (slotIdx < 0) slotIdx = 0;
        _loadIntoSlot(slotIdx, i);
    }
    const otherSlotIdx = slotIdx === 0 ? 1 : 0;
    _activeSlot = slotIdx;
    const v = _vSlots[slotIdx].el;
    const vOther = _vSlots[otherSlotIdx].el;
    vOther?.pause();
    vOther?.classList.remove("active");
    v.classList.add("active");

    const onMeta = () => {
        const d = v.duration;
        if (isFinite(d) && d > 0 && layer.duration !== d) {
            layer.duration = d;
            _saveTrack();
            viewerTimeTotal.textContent = _fmtTime(_totalDuration());
            _renderTimeline();
            _renderSidebar();
        }
    };
    if (v.readyState >= 1) onMeta();
    else v.addEventListener("loadedmetadata", onMeta, { once: true });

    v.onended = () => _onClipEnded();
    v.onerror = () => _onClipEnded();

    v.currentTime = 0;
    _clipStartedAt = performance.now();
    if (autoplay) v.play().catch(() => {});
    _startTick();
    _preloadNext(i);
}

function _startTick() {
    _clearTickTimer();
    _tickTimer = setInterval(() => {
        if (_curIdx < 0) return;
        const slot = _track[_curIdx];
        if (!slot) return;
        const layer = _primary(slot);
        let clipElapsed = 0;
        if (layer && layer.kind === "image") {
            clipElapsed = Math.min((performance.now() - _clipStartedAt) / 1000, IMAGE_DEFAULT_SEC);
        } else if (_activeSlot >= 0) {
            const v = _vSlots[_activeSlot].el;
            clipElapsed = v?.currentTime || 0;
        }
        _renderProgress(clipElapsed);
    }, 80);
}

function _renderProgress(clipElapsedSec) {
    let acc = 0;
    for (let k = 0; k < _curIdx; k++) acc += _slotDuration(_track[k]);
    const total = _totalDuration();
    const absSec = acc + (clipElapsedSec || 0);
    viewerTimeCur.textContent = _fmtTime(absSec);
    _renderPlayhead(total > 0 ? absSec / total : 0);
}

function _renderPlayhead(ratio) {
    const r = Math.max(0, Math.min(1, ratio || 0));
    const pct = (r * 100).toFixed(3) + "%";
    if (viewerScrubbarFill) viewerScrubbarFill.style.width = pct;
    if (viewerScrubbarHead) viewerScrubbarHead.style.left = pct;
    if (viewerScrubbar) viewerScrubbar.style.opacity = _track.length > 0 ? "1" : "0.4";
}

function _onClipEnded() {
    if (_curIdx + 1 < _track.length) {
        _renderClip(_curIdx + 1, _playing);
    } else if (_loopMode && _track.length > 0) {
        // 반복 모드 — 처음 클립으로 되감기
        _renderClip(0, _playing);
    } else {
        _playing = false;
        _updatePlayButton();
        _renderProgress(_slotDuration(_track[_curIdx]));
        _clearTickTimer();
        if (_activeSlot >= 0) _vSlots[_activeSlot].el?.pause();
    }
}

// === 추가 컨트롤: loop / volume / fullscreen ===
const LOOP_KEY = "viewer.loop";
const VOL_KEY = "viewer.volume";
const MUTE_KEY = "viewer.muted";
let _loopMode = (() => { try { return localStorage.getItem(LOOP_KEY) === "1"; } catch { return false; } })();
let _volume = (() => {
    try {
        const v = parseFloat(localStorage.getItem(VOL_KEY));
        return isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
    } catch { return 1; }
})();
let _muted = (() => { try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; } })();

function _applyVolume() {
    const v = _muted ? 0 : _volume;
    if (viewerV0) { viewerV0.volume = v; viewerV0.muted = _muted; }
    if (viewerV1) { viewerV1.volume = v; viewerV1.muted = _muted; }
    if (viewerVolSlider) viewerVolSlider.value = String(Math.round(_volume * 100));
    if (viewerVolBtn) viewerVolBtn.textContent = _muted || _volume === 0 ? "🔇" : (_volume < 0.5 ? "🔉" : "🔊");
}
function _toggleMute() {
    _muted = !_muted;
    try { localStorage.setItem(MUTE_KEY, _muted ? "1" : "0"); } catch {}
    _applyVolume();
}
function _setVolume(v) {
    _volume = Math.max(0, Math.min(1, v));
    if (_volume > 0) _muted = false;
    try {
        localStorage.setItem(VOL_KEY, String(_volume));
        localStorage.setItem(MUTE_KEY, _muted ? "1" : "0");
    } catch {}
    _applyVolume();
}
function _toggleLoop() {
    _loopMode = !_loopMode;
    try { localStorage.setItem(LOOP_KEY, _loopMode ? "1" : "0"); } catch {}
    _updateLoopButton();
}
function _updateLoopButton() {
    if (!viewerLoopBtn) return;
    viewerLoopBtn.classList.toggle("vc-active", _loopMode);
    viewerLoopBtn.title = _loopMode ? "반복 재생 ON (끄기)" : "반복 재생 OFF (켜기)";
}
function _toggleFullscreen() {
    if (!document.fullscreenElement) {
        viewerStage?.requestFullscreen?.().catch(() => {});
    } else {
        document.exitFullscreen?.().catch(() => {});
    }
}

function play() {
    if (_track.length === 0) return;
    _playing = true;
    _updatePlayButton();
    if (_curIdx < 0 || _curIdx >= _track.length) {
        _renderClip(0, true);
        return;
    }
    const layer = _primary(_track[_curIdx]);
    if (!layer) return;
    if (layer.kind === "image") {
        _clipStartedAt = performance.now();
        _imgTimer = setTimeout(() => _onClipEnded(), IMAGE_DEFAULT_SEC * 1000);
        _startTick();
    } else if (_activeSlot >= 0) {
        const v = _vSlots[_activeSlot].el;
        if (v) v.play().catch(() => {});
        _startTick();
    }
}

function pause() {
    _playing = false;
    _updatePlayButton();
    _clearImgTimer();
    _clearTickTimer();
    if (_activeSlot >= 0) _vSlots[_activeSlot].el?.pause();
}

function togglePlay() { _playing ? pause() : play(); }

function _seekTo(i, autoplay) {
    if (i < 0 || i >= _track.length) return;
    _playing = !!autoplay;
    _renderClip(i, autoplay);
    _updatePlayButton();
}

function nextClip() { if (_curIdx + 1 < _track.length) _seekTo(_curIdx + 1, _playing); }
function prevClip() { if (_curIdx > 0) _seekTo(_curIdx - 1, _playing); }

// === 트랙 변경 ===

function _insertSlotsAt(paths, atIdx) {
    if (!currentProject) return 0;
    const inserted = [];
    for (const p of paths) {
        const layer = _mkLayer(currentProject, p);
        if (!layer) continue;
        const slot = _mkSlot(layer);
        _track.splice(atIdx + inserted.length, 0, slot);
        inserted.push({ slot, at: atIdx + inserted.length });
        if (layer.kind === "video") _probeVideoDuration(layer);
    }
    if (inserted.length > 0) {
        _saveTrack();
        _vSlots.forEach((s) => { if (s.idx >= atIdx) s.idx += inserted.length; });
        if (_curIdx >= atIdx) _curIdx += inserted.length;
        _renderAll();
        // undo: 끝에서부터 splice 로 제거
        const insertedIds = inserted.map((x) => x.slot.id);
        pushUndo(`트랙 ${inserted.length}개 추가`, () => {
            for (const id of insertedIds) {
                const idx = _track.findIndex((s) => s.id === id);
                if (idx >= 0) _track.splice(idx, 1);
            }
            _vSlots.forEach((s) => { s.idx = -1; });
            if (_curIdx >= _track.length) _curIdx = -1;
            _saveTrack();
            _renderAll();
        });
    }
    return inserted.length;
}

function _addLayersToSlot(slotIdx, paths) {
    const slot = _track[slotIdx];
    if (!slot) return 0;
    const slotId = slot.id;
    const added = [];
    for (const p of paths) {
        const layer = _mkLayer(currentProject, p);
        if (!layer) continue;
        slot.layers.push(layer);
        added.push(layer.id);
        if (layer.kind === "video") _probeVideoDuration(layer);
    }
    if (added.length > 0) {
        _saveTrack();
        showInfo(`레이어 ${added.length}개 추가 (총 ${slot.layers.length})`, "ok");
        _renderAll();
        pushUndo(`레이어 ${added.length}개 추가`, () => {
            const s = _track.find((x) => x.id === slotId);
            if (!s) return;
            s.layers = s.layers.filter((l) => !added.includes(l.id));
            if (s.primaryIdx >= s.layers.length) s.primaryIdx = Math.max(0, s.layers.length - 1);
            _vSlots.forEach((vs) => { vs.idx = -1; });
            _saveTrack();
            _renderAll();
        });
    }
    return added.length;
}

function _removeSlot(i) {
    if (i < 0 || i >= _track.length) return;
    const removedSlot = _track[i];
    const removedSnapshot = JSON.parse(JSON.stringify(removedSlot));
    _track.splice(i, 1);
    _saveTrack();
    if (_curIdx === i) {
        _curIdx = -1;
        pause();
        _hideAllMedia();
        _activeSlot = -1;
    } else if (_curIdx > i) {
        _curIdx -= 1;
    }
    _vSlots.forEach((s) => { if (s.idx === i) s.idx = -1; else if (s.idx > i) s.idx -= 1; });
    _renderAll();
    pushUndo(`슬롯 ${i + 1} 제거`, () => {
        const restoredAt = Math.min(i, _track.length);
        _track.splice(restoredAt, 0, removedSnapshot);
        _vSlots.forEach((s) => { s.idx = -1; });
        _saveTrack();
        _renderAll();
    });
}

// 다중 슬롯 제거 — 인덱스 배열을 큰 것부터 정렬해 splice 인덱스 안 어긋남.
// undo 한 번에 모두 복원.
function _removeSlots(indices) {
    const sorted = Array.from(new Set(indices)).filter((i) => i >= 0 && i < _track.length)
                                                .sort((a, b) => b - a);
    if (sorted.length === 0) return;
    if (sorted.length === 1) { _removeSlot(sorted[0]); return; }
    const snapshots = sorted.map((i) => ({ idx: i, slot: JSON.parse(JSON.stringify(_track[i])) }));
    for (const i of sorted) _track.splice(i, 1);
    // 재생 위치 조정
    if (sorted.includes(_curIdx)) {
        _curIdx = -1;
        pause();
        _hideAllMedia();
        _activeSlot = -1;
    } else if (_curIdx > 0) {
        const removedBefore = sorted.filter((i) => i < _curIdx).length;
        _curIdx -= removedBefore;
    }
    _vSlots.forEach((s) => { s.idx = -1; });
    _clearSlotSelection();
    _saveTrack();
    _renderAll();
    pushUndo(`슬롯 ${sorted.length}개 제거`, () => {
        // 작은 인덱스부터 복원 — 원래 위치 유지.
        const asc = snapshots.slice().sort((a, b) => a.idx - b.idx);
        for (const { idx, slot } of asc) {
            const at = Math.min(idx, _track.length);
            _track.splice(at, 0, slot);
        }
        _vSlots.forEach((s) => { s.idx = -1; });
        _saveTrack();
        _renderAll();
    });
}

function _removeLayer(slotIdx, layerIdx) {
    const slot = _track[slotIdx];
    if (!slot) return;
    if (slot.layers.length <= 1) {
        _removeSlot(slotIdx);
        return;
    }
    const slotId = slot.id;
    const removedLayer = JSON.parse(JSON.stringify(slot.layers[layerIdx]));
    const prevPrimary = slot.primaryIdx;
    slot.layers.splice(layerIdx, 1);
    if (slot.primaryIdx >= slot.layers.length) slot.primaryIdx = slot.layers.length - 1;
    else if (layerIdx < slot.primaryIdx) slot.primaryIdx -= 1;
    _saveTrack();
    _vSlots.forEach((s) => { if (s.idx === slotIdx) s.idx = -1; });
    if (_curIdx === slotIdx) _renderClip(slotIdx, _playing);
    _renderAll();
    pushUndo(`레이어 제거`, () => {
        const s = _track.find((x) => x.id === slotId);
        if (!s) return;
        s.layers.splice(layerIdx, 0, removedLayer);
        s.primaryIdx = prevPrimary;
        _vSlots.forEach((vs) => { vs.idx = -1; });
        _saveTrack();
        _renderAll();
    });
}

function _moveSlot(from, to) {
    if (from === to || from < 0 || to < 0 || from >= _track.length || to > _track.length) return;
    const [slot] = _track.splice(from, 1);
    const insertAt = to > _track.length ? _track.length : to;
    _track.splice(insertAt, 0, slot);
    _saveTrack();
    if (_curIdx === from) _curIdx = insertAt;
    else if (from < _curIdx && _curIdx <= insertAt) _curIdx -= 1;
    else if (insertAt <= _curIdx && _curIdx < from) _curIdx += 1;
    _vSlots.forEach((s) => { s.idx = -1; });
    _renderAll();
    pushUndo(`순서 변경 ${from + 1} → ${insertAt + 1}`, () => {
        // 역방향 이동
        const [m] = _track.splice(insertAt, 1);
        _track.splice(from, 0, m);
        _vSlots.forEach((s) => { s.idx = -1; });
        _saveTrack();
        _renderAll();
    });
}

function clearTrack() {
    if (_track.length === 0) return;
    if (!confirm("트랙을 모두 비울까요?")) return;
    const snapshot = JSON.parse(JSON.stringify(_track));
    const prevCur = _curIdx;
    _track = [];
    _curIdx = -1;
    _activeSlot = -1;
    _vSlots.forEach((s) => { s.idx = -1; s.el?.removeAttribute("src"); });
    pause();
    _saveTrack();
    _hideAllMedia();
    _renderAll();
    pushUndo("트랙 전체 비우기", () => {
        _track = snapshot;
        _curIdx = prevCur >= 0 && prevCur < _track.length ? prevCur : -1;
        _vSlots.forEach((s) => { s.idx = -1; });
        _saveTrack();
        _renderAll();
    });
}

function _extractTreePaths(e) {
    const multi = e.dataTransfer.getData("text/x-tree-paths");
    if (multi) return multi.split("\n").filter(Boolean);
    const single = e.dataTransfer.getData("text/x-tree-path");
    return single ? [single] : [];
}

// === 외부 진입점 ===

export function showViewer() {
    _loadTrack();
    _curIdx = -1;
    _activeSlot = -1;
    _vSlots.forEach((s) => { s.idx = -1; });
    _playing = false;
    _renderAll();
}

export function hideViewer() {
    pause();
    _closeContextMenu();
}

export function addPathToTrack(path) {
    if (!currentProject || !path) return false;
    const layer = _mkLayer(currentProject, path);
    if (!layer) return false;
    const slot = _mkSlot(layer);
    _track.push(slot);
    _saveTrack();
    if (layer.kind === "video") _probeVideoDuration(layer);
    _renderAll();
    return true;
}

// === Picker ===
// picker modal 은 viewer-picker.js 로 분리. 트랙 추가 콜백 + 카운트 게터만 주입.
initPicker({
    addPath: addPathToTrack,
    getCounts: () => ({
        slots: _track.length,
        layers: _track.reduce((s, sl) => s + (sl.layers?.length || 0), 0),
    }),
});

// grid.js 의 카드 트랙-위치 배지가 사용할 provider 등록 — 순환 import 방지.
setTrackMapProvider(getTrackPositionMap);

// === 이벤트 ===

viewerClearBtn?.addEventListener("click", clearTrack);
viewerPlayBtn?.addEventListener("click", togglePlay);
viewerPrevBtn?.addEventListener("click", prevClip);
viewerNextBtn?.addEventListener("click", nextClip);
viewerLoopBtn?.addEventListener("click", _toggleLoop);
viewerVolBtn?.addEventListener("click", _toggleMute);
viewerVolSlider?.addEventListener("input", (e) => _setVolume(parseInt(e.target.value, 10) / 100));
viewerFsBtn?.addEventListener("click", _toggleFullscreen);

// 초기 상태 적용
_applyVolume();
_updateLoopButton();

// 트랙 리스트 빈 영역 drop = 끝에 새 슬롯 추가
viewerTrackList?.addEventListener("dragover", (e) => {
    const t = Array.from(e.dataTransfer?.types || []);
    if (t.includes("text/x-tree-path") || t.includes("text/x-tree-paths")) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        viewerTrackList.classList.add("drop-target");
    }
});
viewerTrackList?.addEventListener("dragleave", (e) => {
    if (!viewerTrackList.contains(e.relatedTarget)) viewerTrackList.classList.remove("drop-target");
});
viewerTrackList?.addEventListener("drop", (e) => {
    viewerTrackList.classList.remove("drop-target");
    if (e.dataTransfer.getData("text/x-vt-idx") !== "") return;
    if (e.target.closest(".vt-item")) return;
    const paths = _extractTreePaths(e);
    if (paths.length === 0 || !currentProject) return;
    e.preventDefault();
    e.stopPropagation();
    const n = _insertSlotsAt(paths, _track.length);
    if (n > 0) showInfo(`트랙에 ${n}개 슬롯 추가`, "ok");
});

// 타임라인 빈 영역 (셀 사이 / 셀 없는 영역) drop = 끝에 추가
viewerTimeline?.addEventListener("dragover", (e) => {
    if (e.target.closest(".vtl-cell")) return;
    const t = Array.from(e.dataTransfer?.types || []);
    if (t.includes("text/x-tree-path") || t.includes("text/x-tree-paths")) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        viewerTimeline.classList.add("vtl-drop-end");
    }
});
viewerTimeline?.addEventListener("dragleave", (e) => {
    if (!viewerTimeline.contains(e.relatedTarget)) viewerTimeline.classList.remove("vtl-drop-end");
});
viewerTimeline?.addEventListener("drop", (e) => {
    viewerTimeline.classList.remove("vtl-drop-end");
    if (e.target.closest(".vtl-cell")) return;
    if (e.dataTransfer.getData("text/x-vt-idx") !== "") return;
    const paths = _extractTreePaths(e);
    if (paths.length === 0 || !currentProject) return;
    e.preventDefault();
    e.stopPropagation();
    const n = _insertSlotsAt(paths, _track.length);
    if (n > 0) showInfo(`트랙에 ${n}개 슬롯 추가`, "ok");
});

// 영상 화면 영역 drop = 끝에 추가 (가장 큰 hit zone)
viewerScreen?.addEventListener("dragover", (e) => {
    const t = Array.from(e.dataTransfer?.types || []);
    if (t.includes("text/x-tree-path") || t.includes("text/x-tree-paths")) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        viewerScreen.classList.add("vs-drop-target");
    }
});
viewerScreen?.addEventListener("dragleave", (e) => {
    if (!viewerScreen.contains(e.relatedTarget)) viewerScreen.classList.remove("vs-drop-target");
});
viewerScreen?.addEventListener("drop", (e) => {
    viewerScreen.classList.remove("vs-drop-target");
    if (e.dataTransfer.getData("text/x-vt-idx") !== "") return;
    const paths = _extractTreePaths(e);
    if (paths.length === 0 || !currentProject) return;
    e.preventDefault();
    e.stopPropagation();
    const n = _insertSlotsAt(paths, _track.length);
    if (n > 0) showInfo(`트랙에 ${n}개 슬롯 추가`, "ok");
});

document.addEventListener("keydown", (e) => {
    if (activeTab !== "viewer") return;
    if (isPickerOpen()) {
        if (e.key === "Escape") { closePicker(); e.preventDefault(); }
        return;
    }
    const ae = document.activeElement;
    if (ae && (["INPUT", "TEXTAREA"].includes(ae.tagName) || ae.isContentEditable)) return;
    if (e.key === " " || e.code === "Space") { togglePlay(); e.preventDefault(); }
    else if (e.key === "ArrowRight") { nextClip(); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { prevClip(); e.preventDefault(); }
    else if (e.key === "Delete") {
        // Backspace 는 의도적으로 제외 — 그리드에서 "부모 폴더로" 동작 (keyboard.js) 과 충돌 회피.
        // 트랙 슬롯 제거: 다중 선택이 있으면 그것 모두, 아니면 _curIdx 만.
        if (_selectedSlots.size > 0) {
            _removeSlots(Array.from(_selectedSlots));
            e.preventDefault();
        } else if (_curIdx >= 0) {
            _removeSlot(_curIdx);
            e.preventDefault();
        }
    }
    else if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey)) {
        // Ctrl/Cmd+A — 트랙 전체 선택
        if (_track.length > 0) {
            _selectedSlots.clear();
            for (let k = 0; k < _track.length; k++) _selectedSlots.add(k);
            _anchorIdx = _track.length - 1;
            _syncSlotSelectionDOM();
            e.preventDefault();
        }
    }
    else if (e.key === "Escape") {
        if (_selectedSlots.size > 0) {
            _clearSlotSelection();
            _syncSlotSelectionDOM();
            e.preventDefault();
        }
    }
    else if (e.key === "m" || e.key === "M") { _toggleMute(); e.preventDefault(); }
    else if (e.key === "f" || e.key === "F") { _toggleFullscreen(); e.preventDefault(); }
    else if (e.key === "l" || e.key === "L") { _toggleLoop(); e.preventDefault(); }
    else if (e.key === "/") {
        // / = 현재 슬롯의 primary layer 의 코멘트 모달.
        // 그리드 카드가 선택돼 있으면 comments.js 의 글로벌 / 핸들러가 우선 처리하므로
        // 여기는 그리드 선택 없을 때만 동작.
        if (document.querySelector(".card.selected[data-path]")) return;
        if (_curIdx >= 0) {
            const layer = _primary(_track[_curIdx]);
            if (layer && layer.path) {
                openCommentsModal(layer.path);
                e.preventDefault();
            }
        }
    }
});

window.addEventListener("pv:project-changed", () => {
    pause();
    _closeContextMenu();
    _curIdx = -1;
    _activeSlot = -1;
    _vSlots.forEach((s) => { s.idx = -1; s.el?.removeAttribute("src"); });
    _loadTrack();
    _hideAllMedia();
    _renderAll();
});
