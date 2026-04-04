// @ts-nocheck

/* =========================================
   Constants
========================================= */

const SHEET_NAMES = {
  jobs: "jobs"
};

const API_BUILD = "2026-03-29-1";
const GITHUB_API_BASE = "https://api.github.com";
const TZ = "Asia/Tokyo";
const TALENT_USERS_CACHE_KEY = "talent_users_v2";
const DEFAULT_TALENT_USERS_CACHE_SECONDS = 300;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_GITHUB_WORKFLOW_ID = "deploy-jobs.yml";
const GITHUB_RUN_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const GITHUB_RUN_POLL_INTERVAL_MS = 5000;

/* =========================================
   Spreadsheet Menu
========================================= */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("更新")
    .addItem("編集をWebページに反映", "runGitHubActionsFromMenu_")
    .addToUi();
}

function runGitHubActionsFromMenu_() {
  const ui = SpreadsheetApp.getUi();
  const ref = getDefaultGitHubRef_();

  try {
    const result = triggerGitHubWorkflowDispatch_(ref);
    const lines = [
      `GitHub Actions が完了しました。`,
      `workflow: ${result.workflowId}`,
      `branch: ${result.ref}`,
      `status: ${result.conclusion || result.status || "completed"}`
    ];

    if (result.runUrl) {
      lines.push(`run: ${result.runUrl}`);
    }

    ui.alert(lines.join("\n"));
  } catch (err) {
    ui.alert(
      "GitHub Actions エラー",
      err && err.message ? err.message : "不明なエラー",
      ui.ButtonSet.OK
    );
  }
}

function getDefaultGitHubRef_() {
  const ref = String(PropertiesService.getScriptProperties().getProperty("GITHUB_REF") || "").trim();
  return ref || "main";
}

