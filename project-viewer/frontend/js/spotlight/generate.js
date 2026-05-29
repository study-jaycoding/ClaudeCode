// 생성 흐름: 폼 빌드 → POST → 결과/폴링 → 카드 렌더링.

import {
    promptInput, genBtn, results, resultsGrid,
    resultsToggle, resultsToggleIcon, resultsUnseen,
} from "./dom.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import { showToast } from "./toast.js";
import { getPromptText, getPromptRefs, getPromptDisplayText } from "./prompt.js";
import { refUrl } from "./refModel.js";
import { openLightbox } from "./lightbox.js";
import { closeFavPicker } from "./favPicker.js";
import { postGenerate, fetchJobStatus, postCost } from "./api.js";

// 현재 추정 크레딧 (Generate 버튼에 표시).
let estimatedCredits = null;

function renderGenBtn() {
    const costHtml = estimatedCredits != null && estimatedCredits > 0
        ? ` <span class="gen-cost">${estimatedCredits}</span>`
        : "";
    genBtn.innerHTML = `Generate <span class="gen-sparkle">&#x2726;</span>${costHtml}`;
}

function setGenButton(enabled, text) {
    // 생성 중에도 추가 클릭 가능하도록 항상 활성. text 인자는 호환성 위해 받지만 무시.
    genBtn.disabled = false;
    renderGenBtn();
}

// ── Cost 추정 ───────────────────────────────────────────────
let costDebounce = null;
let costSeq = 0;

function buildCostPayload() {
    const body = {
        model: state.model,
        aspect_ratio: state.ratio,
        repeat: state.repeatCount || 1,
    };
    for (const [key, val] of Object.entries(state.optionValues)) {
        if (val != null) body[key] = val;
    }
    return body;
}

export function updateCostEstimate() {
    clearTimeout(costDebounce);
    costDebounce = setTimeout(async () => {
        const mySeq = ++costSeq;
        try {
            const data = await postCost(buildCostPayload());
            if (mySeq !== costSeq) return;
            estimatedCredits = Math.round(data.credits_total || 0);
        } catch {
            if (mySeq !== costSeq) return;
            estimatedCredits = null;
        }
        if (!genBtn.disabled) renderGenBtn();
    }, 350);
}

function renderMetaOverlay(meta) {
    if (!meta || (!meta.credits_per_job && !meta.creator)) return "";
    const cost = meta.credits_per_job != null
        ? `<span class="meta-cost">✦ ${meta.credits_per_job}</span>` : "";
    const creator = meta.creator
        ? `<span class="meta-creator">${escapeHtml(meta.creator.split("@")[0])}</span>` : "";
    return `<div class="meta-overlay">${creator}${cost}</div>`;
}

// container 에 결과 카드를 append (혹은 container.innerHTML="" 후 채움).
function _appendCardsTo(container, images, sourceIds, saved, savedProject) {
    const isVideo = state.type === "video";
    const sidsJson = sourceIds && sourceIds.length ? JSON.stringify(sourceIds) : "";
    for (let idx = 0; idx < images.length; idx++) {
        const img = images[idx];
        const savedInfo = saved && saved[idx] ? saved[idx] : null;
        const dragUrl = (savedInfo && savedProject)
            ? `${location.origin}/media?project=${encodeURIComponent(savedProject)}&path=${encodeURIComponent(savedInfo.path)}`
            : img.url;
        const card = document.createElement("div");
        card.className = "result-card" + (isVideo ? " result-video" : "");
        card.draggable = true;
        card.dataset.url = img.url;
        if (sidsJson) card.dataset.sourceIds = sidsJson;
        card.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/uri-list", dragUrl);
            e.dataTransfer.setData("application/x-hf-ref", dragUrl);
            if (sidsJson) e.dataTransfer.setData("application/x-source-ids", sidsJson);
        });
        const meta = img.metadata || {};
        const metaOverlay = renderMetaOverlay(meta);

        if (isVideo) {
            card.innerHTML = `<video src="${img.url}" preload="metadata" muted loop></video>
                <div class="play-badge">&#9654;</div>${metaOverlay}`;
            const video = card.querySelector("video");
            card.addEventListener("mouseenter", () => { video.play().catch(() => {}); });
            card.addEventListener("mouseleave", () => { video.pause(); video.currentTime = 0; });
            card.addEventListener("click", () => openLightbox(img.url, true, meta));
        } else {
            card.innerHTML = `<img src="${img.url}" alt="Generated" loading="lazy" draggable="false" />${metaOverlay}`;
            card.addEventListener("click", () => openLightbox(img.url, false, meta));
        }
        container.appendChild(card);
    }
}

// 호환용 — 외부에서 호출 가능. (현재는 doGenerate 가 batch 단위로 처리)
export function renderCompletedImages(images, sourceIds = [], saved = [], savedProject = "") {
    resultsGrid.innerHTML = "";
    if (results.classList.contains("hidden") && images) {
        unseenCount = images.length;
        updateUnseenBadge();
    }
    _appendCardsTo(resultsGrid, images, sourceIds, saved, savedProject);
}

