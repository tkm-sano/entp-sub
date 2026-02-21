const pageId = document.body?.dataset?.page || "default";
const routes = window.MENU_TALENT_ROUTES || {
  login: "/",
  jobs: "/jobs/"
};

const apiUrl = String(window.MENU_TALENT_API_URL || "").trim();
const apiTimeoutMs = Number(window.MENU_TALENT_API_TIMEOUT_MS || 15000);
const isConfigured = apiUrl && !apiUrl.startsWith("YOUR_");
const sessionKey = "menuTalentSessionV1";
const contactEmailKey = "menuTalentContactEmailV1";

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
} else {
  initPage();
}

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

async function onLoginSubmit(event) {
  event.preventDefault();
  if (!(event.currentTarget instanceof HTMLFormElement)) {
    return;
  }

  const formData = new FormData(event.currentTarget);
  const name = String(formData.get("name") || "").trim();
  const password = String(formData.get("password") || "");

  if (!name || !password) {
    setLoginMessage("名前とパスワードを入力してください。", true);
    return;
  }

  disableForm(loginEls.form);
  setLoginMessage("認証中です...", false);

  try {
    const response = await callApi("login", { name, password });
    if (!response.ok || !response.session?.token) {
      setLoginMessage(readableApiError(response), true);
      enableForm(loginEls.form);
      return;
    }

    const session = normalizeSession(response.session);
    saveSession(session);
    setLoginMessage("ログインしました。", false, true);
    goTo(routes.jobs);
  } catch (error) {
    console.error(error);
    setLoginMessage("ログイン処理に失敗しました。", true);
    enableForm(loginEls.form);
  }
}

async function refreshJobs() {
  if (!state.session) {
    goTo(routes.login);
    return;
  }

  setJobsMessage("案件を読み込み中です...", false);

  try {
    const response = await callApi("listJobs", { token: state.session.token });
    if (!response.ok) {
      if (isAuthErrorCode(response.errorCode)) {
        forceLogout("セッションが無効です。再ログインしてください。");
        return;
      }
      setJobsMessage(readableApiError(response), true);
      return;
    }

    if (response.profile) {
      state.session = {
        ...state.session,
        name: String(response.profile.name || state.session.name || ""),
        role: String(response.profile.role || state.session.role || "talent"),
        email: String(response.profile.email || state.session.email || "")
      };
      saveSession(state.session);
      updateAccountSummary();
    }

    state.jobs = Array.isArray(response.jobs)
      ? response.jobs.map((job) => ({
          ...job,
          deadlineDate: toDate(job.deadline),
          applicantCount: Number(job.applicantCount || 0),
          maxApplicants: Number(job.maxApplicants || 0)
        }))
      : [];

    state.appliedJobIds = new Set(
      Array.isArray(response.appliedJobIds)
        ? response.appliedJobIds.map((id) => String(id))
        : state.jobs.filter((job) => job.applied).map((job) => String(job.id))
    );

    state.jobs.sort((a, b) => a.deadlineDate - b.deadlineDate);
    hydrateCategoryFilter(state.jobs);
    renderJobs();
    setJobsMessage("", false);
  } catch (error) {
    console.error(error);
    setJobsMessage("案件一覧の取得に失敗しました。", true);
  }
}

function renderJobs() {
  if (pageId !== "jobs" || !jobEls.jobsList) {
    return;
  }

  jobEls.jobsList.innerHTML = "";
  const filtered = applyFilters(state.jobs);

  if (jobEls.jobsCount) {
    jobEls.jobsCount.textContent = `${filtered.length} 件表示`;
  }

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "条件に一致する案件がありません。";
    jobEls.jobsList.appendChild(empty);
    return;
  }

  for (const job of filtered) {
    jobEls.jobsList.appendChild(createJobCard(job));
  }
}

function applyFilters(jobs) {
  const keyword = (jobEls.searchInput?.value || "").trim().toLowerCase();
  const category = jobEls.categoryFilter?.value || "";
  const status = jobEls.statusFilter?.value || "all";

  return jobs.filter((job) => {
    const text = `${job.title || ""} ${job.description || ""} ${job.location || ""}`.toLowerCase();
    const tags = normalizeTags(job.tags);
    const open = isJobOpen(job);

    if (keyword && !text.includes(keyword) && !tags.join(" ").toLowerCase().includes(keyword)) {
      return false;
    }

    if (category && !tags.includes(category)) {
      return false;
    }

    if (status === "open" && !open) {
      return false;
    }

    if (status === "closed" && open) {
      return false;
    }

    return true;
  });
}

