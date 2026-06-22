// 설정 — AccountMenu의 "⚙ 설정"으로 열리는 플로팅 창(ManageAccount 와 같은 패턴).
//  · 강조색 팔레트(프리셋 → CSS 변수 즉시 적용·영속)
//  · 언어 한글/English (선택 영속 — 전체 번역은 단계 적용)
//  · 단축키(변경은 별도 플로팅 창 ShortcutsWindow)
//  · 생성물 전체 가져오기(지금 동기화 = 최신 100. 100 밖은 MCP backfill 안내)
import { useEffect, useState } from "react";
import {
  ACCENT_PRESETS,
  loadAccent,
  saveAccent,
  loadLang,
  loadReduceMotion,
  saveReduceMotion,
  type Lang,
} from "../lib/theme";
import { setLang, useT } from "../lib/i18n";
import { ShortcutsWindow } from "./ShortcutsWindow";
import type { Account } from "../types";

export function SettingsPanel({
  onClose,
  onFullSync,
  account,
}: {
  onClose: () => void;
  onFullSync?: () => Promise<void> | void;
  account?: Account | null;
}) {
  const t = useT();
  const [accent, setAccent] = useState(loadAccent());
  const isCustom = !ACCENT_PRESETS.some(
    (p) => p.hex.toLowerCase() === accent.toLowerCase(),
  );
  const [lang, setLangState] = useState<Lang>(loadLang());
  const [reduceMotion, setReduceMotion] = useState(loadReduceMotion());
  const [copied, setCopied] = useState(false);
  const [copiedBf, setCopiedBf] = useState(false); // 백필 지시문 복사됨 표시
  const [msg, setMsg] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [scOpen, setScOpen] = useState(false); // 단축키 변경 플로팅 창

  // 내 PC에서 에이전트를 띄울 실행 명령(서버=지금 접속한 주소, 이메일=로그인 계정).
  const agentCmd = `python push_agent.py --server ${window.location.origin} --email ${
    account?.email || "<내 이메일>"
  } --watch 30`;
  const copyCmd = () => {
    navigator.clipboard?.writeText(agentCmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  // 과거 전체(100건 밖) 백필 지시문 — 힉스필드 MCP가 붙은 Claude 세션에 그대로 줄 문장.
  //  서버 코드·DB 접근 없이 허브 로그인만으로 /api/ingest/mcp 에 직접 적재(멱등). origin·이메일 자동 주입.
  const backfillPrompt = `힉스필드 MCP의 show_generations 도구로 내 생성 이력을 next_cursor가 없어질 때까지 끝까지 페이지네이션해줘. 각 페이지의 items 배열을 ${window.location.origin}/api/ingest/mcp 로 POST해서 이 허브에 올려줘. 인증은 ${window.location.origin}/api/auth/login 에 이메일 ${
    account?.email || "<내 이메일>"
  } 과 내 비밀번호로 먼저 로그인해 받은 token을 Authorization: Bearer 헤더로 붙이면 돼. 멱등이라 여러 번 돌려도 중복은 안 생겨.`;
  const copyBackfill = () => {
    navigator.clipboard?.writeText(backfillPrompt).then(() => {
      setCopiedBf(true);
      setMsg("지시문을 복사했습니다. 내 힉스필드 계정으로 MCP가 연결된 Claude 세션에 붙여넣으세요.");
      setTimeout(() => setCopiedBf(false), 1500);
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickAccent = (hex: string) => {
    setAccent(hex);
    saveAccent(hex); // CSS 변수 즉시 갱신 + localStorage
  };
  const pickLang = (l: Lang) => {
    setLangState(l);
    setLang(l); // 즉시 UI 리렌더 + 영속(<html lang> 포함)
  };
  const fullSync = async () => {
    if (!onFullSync) return;
    setSyncing(true);
    setMsg("");
    try {
      await onFullSync();
      setMsg("최신 동기화 완료. 100건 밖 과거 전체는 Claude에게 “전체 가져와줘”라고 요청하세요.");
    } catch (e) {
      setMsg("동기화 실패: " + String(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <div className="info-catcher" onMouseDown={onClose} />
      <div className="manage-float settings-float" role="dialog" aria-label={t("설정")}>
        <header className="admin-head">
          <span className="admin-title">⚙ {t("설정")}</span>
          <button className="assets-x" onClick={onClose} title={t("닫기")}>
            ✕
          </button>
        </header>

        <div className="admin-body">
          {/* 강조색 팔레트 */}
          <section className="settings-section">
            <h4>{t("강조색")}</h4>
            <div className="accent-swatches">
              {ACCENT_PRESETS.map((p) => (
                <button
                  key={p.key}
                  className={"accent-swatch" + (accent === p.hex ? " on" : "")}
                  style={{ background: p.hex }}
                  title={p.name}
                  onClick={() => pickAccent(p.hex)}
                >
                  {accent === p.hex && <span className="accent-check">✓</span>}
                </button>
              ))}
              {/* 커스텀 — OS 컬러 피커로 직접 선택. 프리셋에 없으면 이 칸이 현재 색. */}
              <label
                className={"accent-swatch accent-custom" + (isCustom ? " on" : "")}
                title="커스텀 색 선택"
                style={isCustom ? { background: accent } : undefined}
              >
                <input
                  type="color"
                  value={accent}
                  onChange={(e) => pickAccent(e.target.value)}
                />
                <span className="accent-check">{isCustom ? "✓" : "＋"}</span>
              </label>
            </div>
            <p className="settings-hint">{t("선택 즉시 적용되고 다음 접속에도 유지됩니다.")}</p>
          </section>

          {/* 언어 — 강조색 바로 아래 */}
          <section className="settings-section">
            <h4>{t("언어 · Language")}</h4>
            <div className="lang-toggle">
              <button className={lang === "ko" ? "on" : ""} onClick={() => pickLang("ko")}>
                한글
              </button>
              <button className={lang === "en" ? "on" : ""} onClick={() => pickLang("en")}>
                English
              </button>
            </div>
            <p className="settings-hint">
              {t("선택은 저장됩니다. 영어 UI 번역은 순차 적용 예정입니다.")}
            </p>
          </section>

          {/* 모션(애니메이션) — 언어처럼 ON/OFF 버튼. ON=재생, OFF=정지(reduceMotion=true). */}
          <section className="settings-section">
            <h4>{t("모션")}</h4>
            <div className="lang-toggle">
              <button
                className={!reduceMotion ? "on" : ""}
                onClick={() => {
                  setReduceMotion(false);
                  saveReduceMotion(false); // 즉시 적용 + 영속
                }}
              >
                ON
              </button>
              <button
                className={reduceMotion ? "on" : ""}
                onClick={() => {
                  setReduceMotion(true);
                  saveReduceMotion(true);
                }}
              >
                OFF
              </button>
            </div>
            <p className="settings-hint">
              {t("ON이면 최종(골드) 카드의 흐르는 빛 같은 장식 애니메이션이 재생되고, OFF면 멈춥니다.")}
            </p>
          </section>

          {/* 단축키 — 변경은 별도 플로팅 창으로 */}
          <section className="settings-section">
            <h4>{t("단축키")}</h4>
            <button className="settings-action" onClick={() => setScOpen(true)}>
              ⌨ {t("단축키 설정")}
            </button>
            <p className="settings-hint">
              {t("지정된 단축키를 보고 원하는 키로 바꿀 수 있습니다.")}
            </p>
          </section>

          {/* 내 힉스필드 연결 — 단축키 아래, 전체 가져오기 위 */}
          <section className="settings-section">
            <h4>{t("내 힉스필드 연결 (에이전트)")}</h4>
            <a className="settings-action" href="/api/agent/run-bat" download="run-agent.bat">
              ⬇ run-agent.bat 받기 (Windows · 원클릭)
            </a>
            <p className="settings-hint">
              내 PC에 켜두면 내 작업을 허브에 올리고, 허브 생성·재생성을 내 CLI로 실행합니다.
              더블클릭 → 없으면 <b>Python·Node·CLI 자동 설치 → 로그인 1회 → 작동</b>.{" "}
              (처음 설치 시 창 닫고 한 번 더 더블클릭)
            </p>

            {/* 폴백 — Mac/Linux·고급: 스크립트 직접 받기 + 명령 복사 */}
            <details className="agent-adv">
              <summary>Mac/Linux · 직접 실행</summary>
              <a className="settings-action" href="/api/agent/download" download="push_agent.py">
                ⬇ push_agent.py 직접 받기
              </a>
              <div className="agent-cmd">
                <code>{agentCmd}</code>
                <button className="agent-copy" onClick={copyCmd} title="명령 복사">
                  {copied ? "✓ 복사됨" : "복사"}
                </button>
              </div>
            </details>

            {/* 생성물 전체 가져오기 — Mac/Linux 직접실행 바로 밑, 같은 접이식 형태(같은 섹션 안). 펼치면 MCP 지시문 복사 + 최신100 동기화. */}
            <details className="agent-adv import-fold">
              <summary>{t("생성물 전체 가져오기")}</summary>

              <button className="settings-action" onClick={copyBackfill}>
                ⬇ History 전체 가져오기 (MCP 지시문 복사)
              </button>
              <p className="settings-hint">
                CLI는 최신 100건까지만 가져옵니다. <b>100건 밖 전체</b>는 MCP로 채웁니다 — 버튼으로 복사한
                지시문을 <b>힉스필드 MCP가 연결된 Claude 세션</b>에 붙여넣으면 끝까지 올립니다(멱등).
              </p>
              <div className="agent-cmd prompt">
                <code>{backfillPrompt}</code>
                <button className="agent-copy" onClick={copyBackfill} title="지시문 복사">
                  {copiedBf ? "✓ 복사됨" : "복사"}
                </button>
              </div>
            </details>

            {/* 최신 100건만 빠른 동기화(CLI) — 위 둘(Mac/Linux·생성물 전체)과 같은 레벨(섹션 직속) */}
            <details className="agent-adv">
              <summary>최신 100건 동기화</summary>
              <button className="settings-action" onClick={fullSync} disabled={syncing || !onFullSync}>
                {syncing ? t("가져오는 중…") : t("↺ 최신 100건 동기화")}
              </button>
              <p className="settings-hint">
                지금 즉시 <b>최신 100건</b>을 불러옵니다.
              </p>
            </details>

            {msg && <p className="manage-msg">{msg}</p>}
          </section>
        </div>
      </div>

      {scOpen && <ShortcutsWindow onClose={() => setScOpen(false)} />}
    </>
  );
}
