"use strict";

// =====================================================================
// DOM
// =====================================================================
const spotlight = document.getElementById("spotlight");
const backdrop = document.getElementById("backdrop");
const promptInput = document.getElementById("prompt-input");
const modelBtn = document.getElementById("model-btn");
const modelName = document.getElementById("model-name");
const providerDot = document.getElementById("provider-dot");
const ratioBtn = document.getElementById("ratio-btn");
const ratioValue = document.getElementById("ratio-value");
const genBtn = document.getElementById("gen-btn");
const dynamicOpts = document.getElementById("dynamic-opts");
const modelDropdown = document.getElementById("model-dropdown");
const ratioDropdown = document.getElementById("ratio-dropdown");
const results = document.getElementById("results");
const resultsGrid = document.getElementById("results-grid");
const resultsLabel = document.getElementById("results-label");
const resultsClose = document.getElementById("results-close");
const statusIndicator = document.getElementById("status-indicator");
const statusText = document.getElementById("status-text");
const statusCredits = document.getElementById("status-credits");
const lightbox = document.getElementById("lightbox");
const lightboxBody = document.getElementById("lightbox-body");
const lightboxClose = document.getElementById("lightbox-close");
const refChips = document.getElementById("ref-chips");
const favPicker = document.getElementById("fav-picker");
const favList = document.getElementById("fav-list");
const favEmpty = document.getElementById("fav-empty");
const addRefBtn = document.getElementById("add-ref-btn");

// =====================================================================
// State
// =====================================================================
let allModels = [];
let models = [];
let favorites = [];
let refImages = [];
let state = {
    type: "image",
    model: "nano_banana_2",
    ratio: "16:9",
    optionValues: {},
    repeatCount: 1,
    connected: false,
    credits: 0,
};

const PROVIDER_COLORS = {
    Google: "#4ade80", Higgsfield: "#60a5fa", OpenAI: "#a78bfa",
    "Black Forest Labs": "#f472b6", Bytedance: "#fb923c",
    Kling: "#facc15", xAI: "#f87171", "Tongyi-MAI": "#2dd4bf",
};
const PROVIDER_LETTERS = {
    Google: "G", Higgsfield: "H", OpenAI: "O",
    "Black Forest Labs": "B", Bytedance: "B",
    Kling: "K", xAI: "X", "Tongyi-MAI": "Z",
};

// =====================================================================
// Helpers
// =====================================================================
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
}

function getModel(id) { return models.find((m) => m.id === id); }

function closeAllDropdowns() {
    modelDropdown.classList.add("hidden");
    ratioDropdown.classList.add("hidden");
    closeFavPicker();
    document.querySelectorAll(".opt-dropdown").forEach((d) => d.remove());
}

function showToast(msg, hint, isError) {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " error" : "");
    el.innerHTML = escapeHtml(msg) + (hint ? `<span class="toast-hint">${escapeHtml(hint)}</span>` : "");
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

// =====================================================================
// UI Updates
// =====================================================================
function updateModelChip() {
    const m = getModel(state.model);
    if (!m) return;
    modelName.textContent = m.name;
    const color = PROVIDER_COLORS[m.provider] || "#888";
    const letter = PROVIDER_LETTERS[m.provider] || "?";
    providerDot.style.background = color;
    providerDot.textContent = letter;
}

function updateRatioChip() {
    ratioValue.textContent = state.ratio;
}

function updateStatus() {
    statusIndicator.classList.toggle("connected", state.connected);
    statusText.textContent = state.connected ? "연결됨" : "CLI 미연결 — 클릭하여 로그인";
    statusText.style.cursor = state.connected ? "default" : "pointer";
    statusCredits.textContent = state.connected && state.credits >= 0 ? `${state.credits.toLocaleString()} credits` : "";
}

