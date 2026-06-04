// 프로젝트 선택 칩 + 드롭다운.

import { projectBtn, projectValue, projectDropdown } from "./dom.js";
import { state, cache } from "./state.js";
import { PROJECT_KEY } from "./constants.js";
import { escapeHtml } from "./utils.js";
import { closeAllDropdowns } from "./dropdowns.js";
import { showToast } from "./toast.js";
import { fetchProjects } from "./api.js";

export function updateProjectChip() {
    if (!projectValue) return;
    projectValue.textContent = state.project || "(프로젝트 선택)";
}

export async function loadProjects() {
    try {
        const data = await fetchProjects();
        cache.projects = Array.isArray(data.projects) ? data.projects : [];
    } catch {
        cache.projects = [];
    }
    if (state.project && !cache.projects.includes(state.project)) {
        state.project = "";
        try { localStorage.removeItem(PROJECT_KEY); } catch {}
    }
    updateProjectChip();
}

function showProjectDropdown() {
    closeAllDropdowns();
    if (cache.projects.length === 0) {
        showToast("프로젝트가 없습니다", "viewer 에서 먼저 프로젝트를 만드세요", true);
        return;
    }
    const items = [
        `<button class="dropdown-item${!state.project ? " selected" : ""}" type="button" data-project="">(선택 안함)</button>`,
        ...cache.projects.map((p) =>
            `<button class="dropdown-item${p === state.project ? " selected" : ""}" type="button" data-project="${escapeHtml(p)}">📁 ${escapeHtml(p)}</button>`
        ),
    ];
    projectDropdown.innerHTML = items.join("");
    const rect = projectBtn.getBoundingClientRect();
    projectDropdown.style.position = "fixed";
    projectDropdown.style.left = rect.left + "px";
    projectDropdown.style.top = (rect.bottom + 4) + "px";
    projectDropdown.style.right = "auto";
    projectDropdown.style.width = "auto";
    projectDropdown.style.minWidth = Math.max(150, rect.width) + "px";
    projectDropdown.classList.remove("hidden");
    projectDropdown.querySelectorAll("[data-project]").forEach((btn) => {
        btn.addEventListener("click", () => {
            state.project = btn.dataset.project;
            try {
                if (state.project) localStorage.setItem(PROJECT_KEY, state.project);
                else localStorage.removeItem(PROJECT_KEY);
            } catch {}
            updateProjectChip();
            closeAllDropdowns();
        });
    });
}

export function bindProject() {
    if (!projectBtn) return;
    projectBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!projectDropdown.classList.contains("hidden")) {
            closeAllDropdowns();
        } else {
            showProjectDropdown();
        }
    });
}