function triggerGitHubWorkflowDispatch_(ref) {
  const props = PropertiesService.getScriptProperties();
  const owner = mustGetScriptProperty_("GITHUB_OWNER");
  const repo = mustGetScriptProperty_("GITHUB_REPO");
  const workflowId = getWorkflowId_();
  const token = mustGetScriptProperty_("GITHUB_TOKEN");
  const inputsJson = String(props.getProperty("GITHUB_WORKFLOW_INPUTS_JSON") || "").trim();
  const dispatchedAt = new Date();

  let inputs = {};
  if (inputsJson) {
    try {
      const parsed = JSON.parse(inputsJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("GITHUB_WORKFLOW_INPUTS_JSON は JSON オブジェクト形式で指定してください");
      }
      inputs = parsed;
    } catch (err) {
      throw apiError_("config_error", `GITHUB_WORKFLOW_INPUTS_JSON が不正です: ${err.message}`);
    }
  }

  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`;
  const payload = { ref, inputs };

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    muteHttpExceptions: true,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    payload: JSON.stringify(payload)
  });

  const code = res.getResponseCode();
  const body = res.getContentText();

  if (code !== 204) {
    const detail = buildGitHubDispatchErrorMessage_(code, body, owner, repo, workflowId, ref);
    throw apiError_("github_dispatch_failed", detail);
  }

  const run = waitForWorkflowRunCompletion_(owner, repo, workflowId, ref, token, dispatchedAt);
  return {
    owner,
    repo,
    workflowId,
    ref,
    runId: run.id,
    runUrl: run.html_url,
    status: run.status,
    conclusion: run.conclusion
  };
}

function buildGitHubDispatchErrorMessage_(statusCode, body, owner, repo, workflowId, ref) {
  const base = `GitHub API エラー: status=${statusCode}, body=${body}`;
  let parsed = null;

  try {
    parsed = body ? JSON.parse(body) : null;
  } catch (err) {
    parsed = null;
  }

  const message = String(parsed?.message || "");

  if (statusCode === 401) {
    return [
      base,
      "認証に失敗しました。GITHUB_TOKEN の値が正しいか確認してください。"
    ].join("\n");
  }

  if (statusCode === 403 && /personal access token/i.test(message)) {
    return [
      base,
      "トークン権限不足の可能性があります。次を確認してください。",
      "1) Fine-grained PAT の場合: 対象リポジトリを許可し、Repository permissions の Actions を Write にする。",
      "2) Classic PAT の場合: private リポジトリなら repo と workflow スコープを付与する。",
      "3) トークン所有ユーザーに対象リポジトリの Write 以上の権限がある。",
      `4) workflow_id=${workflowId} と ref=${ref} が ${owner}/${repo} に存在する。`
    ].join("\n");
  }

  if (statusCode === 404) {
    return [
      base,
      "リポジトリまたはワークフローが見つかりません。GITHUB_OWNER/GITHUB_REPO/GITHUB_WORKFLOW_ID を確認してください。"
    ].join("\n");
  }

  if (statusCode === 422) {
    return [
      base,
      "workflow_dispatch が無効、または ref が不正の可能性があります。workflow ファイルに workflow_dispatch があるか確認してください。"
    ].join("\n");
  }

  return base;
}

function mustGetScriptProperty_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw apiError_("config_error", `${key} 未設定`);
  }
  return value;
}

function getWorkflowId_() {
  const value = String(PropertiesService.getScriptProperties().getProperty("GITHUB_WORKFLOW_ID") || "").trim();
  return value || DEFAULT_GITHUB_WORKFLOW_ID;
}

function waitForWorkflowRunCompletion_(owner, repo, workflowId, ref, token, dispatchedAt) {
  const deadline = Date.now() + GITHUB_RUN_POLL_TIMEOUT_MS;
  let run = null;

  while (Date.now() < deadline) {
    run = findDispatchedWorkflowRun_(owner, repo, workflowId, ref, token, dispatchedAt);

    if (run && run.status === "completed") {
      if (run.conclusion !== "success") {
        const detail = [
          `workflow が失敗しました: conclusion=${run.conclusion || "unknown"}`,
          `run=${run.html_url || ""}`
        ].join("\n");
        throw apiError_("github_workflow_failed", detail);
      }
      return run;
    }

    Utilities.sleep(GITHUB_RUN_POLL_INTERVAL_MS);
  }

  throw apiError_(
    "github_workflow_timeout",
    `workflow の完了待機がタイムアウトしました。workflow=${workflowId}, ref=${ref}`
  );
}

function findDispatchedWorkflowRun_(owner, repo, workflowId, ref, token, dispatchedAt) {
  const encodedRef = encodeURIComponent(ref);
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowId)}/runs?event=workflow_dispatch&branch=${encodedRef}&per_page=10`;

  const res = UrlFetchApp.fetch(url, {
    method: "get",
    muteHttpExceptions: true,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });

  const code = res.getResponseCode();
  const body = res.getContentText();

  if (code !== 200) {
    throw apiError_("github_runs_failed", `GitHub runs API エラー: status=${code}, body=${body}`);
  }

  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch (err) {
    throw apiError_("github_runs_failed", `GitHub runs API の応答JSONが不正です: ${err.message}`);
  }

  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  const dispatchedTime = dispatchedAt.getTime() - 30000;

  for (const candidate of runs) {
    const createdAt = Date.parse(String(candidate?.created_at || ""));
    if (!Number.isFinite(createdAt)) {
      continue;
    }
    if (createdAt >= dispatchedTime) {
      return candidate;
    }
  }

  return null;
}

/* =========================================
   Entry
========================================= */

function doGet(e) {
  return handleRequest_(e);
}

function doPost(e) {
  return handleRequest_(e);
}

/* =========================================
   Router
========================================= */

function handleRequest_(e) {
  let callback = "";
  const requestId = Utilities.getUuid();
  const startedAt = Date.now();

  try {
    const params = e?.parameter || {};
    callback = sanitizeCallback_(params.callback);
    const action = String(params.action || "").trim();

    if (!action) {
      throw apiError_("invalid_action", "action 必須");
    }

    let payload;

    if (action === "health") {
      payload = { ok: true, build: API_BUILD };
    } else if (action === "listJobs") {
      payload = listJobs_(params);
    } else if (action === "getJob") {
      payload = getJob_(params);
    } else if (action === "apply") {
      payload = apply_(params);
    } else {
      throw apiError_("invalid_action", "未対応 action");
    }

    payload.requestId = requestId;
    payload.elapsedMs = Date.now() - startedAt;

    return respond_(callback, payload);

  } catch (err) {
    return respond_(callback, {
      ok: false,
      errorCode: err.code || "internal_error",
      message: err.message || "内部エラー",
      requestId,
      elapsedMs: Date.now() - startedAt
    });
  }
}