function renderDynamicOptions() {
    const m = getModel(state.model);
    dynamicOpts.innerHTML = "";
    if (!m || !m.options) return;

    const opts = m.options;
    const hasBatch = "batch_size" in opts;

    for (const [key, config] of Object.entries(opts)) {
        if (key === "batch_size") continue;

        if (key === "duration" && config.min != null) {
            const cur = state.optionValues.duration || config.default || config.min;
            const slider = document.createElement("div");
            slider.className = "duration-slider";
            slider.innerHTML = `
                <span class="opt-label">duration</span>
                <input type="range" class="dur-range" min="${config.min}" max="${config.max}"
                       value="${cur}" step="1" />
                <span class="dur-value">${cur}s</span>`;
            const range = slider.querySelector(".dur-range");
            const label = slider.querySelector(".dur-value");
            range.addEventListener("input", () => {
                state.optionValues.duration = parseInt(range.value);
                label.textContent = range.value + "s";
            });
            dynamicOpts.appendChild(slider);
            continue;
        }

        if (!config.values) continue;
        const curVal = state.optionValues[key] || config.default || config.values[0];
        const chip = document.createElement("button");
        chip.className = "opt-chip";
        chip.type = "button";
        chip.innerHTML = `<span class="opt-label">${key}</span>${curVal}`;
        chip.addEventListener("click", (e) => {
            e.stopPropagation();
            closeAllDropdowns();
            showOptDropdown(chip, key, config);
        });
        dynamicOpts.appendChild(chip);
    }

    // Count (batch_size or repeat) — always last
    const batchCfg = opts.batch_size;
    const cur = batchCfg ? (state.optionValues.batch_size || batchCfg.default || 1) : (state.repeatCount || 1);
    const max = batchCfg ? (batchCfg.max || 4) : 4;
    const min = batchCfg ? (batchCfg.min || 1) : 1;
    const group = document.createElement("div");
    group.className = "count-group";
    group.innerHTML = `
        <button class="count-btn" type="button" data-dir="-1">−</button>
        <span class="count-display">${cur}/${max}</span>
        <button class="count-btn" type="button" data-dir="1">+</button>`;
    group.querySelectorAll(".count-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            const dir = parseInt(btn.dataset.dir);
            if (batchCfg) {
                const val = (state.optionValues.batch_size || batchCfg.default || 1) + dir;
                if (val >= min && val <= max) {
                    state.optionValues.batch_size = val;
                    group.querySelector(".count-display").textContent = `${val}/${max}`;
                }
            } else {
                const val = (state.repeatCount || 1) + dir;
                if (val >= 1 && val <= max) {
                    state.repeatCount = val;
                    group.querySelector(".count-display").textContent = `${val}/${max}`;
                }
            }
        });
    });
    dynamicOpts.appendChild(group);
}

function showOptDropdown(anchor, key, config) {
    const dd = document.createElement("div");
    dd.className = "dropdown opt-dropdown";

    const cur = state.optionValues[key] || config.default || config.values[0];
    let html = '<div class="option-grid">';
    for (const v of config.values) {
        const sel = String(v) === String(cur) ? " selected" : "";
        html += `<button class="option-pill${sel}" data-val="${v}">${v}</button>`;
    }
    html += "</div>";
    dd.innerHTML = html;

    dd.querySelectorAll(".option-pill").forEach((pill) => {
        pill.addEventListener("click", (e) => {
            e.stopPropagation();
            state.optionValues[key] = pill.dataset.val;
            dd.remove();
            renderDynamicOptions();
        });
    });

    document.querySelector(".spotlight-content").appendChild(dd);
}

function onModelChange() {
    const m = getModel(state.model);
    if (!m) return;
    state.optionValues = {};
    state.repeatCount = 1;
    if (m.options) {
        for (const [key, config] of Object.entries(m.options)) {
            if (config.default != null) state.optionValues[key] = config.default;
        }
    }
    if (!m.aspect_ratios.includes(state.ratio)) {
        state.ratio = m.aspect_ratios[0] || "1:1";
    }
    updateModelChip();
    updateRatioChip();
    renderDynamicOptions();
}

function syncUI() {
    onModelChange();
    updateStatus();
}

