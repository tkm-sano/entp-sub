// ------------------------------
// main.js 初期化完全版（JSONP対応）
// ------------------------------

document.addEventListener("DOMContentLoaded", () => {
  if (!window.MENU_TALENT_API_URL) {
    console.error("env.js が読み込まれていないか、API URL が未設定です。");
    alert("API設定が未完了です。`assets/js/env.js` を確認してください。");
    return;
  }

  const pageId = document.body?.dataset?.page || "default";
  const routes = window.MENU_TALENT_ROUTES || {
    login: "/",
    jobs: "/jobs/"
  };

  const apiUrl = String(window.MENU_TALENT_API_URL || "").trim();
  const apiTimeoutMs = Number(window.MENU_TALENT_API_TIMEOUT_MS || 15000);
  const isConfigured = apiUrl && !apiUrl.startsWith("YOUR_");
  const sessionKey = "menuTalentSessionV1";

  const loginEls = {
    form: document.getElementById("sheet-login-form"),
    message: document.getElementById("login-message")
  };

  const jobEls = {
    accountSummary: document.getElementById("account-summary"),
    logoutButton: document.getElementById("logout-button"),
    jobsList: document.getElementById("jobs-list"),
    jobsCount: document.getElementById("jobs-count"),
    message: document.getElementById("jobs-message"),
    searchInput: document.getElementById("search-input"),
    categoryFilter: document.getElementById("category-filter"),
    statusFilter: document.getElementById("status-filter")
  };

  const state = {
    session: null,
    jobs: [],
    appliedJobIds: new Set()
  };

  if (!isConfigured) {
    const text = "API設定が未完了です。`assets/js/env.js` の URL を設定してください。";
    setLoginMessage(text, true);
    setJobsMessage(text, true);
    disableForm(loginEls.form);
    return;
  }

  // ------------------------------
  // ページ初期化
  // ------------------------------
  initPage();

  function initPage() {
    if (pageId === "login") {
      loginEls.form?.addEventListener("submit", onLoginSubmit);
      const session = loadSession();
      if (session) {
        goTo(routes.jobs);
        return;
      }
      enableForm(loginEls.form);
      return;
    }

    if (pageId === "jobs") {
      state.session = loadSession();
      if (!state.session) {
        goTo(routes.login);
        return;
      }
      updateAccountSummary();
      bindJobsEvents();
      refreshJobs();
    }
  }

  function bindJobsEvents() {
    jobEls.logoutButton?.addEventListener("click", onLogout);
    jobEls.searchInput?.addEventListener("input", renderJobs);
    jobEls.categoryFilter?.addEventListener("change", renderJobs);
    jobEls.statusFilter?.addEventListener("change", renderJobs);
    jobEls.jobsList?.addEventListener("click", onJobsListClick);
  }

  // ------------------------------
  // goTo
  // ------------------------------
  function goTo(path) {
    if (!path) return;
    const url = new URL(path, window.location.origin);
    let nextPath = url.pathname.replace(/\/+$/, "");
    let currentPath = window.location.pathname.replace(/\/+$/, "");
    if (currentPath.endsWith("/index.html")) currentPath = currentPath.replace(/\/index\.html$/, "");
    if (nextPath.endsWith("/index.html")) nextPath = nextPath.replace(/\/index\.html$/, "");
    if (currentPath === nextPath) { window.location.reload(); return; }
    window.location.href = url.pathname;
  }

  // ------------------------------
  // JSONP リクエスト
  // ------------------------------
  function jsonpRequest(params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const cbName = "menuTalentCb_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      const script = document.createElement("script");

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timeout"));
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      window[cbName] = function (data) {
        cleanup();
        resolve(data);
      };

      const qs = new URLSearchParams({ ...params, callback: cbName });
      script.src = apiUrl + "?" + qs.toString();
      script.onerror = () => { cleanup(); reject(new Error("script load error")); };
      document.head.appendChild(script);
    });
  }

  // ------------------------------
  // ログイン送信処理
  // ------------------------------
  async function onLoginSubmit(e) {
    e.preventDefault();
    setLoginMessage("", false);
    disableForm(loginEls.form);

    const name     = loginEls.form.querySelector('[name="name"]')?.value.trim() || "";
    const password = loginEls.form.querySelector('[name="password"]')?.value.trim() || "";

    if (!name || !password) {
      setLoginMessage("名前とパスワードを入力してください。", true);
      enableForm(loginEls.form);
      return;
    }

    try {
      const data = await jsonpRequest({ action: "login", name, password }, apiTimeoutMs);

      if (!data.ok) {
        setLoginMessage(readableApiError(data), true);
        enableForm(loginEls.form);
        return;
      }

      saveSession({
        token: data.session.token,
        name: data.session.name,
        role: data.session.role
      });
      goTo(routes.jobs);

    } catch (err) {
      console.error(err);
      setLoginMessage("通信エラーが発生しました。時間をおいて再度お試しください。", true);
      enableForm(loginEls.form);
    }
  }

  // ------------------------------
  // ログアウト処理
  // ------------------------------
  function onLogout() {
    clearSession();
    goTo(routes.login);
  }

  // ------------------------------
  // 求人一覧取得
  // ------------------------------
  async function refreshJobs() {
    setJobsMessage("読み込み中...", false);

    try {
      const data = await jsonpRequest(
        { action: "listJobs", token: state.session.token },
        apiTimeoutMs
      );

      if (!data.ok) {
        if (isAuthErrorCode(data.errorCode || data.code)) {
          clearSession();
          goTo(routes.login);
          return;
        }
        setJobsMessage(readableApiError(data), true);
        return;
      }

      state.jobs = data.jobs || [];
      state.appliedJobIds = new Set();
      setJobsMessage("", false);
      renderJobs();

    } catch (err) {
      console.error(err);
      setJobsMessage("通信エラーが発生しました。時間をおいて再度お試しください。", true);
    }
  }
  
