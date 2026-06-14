// 로그인/가입 화면 — CONTENT_HUB_AUTH=1 이고 미로그인일 때 앱 전체를 가린다(로드맵 §4-2).
// 가입은 자동 등록(승인 대기). 첫 계정만 부트스트랩 관리자라 바로 로그인된다.
import { useState } from "react";
import { api, setAuthToken } from "../api";
import type { Account, AuthConfig } from "../types";

export function LoginScreen({
  config,
  onAuthed,
}: {
  config: AuthConfig;
  onAuthed: (account: Account) => void;
}) {
  // 계정이 하나도 없으면 첫 가입(=관리자 부트스트랩)을 기본으로 안내
  const [mode, setMode] = useState<"login" | "register">(
    config.has_accounts ? "login" : "register",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const first = !config.has_accounts; // 첫 계정 = 관리자

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    try {
      if (mode === "login") {
        const { account, token } = await api.login(email.trim(), password);
        setAuthToken(token);
        onAuthed(account);
      } else {
        const { account, token } = await api.register(email.trim(), password, name.trim());
        if (token) {
          setAuthToken(token); // 부트스트랩 관리자 → 자동 로그인
          onAuthed(account);
        } else {
          // 일반 가입 → 승인 대기. 로그인 탭으로 전환하고 안내.
          setMode("login");
          setInfo("가입 완료 — 관리자 승인 후 로그인할 수 있습니다.");
          setPassword("");
        }
      }
    } catch (err) {
      setError(String(err).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">⬡ Content Hub</div>
        <div className="login-sub">
          {first
            ? "첫 계정을 만들면 관리자가 됩니다."
            : mode === "login"
              ? "로그인"
              : "가입 — 관리자 승인 후 이용"}
        </div>

        {!first && (
          <div className="login-tabs">
            <button
              type="button"
              className={mode === "login" ? "on" : ""}
              onClick={() => {
                setMode("login");
                setError("");
              }}
            >
              로그인
            </button>
            <button
              type="button"
              className={mode === "register" ? "on" : ""}
              onClick={() => {
                setMode("register");
                setError("");
              }}
            >
              가입
            </button>
          </div>
        )}

        <input
          type="email"
          placeholder="이메일"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          required
        />
        {mode === "register" && (
          <input
            type="text"
            placeholder="이름 (표시용)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <input
          type="password"
          placeholder="비밀번호 (6자 이상)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error && <div className="login-error">{error}</div>}
        {info && <div className="login-info">{info}</div>}

        <button type="submit" className="login-submit" disabled={busy}>
          {busy ? "처리 중…" : mode === "login" ? "로그인" : first ? "관리자 계정 만들기" : "가입"}
        </button>
      </form>
    </div>
  );
}
