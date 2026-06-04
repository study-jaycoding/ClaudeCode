// 생성 흐름: 폼 빌드 → POST → toast 로 시작/완료 알림.
// 진행/이력은 viewer 사이드바의 "큐" 탭에서, 결과 파일은 "생성" 탭에서 확인.

import { promptInput, genBtn } from "./dom.js";
import { state } from "./state.js";
import { showToast } from "./toast.js";
import { getPromptText, getPromptRefs, getPromptDisplayText } from "./prompt.js";
import { refUrl } from "./refModel.js";
import { closeFavPicker } from "./favPicker.js";
import { postGenerate, postCost } from "./api.js";
import { currentDir as viewerCurrentDir } from "../state.js";

// 현재 추정 크레딧 (Generate 버튼에 표시). null = 아직 모름, "loading" = 조회 중.
let estimatedCredits = null;
let costLoading = false;

function renderGenBtn() {
    let costHtml = "";
    if (costLoading) {
        costHtml = ` <span class="gen-cost gen-cost-loading">…</span>`;
    } else if (estimatedCredits != null && estimatedCredits > 0) {
        costHtml = ` <span class="gen-cost">${estimatedCredits}</span>`;
    }
    genBtn.innerHTML = `Generate <span class="gen-sparkle">&#x2726;</span>${costHtml}`;
}

// ── Cost 추정 ───────────────────────────────────────────────
// debounce 150ms (옛 350ms). 서버측 캐시가 같은 (model+옵션) 즉시 응답하므로 짧게 OK.
const COST_DEBOUNCE_MS = 150;
let costDebounce = null;
let costSeq = 0;

function buildCostPayload() {
    const body = {
        model: state.model,
        aspect_ratio: state.ratio,
        repeat: state.repeatCount || 1,
    };
    for (const [key, val] of Object.entries(state.optionValues)) {
        if (val != null) body[key] = val;
    }
    return body;
}

export function updateCostEstimate() {
    clearTimeout(costDebounce);
    // 로딩 표시 — debounce 종료 시점부터 응답 도착까지 "..." 깜빡임으로 진행 표시
    costDebounce = setTimeout(async () => {
        const mySeq = ++costSeq;
        costLoading = true;
        if (!genBtn.disabled) renderGenBtn();
        try {
            const data = await postCost(buildCostPayload());
            if (mySeq !== costSeq) return;
            estimatedCredits = Math.round(data.credits_total || 0);
        } catch {
            if (mySeq !== costSeq) return;
            estimatedCredits = null;
        } finally {
            if (mySeq === costSeq) costLoading = false;
        }
        if (!genBtn.disabled) renderGenBtn();
    }, COST_DEBOUNCE_MS);
}

export async function doGenerate() {
    const prompt = getPromptText();
    const promptRefs = getPromptRefs();
    if (!prompt && promptRefs.length === 0) {
        promptInput.focus();
        showToast("프롬프트를 입력하세요.", null, true);
        return;
    }
    if (!state.project) {
        showToast("프로젝트가 선택되지 않았습니다", "📁 칩에서 결과 저장 프로젝트 선택", true);
        return;
    }

    closeFavPicker();

    const totalCount = state.optionValues.batch_size || state.repeatCount || 1;
    const sourceIds = promptRefs.map((f) => f.id).filter(Boolean);
    // 시작 toast — 큐 탭에 entry 생긴 걸 사용자에게 알림.
    showToast(`생성 시작 — ${state.model} · ${totalCount}장 (큐 탭에서 진행 확인)`, null, false);

    try {
        const displayPrompt = getPromptDisplayText();
        // 저장 폴더 결정 — 결과는 항상 Result/ 또는 그 하위에만 둔다.
        // currentDir 이 "Result" 또는 "Result/..." 면 그대로 (cut001 같은 하위 폴더 워크플로우).
        // Assets 등 Result 밖이면 강제로 "Result" — 의도치 않은 위치 저장 차단.
        const RESULT_DIR = "Result";
        const dir = (viewerCurrentDir || "").replace(/\\/g, "/");
        const targetSubdir = (dir === RESULT_DIR || dir.startsWith(RESULT_DIR + "/"))
            ? dir
            : RESULT_DIR;
        const body = {
            model: state.model,
            prompt,
            display_prompt: displayPrompt !== prompt ? displayPrompt : undefined,
            aspect_ratio: state.ratio,
            ref_urls: promptRefs.map((f) => refUrl(f)),
            repeat: state.repeatCount || 1,
            project: state.project,
            subdir: targetSubdir,
            source_ids: sourceIds,
            auto_download: true,
        };
        for (const [key, val] of Object.entries(state.optionValues)) {
            if (val != null) body[key] = val;
        }

        const { ok, data } = await postGenerate(body);
        if (!ok) {
            showToast(data.error || "생성 실패", data.hint || null, true);
            return;
        }

        const saved = data.saved || [];
        const images = data.images || [];
        if (saved.length > 0) {
            showToast(`완료 — ${state.project}/${targetSubdir} 에 ${saved.length}개 저장`, "생성 탭에서 확인", false);
        } else if (images.length > 0) {
            showToast(`${images.length}장 생성 (다운로드 안 됨)`, null, false);
        }
        // 빈 응답이면 큐 탭에서 상태 확인 (jobs SSE 가 처리).
    } catch (err) {
        showToast("서버 연결 실패", err.message, true);
    }
}

export function bindGenerate() {
    genBtn.addEventListener("click", doGenerate);
}
