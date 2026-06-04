// =====================================================================
// 우클릭 메뉴 (트리/그리드 공용 — 단일/다중) + 파일 조작 함수
// 메뉴 항목: 트리에서 보기 / 원본 위치 열기 / 이름 변경 / 삭제
// 외부 의존: showFolderGrid, reloadTreeAndShow, loadTree (모두 callback)
// =====================================================================
import { treeMenu, previewContent, projectSelect } from "./dom.js";
import { cssQueryEscape, findNodeByPath } from "./utils.js";
import {
    treeMenuTarget, setTreeMenuTarget,
    currentProject, rootTree, currentDir, setCurrentDir,
    favorites,
} from "./state.js";
import {
    apiMove, apiRename, apiDelete, apiReveal, apiMkdir,
} from "./api.js";
import {
    persistFavorites, updateFavCount, renderFavorites,
} from "./favorites.js";
import { pushUndo } from "./undo.js";
import { closeContextPopup } from "./popup.js";
import { setActiveLabelByPath } from "./tree.js";
import { selectCard } from "./selection.js";
import { showInfo, showOk, showWarn, showError } from "./info-toast.js";
import { openCommentsModal } from "./comments.js";

// 외부 callback
let _showFolderGrid = () => {};
let _reloadTreeAndShow = async () => {};
let _loadTree = async () => {};

export function setShowFolderGridCallback(fn) {
    _showFolderGrid = typeof fn === "function" ? fn : () => {};
}
export function setReloadTreeAndShowCallback(fn) {
    _reloadTreeAndShow = typeof fn === "function" ? fn : async () => {};
}
export function setLoadTreeCallback(fn) {
    _loadTree = typeof fn === "function" ? fn : async () => {};
}

// --- 메뉴 열기/닫기 ---
export function openTreeMenu(mx, my, project, paths, opts = {}) {
    if (!Array.isArray(paths)) paths = [paths];
    paths = paths.filter(Boolean);
    if (paths.length === 0) return;

    setTreeMenuTarget({ project, paths, lastMx: mx, lastMy: my });

    const single = paths.length === 1;
    // opts.actions 가 주어지면 그 액션만 노출. 기본은 navigate 숨김, reveal/rename 단일만.
    const allowed = opts.actions || null;
    treeMenu.querySelectorAll("button[data-action]").forEach((btn) => {
        const a = btn.dataset.action;
        let visible;
        if (allowed) {
            visible = allowed.includes(a);
        } else {
            if (a === "navigate") visible = false;
            else if (a === "reveal" || a === "rename" || a === "comments") visible = single;
            else visible = true;
        }
        btn.classList.toggle("hidden", !visible);
        if (a === "delete") btn.textContent = single ? "🗑 삭제 (Del)" : `🗑 삭제 (${paths.length}개, Del)`;
    });

    treeMenu.classList.remove("hidden");
    treeMenu.style.left = "0px";
    treeMenu.style.top = "0px";
    const rect = treeMenu.getBoundingClientRect();
    let x = mx + 2, y = my + 2;
    if (x + rect.width > window.innerWidth - 8) x = mx - rect.width - 2;
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    treeMenu.style.left = x + "px";
    treeMenu.style.top = y + "px";
}

export function closeTreeMenu() {
    treeMenu.classList.add("hidden");
    setTreeMenuTarget(null);
}