// ------------------------------
  // 求人一覧レンダリング
  // ------------------------------
  function renderJobs() {
    if (!jobEls.jobsList) return;

    const keyword  = (jobEls.searchInput?.value || "").trim().toLowerCase();
    const category = jobEls.categoryFilter?.value || "";
    const status   = jobEls.statusFilter?.value || "";

    const filtered = state.jobs.filter(job => {
      if (keyword && !JSON.stringify(job).toLowerCase().includes(keyword)) return false;
      if (category && job.category !== category) return false;
      if (status === "applied" && !state.appliedJobIds.has(job.id)) return false;
      if (status === "not_applied" && state.appliedJobIds.has(job.id)) return false;
      return true;
    });

    if (jobEls.jobsCount) {
      jobEls.jobsCount.textContent = `${filtered.length} 件`;
    }

    if (filtered.length === 0) {
      jobEls.jobsList.innerHTML = "<p>該当する案件がありません。</p>";
      return;
    }

    jobEls.jobsList.innerHTML = filtered.map(job => {
      const applied  = state.appliedJobIds.has(job.id);
      const isFull   = Number(job.applicant_count || 0) >= Number(job.max_applicants || 0);
      const deadline = job.deadline ? formatDate(job.deadline) : "未定";
      const tags     = job.tags ? escapeHtml(String(job.tags)) : "";
      const count    = escapeHtml(String(job.applicant_count || 0));
      const max      = escapeHtml(String(job.max_applicants || 0));
      

      let buttonLabel = "応募する";
      if (applied) buttonLabel = "応募済み";
      else if (isFull) buttonLabel = "満員";

      return `
        <div class="job-card">
          <div class="job-card__header">
            <h3 class="job-card__title">${escapeHtml(String(job.title || ""))}</h3>
            ${tags ? `<span class="job-card__tags">${tags}</span>` : ""}
          </div>
          <div class="job-card__body">
            <p class="job-card__deadline">締切：${deadline}</p>
            <p class="job-card__count">応募数：${count} / ${max}</p>
          </div>
          <div class="job-card__footer">
            <button
              class="apply-button"
              data-job-id="${escapeHtml(job.id)}"
              ${applied || isFull ? "disabled" : ""}
            >${buttonLabel}</button>
          </div>
        </div>
      `;
    }).join("");
  }  

  // ------------------------------
  // 応募処理
  // ------------------------------
  
  async function onJobsListClick(e) {
    const button = e.target.closest(".apply-button");
    if (!button) return;

    const jobId = button.dataset.jobId;
    if (!jobId) return;

    // メールアドレスを入力させる
    const contactEmail = window.prompt("確認メールの送信先メールアドレスを入力してください");

    // キャンセルまたは未入力
    if (contactEmail === null) return;
    if (!contactEmail.trim()) {
      alert("メールアドレスを入力してください。");
      return;
    }

    // 簡易バリデーション
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim())) {
      alert("正しいメールアドレスを入力してください。");
      return;
    }

    button.disabled = true;

    try {
      const data = await jsonpRequest(
        { action: "apply", token: state.session.token, jobId, contactEmail: contactEmail.trim() },
        apiTimeoutMs
      );

      if (!data.ok) {
        if (isAuthErrorCode(data.errorCode || data.code)) {
          clearSession();
          goTo(routes.login);
          return;
        }
        alert(readableApiError(data));
        button.disabled = false;
        return;
      }

      state.appliedJobIds.add(jobId);
      renderJobs();
      alert("応募が完了しました。確認メールをご確認ください。");

    } catch (err) {
      console.error(err);
      alert("通信エラーが発生しました。時間をおいて再度お試しください。");
      button.disabled = false;
    }
  }

  // ------------------------------
  // アカウント情報表示
  // ------------------------------
  function updateAccountSummary() {
    if (!jobEls.accountSummary || !state.session) return;
    const { name, role } = state.session;
    jobEls.accountSummary.textContent = `${escapeHtml(name || "")}（${roleLabel(role)}）`;
  }

  // ------------------------------
  // セッション管理
  // ------------------------------
  function saveSession(session) {
    sessionStorage.setItem(sessionKey, JSON.stringify(session));
  }

  function loadSession() {
    try {
      return JSON.parse(sessionStorage.getItem(sessionKey)) || null;
    } catch {
      return null;
    }
  }

  function clearSession() {
    sessionStorage.removeItem(sessionKey);
  }

  // ------------------------------
  // UI ユーティリティ
  // ------------------------------
  function setLoginMessage(text, isError) {
    if (!loginEls.message) return;
    loginEls.message.textContent = text;
    loginEls.message.style.color = isError ? "red" : "green";
  }

  function setJobsMessage(text, isError) {
    if (!jobEls.message) return;
    jobEls.message.textContent = text;
    jobEls.message.style.color = isError ? "red" : "green";
  }

  function disableForm(form) {
    form?.querySelectorAll("input, button, select, textarea").forEach(el => el.disabled = true);
  }

  function enableForm(form) {
    form?.querySelectorAll("input, button, select, textarea").forEach(el => el.disabled = false);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  
  
  function formatDate(value) {
  if (!value) return "未定";
  const d = new Date(value);
  if (isNaN(d.getTime())) return escapeHtml(String(value));
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

  // ------------------------------
  // エラーコード判定
  // ------------------------------
  function isAuthErrorCode(code) {
    const value = String(code || "");
    return value === "invalid_token" || value === "token_expired" || value === "unauthorized";
  }

  function readableApiError(response) {
    const code = String(response?.errorCode || response?.code || "");
    if (code === "invalid_credentials") return "名前またはパスワードが正しくありません。";
    if (code === "invalid_token" || code === "token_expired") return "セッションが無効です。再ログインしてください。";
    if (code === "already_applied") return "この案件には既に応募済みです。";
    if (code === "quota_full") return "応募人数が上限に達しています。";
    if (code === "deadline_passed") return "応募締切を過ぎたため応募できません。";
    if (code === "forbidden") return "この操作を実行する権限がありません。";
    if (code === "invalid_email") return "確認メール送信先のメールアドレスが不正です。";
    return String(response?.message || "処理に失敗しました。");
  }

  function roleLabel(role) {
    if (role === "client") return "クライアント";
    if (role === "admin") return "管理者";
    return "タレント";
  }

});