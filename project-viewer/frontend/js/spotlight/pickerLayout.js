// 피커(@ 즐겨찾기 / / 태그) 를 prompt 패널 위쪽에 고정 배치.
// 화면 하단 도킹된 spotlight 에서 아래로 펼치면 잘리므로 위로 띄움.

export function anchorPickerAbovePanel(picker, panel, opts = {}) {
    if (!picker || !panel) return;
    const rect = panel.getBoundingClientRect();
    const gap = opts.gap ?? 8;
    const topPad = opts.topPad ?? 24;
    // 패널 전체 폭을 쓰면 너무 넓어서 답답함 — 적당한 고정폭 (단, 패널보다 넓진 않게).
    const width = Math.min(opts.width ?? 320, rect.width);
    picker.style.position = "fixed";
    picker.style.left = rect.left + "px";
    picker.style.right = "auto";
    picker.style.top = "auto";
    picker.style.bottom = (window.innerHeight - rect.top + gap) + "px";
    picker.style.width = width + "px";
    picker.style.maxHeight = Math.max(160, rect.top - topPad) + "px";
    picker.style.overflowY = "auto";
    picker.style.zIndex = "60";
}