/* =========================================
   名簿読取（TALENT_SPREADSHEET_ID）
========================================= */

function readUsers_() {
  const cache = CacheService.getScriptCache();
  const cacheKey = getTalentUsersCacheKey_();
  const cached = cache.get(cacheKey);

  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (err) {
      // キャッシュ破損時は読み直す
    }
  }

  const users = runWithRetry_(function() {
    const sheet = getTalentSheet_();
    const values = sheet.getDataRange().getValues();

    if (values.length < 2) {
      return [];
    }

    const headers = values[0].map(h => String(h).trim());

    const nameCol = findColumn_(headers, "名前");
    const emailCol = findColumn_(
      headers,
      "email",
      "メールアドレス",
      "E-mail",
      "Email",
      "mail"
    );
    const pageUrlCol = findColumn_(headers, "個別ページURL", "page_url", "profile_url");

    if (nameCol < 0) {
      throw apiError_("config_error", "名前列不存在");
    }

    return values.slice(1).map(row => {
      const rawName = String(row[nameCol] || "");
      const normalizedName = normalizeName_(rawName);

      if (!normalizedName) {
        return null;
      }

      return {
        uid: hash_(normalizedName),
        name: rawName.trim(),
        normalizedName,
        email: emailCol >= 0 ? String(row[emailCol] || "").trim() : "",
        pageUrl: pageUrlCol >= 0 ? String(row[pageUrlCol] || "").trim() : ""
      };
    }).filter(Boolean);
  }, DEFAULT_RETRY_COUNT, DEFAULT_RETRY_BASE_MS);

  try {
    cache.put(cacheKey, JSON.stringify(users), getTalentUsersCacheSeconds_());
  } catch (err) {
    // キャッシュ保存失敗でも処理は継続
  }

  return users;
}

function getTalentSheet_() {
  const id = getOptionalProperty_("TALENT_SPREADSHEET_ID") || getProperty_("SPREADSHEET_ID");
  const sheetName = getOptionalProperty_("TALENT_SHEET_NAME");
  const ss = SpreadsheetApp.openById(id);

  if (sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      throw apiError_("config_error", `名簿シート不存在: ${sheetName}`);
    }
    return sheet;
  }

  const sheet = findSheetWithHeader_(ss, "名前");
  if (!sheet) {
    throw apiError_("config_error", "名簿シート不存在");
  }
  return sheet;
}

function clearTalentUsersCache_() {
  CacheService.getScriptCache().remove(getTalentUsersCacheKey_());
}

/* =========================================
   JOBS取得（SPREADSHEET_ID）
========================================= */