// 메뉴 항목 click — 단일/다중 자동 분기 (모듈 로드 시 한 번 등록)
treeMenu.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!treeMenuTarget) return;
        const { project, paths } = treeMenuTarget;
        const action = btn.dataset.action;
        closeTreeMenu();
        if (action === "navigate" && paths.length === 1) {
            await navigateToPath(project, paths[0]);
        } else if (action === "reveal" && paths.length === 1) {
            await revealFile(project, paths[0]);
        } else if (action === "rename" && paths.length === 1) {
            // 트리 라벨이 있으면 인라인 편집, 없으면 prompt fallback
            if (!startInlineRenameForPath(project, paths[0])) {
                await renameFilePrompt(project, paths[0]);
            }
        } else if (action === "comments" && paths.length === 1) {
            openCommentsModal(paths[0]);
        } else if (action === "new-folder" && paths.length >= 1) {
            // 폴더 우클릭 → 그 안에, 파일 우클릭 → 그 파일이 있는 폴더 안에
            const target = paths[0];
            const node = findNodeByPath(rootTree, target);
            const parentDir = (node && node.type === "dir")
                ? target
                : (target.includes("/") ? target.substring(0, target.lastIndexOf("/")) : "");
            await createFolderPrompt(project, parentDir);
        } else if (action === "delete") {
            await deleteFilesConfirm(project, paths);
        }
    });
});

// 바깥 click / Esc 로 메뉴 닫기
document.addEventListener("click", (e) => {
    if (!treeMenu.classList.contains("hidden") && !treeMenu.contains(e.target)) closeTreeMenu();
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !treeMenu.classList.contains("hidden")) closeTreeMenu();
});

