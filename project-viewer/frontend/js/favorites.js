// =====================================================================
// 즐겨찾기 (소스 마커, NEW 알림, 태그, 사이드바 목록) — viewer 의 핵심 데이터
// 다른 모듈은 callback 으로 외부 의존성을 주입한다:
//   - setPreviewCallback(fn): renderFavItem 의 썸네일 클릭 시 텍스트 미리보기
//   - setSourceGridCallback(fn): 태그 필터 변경 시 우측 그리드 갱신
// =====================================================================
import {
    favorites, setFavorites,
    firstFavoritesLoad, setFirstFavoritesLoad,
    activeTagFilter, setActiveTagFilter,
    activeTab,
    currentProject,
    setSuppressClickUntil,
} from "./state.js";
import { rootTree } from "./state.js";
import {
    favoritesList, favCountEl, genCountEl, tagFilterBar,
    tabFavorites, lasso,
} from "./dom.js";
import {
    escapeHtml, kindFromPath, generateId, findNodeByPath, isGeneratedPath,
} from "./utils.js";
import { apiGetFavorites, apiPersistFavorites } from "./api.js";
import { openLightbox } from "./lightbox.js";
import { pushUndo } from "./undo.js";

// --- 외부 callback (다른 모듈에서 등록) ---
let _previewNode = () => {};
let _refreshSourceGrid = () => {};

export function setPreviewCallback(fn) {
    _previewNode = typeof fn === "function" ? fn : () => {};
}
export function setSourceGridCallback(fn) {
    _refreshSourceGrid = typeof fn === "function" ? fn : () => {};
}

// ── 사이드바 소스 목록 선택 상태 ──
const _favSelected = new Set();
let _lastSelectedFavId = null;

export function getSelectedFavIds() { return Array.from(_favSelected); }

export function clearFavSelection() {
    _favSelected.clear();
    _lastSelectedFavId = null;
    if (favoritesList) {
        favoritesList.querySelectorAll(".fav-item.selected")
            .forEach((el) => el.classList.remove("selected"));
    }
}

// 여러 fav 에 같은 태그를 한 번에 추가 (개별 addTag 호출은 매번 re-render 하므로 부적합).
export function addTagsToMany(favIds, tag) {
    tag = (tag || "").trim();
    if (!tag) return;
    const added = [];
    for (const fid of favIds) {
        const fav = favorites.find((f) => f.id === fid);
        if (!fav || (fav.tags || []).includes(tag)) continue;
        fav.tags = fav.tags || [];
        fav.tags.push(tag);
        added.push(fid);
    }
    if (added.length === 0) return;
    persistFavorites();
    renderFavorites();
    pushUndo(`태그 추가 #${tag} (${added.length}개)`, async () => {
        for (const fid of added) {
            const f = favorites.find((x) => x.id === fid);
            if (f) f.tags = (f.tags || []).filter((t) => t !== tag);
        }
        persistFavorites();
        renderFavorites();
    });
}

// --- 분류 / 조회 ---
export function isFavorite(project, path) {
    return favorites.some((f) => f.project === project && f.path === path);
}
export function getFavorite(project, path) {
    return favorites.find((f) => f.project === project && f.path === path);
}
export function isSourceFav(fav) {
    return fav && fav.isSource === true && !isGeneratedPath(fav.path);
}
// 현재 viewer 에서 선택된 프로젝트의 소스만 반환.
// 프로젝트 미선택 시 빈 배열 — 소스 탭/사이드바 모두에 자동 적용됨.
export function sourceFavorites() {
    if (!currentProject) return [];
    return favorites.filter((f) => f.project === currentProject && isSourceFav(f));
}

// --- CRUD ---
export function persistFavorites() {
    apiPersistFavorites(favorites);
}

