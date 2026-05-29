// 참조 이미지 추가: 직접 URL / 외부 파일 업로드 + 드래그/드롭/페이스트 이벤트.

import { promptInput, promptRowEl, addRefBtn } from "./dom.js";
import { insertChipAtCaret, ensureCaretInPrompt, insertMixedAtCaret, clearPrompt } from "./prompt.js";
import { postUpload } from "./api.js";
import { showToast } from "./toast.js";
import { openFavPicker, closeFavPicker, isFavPickerOpen, loadFavorites } from "./favPicker.js";
import { state, cache, sourceFavorites } from "./state.js";
import { favName } from "./refModel.js";
import {
    updateModelChip, updateRatioChip, renderDynamicOptions, filterModelsByType,
} from "./modelControls.js";
import { updateCostEstimate } from "./generate.js";

// 붙여넣은 텍스트의 @name 마커를 사용 가능한 즐겨찾기 ref 와 매칭.
// 매칭된 @-토큰은 chip 으로, 사이/나머지 텍스트는 그대로 → parts 배열 반환.
// 매칭 0건이면 null 반환 (기본 paste 진행).
function parseAtMarkers(text) {
    if (!/@\S/.test(text)) return null;
    const favs = sourceFavorites();
    if (favs.length === 0) return null;
    // 더 긴 이름이 더 먼저 매칭되도록 정렬 (예: "img1-img2" 가 "img1" 보다 우선)
    const sorted = [...favs].sort((a, b) => favName(b).length - favName(a).length);

    const parts = [];
    let i = 0;
    let matched = false;
    while (i < text.length) {
        const at = text.indexOf("@", i);
        if (at < 0) {
            if (i < text.length) parts.push({ type: "text", value: text.slice(i) });
            break;
        }
        if (at > i) parts.push({ type: "text", value: text.slice(i, at) });
        // @ 뒤로 favName 시도
        const rest = text.slice(at + 1);
        const hit = sorted.find((f) => {
            const n = favName(f);
            if (!n) return false;
            if (!rest.startsWith(n)) return false;
            // 다음 문자가 단어 일부면 부분 매칭 (잘못된 hit) → 거부
            // favName 자체에 공백이 거의 없고, 영문/숫자/밑줄/하이픈 으로 끝남이 일반
            // 다음 문자가 알파넘이면 거부
            const ch = rest.charAt(n.length);
            return ch === "" || /[\s.,;:!?@()\[\]{}]/.test(ch);
        });
        if (hit) {
            parts.push({ type: "chip", value: hit });
            i = at + 1 + favName(hit).length;
            matched = true;
        } else {
            // 매칭 안 됨 → @ 그대로 텍스트로
            parts.push({ type: "text", value: "@" });
            i = at + 1;
        }
    }
    return matched ? parts : null;
}

// /media URL 에서 project/path 추출 → sidecar JSON 가져오기.
async function fetchSidecarFromMediaUrl(url) {
    if (!url || !url.includes("/media")) return null;
    try {
        const u = new URL(url, location.origin);
        const project = u.searchParams.get("project");
        const path = u.searchParams.get("path");
        if (!project || !path) return null;
        const res = await fetch(
            `/api/meta?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`
        );
        if (!res.ok) return null;
        const data = await res.json();
        return data.sidecar || null;
    } catch { return null; }
}

const SIDECAR_OPT_KEYS = [
    "resolution", "quality", "mode", "duration", "sound", "genre",
    "flux_variant", "veo_variant", "minimax_variant", "batch_size",
];

// sidecar 의 생성 설정을 spotlight 전체 상태로 복원.
function applyGenerationSidecar(sc) {
    if (!sc || !sc.model) return false;
    // 모델 type 알아내서 image/video 토글도 맞추기
    const allM = cache.allModels.find((m) => m.id === sc.model);
    if (allM && state.type !== allM.type) {
        state.type = allM.type;
        document.querySelectorAll(".type-btn").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.type === state.type);
        });
        filterModelsByType();
    }
    state.model = sc.model;
    if (sc.aspect_ratio) state.ratio = sc.aspect_ratio;

    // 옵션 + 카운트
    state.optionValues = {};
    state.repeatCount = 1;
    for (const k of SIDECAR_OPT_KEYS) {
        if (sc[k] != null && sc[k] !== "") state.optionValues[k] = sc[k];
    }
    // batch_size 가 없고 job 이 여러 개면 repeat 카운트로 추정
    if (state.optionValues.batch_size == null
        && Array.isArray(sc.job_ids) && sc.job_ids.length > 1) {
        state.repeatCount = Math.min(4, sc.job_ids.length);
    }

    // UI 갱신
    updateModelChip();
    updateRatioChip();
    renderDynamicOptions();

    // 프롬프트 + ref chips 복원
    clearPrompt();
    const promptText = sc.display_prompt || sc.prompt || "";
    const refs = (sc.source_ids || [])
        .map((sid) => cache.favorites.find((f) => f.id === sid))
        .filter(Boolean);

    // display_prompt 안에 @마커가 매칭되면 그 순서대로, 아니면 chip 들 먼저 + 텍스트
    const parsed = parseAtMarkers(promptText);
    let parts;
    if (parsed) {
        parts = parsed;
    } else {
        parts = [];
        for (const r of refs) parts.push({ type: "chip", value: r });
        if (refs.length && promptText) parts.push({ type: "text", value: " " });
        if (promptText) parts.push({ type: "text", value: promptText });
    }
    insertMixedAtCaret(parts);

    updateCostEstimate();
    showToast(`'${sc.model}' 설정 복원됨`, sc.prompt ? sc.prompt.slice(0, 40) + "…" : "", false);
    return true;
}

