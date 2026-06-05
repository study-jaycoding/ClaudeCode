// =====================================================================
// Job Queue 탭 — Spotlight 생성 작업 이력 표시 (ComfyUI 패턴)
// - 날짜별 grouping (오늘/어제/날짜)
// - 필터: 전체 / 진행 / 완료 / 실패
// - "완료 비우기" 버튼
// - 행 클릭 → 생성 탭으로 이동 + 해당 결과 파일 강조
// =====================================================================
import { escapeHtml, kindFromPath } from "./utils.js";
import {
    apiGetJobs, apiClearFinishedJobs, apiRemoveJob, apiSpGetJobStatus, apiSpRecoverJob,
} from "./api.js";
import { reapplyPanelSearch } from "./panel-search.js";
import { setRunningCount } from "./favorites.js";
import { activeTab, setLastFocusArea } from "./state.js";
import { selectCard } from "./selection.js";
import { openLightbox } from "./lightbox.js";
import { lazyScan } from "./lazy-media.js";

let _lastJobs = [];
// shift+화살표 / shift+클릭 의 range 시작점 (큐 id). 단일/ctrl 클릭으로 새로 잡으면 갱신.
let _queueAnchorId = "";
// 화살표 이동의 현재 위치 (focus) — selection 과 별개로 추적해야 shift+화살표 다중이
// anchor 에 갇히지 않고 끝까지 확장됨 (Windows Explorer 표준).
let _queueFocusId = "";
// 생성 탭의 필터 — "all" | "completed" | "failed". running 은 항상 상단 strip 으로 별도 표시.
// localStorage 영구 저장 — Chrome 재시작 후에도 마지막 필터 유지.
const FILTER_KEY = "viewer.queueFilter";
let _filter = (() => {
    try {
        const v = localStorage.getItem(FILTER_KEY);
        if (v === "all" || v === "completed" || v === "failed") return v;
    } catch {}
    return "all";
})();