// =====================================================================
// Model dropdown
// =====================================================================
function renderModelDropdown() {
    const grouped = {};
    for (const m of models) {
        (grouped[m.provider] = grouped[m.provider] || []).push(m);
    }
    let html = "";
    for (const [provider, items] of Object.entries(grouped)) {
        html += `<div class="dropdown-title">${escapeHtml(provider)}</div>`;
        for (const m of items) {
            const sel = m.id === state.model ? " selected" : "";
            const color = PROVIDER_COLORS[provider] || "#888";
            html += `
                <div class="dropdown-item${sel}" data-model="${m.id}">
                    <span class="di-dot" style="background:${color}"></span>
                    <div class="di-info">
                        <div class="di-name">${escapeHtml(m.name)}</div>
                        <div class="di-desc">${escapeHtml(m.description)}</div>
                    </div>
                    <span class="di-check">&#x2713;</span>
                </div>`;
        }
    }
    modelDropdown.innerHTML = html;
    modelDropdown.querySelectorAll(".dropdown-item").forEach((el) => {
        el.addEventListener("click", () => {
            state.model = el.dataset.model;
            closeAllDropdowns();
            onModelChange();
        });
    });
}

function toggleModelDropdown() {
    const show = modelDropdown.classList.contains("hidden");
    closeAllDropdowns();
    if (show) { renderModelDropdown(); modelDropdown.classList.remove("hidden"); }
}

// =====================================================================
// Ratio dropdown
// =====================================================================
function renderRatioDropdown() {
    const m = getModel(state.model);
    const ratios = m ? m.aspect_ratios : ["1:1", "4:3", "16:9", "9:16"];
    let html = '<div class="option-grid">';
    for (const r of ratios) {
        const sel = r === state.ratio ? " selected" : "";
        html += `<button class="option-pill${sel}" data-ratio="${r}">${escapeHtml(r)}</button>`;
    }
    html += "</div>";
    ratioDropdown.innerHTML = html;
    ratioDropdown.querySelectorAll(".option-pill").forEach((el) => {
        el.addEventListener("click", () => {
            state.ratio = el.dataset.ratio;
            closeAllDropdowns();
            updateRatioChip();
        });
    });
}

function toggleRatioDropdown() {
    const show = ratioDropdown.classList.contains("hidden");
    closeAllDropdowns();
    if (show) { renderRatioDropdown(); ratioDropdown.classList.remove("hidden"); }
}

// =====================================================================
// Spotlight
// =====================================================================
function openSpotlight() {
    spotlight.classList.remove("hidden");
    setTimeout(() => promptInput.focus(), 50);
}

// =====================================================================
// Lightbox
// =====================================================================
function openLightbox(src, isVideo) {
    if (isVideo) {
        lightboxBody.innerHTML = `<video src="${src}" controls autoplay loop></video>`;
    } else {
        lightboxBody.innerHTML = `<img src="${src}" alt="Generated" />`;
    }
    lightbox.classList.remove("hidden");
}
function closeLightbox() {
    lightbox.classList.add("hidden");
    lightboxBody.innerHTML = "";
}
lightboxClose.addEventListener("click", closeLightbox);
lightbox.addEventListener("click", (e) => { if (e.target === lightbox) closeLightbox(); });

