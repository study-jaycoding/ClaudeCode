// 관리자 창 — 로드맵 §4-5. 좌측 상단 "Content Hub" 클릭으로 열림.
// 멤버 등급(C0~C5) 관리 + 프로젝트 관리. ⚠️ 로그인 도입 전이라 '식별·표시'까지만 —
// 실제 접근 차단(권한 검증)은 로그인 단계에서. 지금은 누구나 열 수 있다(2겹 차단은 나중).
import { useEffect, useState } from "react";
import { api } from "../api";
import { ROLES, ROLE_LABEL } from "../types";
import type { Account, Member, Project } from "../types";

export function AdminWindow({ onClose }: { onClose: () => void }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

  const loadProjects = () =>
    api.projects(true).then((r) => setProjects(r.projects)).catch(() => {});
  const loadAccounts = () => api.listAccounts().then(setAccounts).catch(() => setAccounts([]));

  useEffect(() => {
    Promise.all([
      api.members().then(setMembers).catch(() => {}),
      loadProjects(),
      loadAccounts(),
    ]).finally(() => setLoading(false));
  }, []);

  const approve = async (a: Account, status: string) => {
    try {
      await api.setAccountStatus(a.email, status);
      loadAccounts();
    } catch (e) {
      alert("처리 실패: " + String(e));
    }
  };
  const changeAccountRole = async (a: Account, role: string) => {
    try {
      await api.setAccountRole(a.email, role);
      loadAccounts();
    } catch (e) {
      alert("등급 변경 실패: " + String(e));
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const changeRole = async (uid: string, role: string) => {
    try {
      setMembers(await api.setMemberRole(uid, role));
    } catch (e) {
      alert("등급 변경 실패: " + String(e));
    }
  };

  const createProject = async () => {
    const name = window.prompt("새 프로젝트 이름:");
    if (name === null || !name.trim()) return;
    await api.createProject(name.trim());
    loadProjects();
  };
  const renameProject = async (p: Project) => {
    const name = window.prompt("프로젝트 이름:", p.name);
    if (name === null || !name.trim()) return;
    await api.updateProject(p.id, { name: name.trim() });
    loadProjects();
  };
  const toggleArchive = async (p: Project) => {
    await api.updateProject(p.id, { archived: !p.archived });
    loadProjects();
  };
  const deleteProject = async (p: Project) => {
    if (!window.confirm(`프로젝트 '${p.name}' 삭제? 결과물은 미분류로 돌아갑니다.`)) return;
    await api.deleteProject(p.id);
    loadProjects();
  };

  const shortUid = (uid: string) => uid.replace("user_", "").slice(0, 10);

  return (
    <>
      <div className="admin-backdrop" onMouseDown={onClose} />
      <div className="admin-window" role="dialog" aria-label="관리자">
        <header className="admin-head">
          <span className="admin-title">⬡ 관리자</span>
          <button className="assets-x" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>

        <div className="admin-note">
          ⓘ 로그인 도입 전 단계 — 등급은 <b>식별·표시</b>까지입니다. 실제 접근 차단은 로그인
          기능과 함께 적용됩니다(로드맵: 식별 먼저, 차단 나중).
        </div>

        <div className="admin-body">
          {loading ? (
            <div className="admin-loading">불러오는 중…</div>
          ) : (
            <>
              {accounts.length > 0 && (
                <section className="admin-section">
                  <h4>로그인 계정 ({accounts.length})</h4>
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>계정</th>
                        <th>상태</th>
                        <th>등급 · 처리</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accounts.map((a) => (
                        <tr key={a.email}>
                          <td>
                            <div className="admin-member">
                              <span className="admin-mname">{a.name || a.email}</span>
                              <span className="admin-muid" title={a.email}>
                                {a.email}
                              </span>
                            </div>
                          </td>
                          <td>
                            <span className={"acct-status acct-" + a.status}>
                              {a.status === "pending"
                                ? "승인 대기"
                                : a.status === "approved"
                                  ? "승인됨"
                                  : "거부됨"}
                            </span>
                          </td>
                          <td className="acct-actions">
                            {a.status === "pending" ? (
                              <>
                                <button className="acct-approve" onClick={() => approve(a, "approved")}>
                                  승인
                                </button>
                                <button className="acct-reject" onClick={() => approve(a, "rejected")}>
                                  거부
                                </button>
                              </>
                            ) : (
                              <>
                                <select
                                  className="admin-role"
                                  value={a.role}
                                  onChange={(e) => changeAccountRole(a, e.target.value)}
                                >
                                  {ROLES.map((r) => (
                                    <option key={r} value={r}>
                                      {ROLE_LABEL[r]}
                                    </option>
                                  ))}
                                </select>
                                {a.status === "approved" ? (
                                  <button className="acct-reject" onClick={() => approve(a, "rejected")}>
                                    차단
                                  </button>
                                ) : (
                                  <button className="acct-approve" onClick={() => approve(a, "approved")}>
                                    복구
                                  </button>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}

              <section className="admin-section">
                <h4>멤버 · 등급 ({members.length})</h4>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>멤버</th>
                      <th>생성물</th>
                      <th>등급</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.uid}>
                        <td>
                          <div className="admin-member">
                            <span className={"admin-dot" + (m.is_mine ? " mine" : "")} />
                            <span className="admin-mname">
                              {m.is_mine ? "나" : m.name || "팀원"}
                            </span>
                            <span className="admin-muid" title={m.uid}>
                              {m.email || shortUid(m.uid)}
                            </span>
                          </div>
                        </td>
                        <td className="admin-count">{m.count}</td>
                        <td>
                          <select
                            className="admin-role"
                            value={m.role}
                            onChange={(e) => changeRole(m.uid, e.target.value)}
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABEL[r]}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="admin-section">
                <h4 className="admin-sec-head">
                  프로젝트 ({projects.length})
                  <button className="admin-add" onClick={createProject}>
                    + 새 프로젝트
                  </button>
                </h4>
                {projects.length === 0 && <div className="admin-empty">없음</div>}
                <table className="admin-table">
                  <tbody>
                    {projects.map((p) => (
                      <tr key={p.id} className={p.archived ? "archived" : ""}>
                        <td className="admin-pname">
                          {p.name}
                          {p.archived && <span className="admin-badge">보관됨</span>}
                        </td>
                        <td className="admin-count">{p.count}</td>
                        <td className="admin-pactions">
                          <button onClick={() => renameProject(p)} title="이름 변경">
                            ✎
                          </button>
                          <button onClick={() => toggleArchive(p)} title={p.archived ? "복원" : "보관"}>
                            {p.archived ? "↺" : "▾"}
                          </button>
                          <button onClick={() => deleteProject(p)} title="삭제">
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