// 날짜 그룹 라벨 — 오늘/어제/MM월 DD일
function _dateLabel(ms) {
    const d = new Date(ms);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const ymd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((today - ymd) / 86400000);
    if (diff === 0) return "오늘";
    if (diff === 1) return "어제";
    return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

// duration 포맷 — ms → "Xs" or "Xm Ys"
function _fmtDuration(ms) {
    if (!ms || ms < 0) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
}

function _statusBadge(status) {
    if (status === "running") return `<span class="q-status q-running">진행중</span>`;
    if (status === "failed") return `<span class="q-status q-failed">실패</span>`;
    return `<span class="q-status q-done">완료</span>`;
}

function _thumbHtml(job) {
    // 1순위: 로컬 다운로드 완료된 파일 — 서버 /thumb 사용 (한 번 생성 후 디스크 캐시)
    const path = job.thumbnail_path;
    if (path && job.project) {
        // job 의 timestamp 를 cache buster — recover 등으로 같은 path 에 새 결과가 들어와도 격리.
        const _v = job.started_at || job.id || "";
        const url = `/thumb?project=${encodeURIComponent(job.project)}&path=${encodeURIComponent(path)}${_v ? `&v=${_v}` : ""}`;
        if (job.kind === "video") {
            return `<video class="q-thumb" data-lazy-poster="${url}" preload="none" muted></video>`;
        }
        return `<img class="q-thumb" data-lazy-src="${url}" alt="" loading="lazy" />`;
    }
    // 2순위: HF CDN URL — 서버 thumb 불가 (외부 URL). 원본 그대로 lazy 표시.
    const urls = job.result_urls || [];
    if (urls.length > 0) {
        const u = urls[0];
        if (job.kind === "video") {
            return `<video class="q-thumb q-thumb-remote" data-lazy-src="${u}" preload="none" muted title="HF CDN 직접 로드 (다운로드 미완료)"></video>`;
        }
        return `<img class="q-thumb q-thumb-remote" data-lazy-src="${u}" alt="" loading="lazy" title="HF CDN 직접 로드 (다운로드 미완료)" />`;
    }
    // placeholder
    const icon = job.status === "failed" ? "⚠" : job.status === "running" ? "⟳" : (job.kind === "video" ? "▶" : "🖼");
    const cls = "q-thumb q-thumb-placeholder" + (job.status === "running" ? " spinning" : "");
    return `<span class="${cls}">${icon}</span>`;
}

function _renderItem(job) {
    const li = document.createElement("li");
    li.className = "q-item q-status-" + (job.status || "running");
    li.dataset.jobId = job.id || "";
    // 프롬프트는 항상 표시 (failed 든 completed 든 running 이든).
    // failed 인 경우 별도 error 줄 추가. error 가 None 이면 안내 문구.
    const promptText = job.display_prompt || job.prompt || "(프롬프트 없음)";
    const hasErrText = job.status === "failed" && job.error;
    const errorText = job.status === "failed"
        ? (job.error || "오류 메시지 기록 없음 — 클릭해 상세 보기")
        : "";
    const meta = [
        job.project ? escapeHtml(job.project) : "",
        job.model ? escapeHtml(job.model) : "",
        _fmtDuration(job.duration_ms),
    ].filter(Boolean).join(" · ");

    // 복구 버튼은 카드에서 제거 — '실패 상세' 모달의 '오류 복사' 옆으로 이동.
    li.innerHTML = `
        <div class="q-thumb-wrap">${_thumbHtml(job)}</div>
        <div class="q-body">
            <div class="q-row1">
                ${_statusBadge(job.status)}
                <span class="q-title" title="${escapeHtml(promptText)}">${escapeHtml(promptText.slice(0, 80))}${promptText.length > 80 ? "…" : ""}</span>
            </div>
            ${job.status === "failed" ? `<div class="q-row-err" title="클릭하면 전체 오류와 job_id 상세를 확인할 수 있습니다">⚠ ${escapeHtml(errorText.slice(0, 200))}${errorText.length > 200 ? "…" : ""} <span class="q-err-more">상세</span></div>` : ""}
            <div class="q-row2">${meta}</div>
        </div>
        <button class="q-remove" type="button" title="이 항목 삭제">✕</button>`;
    // 본체 클릭 → 사이드바 q-item 자체 .selected (status 무관). 제거 버튼/오류 줄은 제외.
    // result_paths 있으면 우측 그리드 강조도 _openInGenerated 가 추가로 처리.
    li.addEventListener("click", (e) => {
        if (e.target.closest(".q-remove")) return;
        if (e.target.closest(".q-row-err")) {
            _openErrorDetail(job);
            return;
        }
        // 큐 카드 클릭 → 키보드 방향키가 큐를 따라가게 영역 표시
        setLastFocusArea("queue");
        const items = _allQueueItems();
        if (e.shiftKey) {
            // shift+클릭 — anchor ~ 현재 카드 range select
            const anchor = _queueAnchorId
                ? items.find((el) => el.dataset.jobId === _queueAnchorId) : null;
            const aIdx = anchor ? items.indexOf(anchor) : items.indexOf(li);
            const bIdx = items.indexOf(li);
            const [lo, hi] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
            items.forEach((el, i) => el.classList.toggle("selected", i >= lo && i <= hi));
            _queueFocusId = job.id || "";
            return;
        }
        if (e.ctrlKey || e.metaKey) {
            // ctrl+클릭 — 현재 카드 selected 토글. anchor + focus 갱신.
            const wasSel = li.classList.toggle("selected");
            _queueAnchorId = wasSel ? job.id : "";
            _queueFocusId = job.id || "";
            return;
        }
        // 일반 클릭 — 단일 선택. anchor + focus 모두 현재로 리셋.
        items.forEach((el) => el.classList.toggle("selected", el === li));
        _queueAnchorId = job.id || "";
        _queueFocusId = job.id || "";
        _openInGenerated(job);
    });
    // 썸네일 더블클릭 → 첫 결과 파일 라이트박스 (우측 그리드 카드 더블클릭과 동일).
    // 카드 본체 어디든 더블클릭 가능 — 제거 버튼/오류 줄/복구 버튼은 제외.
    li.addEventListener("dblclick", (e) => {
        if (e.target.closest(".q-remove, .q-row-err, .q-recover-btn, .q-thumb-recover")) return;
        const targets = job.result_paths || job.saved_paths || [];
        if (!job.project || targets.length === 0) return;
        const path = targets[0];
        const kind = kindFromPath(path);
        if (kind !== "image" && kind !== "video" && kind !== "text") return;
        openLightbox(job.project, {
            path,
            name: path.split("/").pop(),
            kind,
        });
    });
    // 썸네일이 가리키는 파일이 삭제됐을 때 broken 표시 대신 "파일 없음" 으로 교체
    const qmedia = li.querySelector(".q-thumb-wrap img, .q-thumb-wrap video");
    if (qmedia) {
        const onErr = () => {
            const wrap = li.querySelector(".q-thumb-wrap");
            if (!wrap || wrap.classList.contains("missing")) return;
            wrap.classList.add("missing");
            wrap.innerHTML = `<span class="q-thumb q-thumb-placeholder q-thumb-missing" title="원본 파일이 없습니다">⚠</span>`;
        };
        // src 비어있으면 lazy-media.js IO 가 setting 할 예정 — 즉시 판단 금지.
        if (qmedia.tagName === "IMG" && qmedia.src && qmedia.complete && qmedia.naturalWidth === 0) onErr();
        else qmedia.addEventListener("error", onErr);
    }
    li.querySelector(".q-remove").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!job.id) return;
        // running job 삭제는 확인 — 잘못 누르면 추적 끊김
        if (job.status === "running" && !confirm("진행중인 작업입니다. 큐에서 제거하시겠습니까?\n(실제 생성은 백엔드에서 계속될 수 있음)")) return;
        await apiRemoveJob(job.id);
        await refreshQueue();
    });
    // 우클릭 → 컨텍스트 메뉴 (다시 다운로드 / 제거)
    li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        _openQCtxMenu(e.clientX, e.clientY, job);
    });
    return li;
}