export async function initFavorites() {
    try {
        const data = await apiGetFavorites();
        setFavorites(Array.isArray(data.favorites) ? data.favorites
                  : Array.isArray(data) ? data : []);
        let needPersist = false;
        const now = Date.now();
        for (const f of favorites) {
            if (!f.id) { f.id = generateId(); needPersist = true; }
            if (!f.tags) f.tags = [];
            if (!f.note) f.note = "";
            if (!f.sourceIds) f.sourceIds = [];
            // isSource 마이그레이션 (옛날 데이터 호환)
            if (f.isSource === undefined) {
                f.isSource = !isGeneratedPath(f.path);
                needPersist = true;
            }
            // 첫 로드 시 seenAt 미정의 fav 는 모두 본 것으로 마이그레이션.
            // 그 이후 SSE 로 들어오는 새 fav (seenAt 미정의) 는 unseen 으로 표시됨.
            if (firstFavoritesLoad && f.seenAt === undefined) {
                f.seenAt = now;
                needPersist = true;
            }
        }
        if (needPersist) persistFavorites();
        setFirstFavoritesLoad(false);
    } catch {
        setFavorites([]);
    }
    updateFavCount();
    updateTreeLabelColors();
    updateCardMarkers();
    updateCardNewBadges();
}

/** 즐겨찾기 패널의 ● 버튼: 완전 제거 (ID 파기). */
export function removeFromFavorites(project, path) {
    const idx = favorites.findIndex((f) => f.project === project && f.path === path);
    if (idx < 0) return;
    favorites.splice(idx, 1);
    persistFavorites();
    updateFavCount();
    renderFavorites();
}

// --- 소스 토글 ---
/** 내부: isSource 명시 set + UI 갱신. 미등록이면 신규 생성. */
export function _setSourceValue(project, path, value) {
    let fav = favorites.find((f) => f.project === project && f.path === path);
    const now = Date.now();
    if (!fav) {
        fav = {
            id: generateId(),
            project,
            path,
            tags: [],
            note: "",
            sourceIds: [],
            isSource: !!value,
            sourceMarkedAt: value ? now : 0,
            addedAt: now,
        };
        favorites.push(fav);
    } else {
        fav.isSource = !!value;
        if (value) fav.sourceMarkedAt = now;
    }
    // 토글로 새로 소스가 된 fav 는 NEW 로 표시 — 사용자가 카드를 다시 클릭해야 dismiss
    persistFavorites();
    updateFavCount();
    renderFavorites();
    updateCardMarkers();
    updateTreeLabelColors();
    updateCardNewBadges();
}

/** 카드 우상단 마커 클릭 — Result/ 외에서 isSource 토글. */
export function toggleSource(project, path) {
    if (isGeneratedPath(path)) return;
    const fav = favorites.find((f) => f.project === project && f.path === path);
    const prev = !!(fav && fav.isSource === true);
    _setSourceValue(project, path, !prev);
    const name = path.split("/").pop();
    pushUndo(`마커 ${prev ? "해제→복원" : "지정→해제"} (${name})`, async () => {
        _setSourceValue(project, path, prev);
    });
}

// --- NEW 알림 (seenAt 기반) ---
function _isUnseen(f, trigger) {
    return !(f.seenAt && f.seenAt >= trigger);
}
export function unseenSourcesCount() {
    return favorites.filter((f) => {
        if (!isSourceFav(f)) return false;
        const trig = f.sourceMarkedAt || f.addedAt || 0;
        return _isUnseen(f, trig);
    }).length;
}
export function unseenGeneratedCount() {
    return favorites.filter((f) => {
        if (!isGeneratedPath(f.path)) return false;
        return _isUnseen(f, f.addedAt || 0);
    }).length;
}

/** 카드를 본 것으로 마킹. true 반환 시 UI 갱신 필요. */
export function markCardSeen(project, path) {
    const fav = favorites.find((f) => f.project === project && f.path === path);
    if (!fav) return false;
    const trig = isGeneratedPath(path)
        ? (fav.addedAt || 0)
        : (fav.sourceMarkedAt || fav.addedAt || 0);
    if (fav.seenAt && fav.seenAt >= trig) return false;
    fav.seenAt = Date.now();
    persistFavorites();
    return true;
}