function listJobs_(params) {
  const sheet = getJobsSheet_();
  const range = sheet.getDataRange();
  const values = range.getValues();
  const displayValues = range.getDisplayValues();

  if (values.length < 2) {
    return { ok: true, jobs: [] };
  }

  const headers = values[0].map(h => String(h).trim());
  const findColumn = (...candidates) => findColumn_(headers, ...candidates);

  const jobIdCol        = findColumn("job_id", "id");
  const titleCol        = findColumn("案件名", "title", "案件タイトル");
  const rewardCol       = findColumn("報酬（交通費込）", "報酬", "fee");
  const durationCol     = findColumn("拘束時間", "duration", "duration_hours");
  const hourlyWageCol   = findColumn("時給", "hourly_wage", "wage");
  const dateCol         = findColumn("実施日時", "date", "candidate_shoot_dates");
  const locationCol     = findColumn("実施場所", "location", "shoot_location");
  const requirementsCol = findColumn("応募条件", "requirements");
  const maxCol          = findColumn("募集人数", "max_applicants", "recruitment_number");
  const descriptionCol  = findColumn("案件説明", "description", "shoot_description", "shooting_content");
  const conceptCol      = findColumn("コンセプト", "concept");
  const makeupCol       = findColumn("メイク・ヘアメイクの有無", "メイク・ヘアメイクスタッフの有無", "makeup");
  const belongingsCol   = findColumn("持ち物", "belongings", "items_to_bring");
  const mediaCol        = findColumn("媒体", "media", "media_usage");
  const periodCol       = findColumn("使用期間", "period", "usage_period");
  const competitionCol  = findColumn("競合", "competition", "competition_presence");
  const remainingCol    = findColumn("残り日数");
  const selectionCol    = findColumn("選考方法", "selection_method");
  const deadlineCol     = findColumn("締切日", "deadline", "締切");
  const emailCol        = findColumn("client_email", "クライアントE-mail", "クライアントEmail", "クライアントメール");
  const formCol         = findColumn("form_url");
  const categoryCol     = findColumn("category");
  const countCol        = findColumn("applicant_count");
  const notifiedCol     = findColumn("deadline_notified_at", "締切通知日時", "通知日時");
  const applicantsCol   = findColumn("applicants", "応募者", "応募者名");

  if (titleCol < 0) {
    throw apiError_("config_error", "案件名列が見つかりません");
  }

  const jobs = values.slice(1).map((row, i) => {
    const displayRow = displayValues[i + 1] || [];
    return buildJobFromRow_(row, displayRow, headers, i + 2);
  });

  return { ok: true, jobs };
}

function getJob_(params) {
  const jobId = String(params.jobId || "").trim();
  if (!jobId) {
    throw apiError_("invalid_param", "jobId 必須");
  }

  const sheet = getJobsSheet_();
  const range = sheet.getDataRange();
  const values = range.getValues();
  const displayValues = range.getDisplayValues();

  if (values.length < 2) {
    throw apiError_("not_found", "案件が見つかりません");
  }

  const headers = values[0].map(h => String(h).trim());
  const rowIndex = findJobRowIndex_(values, headers, jobId);

  if (rowIndex < 1) {
    throw apiError_("not_found", "案件が見つかりません");
  }

  const row = values[rowIndex];
  const displayRow = displayValues[rowIndex] || [];
  const job = buildJobFromRow_(row, displayRow, headers, rowIndex + 1);

  return { ok: true, job };
}