// ── 결과 복구 — ip_detected (사이트 confirm 후) / polling 시간초과 케이스 ──
async function _doRecover(job, btn) {
    if (!job?.id) return;
    const origLabel = btn?.textContent || "↻";
    if (btn) { btn.disabled = true; btn.textContent = "조회 중…"; }
    try {
        const { ok, data } = await apiSpRecoverJob(job.id);
        if (!ok) {
            alert("복구 실패: " + (data?.error || "알 수 없는 오류"));
            return;
        }
        const rec = data?.recovered ?? 0;
        const pending = data?.pending_user ?? 0;
        const running = data?.still_running ?? 0;
        if (rec > 0) {
            alert(`${rec}개 결과를 가져와 ${job.project}/Result/ 에 저장했습니다.`);
        } else if (pending > 0) {
            alert(`${pending}개 잡이 사이트 confirm 대기 중입니다.\n\n`
                + `Higgsfield 사이트에서 'I confirm' 누르신 후 다시 이 버튼을 눌러주세요.`);
        } else if (running > 0) {
            alert(`Higgsfield 에서 ${running}개 잡이 아직 처리 중입니다. 잠시 후 다시 시도하세요.`);
        } else {
            const errs = (data?.errors || []).join("\n");
            alert("가져올 결과가 없습니다.\n" + (errs || "(추가 정보 없음)"));
        }
        await refreshQueue();
    } catch (e) {
        alert("복구 실패: " + (e?.message || e));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = origLabel; }
    }
}

// ── 큐 카드 우클릭 컨텍스트 메뉴 ──────────────────────────────────
// 카드 우클릭 → "다시 다운로드 (Higgsfield)" / "큐에서 제거" 빠른 접근.
// recover 는 기존 _doRecover 와 동일 — Higgsfield 서버에서 job_ids 로
// 결과를 다시 조회·다운로드. 사용자가 카드를 지웠다 해도 Higgsfield 에
// job 이 남아있는 한 (job.id 포함된 큐 entry 면) 복구 가능.
let _qCtxMenu = null;
let _qCtxJob = null;

