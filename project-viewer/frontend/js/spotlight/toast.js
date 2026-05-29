// 토스트 알림.

import { escapeHtml } from "./utils.js";

export function showToast(msg, hint, isError) {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " error" : "");
    el.innerHTML = escapeHtml(msg) + (hint ? `<span class="toast-hint">${escapeHtml(hint)}</span>` : "");
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}