function buildJobFromRow_(row, displayRow, headers, sheetRowNumber) {
  const findColumn = (...candidates) => findColumn_(headers, ...candidates);

  const titleCol        = findColumn("案件名", "title", "案件タイトル");
  const rewardCol       = findColumn("報酬（交通費込）", "報酬", "fee");
  const durationCol     = findColumn("拘束時間", "duration", "duration_hours");
  const hourlyWageCol   = findColumn("時給", "hourly_wage", "wage");
  const dateCol         = findColumn("実施日時", "date", "candidate_shoot_dates");
  const locationCol     = findColumn("実施場所", "location", "shoot_location");
  const requirementsCol = findColumn("応募条件", "requirements");
  const maxCol          = findColumn("募集人数", "max_applicants", "recruitment_number");
  const descriptionCol  = findColumn("案件説明", "description", "shoot_description", "shooting_content");
  const conceptCol      = findColumn("コンセプト", "concept");
  const makeupCol       = findColumn("メイク・ヘアメイクの有無", "メイク・ヘアメイクスタッフの有無", "makeup");
  const belongingsCol   = findColumn("持ち物", "belongings", "items_to_bring");
  const mediaCol        = findColumn("媒体", "media", "media_usage");
  const periodCol       = findColumn("使用期間", "period", "usage_period");
  const competitionCol  = findColumn("競合", "competition", "competition_presence");
  const remainingCol    = findColumn("残り日数");
  const selectionCol    = findColumn("選考方法", "selection_method");
  const deadlineCol     = findColumn("締切日", "deadline", "締切");
  const emailCol        = findColumn("client_email", "クライアントE-mail", "クライアントEmail", "クライアントメール");
  const formCol         = findColumn("form_url");
  const categoryCol     = findColumn("category");
  const countCol        = findColumn("applicant_count");
  const notifiedCol     = findColumn("deadline_notified_at", "締切通知日時", "通知日時");
  const applicantsCol   = findColumn("applicants", "応募者", "応募者名");

  const generatedId = getJobIdFromRow_(row, displayRow, headers, sheetRowNumber);
  const deadlineText = colDisplay_(displayRow, deadlineCol, "");
  const remainingText = colDisplay_(displayRow, remainingCol, "");
  const computedRemaining = calculateRemainingDaysLabel_(colValue_(row, deadlineCol, ""));
  const remaining = computedRemaining || remainingText;

  return {
    id: generatedId,
    job_id: generatedId,
    title: colDisplay_(displayRow, titleCol, ""),
    reward: colDisplay_(displayRow, rewardCol, ""),
    duration: colDisplay_(displayRow, durationCol, ""),
    hourly_wage: colDisplay_(displayRow, hourlyWageCol, ""),
    date: colDisplay_(displayRow, dateCol, ""),
    location: colDisplay_(displayRow, locationCol, ""),
    requirements: colDisplay_(displayRow, requirementsCol, ""),
    max_applicants: colDisplay_(displayRow, maxCol, ""),
    description: colDisplay_(displayRow, descriptionCol, ""),
    concept: colDisplay_(displayRow, conceptCol, ""),
    makeup: colDisplay_(displayRow, makeupCol, ""),
    belongings: colDisplay_(displayRow, belongingsCol, ""),
    media: colDisplay_(displayRow, mediaCol, ""),
    period: colDisplay_(displayRow, periodCol, ""),
    competition: colDisplay_(displayRow, competitionCol, ""),
    remaining: remaining,
    selection_method: colDisplay_(displayRow, selectionCol, ""),
    deadline: deadlineText,
    client_email: colDisplay_(displayRow, emailCol, ""),
    form_url: colDisplay_(displayRow, formCol, ""),
    category: colDisplay_(displayRow, categoryCol, ""),
    applicant_count: colValue_(row, countCol, 0),
    deadline_notified_at: colDisplay_(displayRow, notifiedCol, ""),
    applicants: colDisplay_(displayRow, applicantsCol, "")
  };
}

/* =========================================
   応募処理
========================================= */

function apply_(params) {
  const rawToken = String(params.token || "").trim();
  const tokenPayload = rawToken ? verifyToken_(rawToken) : null;
  const applicantName = tokenPayload?.name
    ? normalizeName_(tokenPayload.name)
    : normalizeName_(params.applicantName);
  const jobId = String(params.jobId || "").trim();
  const acceptedCancelPolicy = String(params.acceptedCancelPolicy || "").trim().toLowerCase() === "true";

  if (!jobId) {
    throw apiError_("invalid_param", "jobId 必須");
  }

  if (!applicantName) {
    throw apiError_("invalid_param", "応募者名 必須");
  }

  if (!acceptedCancelPolicy) {
    throw apiError_("consent_required", "キャンセルポリシーの確認が必要です");
  }

  const contactEmail = resolveApplicantEmail_(params, tokenPayload);
  if (!contactEmail || !isValidEmail_(contactEmail)) {
    throw apiError_("invalid_email", "メールアドレスが不正です");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const sheet = getJobsSheet_();
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) {
      throw apiError_("not_found", "案件が見つかりません");
    }

    const headers = values[0].map(h => String(h).trim());
    const findColumn = (...candidates) => findColumn_(headers, ...candidates);

    const titleCol      = findColumn("案件名", "title");
    const deadlineCol   = findColumn("締切日", "deadline", "締切");
    const maxCol        = findColumn("募集人数", "max_applicants");
    const countCol      = findColumn("applicant_count");
    const applicantsCol = findColumn("applicants", "応募者", "応募者名");
    const jobIdCol      = findColumn("job_id", "id");

    if (titleCol < 0) {
      throw apiError_("config_error", "案件名列が見つかりません");
    }
    if (applicantsCol < 0) {
      throw apiError_("config_error", "applicants 列不存在");
    }

    const rowIndex = findJobRowIndex_(values, headers, jobId);
    if (rowIndex < 1) {
      throw apiError_("not_found", "案件が見つかりません");
    }

    const row = values[rowIndex];
    const sheetRow = rowIndex + 1;

    const deadline = deadlineCol >= 0 ? row[deadlineCol] : "";
    const max = normalizeNumber_(maxCol >= 0 ? row[maxCol] : 0);
    const title = String(row[titleCol] || "");
    const explicitJobId = jobIdCol >= 0 ? String(row[jobIdCol] || "").trim() : "";

    const existingApplicantsText = String(row[applicantsCol] || "").trim();
    const applicantsList = splitLines_(existingApplicantsText);
    const currentCount = countCol >= 0 ? normalizeNumber_(row[countCol]) : applicantsList.length;

    if (isDeadlinePassed_(deadline)) {
      throw apiError_("deadline_passed", "応募締切を過ぎています");
    }

    if (max > 0 && currentCount >= max) {
      throw apiError_("quota_full", "定員に達しています");
    }

    if (applicantsList.includes(applicantName)) {
      throw apiError_("already_applied", "既に応募済みです");
    }

    applicantsList.push(applicantName);
    const newCount = applicantsList.length;

    if (countCol >= 0) {
      sheet.getRange(sheetRow, countCol + 1).setValue(newCount);
    }
    sheet.getRange(sheetRow, applicantsCol + 1).setValue(applicantsList.join("\n"));

    sendConfirmationEmail_(contactEmail, applicantName, title, deadline);

    return {
      ok: true,
      job_id: explicitJobId || jobId,
      applicantCount: newCount
    };

  } finally {
    lock.releaseLock();
  }
}