function _ensureQCtxMenu() {
    if (_qCtxMenu) return _qCtxMenu;
    _qCtxMenu = document.createElement("div");
    _qCtxMenu.className = "q-ctx-menu hidden";
    _qCtxMenu.innerHTML = `
        <button type="button" data-action="recover" title="Higgsfield 서버에서 결과를 다시 조회·다운로드">↻ 다시 다운로드</button>
        <button type="button" data-action="open"    title="생성 탭으로 이동해서 결과 보기">📂 생성 탭에서 열기</button>
        <button type="button" data-action="remove"  class="q-ctx-danger" title="큐 entry 제거 (Higgsfield 의 결과는 그대로 남음)">🗑 큐에서 제거</button>
    `;
    document.body.appendChild(_qCtxMenu);

    _qCtxMenu.addEventListener("click", async (e) => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        e.stopPropagation();
        const job = _qCtxJob;
        const action = btn.dataset.action;
        _closeQCtxMenu();
        if (!job) return;
        if (action === "recover") {
            await _doRecover(job, null);
        } else if (action === "open") {
            _openInGenerated(job);
        } else if (action === "remove") {
            if (!job.id) return;
            if (job.status === "running" && !confirm("진행중인 작업입니다. 큐에서 제거하시겠습니까?\n(실제 생성은 백엔드에서 계속될 수 있음)")) return;
            await apiRemoveJob(job.id);
            await refreshQueue();
        }
    });

    document.addEventListener("click", (e) => {
        if (!_qCtxMenu.classList.contains("hidden") && !_qCtxMenu.contains(e.target)) {
            _closeQCtxMenu();
        }
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !_qCtxMenu.classList.contains("hidden")) _closeQCtxMenu();
    });
    return _qCtxMenu;
}

function _openQCtxMenu(x, y, job) {
    _qCtxJob = job;
    const menu = _ensureQCtxMenu();
    menu.classList.remove("hidden");
    menu.style.left = "0px";
    menu.style.top = "0px";
    const rect = menu.getBoundingClientRect();
    let mx = x + 2, my = y + 2;
    if (mx + rect.width  > window.innerWidth  - 8) mx = x - rect.width  - 2;
    if (my + rect.height > window.innerHeight - 8) my = window.innerHeight - rect.height - 8;
    menu.style.left = Math.max(8, mx) + "px";
    menu.style.top  = Math.max(8, my) + "px";
}

function _closeQCtxMenu() {
    if (_qCtxMenu) _qCtxMenu.classList.add("hidden");
    _qCtxJob = null;
}

