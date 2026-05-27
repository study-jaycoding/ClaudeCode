"use strict";

// DOM 요소 참조
const form = document.getElementById("create-form");
const nameInput = document.getElementById("project-name");
const message = document.getElementById("message");
const projectList = document.getElementById("project-list");
const refreshBtn = document.getElementById("refresh-btn");

/**
 * 메시지 영역에 텍스트와 상태(success/error)를 표시한다.
 */
function showMessage(text, kind) {
    message.textContent = text;
    message.className = "message " + (kind || "");
}

/**
 * 사용자 입력 문자열을 HTML 텍스트로 안전하게 렌더링하기 위한 이스케이프.
 */
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[c]));
}

/**
 * 백엔드에서 프로젝트 목록을 가져와 렌더링한다.
 */
async function loadProjects() {
    try {
        const res = await fetch("/api/projects");
        const data = await res.json();
        renderProjects(data.projects || []);
    } catch (err) {
        projectList.innerHTML = `<li class="empty">목록을 불러오지 못했습니다.</li>`;
        console.error(err);
    }
}

/**
 * 프로젝트 배열을 받아 ul 안에 li 들을 채운다.
 */
function renderProjects(projects) {
    if (projects.length === 0) {
        projectList.innerHTML = `<li class="empty">아직 만든 프로젝트가 없습니다.</li>`;
        return;
    }
    projectList.innerHTML = projects
        .map(
            (p) => `
        <li>
            <span class="project-name">${escapeHtml(p.name)}</span>
            <span class="project-created">${escapeHtml(p.created)}</span>
        </li>`
        )
        .join("");
}

/**
 * 폼 제출 시 백엔드에 프로젝트 생성 요청을 보낸다.
 */
form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
        showMessage("프로젝트 이름을 입력하세요.", "error");
        return;
    }
    showMessage("생성 중...", "");
    try {
        const res = await fetch("/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (res.ok) {
            showMessage(`프로젝트 "${data.name}" 생성 완료`, "success");
            nameInput.value = "";
            loadProjects();
        } else {
            showMessage(data.error || "생성에 실패했습니다.", "error");
        }
    } catch (err) {
        showMessage("요청 중 오류 발생: " + err.message, "error");
    }
});

// 새로고침 버튼
refreshBtn.addEventListener("click", loadProjects);

// 페이지 로드 시 자동으로 목록 불러오기
loadProjects();