/* =========================================
   確認メール送信
========================================= */

function sendConfirmationEmail_(to, name, jobTitle, deadline) {
  let deadlineStr = "未定";
  const d = parseDate_(deadline);

  if (d) {
    deadlineStr = Utilities.formatDate(d, TZ, "yyyy年MM月dd日");
  } else if (deadline) {
    deadlineStr = String(deadline);
  }

  const subject = `【応募確認】${jobTitle}`;
  const body = [
    `${name} 様`,
    "",
    `「${jobTitle}」へのご応募を受け付けました。`,
    "",
    `締切：${deadlineStr}`,
    "",
    "ご不明な点はご連絡ください。"
  ].join("\n");

  GmailApp.sendEmail(to, subject, body);
}

/* =========================================
   締切後通知（時間トリガーで定期実行）
========================================= */

function notifyDeadlinePassed() {
  const sheet = getJobsSheet_();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return;
  }

  const headers = values[0].map(h => String(h).trim());
  const findColumn = (...candidates) => findColumn_(headers, ...candidates);

  const titleCol      = findColumn("案件名", "title");
  const deadlineCol   = findColumn("締切日", "deadline", "締切");
  const emailCol      = findColumn("client_email", "クライアントE-mail", "クライアントEmail", "クライアントメール");
  const applicantsCol = findColumn("applicants", "応募者", "応募者名");
  const notifiedCol   = findColumn("deadline_notified_at", "締切通知日時", "通知日時");

  if (titleCol < 0 || deadlineCol < 0 || emailCol < 0 || applicantsCol < 0 || notifiedCol < 0) {
    return;
  }

  const now = new Date();
  const users = readUsers_();
  const pageUrlByName = {};

  users.forEach(user => {
    if (user?.name) {
      pageUrlByName[user.name] = String(user.pageUrl || "").trim();
    }
  });

  values.slice(1).forEach((row, i) => {
    const deadline = row[deadlineCol];
    const notified = row[notifiedCol];
    const clientEmail = String(row[emailCol] || "").trim();
    const title = String(row[titleCol] || "");

    if (!deadline || notified || !clientEmail) {
      return;
    }

    const deadlineDate = parseDate_(deadline);
    if (!deadlineDate) {
      return;
    }

    const nextDay = new Date(deadlineDate);
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(0, 0, 0, 0);

    if (now < nextDay) {
      return;
    }

    const applicantsText = String(row[applicantsCol] || "").trim();
    const names = splitLines_(applicantsText);

    const applicantLines = names.map(name => {
      const url = pageUrlByName[name] || "（URLなし）";
      return `・${name}\n  ${url}`;
    });

    const deadlineStr = Utilities.formatDate(deadlineDate, TZ, "yyyy年MM月dd日");

    const subject = `【応募者一覧】${title}`;
    const body = [
      `「${title}」の締切（${deadlineStr}）が過ぎました。`,
      `応募者数：${names.length}名`,
      "",
      "■ 応募者一覧",
      applicantLines.length > 0 ? applicantLines.join("\n") : "（応募者なし）"
    ].join("\n");

    GmailApp.sendEmail(clientEmail, subject, body);
    sheet.getRange(i + 2, notifiedCol + 1).setValue(new Date().toISOString());
  });
}

