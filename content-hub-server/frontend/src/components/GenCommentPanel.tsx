// 생성본 코멘트 스레드 패널(공유, 에셋 파트와 별개로 동작).
// 글·답글(parent_id) · 작성자/시각 · 내 글만 수정·삭제(남이 답글 달면 잠김).
// 팀 공유 시 다른 팀원이 보고 답글을 달 수 있는 정보(데이터 모델은 공유 백엔드 전제 — Phase 5).
// 에셋의 .cmt-* 패널과 같은 CSS·상호작용이되 gen_id 키 + 전용 api 를 쓴다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { GenComment } from "../types";

const ME = "me"; // 현재 작업자(DEFAULT_WORKER_ID). 내 코멘트 판별용

function fmtWhen(s: string): string {
  const d = new Date(s.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function loadJSON<T>(key: string): T | null {
  try {
    const r = localStorage.getItem(key);
    return r ? (JSON.parse(r) as T) : null;
  } catch {
    return null;
  }
}

interface Props {
  genId: string;
  label: string; // 헤더 표시용(프롬프트 일부 등)
  onClose: () => void;
  onChanged: () => void; // 글 작성/읽음/수정/삭제 후 → 그리드 C 뱃지 갱신용 reload
  muteOwn: boolean; // 내가 쓴 코멘트는 미확인 알림에서 제외
  onToggleMute: () => void;
}

export function GenCommentPanel({
  genId,
  label,
  onClose,
  onChanged,
  muteOwn,
  onToggleMute,
}: Props) {
  const [comments, setComments] = useState<GenComment[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() =>
    loadJSON("ch.gen.cmtPos"),
  );
  const [size, setSize] = useState<{ w: number; h: number } | null>(() =>
    loadJSON("ch.gen.cmtSize"),
  );
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 패널 위치·크기 영속
  useEffect(() => {
    if (pos) localStorage.setItem("ch.gen.cmtPos", JSON.stringify(pos));
  }, [pos]);
  useEffect(() => {
    if (size) localStorage.setItem("ch.gen.cmtSize", JSON.stringify(size));
  }, [size]);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // genId 바뀌면(다른 카드 열기) 스레드 로드 + 읽음 처리 → 뱃지 갱신.
  const refresh = useCallback(
    () => api.genComments(genId).then(setComments).catch(() => setComments([])),
    [genId],
  );
  useEffect(() => {
    setEditingId(null);
    setReplyingId(null);
    refresh();
    api.markGenCommentsRead(genId).then(onChanged).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genId]);

  const sendComment = (text: string, parentId?: string | null) => {
    const t = text.trim();
    if (!t) return;
    setReplyingId(null);
    // 작성 시점의 '내 알림 끄기' 상태를 이 코멘트에 캡처(코멘트별).
    api
      .addGenComment(genId, t, parentId, muteOwn)
      .then(refresh)
      .then(onChanged)
      .catch(() => {});
  };
  const editComment = (id: string, text: string) => {
    const t = text.trim();
    if (!t) return;
    setEditingId(null);
    api.editGenComment(id, t).then(refresh).catch((e) => alert(String(e)));
  };
  const delComment = (id: string) => {
    if (!window.confirm("이 코멘트를 삭제할까요?")) return;
    api.deleteGenComment(id).then(refresh).then(onChanged).catch((e) => alert(String(e)));
  };

  // 드래그(헤더)
  const onDrag = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({ x: e.clientX - d.dx, y: e.clientY - d.dy });
  }, []);
  const onDragUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("mousemove", onDrag);
    window.removeEventListener("mouseup", onDragUp);
  }, [onDrag]);
  const onHeadDown = (e: React.MouseEvent) => {
    const p = pos || { x: 240, y: 160 };
    dragRef.current = { dx: e.clientX - p.x, dy: e.clientY - p.y };
    window.addEventListener("mousemove", onDrag);
    window.addEventListener("mouseup", onDragUp);
  };

  // 코멘트 트리(부모 → 답글)
  const cmtByParent = useMemo(() => {
    const m: Record<string, GenComment[]> = {};
    for (const c of comments) (m[c.parent_id || ""] ||= []).push(c);
    return m;
  }, [comments]);
  const cmtById = useMemo(() => {
    const m: Record<string, GenComment> = {};
    for (const c of comments) m[c.id] = c;
    return m;
  }, [comments]);
  const cmtRoots = useMemo(() => {
    const ids = new Set(comments.map((c) => c.id));
    return comments.filter((c) => !c.parent_id || !ids.has(c.parent_id)).slice().reverse();
  }, [comments]);

  // 한 루트의 하위 답글을 평탄화(시간순) — 들여쓰기 1단계 고정.
  const descendantsOf = (rootId: string): GenComment[] => {
    const out: GenComment[] = [];
    const collect = (pid: string) => {
      for (const k of cmtByParent[pid] || []) {
        out.push(k);
        collect(k.id);
      }
    };
    collect(rootId);
    return out.sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1,
    );
  };

  const renderRow = (c: GenComment, isReply: boolean, replyToName: string | null) => {
    const mine = c.author === ME;
    const lockedByReply = (cmtByParent[c.id] || []).some((ch) => ch.author !== ME);
    return (
      <div key={c.id} className={"cmt-item" + (isReply ? " reply" : "")}>
        <div className="cmt-meta">
          <span className="cmt-author">{c.author_name || c.author}</span>
          {replyToName && <span className="cmt-replyto">↳ {replyToName}</span>}
          <span className="cmt-when">{fmtWhen(c.created_at)}</span>
          <div className="cmt-acts">
            <button onClick={() => { setReplyingId(c.id); setEditingId(null); }}>답글</button>
            {mine && !lockedByReply && (
              <>
                <button onClick={() => { setEditingId(c.id); setReplyingId(null); }}>수정</button>
                <button onClick={() => delComment(c.id)}>삭제</button>
              </>
            )}
            {mine && lockedByReply && (
              <span className="cmt-lock" title="답글이 달려 수정·삭제 불가">🔒</span>
            )}
          </div>
        </div>

        {editingId === c.id ? (
          <form
            className="cmt-mini"
            onSubmit={(e) => {
              e.preventDefault();
              const el = e.currentTarget.elements.namedItem("e") as HTMLInputElement;
              editComment(c.id, el.value);
            }}
          >
            <input name="e" defaultValue={c.text} autoFocus
              onKeyDown={(e) => { if (e.key === "Escape") setEditingId(null); }} />
            <button type="submit">저장</button>
          </form>
        ) : (
          <div className="cmt-text">{c.text}</div>
        )}

        {replyingId === c.id && (
          <form
            className="cmt-mini"
            onSubmit={(e) => {
              e.preventDefault();
              const el = e.currentTarget.elements.namedItem("r") as HTMLInputElement;
              sendComment(el.value, c.id);
              el.value = "";
            }}
          >
            <input name="r" placeholder="답글 작성 ⏎" autoFocus
              onKeyDown={(e) => { if (e.key === "Escape") setReplyingId(null); }} />
            <button type="submit">답글</button>
          </form>
        )}
      </div>
    );
  };

  const renderThread = (root: GenComment) => (
    <div key={root.id} className="cmt-group">
      {renderRow(root, false, null)}
      {descendantsOf(root.id).map((d) => {
        const parent = d.parent_id ? cmtById[d.parent_id] : undefined;
        const toName =
          parent && d.parent_id !== root.id ? `${parent.author_name || parent.author}` : null;
        return renderRow(d, true, toName);
      })}
    </div>
  );

  return (
    <div
      className="cmt-panel"
      ref={panelRef}
      style={{
        left: (pos || { x: 240, y: 160 }).x,
        top: (pos || { x: 240, y: 160 }).y,
        width: size?.w,
        height: size?.h,
      }}
    >
      <div className="cmt-head" onMouseDown={onHeadDown}>
        <span className="cmt-title">
          💬 코멘트 <span className="muted">({comments.length})</span>
        </span>
        <span className="cmt-file">{label}</span>
        <button className="cmt-x" onMouseDown={(e) => e.stopPropagation()} onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="cmt-thread">
        {comments.length === 0 && <div className="cmt-empty">아직 코멘트가 없습니다.</div>}
        {cmtRoots.map((root) => renderThread(root))}
      </div>

      <form
        className="cmt-input"
        onSubmit={(e) => {
          e.preventDefault();
          const el = e.currentTarget.elements.namedItem("c") as HTMLInputElement;
          sendComment(el.value);
          el.value = "";
        }}
      >
        <input name="c" autoComplete="off" placeholder="코멘트 작성 ⏎" autoFocus />
        <button type="submit">전송</button>
      </form>

      <label className="cmt-opt">
        <input type="checkbox" checked={muteOwn} onChange={onToggleMute} />
        내가 작성한 코멘트 알림 끄기
      </label>
    </div>
  );
}
