document.addEventListener("DOMContentLoaded", () => {
  const pageId = document.body?.dataset?.page || "default";
  const routes = window.MENU_TALENT_ROUTES || { login: "/", jobs: "/jobs/" };
  const staticJobs = Array.isArray(window.MENU_TALENT_JOBS) ? window.MENU_TALENT_JOBS : [];
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

  function refreshJobs() {
    state.jobs = staticJobs;
    setJobsMessage("", false);
    renderJobs();
  }

  function parseDeadlineDate(deadline) {
    if (!deadline) return null;

    const raw = String(deadline).normalize("NFKC").trim();
    if (!raw || /^残り\s*\d+\s*日$/.test(raw) || /^\d+\s*日$/.test(raw)) {
      return null;
    }

    const jpMatch = raw.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (jpMatch) {
      return new Date(Number(jpMatch[1]), Number(jpMatch[2]) - 1, Number(jpMatch[3]));
    }

    const ymdMatch = raw.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
    if (ymdMatch) {
      return new Date(Number(ymdMatch[1]), Number(ymdMatch[2]) - 1, Number(ymdMatch[3]));
    }

    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function calculateRemainingDays(deadline) {
    if (!deadline) return "未定";
    const raw = String(deadline).normalize("NFKC").trim();
    if (/^残り\s*\d+\s*日$/.test(raw)) return raw.replace(/\s+/g, "");
    if (/^\d+\s*日$/.test(raw)) return `残り${raw.replace(/\s+/g, "")}`;
    const today = new Date();
    const d = parseDeadlineDate(deadline);
    if (!d || isNaN(d.getTime())) return "未定";

    const diffMs = d.setHours(0,0,0,0) - today.setHours(0,0,0,0);
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return "期限切れ";
    return `残り${diffDays}日`;
  }

  function pickFirst(...values) {
    for (const value of values) {
      const text = String(value || "").trim();
      if (text) return text;
    }
    return "";
  }

  function parseNumericValue(value) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : NaN;
    }

    const raw = String(value ?? "")
      .normalize("NFKC")
      .trim();
    if (!raw) {
      return NaN;
    }

    const matched = raw.replace(/[,\uFF0C]/g, "").match(/-?\d+(?:\.\d+)?/);
    if (!matched) {
      return NaN;
    }

    const parsed = Number(matched[0]);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function formatHourlyWageDisplay(value) {
    const raw = String(value ?? "").trim();
    if (!raw) {
      return "未設定";
    }

    if (/[¥円]/.test(raw)) {
      return raw;
    }

    const numeric = parseNumericValue(value);
    if (Number.isFinite(numeric)) {
      const normalizedRaw = raw.normalize("NFKC").replace(/[,\uFF0C]/g, "");
      if (/^-?\d+(?:\.\d+)?$/.test(normalizedRaw)) {
        return `¥${numeric.toLocaleString()}`;
      }
    }

    return raw;
  }

  function renderJobs() {
    if (!jobEls.jobsList) return;

    const keyword  = (state.appliedKeyword || "").trim().toLowerCase();
    const wageRange = jobEls.wageRangeFilter?.value || "";

    const filtered = state.jobs.filter(job => {
      if (keyword && !JSON.stringify(job).toLowerCase().includes(keyword)) return false;

      if (job.deadline) {
        const deadlineDate = parseDeadlineDate(job.deadline);
        if (deadlineDate && !Number.isNaN(deadlineDate.getTime())) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          deadlineDate.setHours(0, 0, 0, 0);
          if (deadlineDate < today) return false;
        }
      }
      
      // 時給フィルター
      const hourlyWage = parseNumericValue(job.hourly_wage ?? job.hourlyWage);
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
      const remainingSource = pickFirst(job.remaining, job["残り日数"], job.deadline);
      const remainingDays = calculateRemainingDays(remainingSource);
      const category = escapeHtml(String(job.category || job.media || job.shooting_format || "Casting").trim());
      const rawJobId = String(job.job_id || job.id || "").trim();
      const encodedJobId = encodeURIComponent(rawJobId);
      const jobsBase = String(routes.jobs || "/jobs/").replace(/\/+$/, "") + "/";
      const hourlyWage = formatHourlyWageDisplay(job.hourly_wage ?? job.hourlyWage);
      const feeValue = job.fee ?? job.reward ?? job.reward_amount;
      const feeNumber = parseNumericValue(feeValue);
      const fee = Number.isFinite(feeNumber) && feeNumber > 0
        ? `${feeNumber.toLocaleString()}円（交通費込）`
        : (feeValue ? escapeHtml(String(feeValue)) : "未設定");
      const duration = escapeHtml(
        pickFirst(
          job.duration,
          job.duration_hours,
          job.duration_minutes,
          job["拘束時間（分単位）※数字のみ"],
          job["拘束時間"],
          job["拘束時間(時間)"]
        ) || "未設定"
      );
      const shootingArea = escapeHtml(
        pickFirst(
          job.location,
          job.shoot_location,
          job.place,
          job.venue,
          job["実施場所"],
          job["場所"],
          job.area,
          job["撮影エリア"]
        ) || "未設定"
      );
      const title = escapeHtml(String(job.title || job.name || "案件詳細"));

      // 「詳細ページ」リンクボタンに変更
      return `
        <a class="job-card-link" href="${jobsBase}${encodedJobId}/">
          <div class="job-card">
            <div class="job-card__header">
              <div class="job-card__header-top">
                <span class="job-card__category">${category}</span>
                <span class="job-card__remaining">${escapeHtml(remainingDays)}</span>
              </div>
              <h3 class="job-card__title">${title}</h3>
            </div>
            <div class="job-card__body">
              <p class="job-card__meta-item job-card__wage"><span class="job-card__meta-label">時給</span><span class="job-card__meta-value">${escapeHtml(hourlyWage)}</span></p>
              <p class="job-card__meta-item job-card__wage"><span class="job-card__meta-label">報酬総額</span><span class="job-card__meta-value">${fee}</span></p>
              <p class="job-card__meta-item job-card__count"><span class="job-card__meta-label">拘束時間</span><span class="job-card__meta-value">${duration}</span></p>
              <p class="job-card__meta-item job-card__count"><span class="job-card__meta-label">撮影エリア</span><span class="job-card__meta-value">${shootingArea}</span></p>
            </div>
            <div class="job-card__footer">
              <span class="job-card__cta">詳細を見る</span>
            </div>
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

  function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
});