// ── 오류 상세 모달 ─────────────────────────────────────────────────
// 실패 카드의 .q-row-err 클릭 시 호출. 전체 프롬프트 + 전체 오류 + job_id 별
// Higgsfield 상태 조회 버튼 제공.
function _openErrorDetail(job) {
    // 기존 모달 제거 (중복 방지)
    document.querySelectorAll(".q-err-modal-overlay").forEach((el) => el.remove());

    const overlay = document.createElement("div");
    overlay.className = "q-err-modal-overlay";
    const fmt = (v) => v == null || v === "" ? "(없음)" : String(v);
    const startedStr = job.started_at ? new Date(job.started_at).toLocaleString("ko-KR") : "(없음)";
    const errText = job.error || "(백엔드가 오류 메시지를 기록하지 않았습니다. 백엔드 콘솔/로그 확인 필요)";
    const jobIds = job.job_ids || [];

    overlay.innerHTML = `
      <div class="q-err-modal" role="dialog">
        <div class="q-err-head">
          <span class="q-err-title">실패 상세</span>
          <button type="button" class="q-err-close" title="닫기">✕</button>
        </div>
        <div class="q-err-body">
          <div class="q-err-section">
            <div class="q-err-label">프로젝트 · 모델 · 시각</div>
            <div class="q-err-value">${escapeHtml(fmt(job.project))} · ${escapeHtml(fmt(job.model))} · ${escapeHtml(startedStr)}</div>
          </div>
          <div class="q-err-section">
            <div class="q-err-label">프롬프트</div>
            <div class="q-err-value q-err-pre">${escapeHtml(fmt(job.display_prompt || job.prompt))}</div>
          </div>
          <div class="q-err-section">
            <div class="q-err-label">오류 메시지</div>
            <div class="q-err-value q-err-pre q-err-msg">${escapeHtml(errText)}</div>
            <div class="q-err-actions">
              <button type="button" class="q-err-copy" data-copy="err">오류 복사</button>
              ${jobIds.length > 0 ? `<button type="button" class="q-err-recover" title="Higgsfield 서버에서 결과를 다시 조회해 다운로드합니다.&#10;ip_detected (저작권 동의 필요) 케이스는 사이트에서 'I confirm' 후 클릭.">↻ 결과 다시 가져오기</button>` : ""}
            </div>
          </div>
          <div class="q-err-section">
            <div class="q-err-label">Higgsfield job_id (${jobIds.length})</div>
            ${jobIds.length === 0
                ? `<div class="q-err-value q-err-pre">job_id 없음 — 다음 중 하나의 케이스입니다.<br>
                   1) CLI 호출 자체 실패 (네트워크/인증) — 위 "오류 메시지" 에 사유<br>
                   2) CLI 는 성공했지만 서버가 job 을 만들지 않음 (콘텐츠 정책, 파라미터 거부 등)<br>
                   3) CLI 출력 형식이 파싱 불가</div>`
                : `<ul class="q-err-jobs">${jobIds.map((jid) => `
                    <li data-jid="${escapeHtml(jid)}">
                        <code>${escapeHtml(jid)}</code>
                        <button type="button" class="q-err-check">상태 확인</button>
                        <span class="q-err-result"></span>
                    </li>`).join("")}</ul>`
            }
          </div>
        </div>
      </div>`;

    // 닫기 (배경 클릭 / X / Esc)
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay || e.target.closest(".q-err-close")) close();
    });
    const onKey = (e) => {
        if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    };
    document.addEventListener("keydown", onKey);

    // 오류 메시지 복사
    overlay.querySelector(".q-err-copy")?.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(errText);
            const btn = overlay.querySelector(".q-err-copy");
            const orig = btn.textContent;
            btn.textContent = "복사됨";
            setTimeout(() => { btn.textContent = orig; }, 1200);
        } catch {}
    });

    // 결과 다시 가져오기 — 모달 안에서 직접 트리거 + 결과 보여줌
    overlay.querySelector(".q-err-recover")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        await _doRecover(job, btn);
        // 복구 후 모달 닫기 (큐 카드가 새로고침되면서 entry 상태 반영)
        close();
        document.removeEventListener("keydown", onKey);
    });

    // job_id 상태 확인 — Higgsfield CLI 호출
    overlay.querySelectorAll(".q-err-check").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const li = btn.closest("li");
            const jid = li.dataset.jid;
            const out = li.querySelector(".q-err-result");
            btn.disabled = true;
            out.textContent = "조회 중…";
            try {
                const { ok, data } = await apiSpGetJobStatus(jid);
                if (!ok) {
                    out.textContent = "오류: " + (data?.error || "HTTP " + (data?.status || "?"));
                } else {
                    const s = data?.status || "unknown";
                    const fail = data?.fail_reason || "";
                    const url = data?.result_url || (data?.images || [])[0]?.url || "";
                    let html = `상태: <b>${escapeHtml(s)}</b>`;
                    if (fail) html += ` · <span class="q-err-fail">사유: ${escapeHtml(fail)}</span>`;
                    if (url) html += ` · <a href="${escapeHtml(url)}" target="_blank">결과 열기</a>`;
                    out.innerHTML = html;
                }
            } catch (e) {
                out.textContent = "조회 실패: " + (e?.message || e);
            } finally {
                btn.disabled = false;
            }
        });
    });

    document.body.appendChild(overlay);
}