// --- 정보 팝업의 cp-link "트리에서 보기" ---
export async function navigateToPath(project, path) {
    closeContextPopup();
    if (currentProject !== project) {
        projectSelect.value = project;
        await _loadTree(project);
    }
    const treeTabBtn = document.querySelector('.tab-btn[data-tab="tree"]');
    if (treeTabBtn && !treeTabBtn.classList.contains("active")) treeTabBtn.click();
    if (!rootTree) return;
    const slash = path.lastIndexOf("/");
    const parentDir = slash >= 0 ? path.substring(0, slash) : "";
    setCurrentDir(parentDir);
    const parentNode = findNodeByPath(rootTree, parentDir) || rootTree;
    _showFolderGrid(project, parentNode);
    setActiveLabelByPath(path, false);
    // 보이는 트리(file-tree/gen-tree 중 화면에 있는 것) 의 라벨로 스크롤
    const visibleLabel = Array.from(document.querySelectorAll(
        `.tree .file-label[data-path="${cssQueryEscape(path)}"]`
    )).find((l) => l.offsetParent !== null);
    if (visibleLabel) visibleLabel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const cardEl = previewContent.querySelector(
        `.card[data-path="${cssQueryEscape(path)}"]`
    );
    if (cardEl) {
        selectCard(cardEl);
        cardEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
}

// --- 파일 조작 ---
export async function revealFile(project, path) {
    try {
        const { ok, status, data } = await apiReveal(project, path);
        if (!ok) showError(`⚠ 탐색기 열기 실패: ${data.error || status}`);
    } catch (err) {
        showError(`⚠ 탐색기 열기 오류: ${err.message}`);
    }
}

export async function moveFilesPrompt(project, paths) {
    if (paths.length === 0) return;
    const firstFrom = paths[0].includes("/") ? paths[0].substring(0, paths[0].lastIndexOf("/")) : "";
    const label = paths.length === 1
        ? `이동할 폴더 경로를 입력하세요 (프로젝트 루트 기준).\n비워두면 루트로 이동.`
        : `${paths.length}개 항목을 이동할 폴더 경로를 입력하세요 (프로젝트 루트 기준).\n비워두면 루트로 이동.`;
    const toDir = prompt(label, firstFrom);
    if (toDir === null) return;
    const dest = toDir.trim();
    let ok = 0, fail = 0;
    for (const p of paths) {
        const fromDir = p.includes("/") ? p.substring(0, p.lastIndexOf("/")) : "";
        if (fromDir === dest) continue;
        const success = await moveFile(project, p, dest, paths.length > 1);
        if (success) ok += 1; else fail += 1;
    }
    if (paths.length > 1) {
        await _reloadTreeAndShow(project, currentDir);
        showOk(`✓ 이동: ${ok}개 성공${fail ? `, ${fail} 실패` : ""} → ${dest || "(루트)"}/`);
    }
}

export async function renameFilePrompt(project, path) {
    const currentName = path.split("/").pop();
    const newName = prompt("새 파일 이름:", currentName);
    if (!newName || newName === currentName) return;
    showInfo(`이름 변경 중: ${currentName} → ${newName}...`);
    try {
        const { ok, status, data } = await apiRename(project, path, newName.trim());
        if (!ok) {
            showError(`⚠ 이름 변경 실패: ${data.error || status}`);
            return;
        }
        for (const f of favorites) {
            if (f.project === project && f.path === path) f.path = data.to;
        }
        persistFavorites();
        await _reloadTreeAndShow(project, currentDir);
        showOk(`✓ 이름 변경: ${data.name} (Ctrl+Z 로 되돌리기)`);
        const origName = currentName;
        const newPath = data.to;
        pushUndo(`이름 변경 (${origName})`, async () => {
            const { ok: ok2, status: st2, data: d } = await apiRename(project, newPath, origName);
            if (!ok2) throw new Error(d.error || ("rename " + st2));
            for (const f of favorites) {
                if (f.project === project && f.path === newPath) f.path = d.to;
            }
            persistFavorites();
            await _reloadTreeAndShow(project, currentDir);
        });
    } catch (err) {
        showError(`⚠ 이름 변경 오류: ${err.message}`);
    }
}

// 인라인 이름 변경 — 트리 라벨의 텍스트를 input 으로 잠시 바꿔 편집.
export function startInlineRename(labelEl, project, path, isFolder) {
    if (!labelEl || labelEl.dataset.renaming === "1") return;
    labelEl.dataset.renaming = "1";

    const origHtml = labelEl.innerHTML;
    const origText = labelEl.textContent;
    // 라벨 텍스트는 "📁 폴더명" 또는 "🖼️ 파일명.png" 형태 — 첫 공백 앞은 아이콘 prefix
    const sp = origText.indexOf(" ");
    const prefix = sp > 0 ? origText.substring(0, sp + 1) : "";
    const baseName = path.split("/").pop();

    labelEl.textContent = prefix;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-rename-input";
    input.value = baseName;
    input.spellcheck = false;
    labelEl.appendChild(input);
    input.focus();
    if (!isFolder) {
        const dot = baseName.lastIndexOf(".");
        if (dot > 0) input.setSelectionRange(0, dot);
        else input.select();
    } else {
        input.select();
    }

    let settled = false;
    const restore = () => {
        labelEl.innerHTML = origHtml;
        labelEl.dataset.renaming = "";
    };
    const commit = async () => {
        if (settled) return;
        settled = true;
        const newName = input.value.trim();
        if (!newName || newName === baseName) { restore(); return; }
        try {
            const { ok, data } = await apiRename(project, path, newName);
            if (!ok) {
                showError(`⚠ 이름 변경 실패: ${data.error || ""}`);
                restore();
                return;
            }
            // 즐겨찾기 캐시 동기화 (폴더면 prefix 매치, 파일이면 정확 매치)
            for (const f of favorites) {
                if (f.project !== project) continue;
                if (isFolder) {
                    if (f.path === path || f.path.startsWith(path + "/")) {
                        f.path = data.to + f.path.substring(path.length);
                    }
                } else {
                    if (f.path === path) f.path = data.to;
                }
            }
            persistFavorites();
            await _reloadTreeAndShow(project, currentDir);
            showOk(`✓ 이름 변경: ${data.name}`);
            const origPath = path;
            const newPath = data.to;
            pushUndo(`이름 변경 (${baseName})`, async () => {
                const { ok: ok2, data: d2 } = await apiRename(project, newPath, baseName);
                if (!ok2) return;
                for (const f of favorites) {
                    if (f.project !== project) continue;
                    if (isFolder) {
                        if (f.path === newPath || f.path.startsWith(newPath + "/")) {
                            f.path = d2.to + f.path.substring(newPath.length);
                        }
                    } else {
                        if (f.path === newPath) f.path = d2.to;
                    }
                }
                persistFavorites();
                await _reloadTreeAndShow(project, currentDir);
            });
        } catch (err) {
            showError(`⚠ 이름 변경 오류: ${err.message}`);
            restore();
        }
    };
    const cancel = () => {
        if (settled) return;
        settled = true;
        restore();
    };
    input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", () => commit());
    input.addEventListener("click", (e) => e.stopPropagation());
}

// 주어진 path 의 트리 라벨을 찾아 인라인 rename 시작.
export function startInlineRenameForPath(project, path) {
    if (!project || !path) return false;
    const isDir = (() => {
        const n = findNodeByPath(rootTree, path);
        return n ? n.type === "dir" : false;
    })();

    // 1순위: 보이는 트리 라벨 (구성 탭 활성 또는 gen-tree 표시)
    const treeSel = isDir
        ? `.tree .dir-label[data-path="${cssQueryEscape(path)}"]`
        : `.tree .file-label[data-path="${cssQueryEscape(path)}"]`;
    const treeLabel = Array.from(document.querySelectorAll(treeSel))
        .find((l) => l.offsetParent !== null);
    if (treeLabel) {
        startInlineRename(treeLabel, project, path, isDir);
        return true;
    }

    // 2순위: 보이는 우측 그리드 카드의 .card-name (모든 탭에서 작동)
    const cardName = document.querySelector(
        `.preview-content .card[data-path="${cssQueryEscape(path)}"] .card-name`
    );
    if (cardName && cardName.offsetParent) {
        startInlineRenameOnCardName(cardName, project, path, isDir);
        return true;
    }

    return false;  // 둘 다 없으면 호출자가 prompt fallback
}

/** 그리드 카드의 .card-name 인라인 편집 — 트리 라벨용 startInlineRename 의 카드 버전.
 *  카드 텍스트에 prefix(아이콘) 없으므로 전체를 baseName 으로 처리. */
function startInlineRenameOnCardName(nameEl, project, path, isFolder) {
    if (!nameEl || nameEl.dataset.renaming === "1") return;
    nameEl.dataset.renaming = "1";

    const origHtml = nameEl.innerHTML;
    const baseName = path.split("/").pop();

    nameEl.textContent = "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-rename-input";
    input.value = baseName;
    input.spellcheck = false;
    nameEl.appendChild(input);
    input.focus();
    if (!isFolder) {
        const dot = baseName.lastIndexOf(".");
        if (dot > 0) input.setSelectionRange(0, dot);
        else input.select();
    } else {
        input.select();
    }

    let settled = false;
    const restore = () => {
        nameEl.innerHTML = origHtml;
        nameEl.dataset.renaming = "";
    };
    const commit = async () => {
        if (settled) return;
        settled = true;
        const newName = input.value.trim();
        if (!newName || newName === baseName) { restore(); return; }
        try {
            const { ok, data } = await apiRename(project, path, newName);
            if (!ok) {
                showError(`⚠ 이름 변경 실패: ${data.error || ""}`);
                restore();
                return;
            }
            // favorites 캐시 동기화 (트리 인라인 rename 과 동일)
            for (const f of favorites) {
                if (f.project !== project) continue;
                if (isFolder) {
                    if (f.path === path || f.path.startsWith(path + "/")) {
                        f.path = data.to + f.path.substring(path.length);
                    }
                } else {
                    if (f.path === path) f.path = data.to;
                }
            }
            persistFavorites();
            await _reloadTreeAndShow(project, currentDir);
            showOk(`✓ 이름 변경: ${data.name}`);
        } catch (err) {
            showError(`⚠ 이름 변경 오류: ${err.message}`);
            restore();
        }
    };
    const cancel = () => { if (!settled) { settled = true; restore(); } };
    input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", () => commit());
    input.addEventListener("click", (e) => e.stopPropagation());
}

// + 버튼: 기본명 "새 폴더" 로 만들고 곧바로 인라인 rename 모드 진입.
export async function createDefaultFolderInside(project, parentDir) {
    if (!project) return;
    let name = "새 폴더";
    let n = 2;
    let made = null;
    while (n <= 99) {
        const { ok, status, data } = await apiMkdir(project, parentDir, name);
        if (ok) { made = data; break; }
        if (status !== 409) {
            showError(`⚠ 폴더 생성 실패: ${data.error || status}`);
            return;
        }
        name = `새 폴더 (${n++})`;
    }
    if (!made) return;
    await _reloadTreeAndShow(project, parentDir);
    // 라벨이 두 트리(메인 + gen-tree) 양쪽에 있을 수 있어 둘 다 시도
    const path = made.path;
    const labels = document.querySelectorAll(`.tree .dir-label[data-path="${cssQueryEscape(path)}"]`);
    if (labels.length > 0) {
        startInlineRename(labels[labels.length - 1], project, path, true);
    }
}

export async function createFolderPrompt(project, parentDir) {
    if (!project) {
        alert("프로젝트를 먼저 선택하세요.");
        return;
    }
    const label = parentDir
        ? `'${parentDir}/' 안에 만들 폴더 이름:`
        : "프로젝트 루트에 만들 폴더 이름:";
    const name = prompt(label, "");
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
        const { ok, data } = await apiMkdir(project, parentDir, trimmed);
        if (!ok) {
            showError(`⚠ 폴더 생성 실패: ${data.error || ""}`);
            return;
        }
        await _reloadTreeAndShow(project, parentDir);
        showOk(`✓ 폴더 생성: ${data.path}`);
    } catch (err) {
        showError(`⚠ 폴더 생성 오류: ${err.message}`);
    }
}