// README互換のトリガー名
function sendDeadlineMorningEmails() {
  notifyDeadlinePassed();
}

/* =========================================
   Token
========================================= */

function signToken_(payload) {
  const json = JSON.stringify(payload);
  const blob = Utilities.newBlob(json, "application/json", "payload.json");
  const body = Utilities.base64EncodeWebSafe(blob.getBytes());
  const sig = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(body, getProperty_("APP_SECRET"))
  );
  return `${body}.${sig}`;
}

function verifyToken_(token) {
  if (!token) {
    throw apiError_("invalid_token", "token 不存在");
  }

  const parts = String(token).split(".");
  if (parts.length !== 2) {
    throw apiError_("invalid_token", "token 形式不正");
  }

  const body = parts[0];
  const signature = parts[1];

  const expected = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(body, getProperty_("APP_SECRET"))
  );

  if (signature !== expected) {
    throw apiError_("invalid_token", "署名不一致");
  }

  let payload;
  try {
    payload = JSON.parse(
      Utilities.newBlob(
        Utilities.base64DecodeWebSafe(body)
      ).getDataAsString("UTF-8")
    );
  } catch (err) {
    throw apiError_("invalid_token", "token 解析失敗");
  }

  if (!payload || typeof payload !== "object") {
    throw apiError_("invalid_token", "token 内容不正");
  }

  if (payload.exp <= Date.now()) {
    throw apiError_("token_expired", "期限切れ");
  }

  return payload;
}

/* =========================================
   Utilities
========================================= */

function getJobsSheet_() {
  const id = getProperty_("SPREADSHEET_ID");
  const ss = runWithRetry_(function() {
    return SpreadsheetApp.openById(id);
  }, DEFAULT_RETRY_COUNT, DEFAULT_RETRY_BASE_MS);
  const sheet = ss.getSheetByName(SHEET_NAMES.jobs);

  if (!sheet) {
    throw apiError_("config_error", `${SHEET_NAMES.jobs} シート不存在`);
  }
  return sheet;
}

function getProperty_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw apiError_("config_error", `${key} 未設定`);
  }
  return value;
}

function getOptionalProperty_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  return value == null ? "" : String(value).trim();
}

function getTalentUsersCacheKey_() {
  const id = getOptionalProperty_("TALENT_SPREADSHEET_ID") || getProperty_("SPREADSHEET_ID");
  const sheetName = getOptionalProperty_("TALENT_SHEET_NAME") || "auto";
  return `${TALENT_USERS_CACHE_KEY}:${id}:${sheetName}`;
}

function getTalentUsersCacheSeconds_() {
  const raw = getOptionalProperty_("TALENT_USERS_CACHE_SECONDS");
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TALENT_USERS_CACHE_SECONDS;
  }
  return Math.min(Math.floor(parsed), 21600);
}

function findSheetWithHeader_(ss, headerName) {
  const sheets = ss.getSheets();

  for (const sheet of sheets) {
    const lastCol = sheet.getLastColumn();
    if (lastCol <= 0) {
      continue;
    }

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
    if (headers.includes(headerName)) {
      return sheet;
    }
  }

  return null;
}

function findColumn_(headers, ...candidates) {
  for (const candidate of candidates) {
    const i = headers.indexOf(candidate);
    if (i >= 0) {
      return i;
    }
  }
  return -1;
}