function _openInGenerated(job) {
    // backward-compat: 옛 entry 는 saved_paths, 새 entry 는 result_paths
    const targets = job.result_paths || job.saved_paths || [];
    if (!job.project || !targets.length) return;
    // 이미 생성 탭이면 탭 click 안 함 — 같은 탭 click 은 panel 토글이라 닫혀버림.
    if (activeTab !== "generated") {
        const btn = document.querySelector('.tab-btn[data-tab="generated"]');
        if (btn) btn.click();
    }

    // (사이드바 q-item .selected 는 li click handler 가 이미 처리함)

    // 그리드 렌더 후 result_paths 모두 선택 + 첫 카드 강조 (탭 전환 시 짧은 지연)
    const firstPath = targets[0];
    setTimeout(() => {
        const preview = document.querySelector(".preview-content");
        if (!preview) return;
        // 기존 selection 클리어 후 result_paths 전부 selected
        preview.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
        let firstCard = null;
        for (const p of targets) {
            const c = preview.querySelector(`.card[data-path="${CSS.escape(p)}"]`);
            if (c) {
                c.classList.add("selected");
                if (!firstCard) firstCard = c;
            }
        }
        if (firstCard) {
            // selectCard 로 트리 라벨도 동기화 (단일 기준으로 호출 — 다중 selected 는 위에서 처리됨)
            selectCard(firstCard);
            // selectCard 가 단일 모드로 다른 카드 selected 를 지우므로 다시 추가
            for (const p of targets) {
                const c = preview.querySelector(`.card[data-path="${CSS.escape(p)}"]`);
                if (c) c.classList.add("selected");
            }
            firstCard.scrollIntoView({ block: "nearest", behavior: "smooth" });
            firstCard.classList.add("highlight-pulse");
            setTimeout(() => firstCard.classList.remove("highlight-pulse"), 1500);
            // ★ selectCard 가 lastFocusArea 를 "grid" 로 바꿔놓는데, 큐 카드를 클릭한
            // 사용자의 의도는 "좌측 큐" 영역. 다시 "queue" 로 복원해서 방향키가
            // 좌측에서 작동하게 함 (트리 click 핸들러와 동일 패턴).
            setLastFocusArea("queue");
        }
    }, activeTab === "generated" ? 0 : 300);
}

function _updateRunningBadge() {
    // 큐 탭은 폐기됨 — running 카운트를 favorites 로 push 해서 생성 탭 배지에 반영.
    const n = _lastJobs.filter((j) => j.status === "running").length;
    setRunningCount(n);
}

// 생성 탭 상단의 "진행중" strip — running 인 job 만 mini list 로 표시. 없으면 hidden.
function _renderRunningStripInGenerated() {
    const el = document.getElementById("generated-running-strip");
    if (!el) return;
    const running = _lastJobs.filter((j) => j.status === "running");
    el.innerHTML = "";
    if (running.length === 0) {
        el.classList.add("hidden");
        return;
    }
    el.classList.remove("hidden");
    for (const job of running) {
        el.appendChild(_renderItem(job));
    }
    lazyScan(el);
}

// 생성 탭의 메인 list — 완료/실패 batch 들 (running 은 위 strip 이 담당).
function _renderGeneratedJobsList() {
    const el = document.getElementById("generated-jobs-list");
    if (!el) return;
    const finished = _lastJobs.filter((j) => j.status !== "running");
    // 카운트 업데이트는 항상 — finished 전체 기준
    _updateFilterTabCounts(finished);
    // 필터 적용
    const visible = _filter === "all"
        ? finished
        : finished.filter((j) => j.status === _filter);
    el.innerHTML = "";
    if (visible.length === 0) {
        const msg = _filter === "completed" ? "완료된 작업이 없습니다"
                  : _filter === "failed"    ? "실패한 작업이 없습니다"
                  : "아직 생성된 결과가 없습니다";
        el.innerHTML = `<li class="empty">${msg}</li>`;
        return;
    }
    let lastDate = null;
    for (const job of visible) {
        const label = _dateLabel(job.started_at || 0);
        if (label !== lastDate) {
            const header = document.createElement("li");
            header.className = "q-date-header";
            header.textContent = label;
            el.appendChild(header);
            lastDate = label;
        }
        el.appendChild(_renderItem(job));
    }
    lazyScan(el);
}