export async function deleteFilesConfirm(project, paths) {
    if (paths.length === 0) return;
    const msg = paths.length === 1
        ? `정말로 삭제하시겠습니까?\n\n${paths[0]}\n\n(되돌릴 수 없습니다)`
        : `정말로 ${paths.length}개 항목을 삭제하시겠습니까?\n\n${paths.slice(0, 5).join("\n")}${paths.length > 5 ? `\n... 외 ${paths.length - 5}개` : ""}\n\n(되돌릴 수 없습니다)`;
    if (!confirm(msg)) return;
    showInfo(`삭제 중: ${paths.length}개...`);
    let ok = 0, fail = 0;
    for (const p of paths) {
        try {
            const { ok: ok2 } = await apiDelete(project, p);
            if (!ok2) { fail += 1; continue; }
            ok += 1;
            const idx = favorites.findIndex((f) => f.project === project && f.path === p);
            if (idx >= 0) favorites.splice(idx, 1);
        } catch { fail += 1; }
    }
    persistFavorites();
    updateFavCount();
    renderFavorites();
    await _reloadTreeAndShow(project, currentDir);
    showOk(`✓ 삭제: ${ok}개 성공${fail ? `, ${fail} 실패` : ""}`);
}

export async function moveFile(project, fromPath, toDirPath, silent = false, _isUndo = false) {
    if (!silent) showInfo(`이동 중: ${fromPath} → ${toDirPath}/...`);
    try {
        const { ok, status, data } = await apiMove(project, fromPath, toDirPath);
        if (!ok) {
            if (!silent) showError(`⚠ 이동 실패: ${data.error || status}`);
            return false;
        }
        for (const f of favorites) {
            if (f.project === project && f.path === fromPath) f.path = data.to;
        }
        persistFavorites();
        if (!silent) {
            const stayDir = currentDir;
            await _reloadTreeAndShow(project, stayDir);
            showOk(`✓ 이동 완료: ${data.name} → ${toDirPath}/ (Ctrl+Z 로 되돌리기)`);
        }
        if (!_isUndo) {
            const fromDir = fromPath.includes("/") ? fromPath.substring(0, fromPath.lastIndexOf("/")) : "";
            const newPath = data.to;
            pushUndo(`이동 (${data.name || fromPath.split("/").pop()})`, async () => {
                await moveFile(project, newPath, fromDir, false, true);
            });
        }
        return true;
    } catch (err) {
        if (!silent) showError(`⚠ 이동 오류: ${err.message}`);
        return false;
    }
}
