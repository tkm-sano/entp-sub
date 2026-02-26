document.addEventListener("DOMContentLoaded", () => {
  if (!window.MENU_TALENT_API_URL) {
    console.error("env.js が読み込まれていないか、API URL が未設定です。");
    alert("API設定が未完了です。`assets/js/env.js` を確認してください。");
    return;
  }

  const pageId = document.body?.dataset?.page || "default";
  const routes = window.MENU_TALENT_ROUTES || { login: "/", jobs: "/jobs/" };
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
    wageSliderMin: document.getElementById("wage-slider-min"),
    wageSliderMax: document.getElementById("wage-slider-max"),
    wageDisplayMin: document.getElementById("wage-display-min"),
    wageDisplayMax: document.getElementById("wage-display-max")
  };

  const state = { session: null, jobs: [], appliedJobIds: new Set() };

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
      if (session) { goTo(routes.jobs); return; }
      enableForm(loginEls.form);
      return;
    }

    if (pageId === "jobs") {
      state.session = loadSession();
      if (!state.session) { goTo(routes.login); return; }
      updateAccountSummary();
      bindJobsEvents();
      updateWageRangeTrack();
      refreshJobs();
    }
  }

  function bindJobsEvents() {
    jobEls.logoutButton?.addEventListener("click", onLogout);
    jobEls.searchInput?.addEventListener("input", renderJobs);
    jobEls.categoryFilter?.addEventListener("change", renderJobs);
    
    // 時給フィルターのイベント
    jobEls.wageSliderMin?.addEventListener("input", onWageSliderChange);
    jobEls.wageSliderMax?.addEventListener("input", onWageSliderChange);
  }

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

  function onWageSliderChange() {
    let min = parseInt(jobEls.wageSliderMin?.value) || 1200;
    let max = parseInt(jobEls.wageSliderMax?.value) || 5000;
    
    // 下限が上限を超えないようにする
    if (min > max) {
      const temp = min;
      min = max;
      max = temp;
      if (jobEls.wageSliderMin) jobEls.wageSliderMin.value = min;
      if (jobEls.wageSliderMax) jobEls.wageSliderMax.value = max;
    }
    
    updateWageDisplay();
    updateWageRangeTrack();
    renderJobs();
  }

  function updateWageDisplay() {
    const min = parseInt(jobEls.wageSliderMin?.value) || 1200;
    const max = parseInt(jobEls.wageSliderMax?.value) || 5000;
    
    if (jobEls.wageDisplayMin) jobEls.wageDisplayMin.textContent = min.toLocaleString();
    if (jobEls.wageDisplayMax) jobEls.wageDisplayMax.textContent = max.toLocaleString();
  }

  function updateWageRangeTrack() {
    const min = parseInt(jobEls.wageSliderMin?.value) || 1200;
    const max = parseInt(jobEls.wageSliderMax?.value) || 5000;
    const sliderMin = parseInt(jobEls.wageSliderMin?.min) || 0;
    const sliderMax = parseInt(jobEls.wageSliderMin?.max) || 10000;
    
    const percentMin = ((min - sliderMin) / (sliderMax - sliderMin)) * 100;
    const percentMax = ((max - sliderMin) / (sliderMax - sliderMin)) * 100;
    
    const track = document.querySelector('.wage-range-track');
    if (track) {
      track.style.left = percentMin + '%';
      track.style.width = (percentMax - percentMin) + '%';
    }
  }

  function jsonpRequest(params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const cbName = "menuTalentCb_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      const script = document.createElement("script");

      const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, timeoutMs);
      function cleanup() { clearTimeout(timer); delete window[cbName]; if(script.parentNode) script.parentNode.removeChild(script); }

      window[cbName] = function (data) { cleanup(); resolve(data); };
      const qs = new URLSearchParams({ ...params, callback: cbName });
      script.src = apiUrl + "?" + qs.toString();
      script.onerror = () => { cleanup(); reject(new Error("script load error")); };
      document.head.appendChild(script);
    });
  }

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

      saveSession({ token: data.session.token, name: data.session.name, role: data.session.role });
      goTo(routes.jobs);

    } catch (err) {
      console.error(err);
      setLoginMessage("通信エラーが発生しました。時間をおいて再度お試しください。", true);
      enableForm(loginEls.form);
    }
  }

  function onLogout() { clearSession(); goTo(routes.login); }

  async function refreshJobs() {
    setJobsMessage("読み込み中...", false);

    try {
      const data = await jsonpRequest({ action: "listJobs", token: state.session.token }, apiTimeoutMs);

      if (!data.ok) {
        setJobsMessage(readableApiError(data), true);
        return;
      }

      state.jobs = data.jobs || [];
      setJobsMessage("", false);
      renderJobs();

    } catch (err) {
      console.error(err);
      setJobsMessage("通信エラーが発生しました。時間をおいて再度お試しください。", true);
    }
  }

  function calculateRemainingDays(deadline) {
    if (!deadline) return "未定";
    const today = new Date();
    const d = new Date(deadline);
    if (isNaN(d.getTime())) return "未定";

    const diffMs = d.setHours(0,0,0,0) - today.setHours(0,0,0,0);
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return "期限切れ";
    return `${diffDays} 日`;
  }

  function renderJobs() {
    if (!jobEls.jobsList) return;

    const keyword  = (jobEls.searchInput?.value || "").trim().toLowerCase();
    const category = jobEls.categoryFilter?.value || "";
    const wageMin  = parseInt(jobEls.wageSliderMin?.value) || 1200;
    const wageMax  = parseInt(jobEls.wageSliderMax?.value) || 5000;

    const filtered = state.jobs.filter(job => {
      if (keyword && !JSON.stringify(job).toLowerCase().includes(keyword)) return false;
      const jobCategory = job.category || (Array.isArray(job.tags) ? job.tags[0] : job.tags) || "";
      if (category && jobCategory !== category) return false;

      if (job.deadline) {
        const deadlineDate = new Date(job.deadline);
        if (!Number.isNaN(deadlineDate.getTime())) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          deadlineDate.setHours(0, 0, 0, 0);
          if (deadlineDate < today) return false;
        }
      }
      
      // 時給フィルター
      const hourlyWage = Number(job.hourly_wage ?? job.hourlyWage);
      if (Number.isFinite(hourlyWage)) {
        if (hourlyWage < wageMin || hourlyWage > wageMax) return false;
      }
      
      return true;
    });

    if (jobEls.jobsCount) jobEls.jobsCount.textContent = `${filtered.length} 件`;

    if (filtered.length === 0) {
      jobEls.jobsList.innerHTML = "<p>該当する案件がありません。</p>";
      return;
    }

    jobEls.jobsList.innerHTML = filtered.map(job => {
      const remainingDays = job.deadline ? calculateRemainingDays(job.deadline) : "未定";
      const capacity = escapeHtml(String(job.max_applicants ?? job.maxApplicants ?? 0));
      const current  = escapeHtml(String(job.applicant_count ?? job.applicantCount ?? 0));
      const jobSlug = escapeHtml(String(job.job_id || job.id || ""));
      const jobsBase = String(routes.jobs || "/jobs/").replace(/\/+$/, "") + "/";
      const hourlyWage = Number.isFinite(Number(job.hourly_wage ?? job.hourlyWage))
        ? `¥${Number(job.hourly_wage ?? job.hourlyWage).toLocaleString()}`
        : "未設定";
      const fee = job.fee ? escapeHtml(String(job.fee)) : "未設定";

      // 「詳細ページ」リンクボタンに変更
      return `
        <a class="job-card-link" href="${jobsBase}${jobSlug}/">
          <div class="job-card">
            <div class="job-card__header">
              <h3 class="job-card__title">${escapeHtml(String(job.title || ""))}</h3>
            </div>
            <div class="job-card__body">
              <p class="job-card__deadline" style="color:red;">残り：${remainingDays}</p>
              <p class="job-card__wage">時給：${hourlyWage}</p>
              <p class="job-card__wage">ギャラ：${fee}</p>
              <p class="job-card__count">募集人数：${capacity}</p>
              <p class="job-card__count">現在申し込まれている人数：${current}</p>
            </div>
            <div class="job-card__footer"></div>
          </div>
        </a>
      `;
    }).join("");
  }

  function updateAccountSummary() {
    if (!jobEls.accountSummary || !state.session) return;
    const { name, role } = state.session;
    jobEls.accountSummary.textContent = `${escapeHtml(name || "")}（${roleLabel(role)}）`;
  }

  function saveSession(session) { sessionStorage.setItem(sessionKey, JSON.stringify(session)); }
  function loadSession() { try { return JSON.parse(sessionStorage.getItem(sessionKey)) || null; } catch { return null; } }
  function clearSession() { sessionStorage.removeItem(sessionKey); }

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

  function disableForm(form) { form?.querySelectorAll("input, button, select, textarea").forEach(el => el.disabled = true); }
  function enableForm(form) { form?.querySelectorAll("input, button, select, textarea").forEach(el => el.disabled = false); }

  function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function roleLabel(role) {
    if (role === "client") return "クライアント";
    if (role === "admin") return "管理者";
    return "タレント";
  }

  function readableApiError(data) {
    if (data.error) return data.error;
    if (data.message) return data.message;
    return "エラーが発生しました。";
  }
});