// =====================================================================
// 드래그앤드롭 업로드 + 카드의 외부 drag-out
// - document 단의 dragenter/over/leave/drop 핸들러는 모듈 로드 시 한 번 등록
// - makeCardDraggable: 카드 → 외부 앱/바탕화면 드래그 (DownloadURL)
// 외부 의존: reloadTreeAndShow (grid 모듈 callback)
// =====================================================================
import { dropOverlay, dropTargetEl, previewInfo } from "./dom.js";
import { humanSize, mimeFromPath, generateId } from "./utils.js";
import {
    currentProject, currentDir, favorites,
    dragDepth, setDragDepth,
} from "./state.js";
import { isFavorite, persistFavorites, updateFavCount } from "./favorites.js";
import { apiUpload, apiFetchUrl } from "./api.js";
import { selectCard } from "./selection.js";

let _reloadTreeAndShow = async () => {};
export function setReloadTreeAndShowCallback(fn) {
    _reloadTreeAndShow = typeof fn === "function" ? fn : async () => {};
}

/** 카드를 외부 앱/바탕화면으로 드래그 가능하게 (DownloadURL + URI list). */
export function makeCardDraggable(card, project, path, name) {
    // 항상 draggable=true — 클릭과 동시에 외부 앱/바탕화면으로 드래그 가능.
    // lasso 는 카드 밖 빈 영역에서만 시작 (selection.js 에서 처리).
    card.draggable = true;
    // <img>/<video> 자체는 false → 카드 전체가 drag source 가 되도록.
    card.querySelectorAll("img, video").forEach((m) => { m.draggable = false; });
    card.addEventListener("dragstart", (e) => {
        // unselected 카드를 그냥 끌어도 드래그 시작과 동시에 단일 선택 (탐색기 패턴)
        if (!card.classList.contains("selected")) selectCard(card);
        const mediaUrl = `${location.origin}/media?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`;
        const mime = mimeFromPath(path);
        e.dataTransfer.setData("DownloadURL", `${mime}:${name}:${mediaUrl}`);
        e.dataTransfer.setData("text/uri-list", mediaUrl);
        e.dataTransfer.setData("text/plain", mediaUrl);
        // protected-mode (dragenter/dragover) 에서 DownloadURL 은 types 목록에 안 보이는
        // 경우가 있어, 내부 드래그 식별용 커스텀 MIME 을 별도로 부착.
        e.dataTransfer.setData("application/x-pv-internal", "card");
        e.dataTransfer.effectAllowed = "copyMove";
        card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
    });
}

function setDropTargetLabel() {
    if (!currentProject) {
        dropTargetEl.textContent = "⚠ 프로젝트를 먼저 선택하세요";
        dropTargetEl.classList.add("warn");
    } else {
        dropTargetEl.textContent = `🎯 ${currentProject}/${currentDir || ""}`;
        dropTargetEl.classList.remove("warn");
    }
}

// 외부 드래그 판별: OS 파일이거나, 내부 viewer/spotlight 마커가 없는 URL 드래그만 인정.
// 내부 viewer 카드는 application/x-pv-internal, spotlight 결과는 application/x-hf-ref,
// 트리 파일 이동은 text/x-tree-path 를 동봉한다.
// (DownloadURL 은 Chrome 의 protected mode 에서 dragenter/dragover 시 types 에 안 보일 수
//  있어 신뢰 불가 → 커스텀 MIME 마커로 식별.)
function isInternalDrag(types) {
    return types.has("application/x-pv-internal")
        || types.has("application/x-hf-ref")
        || types.has("text/x-tree-path");
}

function isExternalDrop(e) {
    if (!e.dataTransfer) return false;
    const types = new Set(e.dataTransfer.types);
    if (isInternalDrag(types)) return false;
    if (types.has("Files")) return true;
    if (types.has("text/uri-list") || types.has("text/html")) return true;
    return false;
}

