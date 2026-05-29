// 드롭다운 공용 키보드 네비게이션.
// 한 번에 하나의 드롭다운만 활성 — 활성 시 ↑↓Enter/Home/End + 첫 글자 점프 처리.

let activeDropdown = null;
let highlight = -1;

function getItems() {
    if (!activeDropdown) return [];
    return Array.from(activeDropdown.querySelectorAll(".dropdown-item, .option-pill"));
}

// 항목 라벨: 모델 아이템은 .di-name, 그 외는 자체 textContent.
function getLabel(item) {
    const dn = item.querySelector(".di-name");
    const t = (dn ? dn.textContent : item.textContent) || "";
    return t.trim().toLowerCase();
}

function update() {
    const items = getItems();
    items.forEach((el, i) => el.classList.toggle("kbd-active", i === highlight));
    if (highlight >= 0 && items[highlight]) {
        items[highlight].scrollIntoView({ block: "nearest" });
    }
}

// 드롭다운을 보여준 직후 호출. selectedSelector 로 현재 선택 항목 찾아 하이라이트 초기화.
export function activateKbdNav(dropdown, selectedSelector = ".selected") {
    activeDropdown = dropdown;
    const items = getItems();
    highlight = selectedSelector ? items.findIndex((el) => el.matches(selectedSelector)) : -1;
    update();
}

export function deactivateKbdNav() {
    if (activeDropdown) {
        for (const el of getItems()) el.classList.remove("kbd-active");
    }
    activeDropdown = null;
    highlight = -1;
}

// document keydown 에서 호출. 처리했으면 true.
export function handleKbdNav(e) {
    if (!activeDropdown) return false;
    // 드롭다운이 화면에서 빠졌으면 자동 정리
    if (!document.body.contains(activeDropdown) || activeDropdown.classList.contains("hidden")) {
        deactivateKbdNav();
        return false;
    }
    const items = getItems();
    if (items.length === 0) return false;

    if (e.key === "ArrowDown") {
        e.preventDefault();
        highlight = Math.min(highlight + 1, items.length - 1);
        if (highlight < 0) highlight = 0;
        update();
        return true;
    }
    if (e.key === "ArrowUp") {
        e.preventDefault();
        highlight = Math.max(highlight - 1, 0);
        update();
        return true;
    }
    if (e.key === "Enter") {
        e.preventDefault();
        if (highlight >= 0 && items[highlight]) items[highlight].click();
        return true;
    }
    if (e.key === "Home") {
        e.preventDefault();
        highlight = 0;
        update();
        return true;
    }
    if (e.key === "End") {
        e.preventDefault();
        highlight = items.length - 1;
        update();
        return true;
    }
    // 첫 글자 점프 (a-z, 0-9). 같은 글자 반복 시 다음 후보로 cycle.
    if (e.key.length === 1 && /^[a-zA-Z0-9]$/.test(e.key)
        && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const letter = e.key.toLowerCase();
        const start = highlight + 1;
        let found = -1;
        for (let i = start; i < items.length; i++) {
            if (getLabel(items[i]).startsWith(letter)) { found = i; break; }
        }
        if (found === -1) {
            for (let i = 0; i < start && i < items.length; i++) {
                if (getLabel(items[i]).startsWith(letter)) { found = i; break; }
            }
        }
        if (found >= 0) { highlight = found; update(); }
        return true;
    }
    return false;
}