// =====================================================================
// Generate
// =====================================================================
async function doGenerate() {
    const prompt = promptInput.value.trim();
    if (!prompt) { promptInput.focus(); showToast("프롬프트를 입력하세요.", null, true); return; }

    genBtn.disabled = true;
    genBtn.textContent = "Generating...";
    closeFavPicker();

    const totalCount = state.optionValues.batch_size || state.repeatCount || 1;
    results.classList.remove("hidden");
    resultsLabel.textContent = "Generating...";
    resultsGrid.innerHTML = "";
    for (let i = 0; i < totalCount; i++) {
        resultsGrid.innerHTML += `<div class="result-skeleton"></div>`;
    }

    try {
        const body = {
            model: state.model,
            prompt,
            aspect_ratio: state.ratio,
            ref_urls: refImages.map((f) => refUrl(f)),
            repeat: state.repeatCount || 1,
        };
        for (const [key, val] of Object.entries(state.optionValues)) {
            if (val != null) body[key] = val;
        }

        const res = await fetch("/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await res.json();

        if (!res.ok) {
            resultsGrid.innerHTML = "";
            results.classList.add("hidden");
            showToast(data.error || "생성 실패", data.hint || null, true);
            return;
        }

        const images = data.images || [];
        const jobIds = data.job_ids || [];
        if (images.length > 0) {
            resultsLabel.textContent = "Complete";
            renderCompletedImages(images);
        } else if (jobIds.length > 0) {
            resultsLabel.textContent = `Queued ${jobIds.length} job(s)...`;
            pollJobs(jobIds);
        } else {
            resultsLabel.textContent = "No results";
        }
    } catch (err) {
        resultsGrid.innerHTML = "";
        results.classList.add("hidden");
        showToast("서버 연결 실패", err.message, true);
    } finally {
        genBtn.disabled = false;
        genBtn.innerHTML = `Generate <span class="gen-sparkle">&#x2726;</span>`;
    }
}

function renderCompletedImages(images) {
    resultsGrid.innerHTML = "";
    const isVideo = state.type === "video";
    for (const img of images) {
        const card = document.createElement("div");
        card.className = "result-card" + (isVideo ? " result-video" : "");
        card.draggable = true;
        card.dataset.url = img.url;
        card.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/uri-list", img.url);
            e.dataTransfer.setData("application/x-hf-ref", img.url);
        });
        if (isVideo) {
            card.innerHTML = `<video src="${img.url}" preload="metadata" muted loop></video>
                <div class="play-badge">&#9654;</div>`;
            const video = card.querySelector("video");
            card.addEventListener("mouseenter", () => { video.play().catch(() => {}); });
            card.addEventListener("mouseleave", () => { video.pause(); video.currentTime = 0; });
            card.addEventListener("click", () => openLightbox(img.url, true));
        } else {
            card.innerHTML = `<img src="${img.url}" alt="Generated" loading="lazy" draggable="false" />`;
            card.addEventListener("click", () => openLightbox(img.url, false));
        }
        resultsGrid.appendChild(card);
    }
}

async function pollJobs(jobIds) {
    const completed = new Map();
    for (let attempt = 0; attempt < 60; attempt++) {
        let allDone = true;
        for (const jid of jobIds) {
            if (completed.has(jid)) continue;
            try {
                const res = await fetch(`/api/jobs/${jid}`);
                if (!res.ok) continue;
                const data = await res.json();
                if (data.status === "completed") {
                    completed.set(jid, (data.images || []).map((img) => img.url));
                } else if (data.status === "failed") {
                    completed.set(jid, []);
                } else { allDone = false; }
            } catch { allDone = false; }
        }
        const allImages = [];
        for (const jid of jobIds) {
            const urls = completed.get(jid);
            if (urls) allImages.push(...urls.map((u) => ({ url: u })));
        }
        if (allImages.length > 0) renderCompletedImages(allImages);
        if (allDone || completed.size === jobIds.length) {
            resultsLabel.textContent = "Complete";
            return;
        }
        resultsLabel.textContent = `Generating... (${completed.size}/${jobIds.length})`;
        await new Promise((r) => setTimeout(r, 2000));
    }
    resultsLabel.textContent = "Timeout";
}

// =====================================================================
// Data loading
// =====================================================================
async function loadModels() {
    try {
        const res = await fetch("/api/models");
        const data = await res.json();
        allModels = data.models || [];
        filterModelsByType();
        syncUI();
    } catch (err) { console.error("Failed to load models:", err); }
}

function filterModelsByType() {
    models = allModels.filter((m) => m.type === state.type);
    const cur = getModel(state.model);
    if (!cur && models.length > 0) {
        state.model = models[0].id;
    }
}