function _updateFilterTabCounts(finished) {
    const tabs = document.getElementById("generated-filter-tabs");
    if (!tabs) return;
    const totals = {
        all: finished.length,
        completed: finished.filter((j) => j.status === "completed").length,
        failed: finished.filter((j) => j.status === "failed").length,
    };
    tabs.querySelectorAll(".queue-filter-tab").forEach((btn) => {
        const k = btn.dataset.filter;
        const cnt = btn.querySelector(".queue-filter-count");
        if (cnt) cnt.textContent = totals[k] > 0 ? totals[k] : "";
        btn.classList.toggle("active", k === _filter);
    });
    // clear 버튼 라벨/툴팁/비활성화 상태도 동기화
    _syncClearBtn(totals);
}

// 현재 _filter 에 맞춰 "전체/완료/실패 지우기" 버튼 라벨·툴팁·disabled 동기화
function _syncClearBtn(totals) {
    const btn = document.getElementById("generated-clear-btn");
    if (!btn) return;
    const map = {
        all:       { label: "전체 지우기", tip: "완료/실패 모두 비웁니다 (진행중은 유지)", count: totals.all },
        completed: { label: "완료 지우기", tip: "완료된 항목만 비웁니다",                  count: totals.completed },
        failed:    { label: "실패 지우기", tip: "실패한 항목만 비웁니다",                  count: totals.failed },
    };
    const m = map[_filter] || map.all;
    btn.textContent = m.label;
    btn.title = m.tip;
    btn.disabled = m.count === 0;
    btn.classList.toggle("disabled", m.count === 0);
}

// 필터 탭 wiring (탭 click → filter 변경 → 재렌더)
(function _bindFilterTabs() {
    const tabs = document.getElementById("generated-filter-tabs");
    if (!tabs) return;
    tabs.addEventListener("click", (e) => {
        const btn = e.target.closest(".queue-filter-tab");
        if (!btn) return;
        const next = btn.dataset.filter;
        if (next === _filter) return;
        _filter = next;
        try { localStorage.setItem(FILTER_KEY, _filter); } catch {}
        _renderGeneratedJobsList();
        reapplyPanelSearch();
    });
})();

export async function refreshQueue() {
    try {
        const { ok, data } = await apiGetJobs({ limit: 500 });
        if (!ok) return;
        _lastJobs = (data && data.jobs) || [];
        _updateRunningBadge();
        _renderRunningStripInGenerated();
        _renderGeneratedJobsList();
        // 리스트 재구성 후 검색 필터 다시 적용
        reapplyPanelSearch();
    } catch {}
}

// clear 버튼 wiring — 생성 탭의 버튼은 현재 _filter 에 맞춰 전체/완료/실패만 비움.
function _bindFilteredClearBtn(btn) {
    if (!btn) return;
    btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        const prompts = {
            all:       "완료/실패한 항목을 모두 비우시겠습니까? (진행중인 작업은 유지)",
            completed: "완료된 항목만 비우시겠습니까?",
            failed:    "실패한 항목만 비우시겠습니까?",
        };
        if (!confirm(prompts[_filter] || prompts.all)) return;
        const onlyStatus = _filter === "all" ? undefined : _filter;
        await apiClearFinishedJobs(onlyStatus);
        await refreshQueue();
    });
}
_bindFilteredClearBtn(document.getElementById("generated-clear-btn"));

// ── 키보드 navigation — 생성 탭의 큐 카드 (running strip + finished list) 사이 이동 ──
// keyboard.js 가 lastFocusArea === "queue" 일 때 호출.
function _allQueueItems() {
    // search-hidden 만 제외 (사이드바 collapsed 시에도 navigate 는 OK —
    // 사용자가 사이드바 다시 열면 selection 반영됨).
    return Array.from(document.querySelectorAll(
        "#generated-running-strip .q-item, #generated-jobs-list .q-item"
    )).filter((el) => !el.classList.contains("search-hidden"));
}

