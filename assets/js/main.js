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
  const pageSize = 10;

  const loginEls = {
    message: document.getElementById("login-message")
  };

  const jobEls = {
    jobsList: document.getElementById("jobs-list"),
    jobsCount: document.getElementById("jobs-count"),
    pagination: document.getElementById("jobs-pagination"),
    nextButton: document.getElementById("jobs-next"),
    message: document.getElementById("jobs-message"),
    searchInput: document.getElementById("search-input"),
    searchButton: document.getElementById("search-button"),
    wageRangeFilter: document.getElementById("wage-range-filter")
  };

  const state = { jobs: [], appliedJobIds: new Set(), page: 1, appliedKeyword: "" };

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
      goTo("jobs/");
      return;
    }

    if (pageId === "jobs") {
      bindJobsEvents();
      refreshJobs();
    }
  }

  function bindJobsEvents() {
    jobEls.searchButton?.addEventListener("click", resetToFirstPage);
    jobEls.wageRangeFilter?.addEventListener("change", resetToFirstPage);
    jobEls.nextButton?.addEventListener("click", onNextPage);
  }

  function resetToFirstPage() {
    if (pageId === "jobs") {
      state.appliedKeyword = (jobEls.searchInput?.value || "").trim().toLowerCase();
    }
    state.page = 1;
    renderJobs();
  }

  function onNextPage() {
    state.page += 1;
    renderJobs();
  }

  function goTo(path) {
    if (!path) return;
    const url = new URL(path, window.location.href);
    let nextPath = url.pathname.replace(/\/+$/, "");
    let currentPath = window.location.pathname.replace(/\/+$/, "");
    if (currentPath.endsWith("/index.html")) currentPath = currentPath.replace(/\/index\.html$/, "");
    if (nextPath.endsWith("/index.html")) nextPath = nextPath.replace(/\/index\.html$/, "");
    if (currentPath === nextPath) { window.location.reload(); return; }
    window.location.href = url.pathname;
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

  async function refreshJobs() {
    setJobsMessage("読み込み中...", false);

    try {
      const data = await jsonpRequest({ action: "listJobs" }, apiTimeoutMs);

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
    const raw = String(deadline).trim();
    if (/^\d+\s*日$/.test(raw)) return raw.replace(/\s+/g, "");
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

    const keyword  = (state.appliedKeyword || "").trim().toLowerCase();
    const wageRange = jobEls.wageRangeFilter?.value || "";

    const filtered = state.jobs.filter(job => {
      if (keyword && !JSON.stringify(job).toLowerCase().includes(keyword)) return false;

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
        if (wageRange === "under-5000" && hourlyWage > 5000) return false;
        if (wageRange === "5000-7500" && (hourlyWage <= 5000 || hourlyWage > 7500)) return false;
        if (wageRange === "7500-10000" && (hourlyWage <= 7500 || hourlyWage > 10000)) return false;
        if (wageRange === "over-10000" && hourlyWage <= 10000) return false;
      }
      
      return true;
    });

    const totalCount = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    if (state.page > totalPages) state.page = totalPages;

    const startIndex = (state.page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const visible = filtered.slice(startIndex, endIndex);

    if (jobEls.jobsCount) {
      jobEls.jobsCount.textContent = `全${totalCount}件中${visible.length}件表示`;
    }

    if (filtered.length === 0) {
      jobEls.jobsList.innerHTML = "<p>該当する案件がありません。</p>";
      if (jobEls.pagination) jobEls.pagination.classList.add("hidden");
      return;
    }

    jobEls.jobsList.innerHTML = visible.map(job => {
      const remainingDays = job.deadline ? calculateRemainingDays(job.deadline) : "未定";
      const capacityRaw = Number(job.max_applicants ?? job.maxApplicants);
      const currentRaw = Number(job.applicant_count ?? job.applicantCount);
      const capacity = Number.isFinite(capacityRaw) ? `${capacityRaw}人` : "未設定";
      const current = Number.isFinite(currentRaw) ? `${currentRaw}人` : "0人";
      const rawJobId = String(job.job_id || job.id || "");
      const jobSlug = escapeHtml(rawJobId.trim().replace(/_/g, "-"));
      const jobsBase = String(routes.jobs || "/jobs/").replace(/\/+$/, "") + "/";
      const hourlyWage = Number.isFinite(Number(job.hourly_wage ?? job.hourlyWage))
        ? `¥${Number(job.hourly_wage ?? job.hourlyWage).toLocaleString()}`
        : "未設定";
      const fee = job.fee ? escapeHtml(String(job.fee)) : "未設定";
      const eyeCatchRaw =
        job.eyecatch_image ||
        job.eyecatch_url ||
        job.eye_catch_image ||
        job.eye_catch_url ||
        job.thumbnail_url ||
        job.image ||
        "";
      const eyeCatch = String(eyeCatchRaw || "").trim();
      const eyeCatchHtml = eyeCatch
        ? `<div class="job-card__eyecatch"><img src="${escapeHtml(eyeCatch)}" alt="${escapeHtml(String(job.title || "案件"))}" loading="lazy" decoding="async"></div>`
        : `<div class="job-card__eyecatch job-card__eyecatch--placeholder"><span>NO IMAGE</span></div>`;

      // 「詳細ページ」リンクボタンに変更
      return `
        <a class="job-card-link" href="${jobsBase}${jobSlug}/">
          <div class="job-card">
            ${eyeCatchHtml}
            <div class="job-card__header">
              <h3 class="job-card__title">${escapeHtml(String(job.title || ""))}</h3>
            </div>
            <div class="job-card__body">
              <p class="job-card__meta-item job-card__deadline"><span class="job-card__meta-label">締切まで</span><span class="job-card__meta-value">${escapeHtml(remainingDays)}</span></p>
              <p class="job-card__meta-item job-card__wage"><span class="job-card__meta-label">時給</span><span class="job-card__meta-value">${escapeHtml(hourlyWage)}</span></p>
              <p class="job-card__meta-item job-card__wage"><span class="job-card__meta-label">報酬</span><span class="job-card__meta-value">${fee}</span></p>
              <p class="job-card__meta-item job-card__count"><span class="job-card__meta-label">募集枠</span><span class="job-card__meta-value">${escapeHtml(capacity)}</span></p>
              <p class="job-card__meta-item job-card__count"><span class="job-card__meta-label">応募数</span><span class="job-card__meta-value">${escapeHtml(current)}</span></p>
            </div>
            <div class="job-card__footer"></div>
          </div>
        </a>
      `;
    }).join("");

    if (jobEls.pagination) {
      const hasNext = state.page < totalPages;
      jobEls.pagination.classList.toggle("hidden", !hasNext);
      if (jobEls.nextButton) jobEls.nextButton.disabled = !hasNext;
    }
  }

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
  function readableApiError(data) {
    if (data.error) return data.error;
    if (data.message) return data.message;
    return "エラーが発生しました。";
  }
});
