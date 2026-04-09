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

  function parseDeadlineDate(deadline) {
    if (!deadline) return null;

    const raw = String(deadline).trim();
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
    const raw = String(deadline).trim();
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

  function extractDriveFileId(rawUrl) {
    const raw = String(rawUrl || "").trim();
    if (!raw) return "";

    const m1 = raw.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m1 && m1[1]) return m1[1];

    const m2 = raw.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (m2 && m2[1]) return m2[1];

    const m3 = raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m3 && m3[1]) return m3[1];

    return "";
  }

  function normalizeYouTubeEmbedUrl(rawUrl) {
    const raw = String(rawUrl || "").trim();
    if (!raw) return "";

    const short = raw.match(/^https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{6,})/i);
    if (short && short[1]) {
      return `https://www.youtube.com/embed/${short[1]}`;
    }

    const normal = raw.match(/[?&]v=([a-zA-Z0-9_-]{6,})/i);
    if (normal && normal[1]) {
      return `https://www.youtube.com/embed/${normal[1]}`;
    }

    const embed = raw.match(/^https?:\/\/(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{6,})/i);
    if (embed && embed[1]) {
      return `https://www.youtube.com/embed/${embed[1]}`;
    }

    return "";
  }

  function resolveCardMediaSource(job) {
    const raw = pickFirst(
      job.thumbnail_url,
      job.eyecatch_image,
      job.eyecatch_url,
      job.eye_catch_image,
      job.eye_catch_url,
      job.image,
      job.video_url,
      job.movie_url,
      job.video,
      job.media_url,
      job.media,
      job.file_url,
      job["画像"],
      job["画像URL"],
      job["動画"],
      job["動画URL"],
      job["画像・動画"],
      job["画像・動画URL"]
    );

    const url = String(raw || "").trim();
    if (!url) {
      return { type: "none", url: "" };
    }

    const yt = normalizeYouTubeEmbedUrl(url);
    if (yt) {
      return { type: "iframe", url: yt };
    }

    if (/^https?:\/\/drive\.google\.com\//i.test(url)) {
      const driveId = extractDriveFileId(url);
      if (driveId) {
        return { type: "iframe", url: `https://drive.google.com/file/d/${driveId}/preview` };
      }
    }

    if (/\.(mp4|webm|ogg|mov|m4v)(?:$|[?#])/i.test(url)) {
      return { type: "video", url };
    }

    if (/\.(png|jpe?g|gif|webp|avif|svg)(?:$|[?#])/i.test(url)) {
      return { type: "image", url };
    }

    return { type: "image", url };
  }

  function renderCardMedia(job) {
    const mediaSource = resolveCardMediaSource(job);
    const alt = escapeHtml(String(job.title || "案件"));

    if (mediaSource.type === "iframe") {
      return `<div class="job-card__eyecatch"><iframe src="${escapeHtml(mediaSource.url)}" title="${alt}" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`;
    }

    if (mediaSource.type === "video") {
      return `<div class="job-card__eyecatch"><video src="${escapeHtml(mediaSource.url)}" muted playsinline preload="metadata"></video></div>`;
    }

    if (mediaSource.type === "image") {
      return `<div class="job-card__eyecatch"><img src="${escapeHtml(mediaSource.url)}" alt="${alt}" loading="lazy" decoding="async"></div>`;
    }

    return `<div class="job-card__eyecatch job-card__eyecatch--placeholder"><span>NO IMAGE</span></div>`;
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
      const remainingSource = pickFirst(job.remaining, job["残り日数"], job.deadline);
      const remainingDays = calculateRemainingDays(remainingSource);
      const capacityRaw = Number(job.max_applicants ?? job.maxApplicants);
      const currentRaw = Number(job.applicant_count ?? job.applicantCount);
      const capacity = Number.isFinite(capacityRaw) ? `${capacityRaw}人` : "未設定";
      const current = Number.isFinite(currentRaw) ? `${currentRaw}人` : "0人";
      const category = escapeHtml(String(job.category || job.media || "Casting").trim());
      const rawJobId = String(job.job_id || job.id || "").trim();
      const encodedJobId = encodeURIComponent(rawJobId);
      const jobsBase = String(routes.jobs || "/jobs/").replace(/\/+$/, "") + "/";
      const hourlyWage = Number.isFinite(Number(job.hourly_wage ?? job.hourlyWage))
        ? `¥${Number(job.hourly_wage ?? job.hourlyWage).toLocaleString()}`
        : "未設定";
      const fee = job.fee ? escapeHtml(String(job.fee)) : "未設定";
      const eyeCatchHtml = renderCardMedia(job);

      // 「詳細ページ」リンクボタンに変更
      return `
        <a class="job-card-link" href="${jobsBase}detail/?jobId=${encodedJobId}">
          <div class="job-card">
            ${eyeCatchHtml}
            <div class="job-card__header">
              <div class="job-card__header-top">
                <span class="job-card__category">${category}</span>
                <span class="job-card__remaining">${escapeHtml(remainingDays)}</span>
              </div>
              <h3 class="job-card__title">${escapeHtml(String(job.title || ""))}</h3>
            </div>
            <div class="job-card__body">
              <p class="job-card__meta-item job-card__wage"><span class="job-card__meta-label">時給</span><span class="job-card__meta-value">${escapeHtml(hourlyWage)}</span></p>
              <p class="job-card__meta-item job-card__wage"><span class="job-card__meta-label">報酬</span><span class="job-card__meta-value">${fee}</span></p>
              <p class="job-card__meta-item job-card__count"><span class="job-card__meta-label">募集枠</span><span class="job-card__meta-value">${escapeHtml(capacity)}</span></p>
              <p class="job-card__meta-item job-card__count"><span class="job-card__meta-label">応募数</span><span class="job-card__meta-value">${escapeHtml(current)}</span></p>
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