document.addEventListener("dragenter", (e) => {
    if (!isExternalDrop(e)) return;
    e.preventDefault();
    setDragDepth(dragDepth + 1);
    setDropTargetLabel();
    dropOverlay.classList.remove("hidden");
});
document.addEventListener("dragover", (e) => {
    // preventDefault 는 내부 드래그에도 필요 (브라우저가 URL 로 navigate 하는 것 차단).
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
        e.dataTransfer.dropEffect = isExternalDrop(e) ? "copy" : "none";
    }
});
document.addEventListener("dragleave", (e) => {
    if (!isExternalDrop(e)) return;
    e.preventDefault();
    setDragDepth(dragDepth - 1);
    if (dragDepth <= 0) { setDragDepth(0); dropOverlay.classList.add("hidden"); }
});
document.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // 오버레이가 떠 있었을 때만 (= 외부 드래그였을 때만) 업로드 처리.
    // 내부 viewer/spotlight 드래그는 무시 → 의도치 않은 파일 복제 방지.
    const wasOverlayVisible = !dropOverlay.classList.contains("hidden");
    setDragDepth(0);
    dropOverlay.classList.add("hidden");
    if (!wasOverlayVisible) return;

    if (!currentProject) {
        previewInfo.textContent = "⚠ 프로젝트를 먼저 선택하세요.";
        return;
    }

    const dt = e.dataTransfer;
    if (!dt) {
        previewInfo.textContent = "⚠ 드롭 데이터가 없습니다.";
        return;
    }

    // 외부 도구(spotlight 등) 가 동봉한 source-ids → 자동 lineage 우선 사용
    let dropSourceIds = null;
    try {
        const sids = dt.getData("application/x-source-ids");
        if (sids) {
            const parsed = JSON.parse(sids);
            if (Array.isArray(parsed) && parsed.length > 0) dropSourceIds = parsed;
        }
    } catch { /* ignore */ }

    // 1) 일반 파일 (탐색기/바탕화면에서 드래그)
    let files = Array.from(dt.files || []);
    // 2) items 에서 파일 추출 (일부 브라우저는 files 가 비어있고 items 에만 있음)
    if (files.length === 0 && dt.items) {
        for (const it of dt.items) {
            if (it.kind === "file") {
                const f = it.getAsFile();
                if (f) files.push(f);
            }
        }
    }

    if (files.length > 0) {
        const srcInfo = dropSourceIds
            ? `🔗 소스 ${dropSourceIds.length}개 자동 연결`
            : `(부모 없음)`;
        previewInfo.textContent = `📥 ${files.length}개 파일 감지 ${srcInfo}, 업로드 시작...`;
        await uploadFiles(currentProject, currentDir, files, dropSourceIds);
        return;
    }

    // 3) URL 만 온 경우 (외부 웹앱에서 이미지 드래그) → 서버가 다운로드
    const uri = dt.getData("text/uri-list") || dt.getData("text/plain") || "";
    const url = uri.split(/\r?\n/).find((s) => /^https?:\/\//i.test(s));
    if (url) {
        previewInfo.textContent = `🌐 URL 감지, 서버에서 다운로드 중...`;
        try {
            const { ok, status, data } = await apiFetchUrl(currentProject, currentDir, url);
            if (!ok) {
                previewInfo.textContent = `⚠ 다운로드 실패: ${data.error || status}`;
                return;
            }
            // 다운로드 파일을 자동 즐겨찾기 등록.
            // sourceIds: 외부 도구가 동봉한 application/x-source-ids 가 있으면 자동 lineage,
            //           없으면 빈 배열 (부모 없음).
            const resolvedSourceIds = (dropSourceIds && dropSourceIds.length)
                ? [...dropSourceIds] : [];
            if (!isFavorite(currentProject, data.path)) {
                const newFav = {
                    id: generateId(),
                    project: currentProject,
                    path: data.path,
                    tags: [],
                    note: "",
                    sourceIds: resolvedSourceIds,
                    isSource: false,   // 사용자가 명시적으로 토글해야 소스 탭에 노출
                    addedAt: Date.now(),
                };
                favorites.push(newFav);
                persistFavorites();
                updateFavCount();
            }
            await _reloadTreeAndShow(currentProject, currentDir);
            const srcNote = resolvedSourceIds.length
                ? ` ✓ 부모 ${resolvedSourceIds.length}개 연결`
                : ` (부모 없음)`;
            previewInfo.textContent = `✓ URL 다운로드: ${data.name} —${srcNote}`;
        } catch (err) {
            previewInfo.textContent = `⚠ 다운로드 오류: ${err.message}`;
        }
        return;
    }

    // 4) 진단 정보 표시
    const types = Array.from(dt.types || []).join(", ");
    previewInfo.textContent = `⚠ 파일/URL 인식 실패. 데이터 타입: [${types || "없음"}]. 이미지를 PC에 먼저 저장 후 드래그해 보세요.`;
});

export async function uploadFiles(project, dir, files, dropSourceIds = null) {
    const total = files.length;
    let done = 0, fails = 0;
    const uploaded = [];
    for (const file of files) {
        done += 1;
        previewInfo.textContent = `업로드 중 ${done}/${total}: ${file.name} (${humanSize(file.size)})...`;
        try {
            const { ok, data } = await apiUpload(project, dir, file);
            if (ok) uploaded.push(data);
            else fails += 1;
        } catch { fails += 1; }
    }

    // 모든 업로드 파일을 자동 즐겨찾기 등록 (ID 부여 보장)
    // sourceIds: 외부 도구가 동봉한 application/x-source-ids 가 있으면 자동 lineage,
    //           없으면 빈 배열 (부모 없음).
    if (uploaded.length > 0) {
        const resolvedSourceIds = (dropSourceIds && dropSourceIds.length)
            ? [...dropSourceIds] : [];
        for (const u of uploaded) {
            if (!isFavorite(project, u.path)) {
                favorites.push({
                    id: generateId(),
                    project,
                    path: u.path,
                    tags: [],
                    note: "",
                    sourceIds: [...resolvedSourceIds],
                    isSource: false,   // 사용자가 명시적으로 토글해야 소스 탭에 노출
                    addedAt: Date.now(),
                });
            }
        }
        persistFavorites();
        updateFavCount();
    }

    const stayDir = currentDir;
    await _reloadTreeAndShow(project, stayDir);
    const srcNote = (dropSourceIds && dropSourceIds.length)
        ? ` ✓ 부모 ${dropSourceIds.length}개 자동 연결` : ` (부모 없음)`;
    previewInfo.textContent = fails > 0
        ? `업로드: ${total - fails}/${total} 성공, ${fails} 실패`
        : `📁 ${stayDir || "(루트)"} · ${total}개 업로드 완료 —${srcNote}`;
}