function createJobCard(job) {
  const card = document.createElement("article");
  card.className = "job-card";

  const head = document.createElement("div");
  head.className = "job-head";

  const title = document.createElement("h3");
  title.className = "job-title";
  title.textContent = job.title || "(無題案件)";

  const open = isJobOpen(job);
  const badge = document.createElement("span");
  badge.className = `badge ${open ? "" : "warn"}`.trim();
  badge.textContent = open ? "募集中" : "締切/満員";

  head.append(title, badge);

  const meta = document.createElement("p");
  meta.className = "job-meta";
  const maxText = job.maxApplicants > 0 ? `${job.maxApplicants}名` : "上限なし";
  meta.textContent = `締切: ${formatDate(job.deadlineDate)} / 応募人数: ${job.applicantCount} / 定員: ${maxText} / クライアント: ${
    job.clientName || "未設定"
  }`;

  const description = document.createElement("p");
  description.className = "job-description";
  description.textContent = job.description || "説明はありません。";

  const tags = document.createElement("div");
  tags.className = "tags";
  for (const tag of normalizeTags(job.tags)) {
    const tagNode = document.createElement("span");
    tagNode.className = "tag";
    tagNode.textContent = tag;
    tags.appendChild(tagNode);
  }

  const actions = document.createElement("div");
  actions.className = "job-actions";

  const hint = document.createElement("small");
  hint.className = "muted";

  const applyButton = document.createElement("button");
  applyButton.type = "button";
  applyButton.dataset.jobId = String(job.id || "");

  const canApply = canCurrentUserApply(job);
  applyButton.disabled = !canApply;
  applyButton.textContent = state.appliedJobIds.has(String(job.id)) ? "応募済み" : "応募する";

  if (!state.session) {
    hint.textContent = "応募するにはログインが必要です。";
  } else if (state.session.role !== "talent") {
    hint.textContent = "タレント権限ユーザーのみ応募できます。";
  } else if (state.appliedJobIds.has(String(job.id))) {
    hint.textContent = "この案件には応募済みです。";
  } else if (!open) {
    hint.textContent = "締切到来または定員到達のため応募できません。";
  } else {
    hint.textContent = "応募時に確認メール送信先のメールアドレスを入力します。";
  }

  actions.append(hint, applyButton);
  card.append(head, meta, description, tags, actions);
  return card;
}

async function onJobsListClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const jobId = String(target.dataset.jobId || "");
  if (!jobId || !state.session) {
    return;
  }

  const job = state.jobs.find((item) => String(item.id) === jobId);
  if (!job || !canCurrentUserApply(job)) {
    return;
  }

  const contactEmail = promptContactEmail_();
  if (!contactEmail) {
    setJobsMessage("応募をキャンセルしました。", false);
    return;
  }

  target.disabled = true;
  setJobsMessage("応募処理中です...", false);

  try {
    const response = await callApi("apply", { token: state.session.token, jobId, contactEmail });

    if (!response.ok) {
      if (isAuthErrorCode(response.errorCode)) {
        forceLogout("セッションが無効です。再ログインしてください。");
        return;
      }
      setJobsMessage(readableApiError(response), true);
      target.disabled = false;
      return;
    }

    setJobsMessage("応募が完了しました。", false, true);
    await refreshJobs();
  } catch (error) {
    console.error(error);
    setJobsMessage("応募処理に失敗しました。", true);
    target.disabled = false;
  }
}

function canCurrentUserApply(job) {
  if (!state.session || state.session.role !== "talent") {
    return false;
  }

  if (state.appliedJobIds.has(String(job.id))) {
    return false;
  }

  return isJobOpen(job);
}

function isJobOpen(job) {
  const now = new Date();
  const deadlineOpen =
    job.deadlineDate instanceof Date && !Number.isNaN(job.deadlineDate.getTime())
      ? job.deadlineDate >= now
      : false;
  const quotaOpen = job.maxApplicants <= 0 || job.applicantCount < job.maxApplicants;
  return deadlineOpen && quotaOpen;
}

function updateAccountSummary() {
  if (!jobEls.accountSummary || !state.session) {
    return;
  }

  const name = state.session.name || "ユーザー";
  jobEls.accountSummary.textContent = `${name} (${roleLabel(state.session.role)})`;
}

function hydrateCategoryFilter(jobs) {
  if (!jobEls.categoryFilter) {
    return;
  }

  const selected = jobEls.categoryFilter.value;
  const categories = [...new Set(jobs.flatMap((job) => normalizeTags(job.tags)).filter(Boolean))].sort();

  jobEls.categoryFilter.innerHTML = "";

  const all = document.createElement("option");
  all.value = "";
  all.textContent = "すべて";
  jobEls.categoryFilter.appendChild(all);

  for (const category of categories) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    jobEls.categoryFilter.appendChild(option);
  }

  if (categories.includes(selected)) {
    jobEls.categoryFilter.value = selected;
  }
}

async function onLogout() {
  clearSession();
  goTo(routes.login);
}

function forceLogout(message) {
  clearSession();
  if (pageId === "jobs") {
    goTo(routes.login);
    return;
  }
  setLoginMessage(message, true);
}

function callApi(action, params = {}) {
  return jsonpRequest({ action, ...params });
}

