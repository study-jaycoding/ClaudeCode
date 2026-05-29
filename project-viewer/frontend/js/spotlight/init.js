// 초기화 + 전역 이벤트 (Esc, 외부 클릭, 타입 토글, IME 합성).

import { spotlight, backdrop, promptInput, lightbox, modelDropdown, ratioDropdown } from "./dom.js";
import { state, cache, pickerState } from "./state.js";
import { closeAllDropdowns } from "./dropdowns.js";
import { closeLightbox, isLightboxOpen } from "./lightbox.js";
import { fetchModels } from "./api.js";
import { loadFavorites, openFavPicker, closeFavPicker, isFavPickerOpen, renderFavList, selectFavItem, updateFavHighlight } from "./favPicker.js";
import { openTagPicker, closeTagPicker, isTagPickerOpen, renderTagList, selectTag, updateTagHighlight, clearTagFilter } from "./tagPicker.js";
import { getAtQueryInfo, getSlashQueryInfo, stripAtQuery, stripSlashQuery } from "./prompt.js";
import { onModelChange, filterModelsByType } from "./modelControls.js";
import { handleKbdNav } from "./kbdNav.js";
import { updateStatus } from "./status.js";
import { doGenerate } from "./generate.js";

let isComposing = false;

export async function loadModels() {
    try {
        const data = await fetchModels();
        cache.allModels = data.models || [];
        filterModelsByType();
        onModelChange();
    } catch (err) {
        console.error("Failed to load models:", err);
    }
}

export function openSpotlight() {
    spotlight.classList.remove("hidden");
    setTimeout(() => promptInput.focus(), 50);
}

function reactToTrigger() {
    const sl = getSlashQueryInfo();
    if (sl && !isTagPickerOpen()) {
        pickerState.tagHighlight = -1;
        loadFavorites().then(() => openTagPicker());
        return;
    }
    if (isTagPickerOpen()) {
        pickerState.tagHighlight = -1;
        if (!sl) closeTagPicker();
        else renderTagList();
        return;
    }
    const at = getAtQueryInfo();
    if (at && !isFavPickerOpen()) {
        pickerState.favHighlight = -1;
        loadFavorites().then(() => openFavPicker());
    } else if (isFavPickerOpen()) {
        pickerState.favHighlight = -1;
        if (!at) closeFavPicker();
        else renderFavList();
    }
}

function bindPromptInput() {
    promptInput.addEventListener("input", () => {
        if (isComposing) return;
        reactToTrigger();
    });

    promptInput.addEventListener("compositionstart", () => { isComposing = true; });
    promptInput.addEventListener("compositionend", () => {
        isComposing = false;
        reactToTrigger();
    });

    promptInput.addEventListener("keydown", (e) => {
        if (isComposing || e.isComposing || e.keyCode === 229) return;

        // Tag picker 네비게이션
        if (isTagPickerOpen()) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                pickerState.tagHighlight = Math.min(
                    pickerState.tagHighlight + 1, pickerState.filteredTags.length - 1
                );
                updateTagHighlight();
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                pickerState.tagHighlight = Math.max(pickerState.tagHighlight - 1, 0);
                updateTagHighlight();
            } else if (e.key === "Enter" && pickerState.tagHighlight >= 0) {
                e.preventDefault();
                selectTag(pickerState.filteredTags[pickerState.tagHighlight]);
            } else if (e.key === "Tab") {
                e.preventDefault();
                if (pickerState.filteredTags.length > 0) {
                    selectTag(pickerState.filteredTags[Math.max(0, pickerState.tagHighlight)]);
                }
            } else if (e.key === "Enter") {
                e.preventDefault(); closeTagPicker(); stripSlashQuery();
            } else if (e.key === "Escape") {
                e.stopPropagation(); closeTagPicker(); stripSlashQuery();
            }
            return;
        }

        // Fav picker 네비게이션
        if (isFavPickerOpen()) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                pickerState.favHighlight = Math.min(
                    pickerState.favHighlight + 1, pickerState.filteredFavs.length - 1
                );
                updateFavHighlight();
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                pickerState.favHighlight = Math.max(pickerState.favHighlight - 1, 0);
                updateFavHighlight();
            } else if (e.key === "Enter" && pickerState.favHighlight >= 0) {
                e.preventDefault();
                selectFavItem(pickerState.filteredFavs[pickerState.favHighlight]);
            } else if (e.key === "Tab") {
                e.preventDefault();
                if (pickerState.filteredFavs.length > 0) {
                    selectFavItem(pickerState.filteredFavs[Math.max(0, pickerState.favHighlight)]);
                }
            } else if (e.key === "Enter") {
                e.preventDefault(); closeFavPicker(); stripAtQuery();
            } else if (e.key === "Escape") {
                e.stopPropagation(); closeFavPicker(); stripAtQuery();
            }
            return;
        }

        // 평상시 Enter → 생성
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            doGenerate();
        }
    });
}

function bindGlobalKeys() {
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            if (isLightboxOpen()) { closeLightbox(); return; }
            const anyDropdown = !modelDropdown.classList.contains("hidden")
                || !ratioDropdown.classList.contains("hidden")
                || isFavPickerOpen()
                || isTagPickerOpen()
                || document.querySelector(".opt-dropdown");
            if (anyDropdown) {
                closeAllDropdowns();
                return;
            }
            if (pickerState.tagFilter) {
                clearTagFilter();
                promptInput.focus();
            }
        }
    });
}

function bindBackdropAndClicks() {
    if (backdrop) backdrop.addEventListener("click", closeAllDropdowns);
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".dropdown")
            && !e.target.closest(".opt-dropdown")
            && !e.target.closest(".chip")
            && !e.target.closest(".opt-chip")) {
            closeAllDropdowns();
        }
    });
}

function bindTypeToggle() {
    document.querySelectorAll(".type-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            const newType = btn.dataset.type;
            if (newType === state.type) return;
            state.type = newType;
            document.querySelectorAll(".type-btn").forEach((b) => b.classList.toggle("active", b === btn));
            filterModelsByType();
            onModelChange();
        });
    });
}

// 어느 드롭다운이 활성이든 capture phase 에서 가장 먼저 키를 가로챈다.
// 포커스가 칩/프롬프트/body 어디에 있어도 동작.
function bindKbdNav() {
    document.addEventListener("keydown", (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (handleKbdNav(e)) e.stopPropagation();
    }, true);
}

export function bindGlobalEvents() {
    bindPromptInput();
    bindGlobalKeys();
    bindBackdropAndClicks();
    bindTypeToggle();
    bindKbdNav();
    updateStatus();
}
