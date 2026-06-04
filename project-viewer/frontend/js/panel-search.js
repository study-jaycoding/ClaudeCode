// =====================================================================
// 사이드바 panel 검색 — 각 탭(구성/소스/생성) 상단의 검색 input.
// 트리는 매칭되는 항목 + 그 모든 조상 폴더만 표시 (조상 폴더는 자동 펼침).
// 즐겨찾기 리스트는 flat 매칭 (이름/경로/태그 텍스트 전체).
// =====================================================================
import { fileTree, favoritesList } from "./dom.js";

const generatedJobsList = document.getElementById("generated-jobs-list");

/** 트리(file-tree, gen-tree) 의 매칭 + 조상 표시 필터. */
function filterTree(treeEl, query) {
    if (!treeEl) return;
    const q = (query || "").trim().toLowerCase();
    // reset
    treeEl.querySelectorAll(".search-hidden").forEach((el) => el.classList.remove("search-hidden"));
    if (!q) return;

    const visible = new Set();
    treeEl.querySelectorAll(".file-label, .dir-label").forEach((label) => {
        const text = (label.textContent || "").toLowerCase();
        if (!text.includes(q)) return;
        // 자기 li 와 모든 조상 li 표시 + 조상 dir 자동 펼침
        let li = label.closest("li");
        while (li && li !== treeEl) {
            visible.add(li);
            if (li.classList.contains("dir")) {
                li.classList.remove("collapsed");
                const chev = li.querySelector(":scope > .dir-row > .chevron");
                if (chev && chev.textContent === "▶") chev.textContent = "▼";
            }
            li = li.parentElement && li.parentElement.closest("li");
        }
    });
    // 매칭/조상 아니면 hide
    treeEl.querySelectorAll("li").forEach((li) => {
        if (!visible.has(li)) li.classList.add("search-hidden");
    });
}

/** 즐겨찾기 리스트 flat 매칭. project/path/tag 전체 텍스트 검색. */
function filterFavorites(query) {
    if (!favoritesList) return;
    const q = (query || "").trim().toLowerCase();
    favoritesList.querySelectorAll(".fav-item").forEach((li) => {
        if (!q) { li.classList.remove("search-hidden"); return; }
        const text = (li.textContent || "").toLowerCase();
        li.classList.toggle("search-hidden", !text.includes(q));
    });
}

/** 생성 탭의 jobs 카드 list 매칭. 검색 중에는 날짜 헤더는 모두 숨김. */
function filterGeneratedJobs(query) {
    if (!generatedJobsList) return;
    const q = (query || "").trim().toLowerCase();
    generatedJobsList.querySelectorAll(".q-date-header").forEach((h) => {
        h.classList.toggle("search-hidden", !!q);
    });
    generatedJobsList.querySelectorAll(".q-item").forEach((li) => {
        if (!q) { li.classList.remove("search-hidden"); return; }
        const text = (li.textContent || "").toLowerCase();
        li.classList.toggle("search-hidden", !text.includes(q));
    });
}

// 각 input 에 핸들러 등록. 검색은 디바운스 없이 즉시 (수백 항목 처리에 충분히 빠름).
document.querySelectorAll(".panel-search-input").forEach((input) => {
    input.addEventListener("input", () => {
        const target = input.dataset.target;
        const v = input.value;
        if (target === "tree") filterTree(fileTree, v);
        else if (target === "generated") filterGeneratedJobs(v);
        else if (target === "favorites") filterFavorites(v);
    });
});

// 트리/리스트가 재렌더된 후에도 현재 검색어를 다시 적용해야 함.
export function reapplyPanelSearch() {
    document.querySelectorAll(".panel-search-input").forEach((input) => {
        const target = input.dataset.target;
        const v = input.value;
        if (!v) return;
        if (target === "tree") filterTree(fileTree, v);
        else if (target === "generated") filterGeneratedJobs(v);
        else if (target === "favorites") filterFavorites(v);
    });
}