async function loadBalance() {
    try {
        const res = await fetch("/api/balance");
        const data = await res.json();
        state.connected = data.connected || false;
        state.credits = data.credits || 0;
        updateStatus();
        return state.connected;
    } catch { state.connected = false; updateStatus(); return false; }
}

// =====================================================================
// Event bindings
// =====================================================================
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        if (!lightbox.classList.contains("hidden")) { closeLightbox(); return; }
        const anyDropdown = !modelDropdown.classList.contains("hidden")
            || !ratioDropdown.classList.contains("hidden")
            || isFavPickerOpen()
            || document.querySelector(".opt-dropdown");
        if (anyDropdown) closeAllDropdowns();
    }
});

promptInput.addEventListener("keydown", (e) => {
    if (isFavPickerOpen()) {
        if (e.key === "Escape") { e.stopPropagation(); closeFavPicker(); stripAtQuery(); return; }
        if (["ArrowDown", "ArrowUp", "Tab"].includes(e.key)) return;
        if (e.key === "Enter" && favHighlight >= 0) return;
        if (e.key === "Enter") { e.preventDefault(); closeFavPicker(); stripAtQuery(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doGenerate();
    }
});

backdrop.addEventListener("click", closeAllDropdowns);

// Type toggle (Image / Video)
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

// Status bar click → login
document.getElementById("status-bar").addEventListener("click", () => { doLogin(); });

async function doLogin() {
    if (state.connected) return;
    statusText.textContent = "로그인 중... (브라우저에서 승인하세요)";
    statusIndicator.classList.remove("connected");
    try {
        const res = await fetch("/api/login", { method: "POST" });
        const data = await res.json();
        if (res.ok) {
            showToast("로그인 성공!", null, false);
            await loadBalance();
        } else {
            showToast(data.error || "로그인 실패", null, true);
            updateStatus();
        }
    } catch (err) {
        showToast("로그인 실패: " + err.message, null, true);
        updateStatus();
    }
}
modelBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleModelDropdown(); });
ratioBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleRatioDropdown(); });
genBtn.addEventListener("click", doGenerate);
resultsClose.addEventListener("click", () => { results.classList.add("hidden"); resultsGrid.innerHTML = ""; });
document.addEventListener("click", (e) => {
    if (!e.target.closest(".dropdown") && !e.target.closest(".opt-dropdown")
        && !e.target.closest(".chip") && !e.target.closest(".opt-chip")) {
        closeAllDropdowns();
    }
});

// =====================================================================
// @ Favorites picker
// =====================================================================
async function loadFavorites() {
    try { const res = await fetch("/api/favorites"); const data = await res.json(); favorites = data.favorites || []; }
    catch { favorites = []; }
}

function mediaUrl(fav) {
    if (fav.directUrl) return fav.directUrl;
    if (fav.localThumb) return fav.localThumb;
    return `/pv-media?project=${encodeURIComponent(fav.project)}&path=${encodeURIComponent(fav.path)}`;
}
function refUrl(fav) {
    if (fav.directUrl) return fav.directUrl;
    if (fav.uploadPath) return fav.uploadPath;
    return `/pv-media?project=${encodeURIComponent(fav.project)}&path=${encodeURIComponent(fav.path)}`;
}
function favName(fav) {
    if (fav.name) return fav.name;
    const full = fav.path.split("/").pop();
    const dot = full.lastIndexOf(".");
    return dot > 0 ? full.substring(0, dot) : full;
}
function favKey(fav) {
    if (fav.directUrl) return fav.directUrl;
    if (fav.uploadPath) return fav.uploadPath;
    return `${fav.project}/${fav.path}`;
}
function isRefSelected(fav) { return refImages.some((r) => favKey(r) === favKey(fav)); }

let favHighlight = -1;
let filteredFavs = [];

function openFavPicker() {
    modelDropdown.classList.add("hidden");
    ratioDropdown.classList.add("hidden");
    favHighlight = -1;
    renderFavList();
    favPicker.classList.remove("hidden");
}
function closeFavPicker() { favPicker.classList.add("hidden"); favHighlight = -1; }
function isFavPickerOpen() { return !favPicker.classList.contains("hidden"); }

