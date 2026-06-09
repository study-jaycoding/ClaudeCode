// 스포트라이트 프롬프트 (생성 모달 대체).
// 화면 중앙 상단에 떠오르는 입력창 — Ctrl/⌘+K 로 열고 Esc 로 닫는다.
// 프롬프트 + 모델 드롭다운이 기본, 'Ｎ＋레퍼런스'로 @Image/@Video 슬롯을 펼친다.
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ModelInfo } from "../types";

interface RefSlot {
  file_path: string;
  type: "image" | "video";
  role: string;
}

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export function SpotlightPrompt({ onClose, onCreated }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [refs, setRefs] = useState<RefSlot[]>([]);
  const [showRefs, setShowRefs] = useState(false);
  const [refInput, setRefInput] = useState("");
  const [refRole, setRefRole] = useState("@Image1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    api
      .models()
      .then((m) => {
        setModels(m);
        if (m.length) setModel(m[0].job_set_type);
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Esc 로 닫기 (전역)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const addRef = () => {
    if (!refInput.trim()) return;
    const isVideo = refRole.toLowerCase().includes("video");
    setRefs([
      ...refs,
      { file_path: refInput.trim(), type: isVideo ? "video" : "image", role: refRole },
    ]);
    setRefInput("");
  };

  const submit = async () => {
    setError(null);
    if (!prompt.trim() || !model) {
      setError("프롬프트와 모델은 필수입니다.");
      return;
    }
    setBusy(true);
    try {
      await api.create({ prompt: prompt.trim(), model, references: refs });
      onCreated();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  // 프롬프트에서 Enter = 생성, Shift+Enter = 줄바꿈
  const onPromptKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!busy) submit();
    }
  };

  return (
    <div className="spotlight-backdrop" onMouseDown={onClose}>
      <div className="spotlight" onMouseDown={(e) => e.stopPropagation()}>
        <div className="spotlight-input">
          <span className="spotlight-icon">✦</span>
          <textarea
            ref={inputRef}
            rows={1}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onPromptKey}
            placeholder="프롬프트를 입력하세요…  (Enter 생성 · Shift+Enter 줄바꿈)"
          />
        </div>

        <div className="spotlight-row">
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.length === 0 && <option>모델 불러오는 중…</option>}
            {models.map((m) => (
              <option key={m.job_set_type} value={m.job_set_type}>
                {m.display_name} ({m.type})
              </option>
            ))}
          </select>

          <button
            className={"ghost" + (showRefs ? " on" : "")}
            onClick={() => setShowRefs((v) => !v)}
          >
            ＋레퍼런스{refs.length ? ` (${refs.length})` : ""}
          </button>

          <span className="spotlight-spacer" />

          <button className="primary" disabled={busy} onClick={submit}>
            {busy ? "시작 중…" : "↵ 생성"}
          </button>
        </div>

        {showRefs && (
          <div className="spotlight-refs">
            <div className="ref-add">
              <select value={refRole} onChange={(e) => setRefRole(e.target.value)}>
                <option>@Image1</option>
                <option>@Image2</option>
                <option>@Start</option>
                <option>@End</option>
                <option>@Video</option>
              </select>
              <input
                value={refInput}
                placeholder="로컬 경로 또는 업로드/잡 UUID"
                onChange={(e) => setRefInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addRef()}
              />
              <button onClick={addRef}>추가</button>
            </div>
            <div className="ref-list">
              {refs.map((r, i) => (
                <span key={i} className="ref-chip">
                  {r.role}: {r.file_path.slice(0, 24)}
                  <button onClick={() => setRefs(refs.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {error && <div className="error spotlight-error">{error}</div>}
        <p className="spotlight-hint">
          ⚠️ 생성은 Higgsfield 크레딧을 소모합니다 · Esc 로 닫기
        </p>
      </div>
    </div>
  );
}