function _selectedQueueItems() {
    return Array.from(document.querySelectorAll(
        "#generated-running-strip .q-item.selected, #generated-jobs-list .q-item.selected"
    ));
}

function _lastSelectedQueueItem() {
    const all = _selectedQueueItems();
    return all.length > 0 ? all[all.length - 1] : null;
}

/** 큐 카드 사이 이동. ±1. shift=true 면 anchor~focus range 다중 선택.
 *  focus 는 selection 과 별도로 추적 (Windows 표준) — 그래야 anchor 가 selected 라도
 *  화살표가 anchor 자리에 갇히지 않고 양 방향으로 끝까지 확장됨. */
export function moveQueueFocus(direction, shift = false) {
    const items = _allQueueItems();
    if (items.length === 0) return;
    // focus 위치 찾기 — _queueFocusId 우선, 없으면 마지막 selected, 그것도 없으면 -1.
    let curIdx = -1;
    if (_queueFocusId) {
        curIdx = items.findIndex((el) => el.dataset.jobId === _queueFocusId);
    }
    if (curIdx === -1) {
        const cur = _lastSelectedQueueItem();
        curIdx = cur ? items.indexOf(cur) : -1;
    }
    let next;
    if (curIdx === -1) next = direction > 0 ? 0 : items.length - 1;
    else next = Math.max(0, Math.min(items.length - 1, curIdx + direction));
    const target = items[next];
    if (!target) return;

    _queueFocusId = target.dataset.jobId || "";

    if (!shift) {
        // 단일 이동 — 다른 selected 모두 제거, anchor 도 target 로 갱신
        items.forEach((el) => el.classList.toggle("selected", el === target));
        _queueAnchorId = target.dataset.jobId || "";
    } else {
        // shift+화살표 — anchor 부터 focus 까지 range (replace).
        // anchor 없으면 이전 focus 또는 마지막 selected 를 anchor 로 잡음.
        let anchor = _queueAnchorId
            ? items.find((el) => el.dataset.jobId === _queueAnchorId) : null;
        if (!anchor) {
            anchor = curIdx >= 0 ? items[curIdx] : target;
            _queueAnchorId = anchor.dataset.jobId || "";
        }
        const aIdx = items.indexOf(anchor);
        const [lo, hi] = aIdx < next ? [aIdx, next] : [next, aIdx];
        items.forEach((el, i) => el.classList.toggle("selected", i >= lo && i <= hi));
    }
    target.scrollIntoView({ block: "nearest" });
}

/** Enter — 마지막으로 선택된 큐 카드 활성 (result_paths 가 있으면 우측 그리드 강조).
 *  다중 선택 상태여도 마지막 항목 한 개만 entries 그리드로 점프. */
export function activateSelectedQueueItem() {
    const cur = _lastSelectedQueueItem();
    if (!cur) return false;
    // shift/ctrl 없이 클릭 → 단일 선택 + _openInGenerated 트리거
    cur.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
}

/** Delete — 선택된 큐 카드들 일괄 제거. running 포함 시 한 번만 confirm. */
export async function deleteSelectedQueueItems() {
    const sel = _selectedQueueItems();
    if (sel.length === 0) return false;
    const ids = sel.map((el) => el.dataset.jobId).filter(Boolean);
    if (ids.length === 0) return false;
    const runningCount = sel.filter((el) => el.classList.contains("q-status-running")).length;
    const msg = runningCount > 0
        ? `${ids.length}개 항목을 큐에서 제거합니다 (그중 ${runningCount}개 진행중 — 실제 생성은 백엔드에서 계속될 수 있음). 계속할까요?`
        : `${ids.length}개 항목을 큐에서 제거합니다. 계속할까요?`;
    if (!confirm(msg)) return false;
    await Promise.all(ids.map((id) => apiRemoveJob(id)));
    _queueAnchorId = "";
    _queueFocusId = "";
    await refreshQueue();
    return true;
}
