// 생성 흐름: 폼 빌드 → POST → 결과/폴링 → 카드 렌더링.

import {
    promptInput, genBtn, results, resultsGrid, resultsLabel, resultsClose,
} from "./dom.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import { showToast } from "./toast.js";
import { getPromptText, getPromptRefs } from "./prompt.js";
import { refUrl } from "./refModel.js";
import { openLightbox } from "./lightbox.js";
import { closeFavPicker } from "./favPicker.js";
import { postGenerate, fetchJobStatus, postSave } from "./api.js";
import { getModel } from "./state.js";

function setGenButton(enabled, text) {
    genBtn.disabled = !enabled;
    if (text) genBtn.textContent = text;
    else genBtn.innerHTML = `Generate <span class="gen-sparkle">&#x2726;</span>`;
}

function renderMetaOverlay(meta) {
    if (!meta || (!meta.credits_per_job && !meta.creator)) return "";
    const cost = meta.credits_per_job != null
        ? `<span class="meta-cost">✦ ${meta.credits_per_job}</span>` : "";
    const creator = meta.creator
        ? `<span class="meta-creator">${escapeHtml(meta.creator.split("@")[0])}</span>` : "";
    return `<div class="meta-overlay">${creator}${cost}</div>`;
}

export function renderCompletedImages(images, sourceIds = []) {
    resultsGrid.innerHTML = "";
    const isVideo = state.type === "video";
    const sidsJson = sourceIds && sourceIds.length ? JSON.stringify(sourceIds) : "";
    for (const img of images) {
        const card = document.createElement("div");
        card.className = "result-card" + (isVideo ? " result-video" : "");
        card.draggable = true;
        card.dataset.url = img.url;
        if (sidsJson) card.dataset.sourceIds = sidsJson;
        card.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/uri-list", img.url);
            e.dataTransfer.setData("application/x-hf-ref", img.url);
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
        resultsGrid.appendChild(card);
    }
}

async function pollJobs(jobIds, sourceIds = []) {
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
        if (allImages.length > 0) renderCompletedImages(allImages, sourceIds);
        if (allDone || completed.size === jobIds.length) {
            resultsLabel.textContent = "Complete";
            return allImages.map((i) => i.url);
        }
        resultsLabel.textContent = `Generating... (${completed.size}/${jobIds.length})`;
        await new Promise((r) => setTimeout(r, 2000));
    }
    resultsLabel.textContent = "Timeout";
    return [];
}

export async function doGenerate() {
    const prompt = getPromptText();
    const promptRefs = getPromptRefs();
    if (!prompt && promptRefs.length === 0) {
        promptInput.focus();
        showToast("프롬프트를 입력하세요.", null, true);
        return;
    }

    setGenButton(false, "Generating...");
    closeFavPicker();

    const totalCount = state.optionValues.batch_size || state.repeatCount || 1;
    results.classList.remove("hidden");
    resultsLabel.textContent = "Generating...";
    resultsGrid.innerHTML = "";
    for (let i = 0; i < totalCount; i++) {
        resultsGrid.innerHTML += `<div class="result-skeleton"></div>`;
    }

    // viewer lineage 연결용
    const sourceIds = promptRefs.map((f) => f.id).filter(Boolean);

    if (!state.project) {
        showToast("프로젝트가 선택되지 않았습니다", "📁 칩에서 결과 저장 프로젝트 선택", true);
        setGenButton(true);
        return;
    }

    // 모델별 사전 검증: 이미지 ref 가 필수인 모델 (예: veo3) 은 ref 없으면 차단.
    const model = getModel(state.model);
    if (model && model.requires_image && promptRefs.length === 0) {
        showToast(
            `${model.name} 은(는) 이미지 ref 가 필수입니다`,
            "프롬프트에서 @ 로 이미지를 추가하세요",
            true,
        );
        setGenButton(true);
        results.classList.add("hidden");
        resultsGrid.innerHTML = "";
        return;
    }

    try {
        const body = {
            model: state.model,
            prompt,
            ref_urls: promptRefs.map((f) => refUrl(f)),
            repeat: state.repeatCount || 1,
            project: state.project,
            source_ids: sourceIds,
            auto_download: true,
        };
        // aspect_ratio 안 받는 모델 (예: minimax_hailuo) 은 body 에서 제외.
        if (state.ratio) body.aspect_ratio = state.ratio;
        for (const [key, val] of Object.entries(state.optionValues)) {
            if (val != null) body[key] = val;
        }

        const { ok, data } = await postGenerate(body);
        if (!ok) {
            resultsGrid.innerHTML = "";
            results.classList.add("hidden");
            showToast(data.error || "생성 실패", data.hint || null, true);
            return;
        }

        const images = data.images || [];
        const jobIds = data.job_ids || [];
        const saved = data.saved || [];
        const metadata = data.metadata || {};
        if (saved.length > 0) {
            showToast(`viewer 의 ${state.project}/Result 에 ${saved.length}개 자동 저장`, null, false);
        }
        if (images.length > 0) {
            resultsLabel.textContent = "Complete";
            renderCompletedImages(images, sourceIds);
        } else if (jobIds.length > 0) {
            resultsLabel.textContent = `Queued ${jobIds.length} job(s)...`;
            // 비디오처럼 --wait 안에 안 끝난 경우, 폴링 완료 후 백엔드에 저장 요청.
            // 백엔드가 첫 응답에서 이미 saved 한 게 있으면 (이미지 모델) 건너뜀.
            const urls = await pollJobs(jobIds, sourceIds);
            if (urls.length > 0 && state.project && saved.length === 0) {
                try {
                    const { ok, data: sdata } = await postSave({
                        project: state.project,
                        urls,
                        source_ids: sourceIds,
                        metadata,
                    });
                    if (ok && (sdata.saved || []).length > 0) {
                        showToast(
                            `viewer 의 ${state.project}/Result 에 ${sdata.saved.length}개 자동 저장`,
                            null, false,
                        );
                    }
                } catch (err) {
                    showToast("자동 저장 실패", err.message, true);
                }
            }
        } else {
            resultsLabel.textContent = "No results";
        }
    } catch (err) {
        resultsGrid.innerHTML = "";
        results.classList.add("hidden");
        showToast("서버 연결 실패", err.message, true);
    } finally {
        setGenButton(true);
    }
}

export function bindGenerate() {
    genBtn.addEventListener("click", doGenerate);
    resultsClose.addEventListener("click", () => {
        results.classList.add("hidden");
        resultsGrid.innerHTML = "";
    });
}
