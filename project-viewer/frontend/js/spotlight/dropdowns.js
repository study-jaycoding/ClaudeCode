// 여러 드롭다운/피커를 한꺼번에 닫는 디스패처.
// 각 모듈이 자신의 close 함수를 register 한다 (circular import 회피).

import { modelDropdown, ratioDropdown, projectDropdown } from "./dom.js";
import { deactivateKbdNav } from "./kbdNav.js";

const closers = new Set();

export function registerCloser(fn) {
    closers.add(fn);
}

export function closeAllDropdowns() {
    modelDropdown.classList.add("hidden");
    ratioDropdown.classList.add("hidden");
    if (projectDropdown) projectDropdown.classList.add("hidden");
    document.querySelectorAll(".opt-dropdown").forEach((d) => d.remove());
    deactivateKbdNav();
    closers.forEach((fn) => { try { fn(); } catch {} });
}
