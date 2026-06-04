// 상태바 (CLI 연결 상태 + 크레딧) + 로그인 트리거.

import { statusIndicator, statusText, statusCredits, statusBar } from "./dom.js";
import { state } from "./state.js";
import { fetchBalance, postLogin } from "./api.js";
import { showToast } from "./toast.js";

export function updateStatus() {
    statusIndicator.classList.toggle("connected", state.connected);
    statusText.textContent = state.connected ? "연결됨" : "CLI 미연결 — 클릭하여 로그인";
    statusText.style.cursor = state.connected ? "default" : "pointer";
    statusCredits.textContent = state.connected && state.credits >= 0
        ? `${state.credits.toLocaleString()} credits`
        : "";
}

export async function loadBalance() {
    try {
        const data = await fetchBalance();
        state.connected = data.connected || false;
        state.credits = data.credits || 0;
        updateStatus();
        return state.connected;
    } catch {
        state.connected = false;
        updateStatus();
        return false;
    }
}

export async function doLogin() {
    if (state.connected) return;
    statusText.textContent = "로그인 중... (브라우저에서 승인하세요)";
    statusIndicator.classList.remove("connected");
    try {
        const { ok, data } = await postLogin();
        if (ok) {
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

export function bindStatusBar() {
    statusBar.addEventListener("click", () => { doLogin(); });
}
