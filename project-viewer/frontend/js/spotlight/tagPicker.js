// `/` 트리거 태그 필터 피커 + 활성 인디케이터.

import {
    tagPicker, tagList, tagEmpty,
    tagActiveBadge, tabName, tabClear, tfbClear,
    promptRowEl, promptInput, panelEl,
    modelDropdown, ratioDropdown, projectDropdown,
    tagFilterBadge,
} from "./dom.js";
import { anchorPickerAbovePanel } from "./pickerLayout.js";
import { cache, pickerState, sourceFavorites, isSourceFav } from "./state.js";
import { currentProject as viewerCurrentProject } from "../state.js";
import { escapeHtml } from "./utils.js";
import { getSlashQueryInfo, stripSlashQuery } from "./prompt.js";
import { registerCloser } from "./dropdowns.js";

function getAllTags() {
    const set = new Set();
    sourceFavorites().forEach((f) => Array.isArray(f.tags) && f.tags.forEach((t) => set.add(t)));
    return [...set].sort();
}

export function openTagPicker() {
    modelDropdown.classList.add("hidden");
    ratioDropdown.classList.add("hidden");
    if (projectDropdown) projectDropdown.classList.add("hidden");
    pickerState.tagHighlight = -1;
    renderTagList();
    tagPicker.classList.remove("hidden");
    anchorPickerAbovePanel(tagPicker, panelEl);
}

export function closeTagPicker() {
    tagPicker.classList.add("hidden");
    pickerState.tagHighlight = -1;
}

export function isTagPickerOpen() {
    return !tagPicker.classList.contains("hidden");
}

export function renderTagList() {
    const sl = getSlashQueryInfo();
    const filter = sl ? sl.query.toLowerCase() : "";
    const allTags = getAllTags();
    pickerState.filteredTags = filter
        ? allTags.filter((t) => t.toLowerCase().includes(filter))
        : allTags;

    if (pickerState.filteredTags.length === 0) {
        tagList.innerHTML = "";
        tagEmpty.classList.remove("hidden");
        tagEmpty.textContent = !viewerCurrentProject
            ? "프로젝트를 먼저 선택하세요"
            : "태그가 없습니다";
        return;
    }
    tagEmpty.classList.add("hidden");
    tagList.innerHTML = "";
    pickerState.filteredTags.forEach((tag, i) => {
        const count = sourceFavorites().filter((f) => Array.isArray(f.tags) && f.tags.includes(tag)).length;
        const item = document.createElement("div");
        item.className = "fav-item"
            + (tag === pickerState.tagFilter ? " selected" : "")
            + (i === pickerState.tagHighlight ? " highlight" : "");
        item.dataset.idx = i;
        item.innerHTML = `
            <span class="fav-item-thumb">#</span>
            <span class="fav-item-name">${escapeHtml(tag)} <span style="color:var(--text-3);font-weight:400">(${count})</span></span>
            <span class="fav-item-check">&#x2713;</span>`;
        item.addEventListener("click", (e) => {
            e.preventDefault();
            selectTag(tag);
        });
        tagList.appendChild(item);
    });
}

export function selectTag(tag) {
    pickerState.tagFilter = tag;
    stripSlashQuery();
    closeTagPicker();
    updateTagActiveIndicator();
    promptInput.focus();
}

export function clearTagFilter() {
    pickerState.tagFilter = null;
    tagFilterBadge.classList.add("hidden");
    updateTagActiveIndicator();
}

export function updateTagActiveIndicator() {
    if (pickerState.tagFilter) {
        tagActiveBadge.classList.remove("hidden");
        tabName.textContent = pickerState.tagFilter;
        promptRowEl.classList.add("tag-active");
    } else {
        tagActiveBadge.classList.add("hidden");
        promptRowEl.classList.remove("tag-active");
    }
}

export function updateTagHighlight() {
    tagList.querySelectorAll(".fav-item").forEach((el) => {
        el.classList.toggle("highlight", parseInt(el.dataset.idx) === pickerState.tagHighlight);
    });
    const highlighted = tagList.querySelector(".fav-item.highlight");
    if (highlighted) highlighted.scrollIntoView({ block: "nearest" });
}

export function bindTagBadgeButtons() {
    if (tabClear) tabClear.addEventListener("click", (e) => {
        e.stopPropagation();
        clearTagFilter();
        promptInput.focus();
    });
    if (tfbClear) tfbClear.addEventListener("click", (e) => {
        e.stopPropagation();
        clearTagFilter();
        promptInput.focus();
    });
}

registerCloser(closeTagPicker);