/** 카드가 "새 항목" 표시 대상인지 — seenAt 이 마지막 trigger 이전이거나 미정의일 때. */
export function isCardNew(project, path) {
    const fav = favorites.find((f) => f.project === project && f.path === path);
    if (!fav) return false;
    if (isGeneratedPath(path)) {
        return _isUnseen(fav, fav.addedAt || 0);
    }
    if (isSourceFav(fav)) {
        return _isUnseen(fav, fav.sourceMarkedAt || fav.addedAt || 0);
    }
    return false;
}

// --- UI 갱신 (다른 모듈도 호출) ---
export function updateFavCount() {
    const srcN = unseenSourcesCount();
    favCountEl.textContent = String(srcN);
    favCountEl.classList.toggle("hidden", srcN === 0);

    if (genCountEl) {
        const genN = unseenGeneratedCount();
        genCountEl.textContent = String(genN);
        genCountEl.classList.toggle("hidden", genN === 0);
    }
}

/** 트리 라벨에 source/generated 클래스 동기화. */
export function updateTreeLabelColors() {
    document.querySelectorAll(".tree .file-label[data-path]").forEach((label) => {
        const path = label.dataset.path;
        const isGen = isGeneratedPath(path);
        const fav = favorites.find((f) => f.project === currentProject && f.path === path);
        const isSrc = !!(fav && fav.isSource === true);
        label.classList.toggle("generated", isGen);
        label.classList.toggle("source", isSrc && !isGen);
    });
}

/** 그리드 카드 우상단 마커 갱신 (생성물/소스/중립). */
export function updateCardMarkers() {
    document.querySelectorAll(".card .card-marker[data-path]").forEach((btn) => {
        const path = btn.dataset.path;
        if (isGeneratedPath(path)) {
            btn.className = "card-marker generated";
            btn.title = "자동 생성물 (Result/)";
            return;
        }
        const fav = favorites.find((f) => f.project === currentProject && f.path === path);
        const isSrc = !!(fav && fav.isSource === true);
        btn.className = "card-marker " + (isSrc ? "source" : "neutral");
        btn.title = isSrc ? "소스 해제" : "소스로 표시";
    });
}

/** 그리드 카드 NEW 배지 갱신 (좌상단 라임 배지). */
export function updateCardNewBadges() {
    document.querySelectorAll(".card[data-path]").forEach((card) => {
        const path = card.dataset.path;
        const isNew = isCardNew(currentProject, path);
        card.classList.toggle("is-new", isNew);
        const existing = card.querySelector(".new-badge");
        if (isNew && !existing) {
            const badge = document.createElement("span");
            badge.className = "new-badge";
            badge.textContent = "NEW";
            card.appendChild(badge);
        } else if (!isNew && existing) {
            existing.remove();
        }
    });
}

// --- 태그 관리 ---
export function addTag(favId, tag) {
    const fav = favorites.find((f) => f.id === favId);
    if (!fav) return;
    tag = tag.trim();
    if (!tag || fav.tags.includes(tag)) return;
    fav.tags.push(tag);
    persistFavorites();
    renderFavorites();
    pushUndo(`태그 추가 (#${tag})`, async () => {
        const f = favorites.find((x) => x.id === favId);
        if (!f) return;
        f.tags = f.tags.filter((t) => t !== tag);
        persistFavorites();
        renderFavorites();
    });
}

export function removeTag(favId, tag) {
    const fav = favorites.find((f) => f.id === favId);
    if (!fav) return;
    if (!fav.tags.includes(tag)) return;
    fav.tags = fav.tags.filter((t) => t !== tag);
    persistFavorites();
    renderFavorites();
    pushUndo(`태그 제거 (#${tag})`, async () => {
        const f = favorites.find((x) => x.id === favId);
        if (!f || f.tags.includes(tag)) return;
        f.tags.push(tag);
        persistFavorites();
        renderFavorites();
    });
}

export function getAllTags() {
    const set = new Set();
    sourceFavorites().forEach((f) => (f.tags || []).forEach((t) => set.add(t)));
    return [...set].sort();
}

