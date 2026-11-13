const state = {
  session: null,
  activeCycleId: null,
  activeTab: "status",
  reportPollTimer: null,
};

function clearReportPollTimer() {
  if (state.reportPollTimer) {
    clearTimeout(state.reportPollTimer);
    state.reportPollTimer = null;
  }
}

const MAX_QUESTION_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

function getCurrentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

function setTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", normalized);
  try {
    localStorage.setItem("peerflow_theme", normalized);
  } catch {}
  const btn = document.getElementById("btn-theme-toggle");
  if (btn) {
    btn.textContent = normalized === "dark" ? "☀️ 라이트 모드" : "🌙 다크 모드";
  }
}

function toggleTheme() {
  setTheme(getCurrentTheme() === "dark" ? "light" : "dark");
}

function showToast(message, isError = false) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast${isError ? " error" : ""}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function showConfirmModal({
  title = "작업 확인",
  message = "이 작업을 진행하시겠습니까?",
  confirmLabel = "확인",
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById("confirm-modal");
    const titleEl = document.getElementById("confirm-modal-title");
    const msgEl = document.getElementById("confirm-modal-message");
    const cancelBtn = document.getElementById("confirm-modal-cancel");
    const okBtn = document.getElementById("confirm-modal-ok");

    if (!backdrop || !titleEl || !msgEl || !cancelBtn || !okBtn) {
      resolve(window.confirm(message));
      return;
    }

    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = confirmLabel;
    okBtn.className = `btn${danger ? " btn-danger" : ""}`;
    backdrop.hidden = false;

    const cleanup = (result) => {
      backdrop.hidden = true;
      cancelBtn.removeEventListener("click", onCancel);
      okBtn.removeEventListener("click", onOk);
      backdrop.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKeydown);
      resolve(result);
    };

    const onCancel = () => cleanup(false);
    const onOk = () => cleanup(true);
    const onBackdrop = (e) => {
      if (e.target === backdrop) cleanup(false);
    };
    const onKeydown = (e) => {
      if (e.key === "Escape") cleanup(false);
    };

    cancelBtn.addEventListener("click", onCancel);
    okBtn.addEventListener("click", onOk);
    backdrop.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKeydown);
    okBtn.focus();
  });
}

async function withAsyncLock(el, fn) {
  if (!el) return fn();
  if (el.dataset.busy === "true") return;
  el.dataset.busy = "true";

  const buttons =
    el.tagName === "FORM"
      ? [...el.querySelectorAll('button[type="submit"], button:not([type])')]
      : el.tagName === "BUTTON"
        ? [el]
        : [];

  buttons.forEach((b) => {
    b.disabled = true;
  });

  try {
    return await fn();
  } finally {
    el.dataset.busy = "false";
    buttons.forEach((b) => {
      if (b.isConnected) b.disabled = false;
    });
  }
}

function esc(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.session?.csrf_token) {
    headers.set("X-CSRF-Token", state.session.csrf_token);
  }
  let body = options.body;
  if (body && !(body instanceof FormData) && typeof body === "object") {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }
  const res = await fetch(path, {
    ...options,
    headers,
    body,
    credentials: "same-origin",
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `요청 실패 (${res.status})`);
  }
  return data;
}

function renderNav() {
  const nav = document.getElementById("nav-actions");
  if (!nav) return;
  const themeLabel =
    getCurrentTheme() === "dark" ? "☀️ 라이트 모드" : "🌙 다크 모드";
  const themeBtnHtml = `<button type="button" id="btn-theme-toggle" class="btn btn-outline btn-sm">${themeLabel}</button>`;

  if (!state.session) {
    nav.innerHTML = `
      ${themeBtnHtml}
      <a href="/login" class="btn btn-outline btn-sm" data-link>리뷰어 로그인</a>
      <a href="/admin/login" class="btn btn-outline btn-sm" data-link>관리자 로그인</a>
    `;
  } else if (state.session.role === "ADMIN") {
    nav.innerHTML = `
      <span class="muted">${esc(state.session.admin?.username)} (관리자)</span>
      <a href="/admin" class="btn btn-outline btn-sm" data-link>회차 관리</a>
      <a href="/admin/members" class="btn btn-outline btn-sm" data-link>팀원 관리</a>
      ${themeBtnHtml}
      <button id="btn-logout" class="btn btn-outline btn-sm">로그아웃</button>
    `;
  } else {
    nav.innerHTML = `
      <span class="muted">${esc(state.session.reviewer?.name)} 님</span>
      ${themeBtnHtml}
      <button id="btn-logout" class="btn btn-outline btn-sm">로그아웃</button>
    `;
  }

  document
    .getElementById("btn-theme-toggle")
    ?.addEventListener("click", toggleTheme);

  document.getElementById("btn-logout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    state.session = null;
    navigate("/login");
  });
}