function renderFavList() {
    const query = promptInput.value;
    const atIdx = query.lastIndexOf("@");
    const filter = atIdx >= 0 ? query.substring(atIdx + 1).toLowerCase() : "";
    filteredFavs = filter
        ? favorites.filter((f) => favName(f).toLowerCase().includes(filter) || f.project.toLowerCase().includes(filter))
        : [...favorites];
    if (filteredFavs.length === 0) { favList.innerHTML = ""; favEmpty.classList.remove("hidden"); return; }
    favEmpty.classList.add("hidden");
    favList.innerHTML = "";
    filteredFavs.forEach((fav, i) => {
        const selected = isRefSelected(fav);
        const item = document.createElement("div");
        item.className = "fav-item" + (selected ? " selected" : "") + (i === favHighlight ? " highlight" : "");
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

function selectFavItem(fav) {
    if (isRefSelected(fav)) {
        closeFavPicker();
        stripAtQuery();
        promptInput.focus();
        return;
    }
    refImages.push(fav);
    renderRefChips();
    stripAtQuery();
    closeFavPicker();
    promptInput.focus();
}

function stripAtQuery() {
    const val = promptInput.value;
    const atIdx = val.lastIndexOf("@");
    if (atIdx >= 0) {
        promptInput.value = val.substring(0, atIdx);
    }
}

function toggleRefImage(fav) {
    const key = favKey(fav);
    const idx = refImages.findIndex((r) => favKey(r) === key);
    if (idx >= 0) refImages.splice(idx, 1); else refImages.push(fav);
}

function removeRefImage(idx) {
    refImages.splice(idx, 1);
    renderRefChips();
    promptInput.focus();
}

function renderRefChips() {
    refChips.innerHTML = "";
    refImages.forEach((fav, i) => {
        const tag = document.createElement("div");
        tag.className = "ref-tag";
        tag.title = `${fav.project} / ${fav.path}`;
        tag.innerHTML = `
            <img class="ref-tag-thumb" src="${mediaUrl(fav)}" alt="" />
            <span class="ref-tag-name">${escapeHtml(favName(fav))}</span>
            <button class="ref-tag-remove" type="button">&times;</button>`;
        tag.querySelector(".ref-tag-remove").addEventListener("click", (e) => { e.stopPropagation(); removeRefImage(i); });
        refChips.appendChild(tag);
    });
}

promptInput.addEventListener("input", () => {
    const val = promptInput.value;
    const caretPos = promptInput.selectionStart;
    const charBefore = caretPos > 0 ? val[caretPos - 1] : "";
    if (charBefore === "@" && !isFavPickerOpen()) {
        favHighlight = -1;
        loadFavorites().then(() => openFavPicker());
    } else if (isFavPickerOpen()) {
        favHighlight = -1;
        renderFavList();
        if (filteredFavs.length === 0 && !val.includes("@")) {
            closeFavPicker();
        }
    }
});

promptInput.addEventListener("keydown", (e) => {
    if (!isFavPickerOpen()) return;

    if (e.key === "ArrowDown") {
        e.preventDefault();
        favHighlight = Math.min(favHighlight + 1, filteredFavs.length - 1);
        updateFavHighlight();
    } else if (e.key === "ArrowUp") {
        e.preventDefault();
        favHighlight = Math.max(favHighlight - 1, 0);
        updateFavHighlight();
    } else if (e.key === "Enter") {
        if (favHighlight >= 0 && favHighlight < filteredFavs.length) {
            e.preventDefault();
            selectFavItem(filteredFavs[favHighlight]);
        }
    } else if (e.key === "Tab") {
        e.preventDefault();
        if (filteredFavs.length > 0) {
            const idx = favHighlight >= 0 ? favHighlight : 0;
            selectFavItem(filteredFavs[idx]);
        }
    }
});

function updateFavHighlight() {
    favList.querySelectorAll(".fav-item").forEach((el) => {
        el.classList.toggle("highlight", parseInt(el.dataset.idx) === favHighlight);
    });
    const highlighted = favList.querySelector(".fav-item.highlight");
    if (highlighted) highlighted.scrollIntoView({ block: "nearest" });
}

addRefBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isFavPickerOpen()) { closeFavPicker(); }
    else { loadFavorites().then(() => openFavPicker()); }
    promptInput.focus();
});

