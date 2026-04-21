document.addEventListener("DOMContentLoaded", () => {
  const pageId = document.body?.dataset?.page || "default";
  const routes = window.MENU_TALENT_ROUTES || { login: "/", jobs: "/jobs/" };
  const staticJobs = Array.isArray(window.MENU_TALENT_JOBS) ? window.MENU_TALENT_JOBS : [];
  const thumbnailFiles = Array.isArray(window.MENU_TALENT_THUMBNAILS) ? window.MENU_TALENT_THUMBNAILS : [];
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
    wageRangeFilter: document.getElementById("wage-range-filter"),
    audienceButtons: Array.from(document.querySelectorAll("[data-audience-filter]"))
  };

  const state = { jobs: [], appliedJobIds: new Set(), page: 1, appliedKeyword: "", audienceFilter: "all" };
  const thumbnailRandomCache = new Map();

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
    jobEls.audienceButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const nextFilter = String(button.dataset.audienceFilter || "all").trim() || "all";
        if (state.audienceFilter === nextFilter) {
          return;
        }

        state.audienceFilter = nextFilter;
        syncAudienceButtons();
        resetToFirstPage();
      });
    });
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
    syncAudienceButtons();
    setJobsMessage("", false);
    renderJobs();
  }

  function syncAudienceButtons() {
    jobEls.audienceButtons.forEach((button) => {
      const isActive = String(button.dataset.audienceFilter || "") === state.audienceFilter;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
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

  function normalizeToStartOfDay(date) {
    const normalized = new Date(date.getTime());
    normalized.setHours(0, 0, 0, 0);
    return normalized;
  }

  function addMonthsPreservingDay(date, months) {
    const base = normalizeToStartOfDay(date);
    const day = base.getDate();
    const shifted = new Date(base.getTime());
    shifted.setDate(1);
    shifted.setMonth(shifted.getMonth() + months);
    const lastDayOfMonth = new Date(shifted.getFullYear(), shifted.getMonth() + 1, 0).getDate();
    shifted.setDate(Math.min(day, lastDayOfMonth));
    return normalizeToStartOfDay(shifted);
  }

  function getDeadlineState(deadline) {
    const parsedDeadline = parseDeadlineDate(deadline);
    if (!parsedDeadline || Number.isNaN(parsedDeadline.getTime())) {
      return {
        deadlineDate: null,
        isClosed: false,
        isArchived: false,
        remainingLabel: calculateRemainingDays(deadline),
        sortPriority: 0
      };
    }

    const today = normalizeToStartOfDay(new Date());
    const deadlineDate = normalizeToStartOfDay(parsedDeadline);
    const archiveDate = addMonthsPreservingDay(deadlineDate, 3);
    const isClosed = deadlineDate < today;
    const isArchived = archiveDate < today;

    return {
      deadlineDate,
      isClosed,
      isArchived,
      remainingLabel: isClosed ? "募集終了" : calculateRemainingDays(deadline),
      sortPriority: isClosed ? 1 : 0
    };
  }

  function normalizeDisplayStatus(value) {
    const normalized = String(value || "")
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .toLowerCase();

    if (!normalized || normalized === "表示" || normalized === "公開" || normalized === "published") {
      return "visible";
    }
    if (normalized === "非表示" || normalized === "hidden") {
      return "hidden";
    }
    if (normalized === "一時停止" || normalized === "停止" || normalized === "paused" || normalized === "pause") {
      return "paused";
    }
    if (
      normalized === "案件終了"
      || normalized === "募集終了"
      || normalized === "終了"
      || normalized === "closed"
    ) {
      return "closed";
    }

    return "visible";
  }

  function getJobAvailability(job, getValue) {
    const deadlineValue = getValue("deadline", "締切日", "締切");
    const deadlineState = getDeadlineState(deadlineValue);
    const manualStatus = normalizeDisplayStatus(
      getValue("display_status", "表示状態", "公開状態", "掲載状態")
    );

    if (manualStatus === "hidden") {
      return {
        manualStatus,
        deadlineState,
        effectiveStatus: "hidden",
        listVisible: false,
        applyEnabled: false,
        remainingLabel: deadlineState.remainingLabel,
        sortPriority: 3,
        statusNote: ""
      };
    }

    if (manualStatus === "paused") {
      return {
        manualStatus,
        deadlineState,
        effectiveStatus: "paused",
        listVisible: true,
        applyEnabled: false,
        remainingLabel: deadlineState.remainingLabel,
        sortPriority: 1,
        statusNote: "一時募集停止中"
      };
    }

    if (manualStatus === "closed") {
      return {
        manualStatus,
        deadlineState,
        effectiveStatus: "closed",
        listVisible: true,
        applyEnabled: false,
        remainingLabel: "募集終了",
        sortPriority: 2,
        statusNote: "募集終了"
      };
    }

    if (deadlineState.isArchived) {
      return {
        manualStatus,
        deadlineState,
        effectiveStatus: "archived",
        listVisible: false,
        applyEnabled: false,
        remainingLabel: "募集終了",
        sortPriority: 3,
        statusNote: "募集終了"
      };
    }

    if (deadlineState.isClosed) {
      return {
        manualStatus,
        deadlineState,
        effectiveStatus: "closed",
        listVisible: true,
        applyEnabled: false,
        remainingLabel: "募集終了",
        sortPriority: 2,
        statusNote: "募集終了"
      };
    }

    return {
      manualStatus,
      deadlineState,
      effectiveStatus: "visible",
      listVisible: true,
      applyEnabled: true,
      remainingLabel: deadlineState.remainingLabel,
      sortPriority: 0,
      statusNote: ""
    };
  }

  function calculateRemainingDays(deadline) {
    if (!deadline) return "未定";
    const raw = String(deadline).normalize("NFKC").trim();
    if (/^残り\s*0+\s*日$/.test(raw) || /^0+\s*日$/.test(raw)) return "本日締切";
    if (/^残り\s*\d+\s*日$/.test(raw)) return raw.replace(/\s+/g, "");
    if (/^\d+\s*日$/.test(raw)) return `残り${raw.replace(/\s+/g, "")}`;
    const today = new Date();
    const d = parseDeadlineDate(deadline);
    if (!d || isNaN(d.getTime())) return "未定";

    const diffMs = d.setHours(0,0,0,0) - today.setHours(0,0,0,0);
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return "期限切れ";
    if (diffDays === 0) return "本日締切";
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

  function resolveThumbnailUrl(job) {
    const getValue = createJobValueResolver(job);
    const url = String(
      pickFirst(
        getValue(
          "thumbnail_url",
          "thumbnailUrl",
          "thumbnail",
          "thumbnail_image",
          "eyecatch_image",
          "eyecatch_url",
          "eye_catch_image",
          "eye_catch_url",
          "image",
          "画像",
          "画像URL",
          "サムネイル",
          "サムネイルURL",
          "サムネイル画像",
          "サムネイル画像URL",
          "アイキャッチ画像",
          "アイキャッチ画像URL"
        )
      )
    ).trim();

    if (/^(https?:\/\/|\/)/i.test(url)) {
      return url;
    }

    return resolveThumbnailUrlByCategory(job);
  }

  function normalizeThumbnailKey(value) {
    const normalized = String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/^.*[\\/]/, "")
      .replace(/\.[^.]+$/, "")
      .replace(/[\s._-]+/g, "");

    return normalized;
  }

  function decodeThumbnailSegment(value) {
    const text = String(value || "");
    if (!text) {
      return "";
    }

    try {
      return decodeURIComponent(text);
    } catch (error) {
      return text;
    }
  }

  function tokenizeThumbnailName(value) {
    return decodeThumbnailSegment(value)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\.[^.]+$/, "")
      .split(/[、,，\/／・\s_-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2);
  }

  function getThumbnailFolderName(file) {
    const path = String(file?.path || "").split("?")[0];
    const segments = path.split("/").filter(Boolean);
    return segments.length >= 2 ? decodeThumbnailSegment(segments[segments.length - 2]) : "";
  }

  function tokenizeThumbnailFolderName(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .split(/[、,，\/／・\s]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2);
  }

  function buildThumbnailSearchText(job) {
    const getValue = createJobValueResolver(job);
    return [
      getValue("category", "カテゴリ"),
      getValue("title", "name", "job_title", "案件名（サイト上の見出し）", "案件名", "案件タイトル"),
      getValue("product_name", "productName", "商品名（サービス名、ブランド名等）", "商品名"),
      getValue("description", "details", "shoot_description", "shooting_content", "案件説明"),
      getValue("media", "medium", "media_usage", "媒体"),
      getValue("shooting_format", "shootingFormat", "撮影形式"),
      getValue("concept", "コンセプト"),
      getValue("makeup_image", "makeupImage", "メイク・ヘアメイクのイメージ"),
      getValue("outfit", "wardrobe", "衣装")
    ]
      .join(" ")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, "");
  }

  function buildThumbnailTitleText(job) {
    const getValue = createJobValueResolver(job);
    return String(
      pickFirst(
        getValue("title", "name", "job_title", "案件名（サイト上の見出し）", "案件名", "案件タイトル")
      )
    )
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, "");
  }

  function normalizeAudienceValue(value) {
    const normalized = String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, "");

    if (!normalized) {
      return "";
    }

    const includesAny = (keywords) => keywords.some((keyword) => normalized.includes(keyword));
    const mentionsAll = includesAny(["男女両方", "男女どちらも", "男女不問", "性別不問", "男女問わず", "性別問わず", "ユニセックス", "共通", "allgender", "all"]);
    const mentionsFemale = includesAny(["女性", "female", "women", "woman", "ladies", "lady", "レディース", "レディス", "girls", "girl", "miss", "ミス"]);
    const mentionsMale = includesAny(["男性", "male", "men", "man", "gentleman", "gentlemen", "mister", "ミスター", "メンズ", "boys", "boy"]);

    if (mentionsAll || (mentionsFemale && mentionsMale)) {
      return "all";
    }
    if (mentionsFemale) {
      return "miss";
    }
    if (mentionsMale) {
      return "mister";
    }

    return "";
  }

  function calculateKeywordScore(searchText, value, exactWeight = 3) {
    const decodedValue = decodeThumbnailSegment(value);
    const normalizedValue = normalizeThumbnailKey(decodedValue);
    const tokens = tokenizeThumbnailName(decodedValue);
    let score = 0;

    if (normalizedValue && searchText.includes(normalizedValue)) {
      score += normalizedValue.length * exactWeight;
    }

    tokens.forEach((token) => {
      if (searchText.includes(token)) {
        score += token.length;
        return;
      }

      for (let size = Math.min(token.length - 1, 8); size >= 2; size -= 1) {
        const prefix = token.slice(0, size);
        const suffix = token.slice(-size);

        if (searchText.includes(prefix) || searchText.includes(suffix)) {
          score += size;
          break;
        }
      }
    });

    return score;
  }

  function calculateTitleMatchBonus(titleText, value, bonus = 10) {
    if (!titleText) {
      return 0;
    }

    return calculateKeywordScore(titleText, value, 4) > 0 ? bonus : 0;
  }

  function selectThumbnailFromGroup(files, seedSource, searchText, titleText) {
    if (!Array.isArray(files) || !files.length) {
      return null;
    }

    if (searchText) {
      let bestFile = null;
      let bestScore = -1;

      files.forEach((file) => {
        const score = calculateKeywordScore(searchText, file?.basename || "", 4)
          + calculateTitleMatchBonus(titleText, file?.basename || "");
        if (score > bestScore) {
          bestScore = score;
          bestFile = file;
        }
      });

      if (bestFile && bestScore > 0) {
        return bestFile;
      }
    }

    const cacheKey = `${String(seedSource || "")}::${files.map((file) => file?.path || "").join("|")}`;
    if (thumbnailRandomCache.has(cacheKey)) {
      return thumbnailRandomCache.get(cacheKey) || null;
    }

    const selected = files[Math.floor(Math.random() * files.length)] || files[0] || null;
    thumbnailRandomCache.set(cacheKey, selected);
    return selected;
  }

  function resolveThumbnailUrlByCategory(job) {
    if (!thumbnailFiles.length) {
      return "";
    }

    const grouped = thumbnailFiles.reduce((map, file) => {
      const folderName = getThumbnailFolderName(file);
      if (!folderName) {
        return map;
      }

      if (!map.has(folderName)) {
        map.set(folderName, []);
      }

      map.get(folderName).push(file);
      return map;
    }, new Map());

    const searchText = buildThumbnailSearchText(job);
    const titleText = buildThumbnailTitleText(job);
    let bestGroup = null;
    let bestScore = 0;
    let fallbackGroup = null;

    grouped.forEach((files, folderName) => {
      if (/当てはまらない/.test(folderName)) {
        fallbackGroup = files;
        return;
      }

      const score = calculateKeywordScore(searchText, folderName, 3)
        + calculateTitleMatchBonus(titleText, folderName);
      if (!searchText || score <= 0) {
        return;
      }

      if (score > bestScore) {
        bestScore = score;
        bestGroup = files;
      }
    });

    const resolvedGroup = bestGroup || fallbackGroup;
    const selected = selectThumbnailFromGroup(
      resolvedGroup,
      pickFirst(job.job_id, job.id, job.title, job.name, searchText),
      searchText,
      titleText
    );

    return String(selected?.path || "").trim();
  }

  function getJobAudience(job) {
    const getValue = createJobValueResolver(job);
    const explicitAudience = normalizeAudienceValue(
      getValue(
        "audience",
        "target_audience",
        "casting_target",
        "target_gender",
        "gender_target",
        "gender",
        "性別",
        "対象性別",
        "募集対象",
        "対象",
        "対象モデル",
        "出演者区分",
        "モデル区分"
      )
    );
    if (explicitAudience) {
      return explicitAudience;
    }

    const audienceSource = [
      getValue("requirements", "qualifications", "conditions", "応募条件", "条件"),
      getValue("title", "name", "job_title", "案件名（サイト上の見出し）", "案件名", "案件タイトル"),
      getValue("description", "details", "shoot_description", "shooting_content", "案件説明")
    ]
      .flat()
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" ");

    return normalizeAudienceValue(audienceSource) || "all";
  }

  function matchesAudienceFilter(job, filter) {
    if (!filter || filter === "all") {
      return true;
    }

    const audience = getJobAudience(job);
    return audience === "all" || audience === filter;
  }

  function getAudienceLabel(audience) {
    if (audience === "miss") {
      return "女性募集";
    }
    if (audience === "mister") {
      return "男性募集";
    }
    return "男女両方募集";
  }

  function renderJobs() {
    if (!jobEls.jobsList) return;

    const keyword  = (state.appliedKeyword || "").trim().toLowerCase();
    const wageRange = jobEls.wageRangeFilter?.value || "";
    const audienceFilter = state.audienceFilter || "all";

    const filtered = state.jobs.map((job, index) => {
      const getValue = createJobValueResolver(job);
      return {
        job,
        index,
        getValue,
        availability: getJobAvailability(job, getValue)
      };
    }).filter(({ job, getValue, availability }) => {
      if (keyword && !JSON.stringify(job).toLowerCase().includes(keyword)) return false;
      if (!matchesAudienceFilter(job, audienceFilter)) return false;
      if (!availability.listVisible) {
        return false;
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
    }).sort((a, b) => {
      if (a.availability.sortPriority !== b.availability.sortPriority) {
        return a.availability.sortPriority - b.availability.sortPriority;
      }

      return a.index - b.index;
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

    jobEls.jobsList.innerHTML = visible.map(({ job, getValue, availability }) => {
      const remainingSource = pickFirst(
        getValue("remaining", "残り日数"),
        getValue("deadline", "締切日", "締切")
      );
      const remainingDays = availability.remainingLabel || calculateRemainingDays(remainingSource);
      const category = escapeHtml(String(
        pickFirst(
          getValue("category", "カテゴリ"),
          getValue("media", "媒体"),
          getValue("shooting_format", "撮影形式"),
          "Casting"
        )
      ).trim());
      const audienceLabel = escapeHtml(getAudienceLabel(getJobAudience(job)));
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
      const thumbnailUrl = resolveThumbnailUrl(job);
      const closedBadgeMarkup = availability.effectiveStatus === "closed"
        ? '<span class="job-card__status-badge">募集終了</span>'
        : "";
      const thumbnailMarkup = thumbnailUrl
        ? `<div class="job-card__thumb"><img src="${escapeHtml(thumbnailUrl)}" alt="${title} のサムネイル" loading="lazy">${closedBadgeMarkup}</div>`
        : `<div class="job-card__thumb job-card__thumb--empty" aria-hidden="true">${closedBadgeMarkup}</div>`;
      const cardClasses = `job-card${availability.effectiveStatus === "closed" ? " job-card--closed" : ""}`;
      const remainingClasses = `job-card__remaining${availability.effectiveStatus === "closed" ? " job-card__remaining--closed" : ""}`;

      return `
        <a class="job-card-link" href="${jobsBase}${encodedJobId}/">
          <div class="${cardClasses}">
            ${thumbnailMarkup}
            <div class="job-card__header">
              <div class="job-card__header-top">
                <div class="job-card__header-tags">
                  <span class="job-card__category">${category}</span>
                  <span class="job-card__audience">${audienceLabel}</span>
                </div>
                <span class="${remainingClasses}">${escapeHtml(remainingDays)}</span>
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