async function renderSetup(root) {
  root.innerHTML = `
    <div class="card auth-card">
      <h2>최초 관리자 설정</h2>
      <p class="muted">시스템을 사용할 최초 관리자 계정을 생성합니다.</p>
      <form id="form-setup">
        <div class="form-group">
          <label>아이디</label>
          <input type="text" name="username" required />
        </div>
        <div class="form-group">
          <label>이메일</label>
          <input type="email" name="email" required />
        </div>
        <div class="form-group">
          <label>비밀번호 (8자 이상)</label>
          <input type="password" name="password" minlength="8" required />
        </div>
        <button type="submit" class="btn" style="width:100%">관리자 생성 및 시작</button>
      </form>
    </div>
  `;
  const form = document.getElementById("form-setup");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await withAsyncLock(form, async () => {
      const fd = new FormData(form);
      try {
        state.session = await api("/api/auth/setup", {
          method: "POST",
          body: {
            username: fd.get("username"),
            email: fd.get("email"),
            password: fd.get("password"),
          },
        });
        renderNav();
        navigate("/admin");
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

function renderReviewerLogin(root) {
  root.innerHTML = `
    <div class="card auth-card">
      <h2>리뷰어 PIN 로그인</h2>
      <p class="muted">Slack DM으로 전달받은 6자리 숫자 PIN을 입력해 주세요.</p>
      <form id="form-pin-login">
        <div class="form-group">
          <label>6자리 PIN 코드</label>
          <input type="text" name="pin_code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" required />
        </div>
        <button type="submit" class="btn" style="width:100%">피어리뷰 시작하기</button>
      </form>
    </div>
  `;
  const form = document.getElementById("form-pin-login");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await withAsyncLock(form, async () => {
      const fd = new FormData(form);
      try {
        state.session = await api("/api/auth/reviewer/login", {
          method: "POST",
          body: { pin_code: fd.get("pin_code") },
        });
        renderNav();
        navigate("/");
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

function renderAdminLogin(root) {
  root.innerHTML = `
    <div class="card auth-card">
      <h2>관리자 로그인</h2>
      <form id="form-admin-login">
        <div class="form-group">
          <label>아이디</label>
          <input type="text" name="username" required />
        </div>
        <div class="form-group">
          <label>비밀번호</label>
          <input type="password" name="password" required />
        </div>
        <button type="submit" class="btn" style="width:100%">로그인</button>
      </form>
    </div>
  `;
  const form = document.getElementById("form-admin-login");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await withAsyncLock(form, async () => {
      const fd = new FormData(form);
      try {
        state.session = await api("/api/auth/admin/login", {
          method: "POST",
          body: {
            username: fd.get("username"),
            password: fd.get("password"),
          },
        });
        renderNav();
        navigate("/admin");
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

async function renderReviewerDashboard(root) {
  const data = await api("/api/reviewer/dashboard");
  root.innerHTML = `
    <div class="card">
      <span class="badge">${esc(data.cycle.status)}</span>
      <h2 style="margin-top:8px;">${esc(data.cycle.title)}</h2>
      <p class="muted">${esc(data.cycle.reviewer_notice_message)}</p>
      <p>진행률: <strong>${data.submitted_count} / ${data.total_count}명 완료 (${data.completion_rate}%)</strong></p>
    </div>
    <div class="card">
      <h3>내 피어리뷰 대상 목록</h3>
      <table>
        <thead>
          <tr><th>피평가자</th><th>부서</th><th>상태</th><th>작성</th></tr>
        </thead>
        <tbody>
          ${data.assignments
            .map(
              (a) => `
            <tr>
              <td><strong>${esc(a.reviewee.name)}</strong></td>
              <td>${esc(a.reviewee.department)}</td>
              <td>${a.is_submitted ? '<span class="badge badge-success">제출 완료</span>' : '<span class="badge">미제출</span>'}</td>
              <td><a href="/review/${a.id}" class="btn btn-sm" data-link>${a.is_submitted ? "열람" : "작성하기"}</a></td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

async function renderReviewerForm(root, assignmentId) {
  const data = await api(`/api/reviewer/assignments/${assignmentId}`);
  const answerMap = new Map(data.answers.map((a) => [a.question_id, a]));
  const disabled = data.is_locked ? "disabled" : "";

  root.innerHTML = `
    <div class="card">
      <a href="/" class="btn btn-outline btn-sm" data-link>← 목록으로</a>
      <h2 style="margin-top:12px;">${esc(data.assignment.reviewee.name)} 님에 대한 피어리뷰</h2>
      <p class="muted">${data.is_locked ? "제출 완료되었거나 마감된 리뷰입니다 (읽기 전용)." : "모든 문항을 작성한 뒤 최종 제출해 주세요."}</p>
    </div>
    <form id="form-review">
      ${data.questions
        .map((q) => {
          const prev = answerMap.get(q.id) || {};
          return `
          <div class="card" data-question-id="${q.id}" data-question-type="${q.question_type}">
            <span class="badge">${esc(q.category)}</span>
            <h3 style="margin-top:8px;">Q${q.display_order}. ${esc(q.content)}</h3>
            ${q.image_url ? `<div style="margin:12px 0;"><img src="${esc(q.image_url)}" style="max-height:200px;border-radius:8px;" alt="문항 이미지"/></div>` : ""}
            ${
              q.question_type === "RATING"
                ? `<div style="display:flex;gap:12px;flex-wrap:wrap;">
                    ${[1, 2, 3, 4, 5]
                      .map(
                        (n) => `
                      <label style="display:inline-flex;align-items:center;gap:6px;">
                        <input type="radio" name="q_${q.id}" value="${n}" ${prev.rating_value === n ? "checked" : ""} ${disabled} />
                        ${n}점
                      </label>`,
                      )
                      .join("")}
                  </div>`
                : q.question_type === "TEXT"
                  ? `<textarea name="q_${q.id}" maxlength="2000" ${disabled}>${esc(prev.answer_text || "")}</textarea>`
                  : q.options
                      .map((opt) => {
                        const checked = (prev.option_ids || []).includes(opt.id)
                          ? "checked"
                          : "";
                        const inputType =
                          q.question_type === "SINGLE_CHOICE"
                            ? "radio"
                            : "checkbox";
                        return `
                        <div style="margin-bottom:6px;">
                          <label style="display:inline-flex;align-items:center;gap:8px;">
                            <input type="${inputType}" name="q_${q.id}" value="${opt.id}" ${checked} ${disabled} />
                            ${esc(opt.option_text)}
                          </label>
                        </div>`;
                      })
                      .join("")
            }
          </div>`;
        })
        .join("")}
      ${
        !data.is_locked
          ? `<div style="display:flex;gap:12px;">
              <button type="button" id="btn-save-draft" class="btn btn-outline">임시 저장</button>
              <button type="submit" class="btn">최종 제출</button>
            </div>`
          : ""
      }
    </form>
  `;

  const collectAnswers = () => {
    return data.questions.map((q) => {
      if (q.question_type === "RATING") {
        const checked = document.querySelector(
          `input[name="q_${q.id}"]:checked`,
        );
        return {
          question_id: q.id,
          rating_value: checked ? Number(checked.value) : null,
        };
      }
      if (q.question_type === "TEXT") {
        const area = document.querySelector(`textarea[name="q_${q.id}"]`);
        return {
          question_id: q.id,
          answer_text: area ? area.value : null,
        };
      }
      const checkedEls = [
        ...document.querySelectorAll(`input[name="q_${q.id}"]:checked`),
      ];
      return {
        question_id: q.id,
        option_ids: checkedEls.map((el) => Number(el.value)),
      };
    });
  };

  const draftBtn = document.getElementById("btn-save-draft");
  draftBtn?.addEventListener("click", async () => {
    await withAsyncLock(draftBtn, async () => {
      try {
        await api(`/api/reviewer/assignments/${assignmentId}/draft`, {
          method: "PUT",
          body: { answers: collectAnswers() },
        });
        showToast("임시 저장되었습니다.");
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  const reviewForm = document.getElementById("form-review");
  reviewForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ok = await showConfirmModal({
      title: "피어리뷰 최종 제출",
      message: `${data.assignment.reviewee.name} 님에 대한 피어리뷰를 최종 제출하시겠습니까?\n제출 완료 후에는 내용을 수정할 수 없습니다.`,
      confirmLabel: "최종 제출",
    });
    if (!ok) return;

    await withAsyncLock(reviewForm, async () => {
      try {
        await api(`/api/reviewer/assignments/${assignmentId}/submit`, {
          method: "POST",
          body: { answers: collectAnswers() },
        });
        showToast("피어리뷰가 최종 제출되었습니다.");
        navigate("/");
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

async function renderAdminMembers(root) {
  const { items } = await api("/api/admin/members");
  root.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <h3>팀원 단건 등록</h3>
        <form id="form-add-member">
          <div class="form-group"><label>이름</label><input type="text" name="name" required /></div>
          <div class="form-group"><label>이메일</label><input type="email" name="email" required /></div>
          <div class="form-group"><label>부서</label><input type="text" name="department" /></div>
          <div class="form-group"><label>Slack User ID</label><input type="text" name="slack_user_id" /></div>
          <button type="submit" class="btn">등록</button>
        </form>
      </div>
      <div class="card">
        <h3>팀원 CSV 일괄 업로드</h3>
        <form id="form-csv-member">
          <div class="form-group"><label>CSV 파일 (.csv)</label><input type="file" name="csv_file" accept=".csv" required /></div>
          <button type="submit" class="btn btn-outline">CSV 업로드</button>
        </form>
      </div>
    </div>
    <div class="card">
      <h3>등록된 팀원 (${items.length}명)</h3>
      <table>
        <thead><tr><th>이름</th><th>이메일</th><th>부서</th><th>Slack ID</th><th>관리</th></tr></thead>
        <tbody>
          ${items
            .map(
              (m) => `
            <tr>
              <td><strong>${esc(m.name)}</strong></td>
              <td>${esc(m.email)}</td>
              <td>${esc(m.department)}</td>
              <td>${esc(m.slack_user_id)}</td>
              <td><button class="btn btn-danger btn-sm" data-del-member="${m.id}" data-member-name="${esc(m.name)}">삭제</button></td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;

  const addMemberForm = document.getElementById("form-add-member");
  addMemberForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await withAsyncLock(addMemberForm, async () => {
      const fd = new FormData(addMemberForm);
      try {
        await api("/api/admin/members", {
          method: "POST",
          body: {
            name: fd.get("name"),
            email: fd.get("email"),
            department: fd.get("department") || "",
            slack_user_id: fd.get("slack_user_id") || "",
          },
        });
        showToast("팀원이 등록되었습니다.");
        await renderAdminMembers(root);
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  const csvForm = document.getElementById("form-csv-member");
  csvForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await withAsyncLock(csvForm, async () => {
      const fd = new FormData(csvForm);
      try {
        const res = await api("/api/admin/members/import-csv", {
          method: "POST",
          body: fd,
        });
        showToast(
          `CSV 처리 완료 (신규 ${res.created_count}명, 업데이트 ${res.updated_count}명)`,
        );
        await renderAdminMembers(root);
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  root.querySelectorAll("[data-del-member]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const memberName = btn.dataset.memberName || "선택한 팀원";
      const ok = await showConfirmModal({
        title: "팀원 삭제",
        message: `'${memberName}' 팀원을 삭제하시겠습니까?\n미제출 배정 정보가 있는 경우 함께 정리됩니다.`,
        confirmLabel: "삭제",
        danger: true,
      });
      if (!ok) return;

      await withAsyncLock(btn, async () => {
        try {
          await api(`/api/admin/members/${btn.dataset.delMember}`, {
            method: "DELETE",
          });
          showToast("팀원이 삭제되었습니다.");
          await renderAdminMembers(root);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });
  });
}

async function renderAdminDashboard(root) {
  const { items: cycles } = await api("/api/admin/cycles");
  if (!state.activeCycleId && cycles.length > 0) {
    state.activeCycleId = cycles[0].id;
  }

  root.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <h3>피어리뷰 회차 목록</h3>
        ${
          cycles.length
            ? `<table>
                <thead><tr><th>회차명</th><th>상태</th><th>진행률</th><th>선택</th></tr></thead>
                <tbody>
                  ${cycles
                    .map(
                      (c) => `
                    <tr>
                      <td><strong>${esc(c.title)}</strong></td>
                      <td><span class="badge">${esc(c.status)}</span></td>
                      <td>${c.submitted_assignments_count}/${c.total_assignments_count} (${c.completion_rate}%)</td>
                      <td><button class="btn btn-sm ${state.activeCycleId === c.id ? "" : "btn-outline"}" data-select-cycle="${c.id}">관리</button></td>
                    </tr>`,
                    )
                    .join("")}
                </tbody>
              </table>`
            : '<p class="muted">생성된 회차가 없습니다.</p>'
        }
      </div>
      <div class="card">
        <h3>신규 회차 생성</h3>
        <form id="form-create-cycle">
          <div class="form-group"><label>회차 제목</label><input type="text" name="title" required /></div>
          <div class="form-group"><label>시작 일시</label><input type="datetime-local" name="start_at" required /></div>
          <div class="form-group"><label>마감 일시</label><input type="datetime-local" name="end_at" required /></div>
          <button type="submit" class="btn">회차 생성</button>
        </form>
      </div>
    </div>
    <div id="cycle-workspace"></div>
  `;

  root.querySelectorAll("[data-select-cycle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeCycleId = Number(btn.dataset.selectCycle);
      renderAdminDashboard(root);
    });
  });

  const createCycleForm = document.getElementById("form-create-cycle");
  createCycleForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await withAsyncLock(createCycleForm, async () => {
      const fd = new FormData(createCycleForm);
      try {
        const created = await api("/api/admin/cycles", {
          method: "POST",
          body: {
            title: fd.get("title"),
            start_at: new Date(fd.get("start_at")).toISOString(),
            end_at: new Date(fd.get("end_at")).toISOString(),
          },
        });
        state.activeCycleId = created.id;
        showToast("신규 회차가 생성되었습니다.");
        await renderAdminDashboard(root);
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  if (state.activeCycleId) {
    await renderCycleWorkspace(
      document.getElementById("cycle-workspace"),
      state.activeCycleId,
    );
  }
}

async function renderCycleWorkspace(container, cycleId) {
  clearReportPollTimer();
  const tabs = [
    ["status", "진행 현황"],
    ["questions", "설문 문항"],
    ["assignments", "리뷰 매칭"],
    ["reports", "리포트·승인"],
    ["deliveries", "Slack 발송이력"],
  ];

  container.innerHTML = `
    <div class="tabs">
      ${tabs
        .map(
          ([key, label]) =>
            `<button class="tab-btn ${state.activeTab === key ? "active" : ""}" data-tab="${key}">${label}</button>`,
        )
        .join("")}
    </div>
    <div id="tab-content"></div>
  `;

  container.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      renderCycleWorkspace(container, cycleId);
    });
  });

  const tabContent = document.getElementById("tab-content");
  if (state.activeTab === "status") {
    const { cycle, reviewer_progress } = await api(
      `/api/admin/cycles/${cycleId}`,
    );
    tabContent.innerHTML = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
          <div>
            <span class="badge">${esc(cycle.status)}</span>
            <h3 style="margin:6px 0;">${esc(cycle.title)}</h3>
            <p class="muted">전체 제출률: ${cycle.submitted_assignments_count} / ${cycle.total_assignments_count} (${cycle.completion_rate}%)</p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${cycle.status === "DRAFT" ? `<button id="btn-start-cycle" class="btn">회차 시작 및 PIN 발송</button>` : ""}
            ${cycle.status === "ACTIVE" ? `<button id="btn-remind-cycle" class="btn btn-outline">미제출 리마인더 발송</button><button id="btn-close-cycle" class="btn btn-danger">회차 마감 및 리포트 생성</button>` : ""}
          </div>
        </div>
      </div>
      <div class="card">
        <h3>리뷰어별 제출 현황</h3>
        <table>
          <thead><tr><th>리뷰어</th><th>진행 현황</th><th>미제출 대상자</th></tr></thead>
          <tbody>
            ${reviewer_progress
              .map(
                (p) => `
              <tr>
                <td><strong>${esc(p.reviewer.name)}</strong></td>
                <td>${p.submitted_count} / ${p.total_count} 완료</td>
                <td>${p.unsubmitted_reviewees.map((m) => esc(m.name)).join(", ") || "-"}</td>
              </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;

    const startBtn = document.getElementById("btn-start-cycle");
    startBtn?.addEventListener("click", async () => {
      const ok = await showConfirmModal({
        title: "회차 시작 및 PIN 발송",
        message: `'${cycle.title}' 회차를 시작하고 모든 리뷰어에게 로그인 PIN을 발송하시겠습니까?\n회차가 시작되면 설문 문항을 추가·삭제할 수 없습니다.`,
        confirmLabel: "회차 시작",
      });
      if (!ok) return;

      await withAsyncLock(startBtn, async () => {
        try {
          await api(`/api/admin/cycles/${cycleId}/start`, { method: "POST" });
          showToast("회차가 시작되고 PIN 발송 작업이 등록되었습니다.");
          await renderCycleWorkspace(container, cycleId);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });

    const remindBtn = document.getElementById("btn-remind-cycle");
    remindBtn?.addEventListener("click", async () => {
      const ok = await showConfirmModal({
        title: "미제출 리마인더 발송",
        message:
          "아직 피어리뷰를 모두 제출하지 않은 리뷰어들에게 리마인더 DM을 발송하시겠습니까?",
        confirmLabel: "리마인더 발송",
      });
      if (!ok) return;

      await withAsyncLock(remindBtn, async () => {
        try {
          const res = await api(`/api/admin/cycles/${cycleId}/reminders`, {
            method: "POST",
          });
          showToast(`${res.queued_count}건의 리마인더가 큐에 등록되었습니다.`);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });

    const closeBtn = document.getElementById("btn-close-cycle");
    closeBtn?.addEventListener("click", async () => {
      if (cycle.submitted_assignments_count < 1) {
        showToast(
          "제출된 피어리뷰 답변이 최소 1개 이상 포함되어야 회차를 마감할 수 있습니다.",
          true,
        );
        return;
      }
      const ok = await showConfirmModal({
        title: "회차 마감 및 리포트 생성",
        message: `'${cycle.title}' 회차를 마감하고 피평가자별 HTML·PDF 리포트 생성을 시작하시겠습니까?\n마감 후에는 리뷰어가 추가 제출할 수 없습니다.`,
        confirmLabel: "회차 마감",
        danger: true,
      });
      if (!ok) return;

      await withAsyncLock(closeBtn, async () => {
        try {
          await api(`/api/admin/cycles/${cycleId}/close`, {
            method: "POST",
            body: { require_all_submitted: false },
          });
          showToast("회차가 마감되고 리포트 생성 작업이 등록되었습니다.");
          await renderCycleWorkspace(container, cycleId);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });
  } else if (state.activeTab === "questions") {
    const { items: questions } = await api(
      `/api/admin/cycles/${cycleId}/questions`,
    );
    tabContent.innerHTML = `
      <div class="card">
        <h3>문항 추가 (DRAFT 전용)</h3>
        <form id="form-add-question">
          <div class="grid-2">
            <div class="form-group"><label>순서</label><input type="number" name="display_order" value="${questions.length + 1}" min="1" required /></div>
            <div class="form-group">
              <label>문항 유형</label>
              <select name="question_type">
                <option value="RATING">5점 척도 (RATING)</option>
                <option value="TEXT">서술형 (TEXT)</option>
                <option value="SINGLE_CHOICE">단일 선택 (SINGLE_CHOICE)</option>
                <option value="MULTIPLE_CHOICE">다중 선택 (MULTIPLE_CHOICE)</option>
              </select>
            </div>
          </div>
          <div class="form-group"><label>카테고리</label><input type="text" name="category" value="기본 역량" required /></div>
          <div class="form-group"><label>질문 내용</label><textarea name="content" required></textarea></div>
          <div class="form-group"><label>참고 이미지 (선택, PNG/JPG/WebP, 최대 10MB)</label><input type="file" name="image" accept="image/png,image/jpeg,image/webp" /></div>
          <button type="submit" class="btn">문항 등록</button>
        </form>
      </div>
      ${questions
        .map(
          (q) => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
            <div>
              <span class="badge">${esc(q.question_type)}</span>
              <strong>Q${q.display_order}. [${esc(q.category)}] ${esc(q.content)}</strong>
            </div>
            <button class="btn btn-danger btn-sm" data-del-q="${q.id}" data-q-order="${q.display_order}">문항 삭제</button>
          </div>
          ${q.image_url ? `<div style="margin-top:8px;"><img src="${esc(q.image_url)}" style="max-height:120px;border-radius:6px;" alt="img"/></div>` : ""}
          ${
            q.question_type.includes("CHOICE")
              ? `<div style="margin-top:12px;">
                  <ul>
                    ${q.options
                      .map(
                        (o) =>
                          `<li style="margin-bottom:6px;">${esc(o.option_text)} <button class="btn btn-outline btn-sm" data-del-opt="${o.id}" data-opt-text="${esc(o.option_text)}">삭제</button></li>`,
                      )
                      .join("")}
                  </ul>
                  <form class="form-add-opt" data-qid="${q.id}" style="display:flex;gap:8px;">
                    <input type="text" name="option_text" placeholder="선택지 입력" required />
                    <button type="submit" class="btn btn-sm">선택지 추가</button>
                  </form>
                </div>`
              : ""
          }
        </div>`,
        )
        .join("")}
    `;

    const addQuestionForm = document.getElementById("form-add-question");
    addQuestionForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await withAsyncLock(addQuestionForm, async () => {
        const fd = new FormData(addQuestionForm);
        const imageFile = fd.get("image");
        if (
          imageFile instanceof File &&
          imageFile.size > MAX_QUESTION_IMAGE_BYTES
        ) {
          showToast(
            "문항 참고 이미지는 최대 10MB까지 업로드할 수 있습니다.",
            true,
          );
          return;
        }
        try {
          await api(`/api/admin/cycles/${cycleId}/questions`, {
            method: "POST",
            body: fd,
          });
          showToast("문항이 추가되었습니다.");
          await renderCycleWorkspace(container, cycleId);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });

    tabContent.querySelectorAll("[data-del-q]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const ok = await showConfirmModal({
          title: "설문 문항 삭제",
          message: `Q${btn.dataset.qOrder || ""} 설문 문항을 삭제하시겠습니까?\n포함된 선택지 및 첨부 이미지도 함께 삭제됩니다.`,
          confirmLabel: "문항 삭제",
          danger: true,
        });
        if (!ok) return;

        await withAsyncLock(btn, async () => {
          try {
            await api(`/api/admin/questions/${btn.dataset.delQ}`, {
              method: "DELETE",
            });
            showToast("설문 문항이 삭제되었습니다.");
            await renderCycleWorkspace(container, cycleId);
          } catch (err) {
            showToast(err.message, true);
          }
        });
      });
    });

    tabContent.querySelectorAll(".form-add-opt").forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        await withAsyncLock(form, async () => {
          const fd = new FormData(form);
          const optionText = String(fd.get("option_text") || "").trim();
          if (!optionText) return;
          try {
            await api(`/api/admin/questions/${form.dataset.qid}/options`, {
              method: "POST",
              body: { option_text: optionText },
            });
            form.reset();
            await renderCycleWorkspace(container, cycleId);
          } catch (err) {
            showToast(err.message, true);
          }
        });
      });
    });

    tabContent.querySelectorAll("[data-del-opt]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const ok = await showConfirmModal({
          title: "선택지 삭제",
          message: `'${btn.dataset.optText || "선택지"}' 항목을 삭제하시겠습니까?`,
          confirmLabel: "삭제",
          danger: true,
        });
        if (!ok) return;

        await withAsyncLock(btn, async () => {
          try {
            await api(`/api/admin/options/${btn.dataset.delOpt}`, {
              method: "DELETE",
            });
            await renderCycleWorkspace(container, cycleId);
          } catch (err) {
            showToast(err.message, true);
          }
        });
      });
    });
  } else if (state.activeTab === "assignments") {
    const [{ items: assignments }, { items: members }] = await Promise.all([
      api(`/api/admin/cycles/${cycleId}/assignments`),
      api("/api/admin/members"),
    ]);
    const memberOpts = members
      .map(
        (m) =>
          `<option value="${m.id}">${esc(m.name)} (${esc(m.department)})</option>`,
      )
      .join("");
    tabContent.innerHTML = `
      <div class="grid-2">
        <div class="card">
          <h3>개별 매칭 추가</h3>
          <form id="form-add-assignment">
            <div class="form-group"><label>리뷰어</label><select name="reviewer_id">${memberOpts}</select></div>
            <div class="form-group"><label>피평가자</label><select name="reviewee_id">${memberOpts}</select></div>
            <button type="submit" class="btn">매칭 추가</button>
          </form>
        </div>
        <div class="card">
          <h3>자동 매칭</h3>
          <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;">
            <button class="btn btn-outline" data-automatch="ALL">전체 교차 매칭</button>
            <button class="btn btn-outline" data-automatch="SAME_DEPARTMENT">동일 부서 매칭</button>
          </div>
        </div>
      </div>
      <div class="card">
        <h3>등록된 매칭 (${assignments.length}건)</h3>
        <table>
          <thead><tr><th>리뷰어</th><th>피평가자</th><th>제출 여부</th><th>관리</th></tr></thead>
          <tbody>
            ${assignments
              .map(
                (a) => `
              <tr>
                <td>${esc(a.reviewer.name)}</td>
                <td>${esc(a.reviewee.name)}</td>
                <td>${a.is_submitted ? "제출 완료" : "미제출"}</td>
                <td>${!a.is_submitted ? `<button class="btn btn-danger btn-sm" data-del-assign="${a.id}" data-assign-label="${esc(a.reviewer.name)} → ${esc(a.reviewee.name)}">삭제</button>` : "-"}</td>
              </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;

    const addAssignForm = document.getElementById("form-add-assignment");
    addAssignForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await withAsyncLock(addAssignForm, async () => {
        const fd = new FormData(addAssignForm);
        try {
          await api(`/api/admin/cycles/${cycleId}/assignments`, {
            method: "POST",
            body: {
              reviewer_id: Number(fd.get("reviewer_id")),
              reviewee_id: Number(fd.get("reviewee_id")),
            },
          });
          await renderCycleWorkspace(container, cycleId);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });

    tabContent.querySelectorAll("[data-automatch]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const modeLabel =
          btn.dataset.automatch === "SAME_DEPARTMENT"
            ? "동일 부서 매칭"
            : "전체 교차 매칭";
        const ok = await showConfirmModal({
          title: "자동 매칭 실행",
          message: `'${modeLabel}' 방식으로 리뷰 매칭을 일괄 생성하시겠습니까?`,
          confirmLabel: "실행",
        });
        if (!ok) return;

        await withAsyncLock(btn, async () => {
          try {
            const res = await api(
              `/api/admin/cycles/${cycleId}/assignments/auto-match`,
              {
                method: "POST",
                body: { match_type: btn.dataset.automatch },
              },
            );
            showToast(`${res.created_count}건의 매칭이 추가되었습니다.`);
            await renderCycleWorkspace(container, cycleId);
          } catch (err) {
            showToast(err.message, true);
          }
        });
      });
    });

    tabContent.querySelectorAll("[data-del-assign]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const ok = await showConfirmModal({
          title: "리뷰 매칭 삭제",
          message: `'${btn.dataset.assignLabel || "선택한 매칭"}' 배정을 삭제하시겠습니까?`,
          confirmLabel: "매칭 삭제",
          danger: true,
        });
        if (!ok) return;

        await withAsyncLock(btn, async () => {
          try {
            await api(`/api/admin/assignments/${btn.dataset.delAssign}`, {
              method: "DELETE",
            });
            showToast("리뷰 매칭이 삭제되었습니다.");
            await renderCycleWorkspace(container, cycleId);
          } catch (err) {
            showToast(err.message, true);
          }
        });
      });
    });
  } else if (state.activeTab === "reports") {
    const { items: reports } = await api(
      `/api/admin/cycles/${cycleId}/reports`,
    );
    const hasPendingOrFailed = reports.some(
      (r) =>
        r.generation_status === "PENDING" || r.generation_status === "FAILED",
    );

    tabContent.innerHTML = `
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
        <div>
          <h3 style="margin:0;">피평가자 리포트 목록 (${reports.length}건)</h3>
          <p class="muted" style="margin:4px 0 0;">
            전체 HTML·PDF 생성이 READY 상태이면 승인 및 Slack 일괄 발송을 실행할 수 있습니다.
            ${hasPendingOrFailed ? "<br/>⏳ 생성 대기 중이거나 실패(FAILED)한 리포트는 15초 주기로 자동 재시도 및 갱신됩니다." : ""}
          </p>
        </div>
        <button id="btn-publish-reports" class="btn">전체 검토 승인 및 Slack 발송</button>
      </div>
      <div class="card">
        <table>
          <thead><tr><th>피평가자</th><th>부서</th><th>생성 상태</th><th>승인/발송 상태</th><th>미리보기</th></tr></thead>
          <tbody>
            ${reports
              .map(
                (r) => `
              <tr>
                <td><strong>${esc(r.reviewee.name)}</strong></td>
                <td>${esc(r.reviewee.department || "-")}</td>
                <td>
                  <span class="badge ${r.generation_status === "READY" ? "badge-success" : r.generation_status === "FAILED" ? "badge-danger" : ""}">
                    ${esc(r.generation_status)}
                  </span>
                  ${r.generation_status === "FAILED" ? `<div class="muted" style="font-size:12px;margin-top:4px;">15초 주기 자동 재시도 중</div>` : ""}
                </td>
                <td><span class="badge ${r.approval_status === "SENT" ? "badge-success" : ""}">${esc(r.approval_status)}</span></td>
                <td>
                  ${r.html_url ? `<a href="${esc(r.html_url)}" target="_blank" rel="noopener" class="btn btn-outline btn-sm">HTML</a>` : ""}
                  ${r.pdf_url ? `<a href="${esc(r.pdf_url)}" target="_blank" rel="noopener" class="btn btn-outline btn-sm">PDF</a>` : ""}
                  ${!r.html_url && !r.pdf_url ? '<span class="muted">-</span>' : ""}
                </td>
              </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;

    if (hasPendingOrFailed) {
      state.reportPollTimer = setTimeout(() => {
        if (
          state.activeTab === "reports" &&
          document.body.contains(container)
        ) {
          renderCycleWorkspace(container, cycleId);
        }
      }, 15_000);
    }

    const publishBtn = document.getElementById("btn-publish-reports");
    publishBtn?.addEventListener("click", async () => {
      const ok = await showConfirmModal({
        title: "리포트 일괄 승인 및 발송",
        message:
          "모든 피평가자의 HTML·PDF 리포트를 최종 승인하고 Slack DM으로 일괄 발송하시겠습니까?\n전원 발송 완료 시 회차가 최종 종료(CLOSED)됩니다.",
        confirmLabel: "승인 및 발송",
      });
      if (!ok) return;

      await withAsyncLock(publishBtn, async () => {
        try {
          const res = await api(
            `/api/admin/cycles/${cycleId}/reports/publish`,
            { method: "POST" },
          );
          showToast(
            `${res.queued_count}건의 리포트 발송 작업이 큐에 등록되었습니다.`,
          );
          await renderCycleWorkspace(container, cycleId);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });
  } else if (state.activeTab === "deliveries") {
    const { items: deliveries } = await api(
      `/api/admin/cycles/${cycleId}/deliveries`,
    );
    tabContent.innerHTML = `
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
        <h3 style="margin:0;">Slack DM 발송 이력 (${deliveries.length}건)</h3>
        <button id="btn-retry-failed" class="btn btn-outline">실패(FAILED) 건 일괄 재시도</button>
      </div>
      <div class="card">
        <table>
          <thead><tr><th>수신자</th><th>유형</th><th>상태</th><th>시도 횟수</th><th>오류 메시지</th><th>발송 시각</th></tr></thead>
          <tbody>
            ${deliveries
              .map(
                (d) => `
              <tr>
                <td><strong>${esc(d.member.name)}</strong></td>
                <td>${esc(d.delivery_type)}</td>
                <td><span class="badge ${d.status === "SENT" ? "badge-success" : d.status === "FAILED" ? "badge-danger" : ""}">${esc(d.status)}</span></td>
                <td>${d.attempts}</td>
                <td>${esc(d.error_message || "-")}</td>
                <td>${esc(d.sent_at || "-")}</td>
              </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;

    const retryBtn = document.getElementById("btn-retry-failed");
    retryBtn?.addEventListener("click", async () => {
      const ok = await showConfirmModal({
        title: "실패 건 일괄 재시도",
        message: "발송 실패(FAILED) 상태인 Slack DM을 일괄 재시도하시겠습니까?",
        confirmLabel: "재시도",
      });
      if (!ok) return;

      await withAsyncLock(retryBtn, async () => {
        try {
          const res = await api(
            `/api/admin/cycles/${cycleId}/deliveries/retry-failed`,
            { method: "POST" },
          );
          showToast(
            `${res.queued_count}건의 실패 작업을 재시도 큐에 등록했습니다.`,
          );
          await renderCycleWorkspace(container, cycleId);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });
  }
}

async function router() {
  clearReportPollTimer();
  const root = document.getElementById("app-root");
  if (!root) return;
  const path = window.location.pathname.replace(/\/+$/, "") || "/";

  const { needs_setup } = await api("/api/auth/setup-status");
  if (needs_setup && path !== "/setup") {
    return navigate("/setup");
  }

  if (!state.session) {
    try {
      state.session = await api("/api/auth/me");
    } catch {
      state.session = null;
    }
  }
  renderNav();

  if (path === "/setup") return renderSetup(root);
  if (path === "/login") return renderReviewerLogin(root);
  if (path === "/admin/login") return renderAdminLogin(root);

  if (path.startsWith("/admin")) {
    if (!state.session || state.session.role !== "ADMIN") {
      return navigate("/admin/login");
    }
    if (path === "/admin/members") return renderAdminMembers(root);
    return renderAdminDashboard(root);
  }

  if (!state.session || state.session.role !== "REVIEWER") {
    return navigate("/login");
  }
  const reviewMatch = /^\/review\/(\d+)$/.exec(path);
  if (reviewMatch) {
    return renderReviewerForm(root, Number(reviewMatch[1]));
  }
  return renderReviewerDashboard(root);
}

function navigate(path) {
  window.history.pushState({}, "", path);
  router();
}

window.addEventListener("popstate", router);
document.addEventListener("click", (e) => {
  const link = e.target.closest("[data-link]");
  if (link) {
    e.preventDefault();
    navigate(link.getAttribute("href"));
  }
});

router();
