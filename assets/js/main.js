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

  function hasValue(value) {
    if (Array.isArray(value)) {
      return value.length > 0;
    }

    if (typeof value === "number") {
      return Number.isFinite(value);
    }

    return String(value ?? "").trim() !== "";
  }

  function normalizeFieldKey(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function createJobValueResolver(job) {
    const entries = Object.entries(job || {}).map(([key, value]) => ({
      key,
      normalizedKey: normalizeFieldKey(key),
      value
    }));

    return (...candidates) => {
      for (const candidate of candidates) {
        if (Object.prototype.hasOwnProperty.call(job, candidate) && hasValue(job[candidate])) {
          return job[candidate];
        }

        const normalizedCandidate = normalizeFieldKey(candidate);
        const matched = entries.find((entry) =>
          entry.normalizedKey === normalizedCandidate
          || entry.normalizedKey.indexOf(normalizedCandidate) === 0
        );

        if (matched && hasValue(matched.value)) {
          return matched.value;
        }
      }

      return "";
    };
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

  function parseDurationMinutes(value) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : NaN;
    }

    const raw = String(value ?? "").normalize("NFKC").trim();
    if (!raw) {
      return NaN;
    }

    const hourMinuteMatch = raw.match(/(\d+(?:\.\d+)?)\s*時間(?:\s*(\d+(?:\.\d+)?)\s*分)?/);
    if (hourMinuteMatch) {
      const hours = Number(hourMinuteMatch[1] || 0);
      const minutes = Number(hourMinuteMatch[2] || 0);
      return (hours * 60) + minutes;
    }

    const minuteMatch = raw.match(/(\d+(?:\.\d+)?)\s*分/);
    if (minuteMatch) {
      return Number(minuteMatch[1]);
    }

    return parseNumericValue(raw);
  }

  function formatDurationDisplay(value) {
    const raw = String(value ?? "").trim();
    if (!raw) {
      return "未設定";
    }

    if (/分|時間/.test(raw)) {
      return raw;
    }

    const minutes = parseDurationMinutes(value);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return raw;
    }

    if (minutes < 60) {
      return `${minutes}分`;
    }

    const hours = Math.floor(minutes / 60);
    const remainMinutes = minutes % 60;
    return remainMinutes > 0 ? `${hours}時間${remainMinutes}分` : `${hours}時間`;
  }

  function formatRewardDisplay(value) {
    const raw = String(value ?? "").trim();
    if (!raw) {
      return "未設定";
    }

    if (/円/.test(raw)) {
      return raw;
    }

    const numeric = parseNumericValue(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return `${numeric.toLocaleString()}円（交通費込）`;
    }

    return raw;
  }

  function computeHourlyWage(rewardValue, durationValue) {
    const reward = parseNumericValue(rewardValue);
    const durationMinutes = parseDurationMinutes(durationValue);

    if (!Number.isFinite(reward) || reward <= 0 || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      return NaN;
    }

    return Math.round((reward * 60) / durationMinutes);
  }

  function formatHourlyWageDisplay(value, rewardValue, durationValue) {
    const raw = String(value ?? "").trim();
    if (!raw) {
      const computed = computeHourlyWage(rewardValue, durationValue);
      return Number.isFinite(computed) ? `${computed.toLocaleString()}円/時` : "未設定";
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

      const getValue = createJobValueResolver(job);
      const deadlineValue = getValue("deadline", "締切日", "締切");
      if (deadlineValue) {
        const deadlineDate = parseDeadlineDate(deadlineValue);
        if (deadlineDate && !Number.isNaN(deadlineDate.getTime())) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          deadlineDate.setHours(0, 0, 0, 0);
          if (deadlineDate < today) return false;
        }
      }
      
      // 時給フィルター
      const hourlyWage = parseNumericValue(
        getValue("hourly_wage", "hourlyWage", "wage", "時給", "想定時給")
      );
      const computedHourlyWage = computeHourlyWage(
        getValue("fee", "reward", "reward_amount", "total_reward", "報酬・交通費込（数値のみ）", "報酬（交通費込）", "報酬"),
        getValue("duration", "duration_hours", "duration_minutes", "拘束時間（分単位）※数字のみ", "拘束時間")
      );
      const resolvedHourlyWage = Number.isFinite(hourlyWage) ? hourlyWage : computedHourlyWage;
      if (Number.isFinite(resolvedHourlyWage)) {
        if (wageRange === "under-5000" && resolvedHourlyWage > 5000) return false;
        if (wageRange === "5000-7500" && (resolvedHourlyWage <= 5000 || resolvedHourlyWage > 7500)) return false;
        if (wageRange === "7500-10000" && (resolvedHourlyWage <= 7500 || resolvedHourlyWage > 10000)) return false;
        if (wageRange === "over-10000" && resolvedHourlyWage <= 10000) return false;
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
      const getValue = createJobValueResolver(job);
      const remainingSource = pickFirst(
        getValue("remaining", "残り日数"),
        getValue("deadline", "締切日", "締切")
      );
      const remainingDays = calculateRemainingDays(remainingSource);
      const category = escapeHtml(String(
        pickFirst(
          getValue("category", "カテゴリ"),
          getValue("media", "媒体"),
          getValue("shooting_format", "撮影形式"),
          "Casting"
        )
      ).trim());
      const rawJobId = String(pickFirst(getValue("job_id", "id", "案件ID"), job.job_id, job.id)).trim();
      const encodedJobId = encodeURIComponent(rawJobId);
      const jobsBase = String(routes.jobs || "/jobs/").replace(/\/+$/, "") + "/";
      const rewardValue = getValue(
        "fee",
        "reward",
        "reward_amount",
        "total_reward",
        "報酬・交通費込（数値のみ）",
        "報酬（交通費込）",
        "報酬"
      );
      const durationValue = getValue(
        "duration",
        "duration_hours",
        "duration_minutes",
        "拘束時間（分単位）※数字のみ",
        "拘束時間",
        "拘束時間(時間)"
      );
      const hourlyWage = formatHourlyWageDisplay(
        getValue("hourly_wage", "hourlyWage", "wage", "時給", "想定時給"),
        rewardValue,
        durationValue
      );
      const fee = escapeHtml(formatRewardDisplay(rewardValue));
      const duration = escapeHtml(formatDurationDisplay(durationValue));
      const shootingArea = escapeHtml(
        pickFirst(
          getValue("location", "shoot_location", "place", "venue", "実施場所", "場所", "area", "撮影エリア")
        ) || "未設定"
      );
      const title = escapeHtml(String(
        pickFirst(
          getValue("title", "name", "案件名（サイト上の見出し）", "案件名", "案件タイトル"),
          "案件詳細"
        )
      ));

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
