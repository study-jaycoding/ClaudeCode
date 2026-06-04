// 모델 셀렉터 + 비율 셀렉터 + 동적 옵션 렌더.

import {
    modelBtn, modelName, providerDot,
    ratioBtn, ratioValue,
    modelDropdown, ratioDropdown, dynamicOpts,
} from "./dom.js";
import { state, cache, getModel } from "./state.js";
import { PROVIDER_COLORS, PROVIDER_LETTERS } from "./constants.js";
import { escapeHtml } from "./utils.js";
import { closeAllDropdowns } from "./dropdowns.js";

// ── Model chip ──────────────────────────────────────────────
export function updateModelChip() {
    const m = getModel(state.model);
    if (!m) return;
    modelName.textContent = m.name;
    providerDot.style.background = PROVIDER_COLORS[m.provider] || "#888";
    providerDot.textContent = PROVIDER_LETTERS[m.provider] || "?";
}

function renderModelDropdown() {
    const grouped = {};
    for (const m of cache.models) {
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

export function toggleModelDropdown() {
    const show = modelDropdown.classList.contains("hidden");
    closeAllDropdowns();
    if (show) {
        renderModelDropdown();
        modelDropdown.classList.remove("hidden");
    }
}

// ── Ratio chip ──────────────────────────────────────────────
export function updateRatioChip() {
    ratioValue.textContent = state.ratio;
}

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

export function toggleRatioDropdown() {
    const show = ratioDropdown.classList.contains("hidden");
    closeAllDropdowns();
    if (show) {
        renderRatioDropdown();
        ratioDropdown.classList.remove("hidden");
    }
}

// ── Dynamic options ─────────────────────────────────────────
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

export function renderDynamicOptions() {
    const m = getModel(state.model);
    dynamicOpts.innerHTML = "";
    if (!m || !m.options) return;

    const opts = m.options;

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

    // 수량 카운터 (batch_size 또는 repeat) — 항상 맨 뒤
    const batchCfg = opts.batch_size;
    const cur = batchCfg
        ? (state.optionValues.batch_size || batchCfg.default || 1)
        : (state.repeatCount || 1);
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

// ── Combined updates ────────────────────────────────────────
export function onModelChange() {
    const m = getModel(state.model);
    if (!m) return;
    state.optionValues = {};
    state.repeatCount = 1;
    if (m.options) {
        for (const [key, config] of Object.entries(m.options)) {
            if (config.default != null) state.optionValues[key] = config.default;
        }
    }
    // aspect_ratios 가 빈 배열인 모델 (예: minimax_hailuo) 은 ratio chip 자체 숨김.
    const hasRatio = Array.isArray(m.aspect_ratios) && m.aspect_ratios.length > 0;
    ratioBtn.classList.toggle("hidden", !hasRatio);
    if (hasRatio) {
        if (!m.aspect_ratios.includes(state.ratio)) {
            state.ratio = m.aspect_ratios[0];
        }
    } else {
        state.ratio = "";
    }
    updateModelChip();
    updateRatioChip();
    renderDynamicOptions();
}

export function filterModelsByType() {
    cache.models = cache.allModels.filter((m) => m.type === state.type);
    const cur = getModel(state.model);
    if (!cur && cache.models.length > 0) {
        state.model = cache.models[0].id;
    }
}

export function bindModelControls() {
    modelBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleModelDropdown(); });
    ratioBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleRatioDropdown(); });
}
