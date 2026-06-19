// 설정 — AccountMenu의 "⚙ 설정"으로 열리는 플로팅 창(ManageAccount 와 같은 패턴).
//  · 강조색 팔레트(프리셋 → CSS 변수 즉시 적용·영속)
//  · 언어 한글/English (선택 영속 — 전체 번역은 단계 적용)
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
  const [syncing, setSyncing] = useState(false);

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
  const [msg, setMsg] = useState("");

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
          {/* 내 힉스필드 연결 — 원클릭 run-agent.bat(자동으로 push_agent.py 받아 실행) */}
          <section className="settings-section">
            <h4>{t("내 힉스필드 연결 (에이전트)")}</h4>
            <p className="settings-hint">
              내 PC에서 만든 힉스필드 작업을 허브로 올리고, 허브의 생성·재생성을 내 로컬 CLI로
              실행하려면 이 에이전트를 <b>내 PC에서</b> 띄워두세요. (힉스필드 CLI 설치 +{" "}
              <code>higgsfield auth login</code> + 파이썬 필요)
            </p>
            <a className="settings-action" href="/api/agent/run-bat" download="run-agent.bat">
              ⬇ run-agent.bat 받기 (Windows · 원클릭)
            </a>
            <p className="settings-hint">
              받아서 <b>더블클릭</b> → (실행 때마다 <b>최신 push_agent.py 자동 다운로드</b>) → 허브
              비밀번호 입력 → 켜두면 내가 <b>생성·재생성·'내 작업 올리기'</b>를 할 때 즉시 작동(이벤트
              방식, 30초 폴링 없음). 창을 닫으면 멈춥니다.
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
          </section>

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

          {/* 모션(애니메이션) */}
          <section className="settings-section">
            <h4>{t("모션")}</h4>
            <label className="toggle">
              <input
                type="checkbox"
                checked={reduceMotion}
                onChange={(e) => {
                  setReduceMotion(e.target.checked);
                  saveReduceMotion(e.target.checked); // 즉시 적용 + 영속
                }}
              />
              {t("모션 끄기 (골드 글로우 등 애니메이션 정지)")}
            </label>
            <p className="settings-hint">
              {t("켜면 최종(골드) 카드의 흐르는 빛 같은 장식 애니메이션이 멈춥니다.")}
            </p>
          </section>


          {/* 언어 */}
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

          {/* 생성물 전체 가져오기 */}
          <section className="settings-section">
            <h4>{t("생성물 전체 가져오기")}</h4>
            <button className="settings-action" onClick={fullSync} disabled={syncing || !onFullSync}>
              {syncing ? t("가져오는 중…") : t("↺ 지금 전체 가져오기")}
            </button>
            <p className="settings-hint">
              지금 동기화로 <b>최신 100건</b>을 즉시 가져옵니다(자동 20초 주기와 별개). 힉스필드 CLI
              한계로 100건 밖 과거 전체는 Claude에게 “전체 가져와줘”라고 하면 MCP(backfill)로 끌어와
              채웁니다.
            </p>
            {msg && <p className="manage-msg">{msg}</p>}
          </section>
        </div>
      </div>
    </>
  );
}
