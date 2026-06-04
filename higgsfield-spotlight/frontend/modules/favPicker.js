// @ 트리거 즐겨찾기 피커.

import {
    favPicker, favList, favEmpty,
    tagFilterBadge, tfbName, modelDropdown, ratioDropdown,
} from "./dom.js";
import { state, cache, pickerState } from "./state.js";
import { escapeHtml } from "./utils.js";
import { mediaUrl, favName } from "./refModel.js";
import { isRefInDom, insertChipAtCaret, getAtQueryInfo } from "./prompt.js";
import { fetchFavorites } from "./api.js";
import { registerCloser } from "./dropdowns.js";

export function openFavPicker() {
    modelDropdown.classList.add("hidden");
    ratioDropdown.classList.add("hidden");
    pickerState.favHighlight = -1;
    renderFavList();
    favPicker.classList.remove("hidden");
}

export function closeFavPicker() {
    favPicker.classList.add("hidden");
    pickerState.favHighlight = -1;
}

export function isFavPickerOpen() {
    return !favPicker.classList.contains("hidden");
}

export async function loadFavorites() {
    try {
        // 현재 프로젝트의 favorites 만. 프로젝트 없으면 전체 (cross-project 검색).
        const data = await fetchFavorites(state.project || "");
        cache.favorites = data.favorites || [];
    } catch {
        cache.favorites = [];
    }
}

export function renderFavList() {
    const at = getAtQueryInfo();
    const filter = at ? at.query.toLowerCase() : "";

    if (pickerState.tagFilter) {
        tagFilterBadge.classList.remove("hidden");
        tfbName.textContent = pickerState.tagFilter;
    } else {
        tagFilterBadge.classList.add("hidden");
    }

    let base = cache.favorites;
    if (pickerState.tagFilter) {
        base = base.filter((f) => Array.isArray(f.tags) && f.tags.includes(pickerState.tagFilter));
    }

    pickerState.filteredFavs = filter
        ? base.filter((f) => favName(f).toLowerCase().includes(filter) || f.project.toLowerCase().includes(filter))
        : [...base];

    if (pickerState.filteredFavs.length === 0) {
        favList.innerHTML = "";
        favEmpty.classList.remove("hidden");
        favEmpty.textContent = pickerState.tagFilter
            ? `'${pickerState.tagFilter}' 태그가 붙은 즐겨찾기가 없습니다`
            : "즐겨찾기가 없습니다";
        return;
    }
    favEmpty.classList.add("hidden");
    favList.innerHTML = "";
    pickerState.filteredFavs.forEach((fav, i) => {
        const selected = isRefInDom(fav);
        const item = document.createElement("div");
        item.className = "fav-item"
            + (selected ? " selected" : "")
            + (i === pickerState.favHighlight ? " highlight" : "");
        item.dataset.idx = i;
        item.innerHTML = `
            <img class="fav-item-thumb" src="${mediaUrl(fav)}" alt="" loading="lazy" />
            <span class="fav-item-name">${escapeHtml(favName(fav))}</span>
            <span class="fav-item-check">&#x2713;</span>`;
        item.addEventListener("click", (e) => {
            e.preventDefault();
            selectFavItem(fav);
        });
        favList.appendChild(item);
    });
}

export function selectFavItem(fav) {
    insertChipAtCaret(fav, true);
    closeFavPicker();
}

export function updateFavHighlight() {
    favList.querySelectorAll(".fav-item").forEach((el) => {
        el.classList.toggle("highlight", parseInt(el.dataset.idx) === pickerState.favHighlight);
    });
    const highlighted = favList.querySelector(".fav-item.highlight");
    if (highlighted) highlighted.scrollIntoView({ block: "nearest" });
}

registerCloser(closeFavPicker);