function jsonpRequest(params) {
  return new Promise((resolve, reject) => {
    const callbackName = `menuTalentCb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const query = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) {
        continue;
      }
      query.set(key, String(value));
    }

    query.set("callback", callbackName);
    query.set("_", String(Date.now()));

    const separator = apiUrl.includes("?") ? "&" : "?";
    const script = document.createElement("script");
    script.src = `${apiUrl}${separator}${query.toString()}`;
    script.async = true;

    let timer = null;

    const cleanup = () => {
      if (timer) {
        window.clearTimeout(timer);
      }
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
      delete window[callbackName];
    };

    window[callbackName] = (payload) => {
      cleanup();
      resolve(payload || { ok: false, errorCode: "invalid_response", message: "レスポンスが不正です。" });
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("API request failed"));
    };

    timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("API request timeout"));
    }, apiTimeoutMs);

    document.head.appendChild(script);
  });
}

function normalizeSession(raw) {
  return {
    token: String(raw.token || ""),
    name: String(raw.name || ""),
    role: String(raw.role || "talent"),
    email: String(raw.email || ""),
    expiresAt: Number(raw.expiresAt || Date.now() + 12 * 60 * 60 * 1000)
  };
}

function saveSession(session) {
  localStorage.setItem(sessionKey, JSON.stringify(session));
}

function loadSession() {
  const raw = localStorage.getItem(sessionKey);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const session = normalizeSession(parsed);
    if (!session.token || session.expiresAt <= Date.now()) {
      clearSession();
      return null;
    }
    return session;
  } catch {
    clearSession();
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(sessionKey);
  state.session = null;
  state.jobs = [];
  state.appliedJobIds = new Set();
}

function promptContactEmail_() {
  let defaultValue = loadContactEmail_() || String(state.session?.email || "").trim().toLowerCase();

  while (true) {
    const input = window.prompt("確認メール送信先のメールアドレスを入力してください。", defaultValue);
    if (input === null) {
      return "";
    }

    const email = String(input || "").trim().toLowerCase();
    if (!email) {
      window.alert("メールアドレスを入力してください。");
      continue;
    }

    if (!isValidEmail_(email)) {
      window.alert("メールアドレスの形式が正しくありません。");
      defaultValue = email;
      continue;
    }

    saveContactEmail_(email);
    return email;
  }
}

function loadContactEmail_() {
  try {
    return String(localStorage.getItem(contactEmailKey) || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function saveContactEmail_(email) {
  try {
    localStorage.setItem(contactEmailKey, String(email || "").trim().toLowerCase());
  } catch {
    // Ignore storage errors.
  }
}

function isValidEmail_(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function normalizeTags(rawTags) {
  if (!rawTags) {
    return [];
  }

  if (Array.isArray(rawTags)) {
    return rawTags.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof rawTags === "string") {
    return rawTags
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function toDate(raw) {
  if (!raw) {
    return new Date(0);
  }

  if (raw instanceof Date) {
    return raw;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "未設定";
  }

  return date.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function setLoginMessage(text, isError, isSuccess = false) {
  setMessage(loginEls.message, text, isError, isSuccess);
}

function setJobsMessage(text, isError, isSuccess = false) {
  setMessage(jobEls.message, text, isError, isSuccess);
}

function setMessage(element, text, isError, isSuccess) {
  if (!element) {
    return;
  }

  element.textContent = text;
  element.classList.remove("error", "success");

  if (isError) {
    element.classList.add("error");
  } else if (isSuccess) {
    element.classList.add("success");
  }
}

function disableForm(form) {
  if (!form) {
    return;
  }

  for (const element of form.querySelectorAll("input, button")) {
    element.disabled = true;
  }
}

function enableForm(form) {
  if (!form) {
    return;
  }

  for (const element of form.querySelectorAll("input, button")) {
    element.disabled = false;
  }
}

function goTo(path) {
  const url = new URL(path, window.location.origin);
  const current = window.location.pathname.replace(/\/+$/, "") || "/";
  const next = url.pathname.replace(/\/+$/, "") || "/";

  if (current === next) {
    return;
  }

  window.location.href = url.pathname;
}

function isAuthErrorCode(code) {
  const value = String(code || "");
  return value === "invalid_token" || value === "token_expired" || value === "unauthorized";
}

function readableApiError(response) {
  const code = String(response?.errorCode || "");

  if (code === "invalid_credentials") {
    return "名前またはパスワードが正しくありません。";
  }
  if (code === "invalid_token" || code === "token_expired") {
    return "セッションが無効です。再ログインしてください。";
  }
  if (code === "already_applied") {
    return "この案件には既に応募済みです。";
  }
  if (code === "quota_full") {
    return "応募人数が上限に達しています。";
  }
  if (code === "deadline_passed") {
    return "応募締切を過ぎたため応募できません。";
  }
  if (code === "forbidden") {
    return "この操作を実行する権限がありません。";
  }
  if (code === "invalid_email") {
    return "確認メール送信先のメールアドレスが不正です。";
  }

  return String(response?.message || "処理に失敗しました。");
}

function roleLabel(role) {
  if (role === "client") {
    return "クライアント";
  }

  if (role === "admin") {
    return "管理者";
  }

  return "タレント";
}