// --- 태그 필터 바 ---
export function renderTagFilterBar() {
    const tags = getAllTags();
    const sources = sourceFavorites();
    tagFilterBar.innerHTML = "";
    if (tags.length === 0 && sources.length === 0) return;

    const allChip = document.createElement("button");
    allChip.type = "button";
    allChip.className = "tag-chip" + (activeTagFilter === null ? " active" : "");
    allChip.textContent = `전체 (${sources.length})`;
    allChip.addEventListener("click", () => {
        setActiveTagFilter(null);
        renderTagFilterBar();
        renderFavoritesItems();
        _refreshSourceGrid(null);
    });
    tagFilterBar.appendChild(allChip);

    tags.forEach((tag) => {
        const count = sources.filter((f) => (f.tags || []).includes(tag)).length;
        const chip = document.createElement("span");
        chip.className = "tag-chip" + (activeTagFilter === tag ? " active" : "");
        chip.setAttribute("role", "button");
        chip.innerHTML = `<span class="tag-chip-label">#${escapeHtml(tag)} (${count})</span>`
            + `<button class="tag-chip-x" type="button" title="태그 영구 삭제">✕</button>`;
        chip.querySelector(".tag-chip-label").addEventListener("click", () => {
            setActiveTagFilter(activeTagFilter === tag ? null : tag);
            renderTagFilterBar();
            renderFavoritesItems();
            _refreshSourceGrid(activeTagFilter);
        });
        chip.querySelector(".tag-chip-x").addEventListener("click", (e) => {
            e.stopPropagation();
            removeTagFromAll(tag);
        });
        tagFilterBar.appendChild(chip);
    });
}

// 태그를 모든 source favorite 에서 영구 제거 (확인 후) + undo.
export function removeTagFromAll(tag) {
    const affected = sourceFavorites().filter((f) => (f.tags || []).includes(tag));
    if (affected.length === 0) return;
    if (!confirm(`'#${tag}' 태그를 ${affected.length}개 항목에서 모두 제거하시겠습니까?`)) return;
    const ids = affected.map((f) => f.id);
    for (const f of affected) {
        f.tags = (f.tags || []).filter((t) => t !== tag);
    }
    // 현재 필터가 지워질 태그였다면 전체로 복귀
    if (activeTagFilter === tag) setActiveTagFilter(null);
    persistFavorites();
    renderFavorites();
    _refreshSourceGrid(activeTagFilter);
    pushUndo(`태그 #${tag} 일괄 제거 (${ids.length}개)`, async () => {
        for (const fid of ids) {
            const f = favorites.find((x) => x.id === fid);
            if (f && !(f.tags || []).includes(tag)) {
                f.tags = f.tags || [];
                f.tags.push(tag);
            }
        }
        persistFavorites();
        renderFavorites();
        _refreshSourceGrid(activeTagFilter);
    });
}

// --- 사이드바 즐겨찾기 목록 ---
export function renderFavorites() {
    renderTagFilterBar();
    renderFavoritesItems();
}

