// 참조 이미지 추가: 직접 URL / 외부 파일 업로드 + 드래그/드롭/페이스트 이벤트.

import { promptInput, promptRowEl, addRefBtn } from "./dom.js";
import { insertChipAtCaret, ensureCaretInPrompt } from "./prompt.js";
import { postUpload } from "./api.js";
import { showToast } from "./toast.js";
import { openFavPicker, closeFavPicker, isFavPickerOpen, loadFavorites } from "./favPicker.js";

function addDirectRef(url) {
    const name = url.split("/").pop().split("?")[0] || "image";
    const dotIdx = name.lastIndexOf(".");
    const cleanName = dotIdx > 0 ? name.substring(0, dotIdx) : name;
    const ref = { directUrl: url, name: cleanName.substring(0, 20) };
    insertChipAtCaret(ref, false);
}

async function uploadAndAddRef(file) {
    try {
        const data = await postUpload(file);
        const dotIdx = file.name.lastIndexOf(".");
        const cleanName = dotIdx > 0 ? file.name.substring(0, dotIdx) : file.name;
        const thumb = URL.createObjectURL(file);
        const ref = {
            uploadPath: data.path,
            name: cleanName.substring(0, 20),
            localThumb: thumb,
        };
        insertChipAtCaret(ref, false);
    } catch (err) {
        showToast("업로드 실패: " + err.message, null, true);
    }
}

export function bindRefImages() {
    // + 버튼 → fav picker 토글
    addRefBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isFavPickerOpen()) closeFavPicker();
        else loadFavorites().then(() => openFavPicker());
        promptInput.focus();
    });

    // dragover / dragleave 하이라이트
    promptRowEl.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        promptRowEl.classList.add("drop-active");
    });
    promptRowEl.addEventListener("dragleave", (e) => {
        if (!promptRowEl.contains(e.relatedTarget)) {
            promptRowEl.classList.remove("drop-active");
        }
    });

    // drop
    promptRowEl.addEventListener("drop", async (e) => {
        e.preventDefault();
        promptRowEl.classList.remove("drop-active");
        promptInput.focus();

        // 드롭 지점으로 캐럿 이동
        let dropRange = null;
        if (document.caretRangeFromPoint) {
            dropRange = document.caretRangeFromPoint(e.clientX, e.clientY);
        } else if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
            if (pos) {
                dropRange = document.createRange();
                dropRange.setStart(pos.offsetNode, pos.offset);
                dropRange.collapse(true);
            }
        }
        if (dropRange && promptInput.contains(dropRange.startContainer)) {
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(dropRange);
        } else {
            ensureCaretInPrompt();
        }

        // 1. 내부 생성 이미지
        const hfRef = e.dataTransfer.getData("application/x-hf-ref");
        if (hfRef) { addDirectRef(hfRef); return; }

        // 2. 로컬 파일
        const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
        if (files.length) {
            for (const file of files) await uploadAndAddRef(file);
            return;
        }

        // 3. 다른 브라우저 탭의 <img> 드래그
        const html = e.dataTransfer.getData("text/html");
        if (html) {
            const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
            if (match && match[1].startsWith("http")) {
                addDirectRef(match[1]);
                return;
            }
        }

        // 4. URL fallback
        const uri = e.dataTransfer.getData("text/uri-list")
            || e.dataTransfer.getData("text/plain") || "";
        const firstUrl = uri.split("\n").find((l) => l.startsWith("http"));
        if (firstUrl) addDirectRef(firstUrl.trim());
    });

    // 클립보드 paste (Ctrl+V)
    promptRowEl.addEventListener("paste", async (e) => {
        const items = Array.from(e.clipboardData.items);

        // 클립보드 이미지 (스크린샷, copy image)
        const imageItem = items.find((i) => i.type.startsWith("image/"));
        if (imageItem) {
            e.preventDefault();
            const file = imageItem.getAsFile();
            if (file) await uploadAndAddRef(file);
            return;
        }

        // 이미지 URL 텍스트
        const textItem = items.find((i) => i.type === "text/plain");
        if (textItem) {
            textItem.getAsString((text) => {
                const trimmed = text.trim();
                if (/^https?:\/\/.+\.(png|jpg|jpeg|gif|webp|bmp)/i.test(trimmed)) {
                    e.preventDefault();
                    addDirectRef(trimmed);
                }
            });
        }
    });
}
