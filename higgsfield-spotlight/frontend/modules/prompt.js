// contenteditable 프롬프트의 텍스트/참조/캐럿/인라인 칩 헬퍼.

import { promptInput } from "./dom.js";
import { escapeHtml } from "./utils.js";
import { mediaUrl, favName, favKey } from "./refModel.js";

export function getPromptText() {
    let text = "";
    function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
        else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList && node.classList.contains("inline-ref")) return;
            if (node.tagName === "BR") text += "\n";
            else node.childNodes.forEach(walk);
        }
    }
    promptInput.childNodes.forEach(walk);
    return text.trim();
}

export function getPromptRefs() {
    const refs = [];
    promptInput.querySelectorAll(".inline-ref").forEach((el) => {
        try { refs.push(JSON.parse(el.dataset.ref)); } catch {}
    });
    return refs;
}

export function clearPrompt() { promptInput.innerHTML = ""; }

export function isRefInDom(ref) {
    const key = favKey(ref);
    return Array.from(promptInput.querySelectorAll(".inline-ref")).some((el) => {
        try { return favKey(JSON.parse(el.dataset.ref)) === key; }
        catch { return false; }
    });
}

export function getCaretRange() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!promptInput.contains(range.startContainer)) return null;
    return range;
}

export function ensureCaretInPrompt() {
    const range = getCaretRange();
    if (range) return range;
    const r = document.createRange();
    r.selectNodeContents(promptInput);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    return r;
}

function getTriggerQueryInfo(char) {
    const range = getCaretRange();
    if (!range || !range.collapsed) return null;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return null;
    const before = node.textContent.substring(0, range.startOffset);
    const idx = before.lastIndexOf(char);
    if (idx < 0) return null;
    const query = before.substring(idx + 1);
    if (/\s/.test(query)) return null;
    return { textNode: node, atIdx: idx, query };
}

export function getAtQueryInfo() { return getTriggerQueryInfo("@"); }
export function getBackslashQueryInfo() { return getTriggerQueryInfo("\\"); }

export function stripAtQuery() {
    const at = getAtQueryInfo();
    if (!at) return;
    const r = document.createRange();
    r.setStart(at.textNode, at.atIdx);
    r.setEnd(at.textNode, at.atIdx + 1 + at.query.length);
    r.deleteContents();
}

export function stripBackslashQuery() {
    const bs = getBackslashQueryInfo();
    if (!bs) return;
    const r = document.createRange();
    r.setStart(bs.textNode, bs.atIdx);
    r.setEnd(bs.textNode, bs.atIdx + 1 + bs.query.length);
    r.deleteContents();
}

function createInlineChip(ref) {
    const chip = document.createElement("span");
    chip.className = "inline-ref";
    chip.contentEditable = "false";
    chip.dataset.ref = JSON.stringify(ref);
    chip.innerHTML = `<img src="${mediaUrl(ref)}" alt="" /><span class="inline-ref-name">${escapeHtml(favName(ref))}</span><button class="inline-ref-remove" type="button" tabindex="-1">&times;</button>`;
    chip.querySelector(".inline-ref-remove").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        chip.remove();
        promptInput.focus();
    });
    return chip;
}

export function insertChipAtCaret(ref, replaceAtQuery) {
    if (isRefInDom(ref)) {
        if (replaceAtQuery) stripAtQuery();
        promptInput.focus();
        return;
    }
    promptInput.focus();
    let range;
    if (replaceAtQuery) {
        const at = getAtQueryInfo();
        if (at) {
            range = document.createRange();
            range.setStart(at.textNode, at.atIdx);
            range.setEnd(at.textNode, at.atIdx + 1 + at.query.length);
            range.deleteContents();
        }
    }
    if (!range) range = ensureCaretInPrompt();
    range = getCaretRange() || ensureCaretInPrompt();

    const chip = createInlineChip(ref);
    range.insertNode(chip);

    // 칩 뒤에 공백 + 앞에 zero-width space 로 IME 컨텍스트 분리
    const space = document.createTextNode("  ");
    chip.parentNode.insertBefore(space, chip.nextSibling);
    const beforeText = document.createTextNode("​");
    chip.parentNode.insertBefore(beforeText, chip);

    const newRange = document.createRange();
    newRange.setStart(space, space.textContent.length);
    newRange.collapse(true);

    // IME 상태 리셋
    promptInput.blur();
    requestAnimationFrame(() => {
        promptInput.focus();
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(newRange);
    });
}