export function renderFavoritesItems() {
    let filtered = sourceFavorites();
    if (activeTagFilter) {
        filtered = filtered.filter((f) => (f.tags || []).includes(activeTagFilter));
    }
    filtered.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

    if (filtered.length === 0) {
        let msg;
        if (!currentProject) {
            msg = "프로젝트를 먼저 선택하세요";
        } else if (activeTagFilter) {
            msg = `"#${escapeHtml(activeTagFilter)}" 태그가 없습니다`;
        } else {
            msg = "등록된 소스가 없습니다";
        }
        favoritesList.innerHTML = `<li class="empty">${msg}</li>`;
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
    li.className = "fav-item" + (_favSelected.has(fav.id) ? " selected" : "");
    li.dataset.favId = fav.id;

    let thumbHtml;
    if (kind === "image") {
        thumbHtml = `<img src="${url}" loading="lazy" alt="" />`;
    } else if (kind === "video") {
        thumbHtml = `<video src="${url}" preload="metadata" muted></video>`;
    } else {
        thumbHtml = `<span>📄</span>`;
    }

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
        <button class="fav-remove" type="button" title="소스 해제">●</button>`;

    // 썸네일 클릭 → 라이트박스 (이미지/비디오) 또는 텍스트 미리보기
    li.querySelector(".fav-thumb").addEventListener("click", () => {
        const node = { name: fav.path.split("/").pop(), path: fav.path, kind, size: 0 };
        if (kind === "image" || kind === "video") {
            openLightbox(fav.project, node);
        } else if (rootTree && currentProject === fav.project) {
            const tn = findNodeByPath(rootTree, fav.path);
            if (tn) _previewNode(fav.project, tn);
        }
    });

    li.querySelectorAll(".tag-chip.small").forEach((chip) => {
        chip.querySelector(".tag-x").addEventListener("click", (e) => {
            e.stopPropagation();
            removeTag(fav.id, chip.dataset.tag);
        });
    });

    li.querySelector(".tag-add-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        const tagsDiv = li.querySelector(".fav-tags");
        const btn = li.querySelector(".tag-add-btn");
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

    li.querySelector(".fav-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        removeFromFavorites(fav.project, fav.path);
    });

    // li 본체 클릭 → 선택 (썸네일/태그/버튼/입력 영역은 자체 핸들러가 처리하므로 제외).
    li.addEventListener("click", (e) => {
        if (e.target.closest(".fav-thumb")) return;
        if (e.target.closest(".tag-chip.small")) return;
        if (e.target.closest(".tag-add-btn")) return;
        if (e.target.closest(".fav-remove")) return;
        if (e.target.closest(".tag-input")) return;

        if (e.ctrlKey || e.metaKey) {
            if (_favSelected.has(fav.id)) _favSelected.delete(fav.id);
            else _favSelected.add(fav.id);
            _lastSelectedFavId = fav.id;
        } else if (e.shiftKey && _lastSelectedFavId) {
            const items = Array.from(favoritesList.querySelectorAll(".fav-item"));
            const ids = items.map((el) => el.dataset.favId);
            const a = ids.indexOf(_lastSelectedFavId);
            const b = ids.indexOf(fav.id);
            if (a >= 0 && b >= 0) {
                const [lo, hi] = a < b ? [a, b] : [b, a];
                for (let i = lo; i <= hi; i++) _favSelected.add(ids[i]);
            }
        } else {
            _favSelected.clear();
            _favSelected.add(fav.id);
            _lastSelectedFavId = fav.id;
        }
        favoritesList.querySelectorAll(".fav-item").forEach((el) => {
            el.classList.toggle("selected", _favSelected.has(el.dataset.favId));
        });
    });

    return li;
}

// ── 사이드바 소스 선택 + `/` 키로 일괄 태그 입력 ─────────────
// favorites.js 모듈 로드 시 한 번 등록.
document.addEventListener("keydown", (e) => {
    // 입력 중이면 무시
    const ae = document.activeElement;
    if (ae && (["INPUT", "TEXTAREA"].includes(ae.tagName) || ae.isContentEditable)) return;

    if (e.key === "Escape" && _favSelected.size > 0) {
        clearFavSelection();
        return;
    }
    if (e.key !== "/") return;
    if (activeTab !== "favorites") return;
    if (_favSelected.size === 0) return;

    e.preventDefault();
    const ids = Array.from(_favSelected);
    const firstLi = favoritesList.querySelector(`.fav-item[data-fav-id="${CSS.escape(ids[0])}"]`);
    if (!firstLi) return;
    const tagsDiv = firstLi.querySelector(".fav-tags");
    const btn = firstLi.querySelector(".tag-add-btn");
    if (!tagsDiv || !btn) return;
    const existing = tagsDiv.querySelector(".tag-input");
    if (existing) { existing.focus(); return; }

    const input = document.createElement("input");
    input.type = "text";
    input.className = "tag-input";
    input.placeholder = ids.length > 1 ? `태그 (${ids.length}개에 적용)` : "태그 입력";
    input.maxLength = 20;
    tagsDiv.insertBefore(input, btn);
    input.focus();

    let committed = false;
    const commit = () => {
        if (committed) return;
        committed = true;
        const val = input.value.trim();
        if (val) addTagsToMany(ids, val);
        else input.remove();
    };
    input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); commit(); }
        else if (ev.key === "Escape") { committed = true; input.remove(); }
        ev.stopPropagation();
    });
    input.addEventListener("blur", commit);
});

// 사이드바 소스 목록 바깥 클릭 시 선택 해제.
// "다른 곳" = fav-item 외 영역 전부 (사이드바 안의 빈 공간도 포함).
// 단, 편집 중인 tag-input 안의 클릭은 유지.
document.addEventListener("click", (e) => {
    if (_favSelected.size === 0) return;
    if (e.target.closest(".fav-item")) return;
    if (e.target.closest(".tag-input")) return;
    clearFavSelection();
});

// ── 사이드바 lasso 드래그 선택 ──
// favorites 탭 패널의 빈 영역에서 드래그 → 사각형 안의 fav-item 들을 선택.
let _favLassoStart = null;
let _favLassoActive = false;
let _favLassoPreSelected = null;

function _applyFavLassoSelection(rectX, rectY, rectW, rectH) {
    const rx2 = rectX + rectW;
    const ry2 = rectY + rectH;
    favoritesList.querySelectorAll(".fav-item").forEach((el) => {
        const r = el.getBoundingClientRect();
        const overlap = !(r.right < rectX || r.left > rx2 || r.bottom < rectY || r.top > ry2);
        const id = el.dataset.favId;
        if (_favLassoStart && _favLassoStart.ctrl) {
            if (overlap) _favSelected.add(id);
            else if (!_favLassoPreSelected.has(id)) _favSelected.delete(id);
        } else {
            if (overlap) _favSelected.add(id);
            else _favSelected.delete(id);
        }
        el.classList.toggle("selected", _favSelected.has(id));
    });
}

if (tabFavorites) {
    tabFavorites.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest(".fav-item")) return;
        if (e.target.closest("button, a, input, textarea, select")) return;
        if (e.target.closest(".tag-chip")) return;
        e.preventDefault();
        _favLassoStart = { x: e.clientX, y: e.clientY, ctrl: e.ctrlKey || e.metaKey };
        _favLassoActive = false;
        _favLassoPreSelected = _favLassoStart.ctrl ? new Set(_favSelected) : null;
    });
}

document.addEventListener("mousemove", (e) => {
    if (!_favLassoStart) return;
    const dx = e.clientX - _favLassoStart.x;
    const dy = e.clientY - _favLassoStart.y;
    if (!_favLassoActive && Math.abs(dx) + Math.abs(dy) > 4) {
        _favLassoActive = true;
        if (!_favLassoStart.ctrl) {
            _favSelected.clear();
            favoritesList.querySelectorAll(".fav-item.selected")
                .forEach((el) => el.classList.remove("selected"));
        }
        lasso.classList.remove("hidden");
    }
    if (!_favLassoActive) return;
    const x = Math.min(e.clientX, _favLassoStart.x);
    const y = Math.min(e.clientY, _favLassoStart.y);
    const w = Math.abs(dx);
    const h = Math.abs(dy);
    lasso.style.left = x + "px";
    lasso.style.top = y + "px";
    lasso.style.width = w + "px";
    lasso.style.height = h + "px";
    _applyFavLassoSelection(x, y, w, h);
});

document.addEventListener("mouseup", () => {
    if (_favLassoActive) {
        lasso.classList.add("hidden");
        lasso.style.width = "0";
        lasso.style.height = "0";
        // mouseup 직후 발생하는 click 을 잠시 무시 (lasso 결과 보존)
        setSuppressClickUntil(Date.now() + 250);
    }
    _favLassoStart = null;
    _favLassoActive = false;
    _favLassoPreSelected = null;
});
