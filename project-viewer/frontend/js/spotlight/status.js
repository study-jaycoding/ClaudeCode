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

let loginInFlight = false;

export async function doLogin() {
    if (loginInFlight) return;

    // 1. 외부에서 이미 로그인했을 수 있으니 먼저 재확인
    statusText.textContent = "확인 중...";
    if (await loadBalance()) return;

    loginInFlight = true;
    statusText.textContent = "로그인 중... (브라우저에서 승인하세요)";
    statusIndicator.classList.remove("connected");

    // 2. 백엔드 login 트리거. 응답을 기다리지 않고 폴링으로 완료 감지.
    postLogin().catch(() => {});

    // 3. 최대 90초 동안 2초 간격 polling
    try {
        for (let i = 0; i < 45; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            if (await loadBalance()) {
                showToast("로그인 성공!", null, false);
                return;
            }
        }
        showToast("로그인 시간 초과", "터미널에서 'higgsfield auth login' 직접 실행", true);
        updateStatus();
    } finally {
        loginInFlight = false;
    }
}

export function bindStatusBar() {
    statusBar.addEventListener("click", () => { doLogin(); });
}