function colValue_(row, colIndex, fallback = "") {
  return colIndex >= 0 ? row[colIndex] : fallback;
}

function colDisplay_(row, colIndex, fallback = "") {
  return colIndex >= 0 ? row[colIndex] : fallback;
}

function getJobIdFromRow_(row, displayRow, headers, sheetRowNumber) {
  const jobIdCol = findColumn_(headers, "job_id", "id");
  const raw = jobIdCol >= 0 ? (displayRow[jobIdCol] || row[jobIdCol]) : "";
  const explicitId = String(raw || "").trim();
  return explicitId || `job_${sheetRowNumber}`;
}

function findJobRowIndex_(values, headers, jobId) {
  const jobIdCol = findColumn_(headers, "job_id", "id");

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const explicitId = jobIdCol >= 0 ? String(row[jobIdCol] || "").trim() : "";
    const fallbackId = `job_${i + 1}`;

    if (jobId === explicitId || jobId === fallbackId) {
      return i;
    }
  }

  return -1;
}

function resolveApplicantEmail_(params, tokenPayload) {
  const paramEmail = String(params.contactEmail || "").trim();
  const tokenEmail = String(tokenPayload?.email || "").trim();

  if (tokenEmail && isValidEmail_(tokenEmail)) {
    return tokenEmail;
  }
  return paramEmail;
}

function isValidEmail_(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function splitLines_(text) {
  if (!text) {
    return [];
  }
  return String(text)
    .split(/[\r\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function parseDate_(value) {
  if (!value) {
    return null;
  }

  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
    return new Date(value.getTime());
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  if (/^\d+\s*日$/.test(text)) {
    return null;
  }

  const normalized = text.replace(/\./g, "/").replace(/-/g, "/");
  const parsed = new Date(normalized);

  if (isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function isDeadlinePassed_(deadlineValue) {
  const d = parseDate_(deadlineValue);
  if (!d) {
    return false;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);

  return d < today;
}

function calculateRemainingDaysLabel_(deadlineValue) {
  const raw = String(deadlineValue || "").trim();
  if (/^残り\s*\d+\s*日$/.test(raw)) {
    return raw.replace(/\s+/g, "");
  }
  if (/^\d+\s*日$/.test(raw)) {
    return `残り${raw.replace(/\s+/g, "")}`;
  }

  const d = parseDate_(deadlineValue);
  if (!d) {
    return "";
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);

  const diffMs = d.getTime() - today.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return "期限切れ";
  }
  return `残り${diffDays}日`;
}

function normalizeNumber_(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const text = String(value ?? "").trim();
  if (!text) {
    return 0;
  }

  const matched = text.match(/\d+/);
  if (!matched) {
    return 0;
  }

  const num = Number(matched[0]);
  return Number.isFinite(num) ? num : 0;
}

function normalizeName_(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeCallback_(callback) {
  if (!callback) {
    return "";
  }
  if (!/^[a-zA-Z0-9_$.]+$/.test(callback)) {
    throw apiError_("invalid_callback", "callback 不正");
  }
  return callback;
}

function respond_(callback, payload) {
  if (callback) {
    return ContentService
      .createTextOutput(`${callback}(${JSON.stringify(payload)})`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function apiError_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function hash_(text) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    text
  );
  return raw.map(b => ("0" + (b & 0xFF).toString(16)).slice(-2)).join("");
}

function runWithRetry_(fn, maxAttempts = DEFAULT_RETRY_COUNT, baseSleepMs = DEFAULT_RETRY_BASE_MS) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !shouldRetry_(err)) {
        throw err;
      }
      Utilities.sleep(baseSleepMs * attempt);
    }
  }

  throw lastError || apiError_("internal_error", "retry_failed");
}

function shouldRetry_(err) {
  if (!err) {
    return false;
  }

  if (err.code === "config_error" || err.code === "invalid_credentials") {
    return false;
  }

  const message = String(err.message || err || "");
  return /Exception|Service invoked too many times|Timed out|Internal error|Address unavailable|Service error|Spreadsheet/i.test(message);
}