// =====================================================================
// Drag & drop reference images
// =====================================================================
const promptRow = document.querySelector(".prompt-row");

promptRow.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    promptRow.classList.add("drop-active");
});

promptRow.addEventListener("dragleave", (e) => {
    if (!promptRow.contains(e.relatedTarget)) {
        promptRow.classList.remove("drop-active");
    }
});

promptRow.addEventListener("drop", async (e) => {
    e.preventDefault();
    promptRow.classList.remove("drop-active");

    // 1. Internal generated image
    const hfRef = e.dataTransfer.getData("application/x-hf-ref");
    if (hfRef) { addDirectRef(hfRef); return; }

    // 2. Local files
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
        for (const file of files) await uploadAndAddRef(file);
        return;
    }

    // 3. Web image (dragged from browser)
    const html = e.dataTransfer.getData("text/html");
    if (html) {
        const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (match && match[1].startsWith("http")) {
            addDirectRef(match[1]);
            return;
        }
    }

    // 4. URL fallback
    const uri = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || "";
    const firstUrl = uri.split("\n").find((l) => l.startsWith("http"));
    if (firstUrl) { addDirectRef(firstUrl.trim()); }
});

// 5. Clipboard paste (Ctrl+V)
promptRow.addEventListener("paste", async (e) => {
    const items = Array.from(e.clipboardData.items);

    // Image from clipboard (screenshot, copy image)
    const imageItem = items.find((i) => i.type.startsWith("image/"));
    if (imageItem) {
        e.preventDefault();
        const file = imageItem.getAsFile();
        if (file) await uploadAndAddRef(file);
        return;
    }

    // URL text from clipboard
    const textItem = items.find((i) => i.type === "text/plain");
    if (textItem) {
        textItem.getAsString((text) => {
            const trimmed = text.trim();
            if (/^https?:\/\/.+\.(png|jpg|jpeg|gif|webp|bmp)/i.test(trimmed)) {
                e.preventDefault();
                addDirectRef(trimmed);
            }
        });
    }
});


function addDirectRef(url) {
    const name = url.split("/").pop().split("?")[0] || "image";
    const dotIdx = name.lastIndexOf(".");
    const cleanName = dotIdx > 0 ? name.substring(0, dotIdx) : name;
    const ref = { directUrl: url, name: cleanName.substring(0, 20) };
    if (refImages.some((r) => favKey(r) === favKey(ref))) return;
    refImages.push(ref);
    renderRefChips();
    promptInput.focus();
}

async function uploadAndAddRef(file) {
    try {
        const res = await fetch("/api/upload", {
            method: "POST",
            headers: {
                "Content-Type": file.type || "image/png",
                "X-File-Name": encodeURIComponent(file.name),
            },
            body: file,
        });
        if (!res.ok) return;
        const data = await res.json();
        const dotIdx = file.name.lastIndexOf(".");
        const cleanName = dotIdx > 0 ? file.name.substring(0, dotIdx) : file.name;
        const thumb = URL.createObjectURL(file);
        const ref = { uploadPath: data.path, name: cleanName.substring(0, 20), localThumb: thumb };
        refImages.push(ref);
        renderRefChips();
        promptInput.focus();
    } catch (err) {
        showToast("업로드 실패: " + err.message, null, true);
    }
}

// =====================================================================
// Init
// =====================================================================
syncUI();
loadModels();
loadFavorites();

(async function init() {
    const connected = await loadBalance();
    if (!connected) {
        spotlight.classList.add("hidden");
        await doLogin();
    }
    openSpotlight();
})();
