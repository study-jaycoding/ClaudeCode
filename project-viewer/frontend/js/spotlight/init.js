// 초기화 + 전역 이벤트 (Esc, 외부 클릭, 타입 토글, IME 합성).

import { backdrop, promptInput, lightbox, modelDropdown, ratioDropdown } from "./dom.js";
import { state, cache, pickerState } from "./state.js";
import { closeAllDropdowns } from "./dropdowns.js";
import { closeLightbox, isLightboxOpen } from "./lightbox.js";
import { fetchModels } from "./api.js";
import { loadFavorites, openFavPicker, closeFavPicker, isFavPickerOpen, renderFavList, selectFavItem, updateFavHighlight } from "./favPicker.js";
import { openTagPicker, closeTagPicker, isTagPickerOpen, renderTagList, selectTag, updateTagHighlight, clearTagFilter } from "./tagPicker.js";
import { getAtQueryInfo, getSlashQueryInfo, stripAtQuery, stripSlashQuery, clearPrompt } from "./prompt.js";
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

// cache 가 있으면 즉시 open, 백그라운드에서 silent refresh.
// 매번 fetch → 결과 대기 → open 패턴은 작은 RT 라도 사용자가 "딜레이" 로 느낌.
// 첫 페이지 로드 시점에 app.js 가 미리 loadFavorites 호출 → cache 준비됨.
//
// silent refresh 후 cache 가 실제로 변경됐을 때만 재렌더 (같으면 깜빡임 0).
// id + project + path + tags 시그니처로 비교.
function _favSignature() {
    const list = cache.favorites || [];
    let s = String(list.length) + "|";
    for (const f of list) {
        s += (f.id || "") + ":" + (f.project || "") + "/" + (f.path || "")
           + "#" + ((f.tags || []).join(",")) + ";";
    }
    return s;
}

function _openImmediate(openFn, renderFn) {
    if (cache.favorites && cache.favorites.length > 0) {
        openFn();
        const before = _favSignature();
        loadFavorites().then(() => {
            if (_favSignature() !== before) {
                try { renderFn(); } catch {}
            }
        });
    } else {
        loadFavorites().then(openFn);
    }
}

function reactToTrigger() {
    const sl = getSlashQueryInfo();
    if (sl && !isTagPickerOpen()) {
        pickerState.tagHighlight = -1;
        _openImmediate(openTagPicker, renderTagList);
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
        _openImmediate(openFavPicker, renderFavList);
    } else if (isFavPickerOpen()) {
        pickerState.favHighlight = -1;
        if (!at) closeFavPicker();
        else renderFavList();
    }
}

// cache 동기화는 spotlight/app.js 의 pv:favorites-changed 리스너가 담당
// (viewerFavorites.slice() 로 직접 복사 → race condition 없음).
// 여기서 fetch 기반으로 또 호출하면 backend persist 전에 stale 데이터를 받아
// 덮어쓰는 사고가 남 (소스 추가 직후 우측 picker 에 새 항목 안 보이는 증상).

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
        // Shift+Backspace 는 IME 가드보다 먼저 — 한글 조합 중에도 무조건 전체 지움.
        // (조합 중 e.key 가 "Process" 로 바뀌어 e.key === "Backspace" 매치 실패 →
        //  e.code (물리 키) 로 검사. 키코드 8 도 fallback.)
        const isBackspace = e.code === "Backspace" || e.key === "Backspace" || e.keyCode === 8;
        if (isBackspace && e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            // composition 강제 종료 후 clear — IME 잔존 상태 방지
            promptInput.blur();
            clearPrompt();
            isComposing = false;
            requestAnimationFrame(() => promptInput.focus());
            return;
        }

        // Esc 도 IME 가드보다 먼저 — 한글 조합 중 picker 가 안 닫히던 문제.
        // 조합 중 e.key 가 "Process" 로 바뀌어도 e.code === "Escape" 는 유지.
        const isEscape = e.code === "Escape" || e.key === "Escape" || e.keyCode === 27;
        if (isEscape) {
            if (isTagPickerOpen()) {
                e.preventDefault();
                e.stopPropagation();
                closeTagPicker();
                stripSlashQuery();
                return;
            }
            if (isFavPickerOpen()) {
                e.preventDefault();
                e.stopPropagation();
                closeFavPicker();
                stripAtQuery();
                return;
            }
            // picker 가 닫혀있어도 tagFilter 가 활성이면 Esc 로 해제 (badge "x" 와 동등).
            if (pickerState.tagFilter) {
                e.preventDefault();
                e.stopPropagation();
                clearTagFilter();
                promptInput.focus();
                return;
            }
        }

        if (isComposing || e.isComposing || e.keyCode === 229) return;

        // promptInput 안의 모든 keydown 은 글로벌로 안 새게 한다.
        // 이유: selectFavItem → insertChipAtCaret → promptInput.blur() 가 일어나는
        // 동안 activeElement 가 body 로 바뀌어 document 핸들러의 contenteditable
        // 가드가 fail. 그 결과 글로벌 Enter 가 grid 의 selected 카드에 openPath
        // (lightbox) 를 발동시킴.
        // capture/bubble 둘 다 막아 외부 영향 완전 차단.
        e.stopPropagation();

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

        // (Shift+Backspace 는 위에서 IME 가드보다 먼저 처리됨)

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