function addDirectRef(url) {
    const name = url.split("/").pop().split("?")[0] || "image";
    const dotIdx = name.lastIndexOf(".");
    const cleanName = dotIdx > 0 ? name.substring(0, dotIdx) : name;
    const ref = { directUrl: url, name: cleanName.substring(0, 20) };
    insertChipAtCaret(ref, false);
}

async function uploadAndAddRef(file) {
    try {
        const data = await postUpload(file);
        const dotIdx = file.name.lastIndexOf(".");
        const cleanName = dotIdx > 0 ? file.name.substring(0, dotIdx) : file.name;
        const thumb = URL.createObjectURL(file);
        const ref = {
            uploadPath: data.path,
            name: cleanName.substring(0, 20),
            localThumb: thumb,
        };
        insertChipAtCaret(ref, false);
    } catch (err) {
        showToast("업로드 실패: " + err.message, null, true);
    }
}

export function bindRefImages() {
    // + 버튼 → fav picker 토글
    addRefBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isFavPickerOpen()) closeFavPicker();
        else loadFavorites().then(() => openFavPicker());
        promptInput.focus();
    });

    // dragover / dragleave 하이라이트
    // stopPropagation: viewer 의 document-level 핸들러가 내부 드래그에 dropEffect="none"
    // 을 강제하지 못하도록 — 안 막으면 드롭 자체가 차단됨.
    promptRowEl.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        promptRowEl.classList.add("drop-active");
    });
    promptRowEl.addEventListener("dragleave", (e) => {
        if (!promptRowEl.contains(e.relatedTarget)) {
            promptRowEl.classList.remove("drop-active");
        }
    });

    // drop
    promptRowEl.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        promptRowEl.classList.remove("drop-active");
        promptInput.focus();

        // 드롭 지점으로 캐럿 이동
        let dropRange = null;
        if (document.caretRangeFromPoint) {
            dropRange = document.caretRangeFromPoint(e.clientX, e.clientY);
        } else if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
            if (pos) {
                dropRange = document.createRange();
                dropRange.setStart(pos.offsetNode, pos.offset);
                dropRange.collapse(true);
            }
        }
        if (dropRange && promptInput.contains(dropRange.startContainer)) {
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(dropRange);
        } else {
            ensureCaretInPrompt();
        }

        // 0. viewer 의 내부 카드 (application/x-pv-internal) → sidecar 있으면 설정 복원
        if (e.dataTransfer.getData("application/x-pv-internal") === "card") {
            const url = e.dataTransfer.getData("text/uri-list")
                || e.dataTransfer.getData("text/plain") || "";
            const firstUrl = url.split(/\r?\n/).find((s) => /^https?:\/\//i.test(s)) || url;
            const sc = await fetchSidecarFromMediaUrl(firstUrl);
            if (sc && applyGenerationSidecar(sc)) return;
            // sidecar 없는 일반 viewer 이미지 → ref 로 추가
            if (firstUrl) { addDirectRef(firstUrl.trim()); return; }
        }

        // 1. 내부 생성 이미지 (spotlight 결과 카드)
        const hfRef = e.dataTransfer.getData("application/x-hf-ref");
        if (hfRef) {
            // hfRef 가 viewer 의 /media URL 이면 (자동 저장된 결과) sidecar 시도
            if (hfRef.includes("/media") && hfRef.includes("project=")) {
                const sc = await fetchSidecarFromMediaUrl(hfRef);
                if (sc && applyGenerationSidecar(sc)) return;
            }
            addDirectRef(hfRef); return;
        }

        // 2. 로컬 파일
        const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
        if (files.length) {
            for (const file of files) await uploadAndAddRef(file);
            return;
        }

        // 3. 다른 브라우저 탭의 <img> 드래그
        const html = e.dataTransfer.getData("text/html");
        if (html) {
            const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
            if (match && match[1].startsWith("http")) {
                addDirectRef(match[1]);
                return;
            }
        }

        // 4. URL fallback
        const uri = e.dataTransfer.getData("text/uri-list")
            || e.dataTransfer.getData("text/plain") || "";
        const firstUrl = uri.split("\n").find((l) => l.startsWith("http"));
        if (firstUrl) addDirectRef(firstUrl.trim());
    });

    // 클립보드 paste (Ctrl+V)
    promptRowEl.addEventListener("paste", async (e) => {
        const items = Array.from(e.clipboardData.items);

        // 클립보드 이미지 (스크린샷, copy image)
        const imageItem = items.find((i) => i.type.startsWith("image/"));
        if (imageItem) {
            e.preventDefault();
            const file = imageItem.getAsFile();
            if (file) await uploadAndAddRef(file);
            return;
        }

        // 텍스트 (동기적으로 읽어야 preventDefault 효과 있음)
        const text = e.clipboardData.getData("text/plain") || "";
        if (!text) return;
        const trimmed = text.trim();

        // 1. 단일 이미지 URL
        if (/^https?:\/\/.+\.(png|jpg|jpeg|gif|webp|bmp)/i.test(trimmed)) {
            e.preventDefault();
            addDirectRef(trimmed);
            return;
        }

        // 2. @-마커 자동 변환 (복사한 프롬프트 다시 붙여넣기)
        const parts = parseAtMarkers(text);
        if (parts) {
            e.preventDefault();
            insertMixedAtCaret(parts);
            return;
        }

        // 그 외: 기본 paste 진행
    });
}