async function pollJobs(jobIds, sourceIds, batch) {
    const completed = new Map();
    for (let attempt = 0; attempt < 60; attempt++) {
        let allDone = true;
        for (const jid of jobIds) {
            if (completed.has(jid)) continue;
            try {
                const data = await fetchJobStatus(jid);
                if (data.status === "completed") {
                    completed.set(jid, (data.images || []).map((img) => img.url));
                } else if (data.status === "failed") {
                    completed.set(jid, []);
                } else {
                    allDone = false;
                }
            } catch {
                allDone = false;
            }
        }
        const allImages = [];
        for (const jid of jobIds) {
            const urls = completed.get(jid);
            if (urls) allImages.push(...urls.map((u) => ({ url: u })));
        }
        if (allImages.length > 0) {
            batch.innerHTML = "";
            _appendCardsTo(batch, allImages, sourceIds);
        }
        if (allDone || completed.size === jobIds.length) return;
        await new Promise((r) => setTimeout(r, 2000));
    }
}

export async function doGenerate() {
    const prompt = getPromptText();
    const promptRefs = getPromptRefs();
    if (!prompt && promptRefs.length === 0) {
        promptInput.focus();
        showToast("프롬프트를 입력하세요.", null, true);
        return;
    }
    if (!state.project) {
        showToast("프로젝트가 선택되지 않았습니다", "📁 칩에서 결과 저장 프로젝트 선택", true);
        return;
    }

    closeFavPicker();

    // 이 generate 만의 batch 컨테이너 — 동시에 여러 generate 가 돌아도 서로 안 건드림.
    const totalCount = state.optionValues.batch_size || state.repeatCount || 1;
    onGenerateStart();
    const batch = document.createElement("div");
    batch.className = "result-batch";
    for (let i = 0; i < totalCount; i++) {
        const sk = document.createElement("div");
        sk.className = "result-skeleton";
        batch.appendChild(sk);
    }
    resultsGrid.appendChild(batch);

    const sourceIds = promptRefs.map((f) => f.id).filter(Boolean);

    try {
        const displayPrompt = getPromptDisplayText();
        const body = {
            model: state.model,
            prompt,
            display_prompt: displayPrompt !== prompt ? displayPrompt : undefined,
            aspect_ratio: state.ratio,
            ref_urls: promptRefs.map((f) => refUrl(f)),
            repeat: state.repeatCount || 1,
            project: state.project,
            source_ids: sourceIds,
            auto_download: true,
        };
        for (const [key, val] of Object.entries(state.optionValues)) {
            if (val != null) body[key] = val;
        }

        const { ok, data } = await postGenerate(body);
        if (!ok) {
            batch.remove();
            showToast(data.error || "생성 실패", data.hint || null, true);
            return;
        }

        const images = data.images || [];
        const jobIds = data.job_ids || [];
        const saved = data.saved || [];
        if (saved.length > 0) {
            showToast(`viewer 의 ${state.project}/Result 에 ${saved.length}개 자동 저장`, null, false);
        }
        if (images.length > 0) {
            // 이 batch 의 skeleton 을 결과 카드로 교체
            batch.innerHTML = "";
            _appendCardsTo(batch, images, sourceIds, saved, state.project);
            // 접힌 상태면 unseen 증가
            if (results.classList.contains("hidden")) {
                unseenCount += images.length;
                updateUnseenBadge();
            }
        } else if (jobIds.length > 0) {
            pollJobs(jobIds, sourceIds, batch);
        } else {
            batch.remove();
        }
    } catch (err) {
        batch.remove();
        showToast("서버 연결 실패", err.message, true);
    }
}

// ── 결과 토글 + unseen 카운트 ──────────────────────────
// 상태: results 가 hidden = 접힘 (토글 버튼은 +), 보임 = 펼침 (토글 버튼은 ×)
// userCollapsed = 사용자가 명시적으로 접었는지. true 면 새 generate 가 자동 펼치지 않음.
let unseenCount = 0;
let userCollapsed = false;

function updateUnseenBadge() {
    if (unseenCount > 0) {
        resultsUnseen.textContent = unseenCount;
        resultsUnseen.classList.remove("hidden");
    } else {
        resultsUnseen.classList.add("hidden");
    }
}

export function setResultsExpanded(expanded) {
    results.classList.toggle("hidden", !expanded);
    resultsToggleIcon.textContent = expanded ? "×" : "+";
    resultsToggle.title = expanded ? "결과 접기" : "결과 펼치기";
    if (expanded) {
        unseenCount = 0;
        updateUnseenBadge();
    }
}

export function ensureResultsToggleVisible() {
    resultsToggle.classList.remove("hidden");
}

export function bindGenerate() {
    genBtn.addEventListener("click", doGenerate);
    resultsToggle.addEventListener("click", () => {
        const wasCollapsed = results.classList.contains("hidden");
        setResultsExpanded(wasCollapsed);          // 접혀있었으면 펼침
        userCollapsed = !wasCollapsed;             // 사용자 의도 기록
    });
}

// doGenerate 가 호출할 때 사용 (skeleton 보여주기 전)
export function onGenerateStart() {
    ensureResultsToggleVisible();
    if (!userCollapsed) setResultsExpanded(true);
}
