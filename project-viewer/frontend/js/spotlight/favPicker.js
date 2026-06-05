// @ 트리거 즐겨찾기 피커.

import {
    favPicker, favList, favEmpty,
    tagFilterBadge, tfbName, modelDropdown, ratioDropdown,
    panelEl,
} from "./dom.js";
import { anchorPickerAbovePanel } from "./pickerLayout.js";
import { state, cache, pickerState, sourceFavorites } from "./state.js";
import { currentProject as viewerCurrentProject } from "../state.js";
import { escapeHtml } from "./utils.js";
import { kindFromPath } from "../utils.js";
import { thumbUrl, favName } from "./refModel.js";
import { isRefInDom, insertChipAtCaret, getAtQueryInfo } from "./prompt.js";
import { fetchFavorites } from "./api.js";
import { registerCloser } from "./dropdowns.js";
import { lazyScan } from "../lazy-media.js";

export function openFavPicker() {
    modelDropdown.classList.add("hidden");
    ratioDropdown.classList.add("hidden");
    pickerState.favHighlight = -1;
    renderFavList();
    favPicker.classList.remove("hidden");
    anchorPickerAbovePanel(favPicker, panelEl);
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
        // 현재 프로젝트의 favorites 만 로드.
        const proj = viewerCurrentProject || state.project || "";
        const data = await fetchFavorites(proj);
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

    // viewer "소스" 탭과 동일 집합으로만 검색.
    // tagFilter === "scratch" 일 때만 scratch fav 노출 (격리 폴더).
    const showScratch = pickerState.tagFilter === "scratch";
    let base = sourceFavorites({ includeScratch: showScratch });
    if (pickerState.tagFilter) {
        base = base.filter((f) => Array.isArray(f.tags) && f.tags.includes(pickerState.tagFilter));
    }

    if (filter) {
        const matched = base.filter((f) =>
            favName(f).toLowerCase().includes(filter) || (f.project || "").toLowerCase().includes(filter)
        );
        // 접두사 매치 우선 정렬: 파일명이 filter 로 시작 > 그 외 > 같으면 이름 순
        matched.sort((a, b) => {
            const an = favName(a).toLowerCase();
            const bn = favName(b).toLowerCase();
            const ap = an.startsWith(filter) ? 0 : 1;
            const bp = bn.startsWith(filter) ? 0 : 1;
            if (ap !== bp) return ap - bp;
            return an.localeCompare(bn);
        });
        pickerState.filteredFavs = matched;
    } else {
        pickerState.filteredFavs = [...base];
    }

    if (pickerState.filteredFavs.length === 0) {
        favList.innerHTML = "";
        favEmpty.classList.remove("hidden");
        if (!viewerCurrentProject) {
            favEmpty.textContent = "프로젝트를 먼저 선택하세요";
        } else if (pickerState.tagFilter) {
            favEmpty.textContent = `'${pickerState.tagFilter}' 태그가 붙은 소스가 없습니다`;
        } else {
            favEmpty.textContent = `'${viewerCurrentProject}' 프로젝트에 소스가 없습니다`;
        }
        return;
    }
    favEmpty.classList.add("hidden");
    // 필터링된 결과가 있으면 첫 항목을 자동 하이라이트 (Enter 로 바로 확정 가능).
    // 이전 highlight 가 범위 밖이거나 미설정(-1)이면 0 으로 리셋.
    if (pickerState.filteredFavs.length > 0
        && (pickerState.favHighlight < 0
            || pickerState.favHighlight >= pickerState.filteredFavs.length)) {
        pickerState.favHighlight = 0;
    }
    favList.innerHTML = "";
    pickerState.filteredFavs.forEach((fav, i) => {
        const selected = isRefInDom(fav);
        const item = document.createElement("div");
        item.className = "fav-item"
            + (selected ? " selected" : "")
            + (i === pickerState.favHighlight ? " highlight" : "");
        item.dataset.idx = i;
        // 파일 종류에 맞는 썸네일 (이미지 = img, 비디오 = video, 그 외 = 아이콘)
        const kind = kindFromPath(fav.path || "");
        const tUrl = thumbUrl(fav);   // 서버 사전생성 800px JPG — 원본 디코드 회피
        let thumbHtml;
        if (kind === "video") {
            // 카드 비디오는 재생 안 함 → poster 만 표시 (디코드 0)
            thumbHtml = `<video class="fav-item-thumb" data-lazy-poster="${tUrl}" preload="none" muted></video>`;
        } else if (kind === "image") {
            thumbHtml = `<img class="fav-item-thumb" data-lazy-src="${tUrl}" alt="" loading="lazy" />`;
        } else {
            thumbHtml = `<span class="fav-item-thumb fav-item-thumb-icon">📄</span>`;
        }
        item.innerHTML = `
            ${thumbHtml}
            <span class="fav-item-name">${escapeHtml(favName(fav))}</span>
            <span class="fav-item-check">&#x2713;</span>`;
        item.addEventListener("click", (e) => {
            e.preventDefault();
            selectFavItem(fav);
        });
        favList.appendChild(item);
    });
    lazyScan(favList);
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
