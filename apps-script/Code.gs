// @ts-nocheck

/* =========================================
   Constants
========================================= */

const SHEET_NAMES = {
  jobs: "案件",
  applicants: "応募者リスト"
};

const API_BUILD = "2026-04-11-3";
const GITHUB_API_BASE = "https://api.github.com";
const TZ = "Asia/Tokyo";
const TALENT_USERS_CACHE_KEY = "talent_users_v2";
const DEFAULT_TALENT_USERS_CACHE_SECONDS = 300;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_GITHUB_WORKFLOW_ID = "deploy-jobs.yml";
const GITHUB_RUN_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const GITHUB_RUN_POLL_INTERVAL_MS = 5000;
const JOB_ID_HEADER = "案件ID";
const JOB_ID_PREFIX = "job_";
const JOB_ID_SEQUENCE_WIDTH = 3;
const DEFAULT_JOB_PUBLIC_BASE_URL = "https://job-list.missconnect.jp/jobs";
const HEADER_ROW = 1;
const APPLICANT_LIST_HEADERS = [
  "job_id",
  "source_key",
  "案件名",
  "applicant_count",
  "applicants",
  "応募者メールアドレス",
  "キャンセルポリシー確認済み",
  "キャンセルポリシー確認日時",
  "応募日時",
  "deadline_notified_at",
  "updated_at"
];
const LEGACY_APPLICANT_LIST_HEADERS = [
  "job_id",
  "source_key",
  "案件名",
  "applicant_count",
  "applicants",
  "deadline_notified_at",
  "updated_at"
];

/* =========================================
   Spreadsheet Menu
========================================= */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("更新")
    .addItem("webページに反映", "runGitHubActionsFromMenu_")
    .addToUi();
}

function onEdit(e) {
  if (!e || !e.range) {
    return;
  }

  const sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_NAMES.jobs) {
    return;
  }

  if (e.range.getRow() <= HEADER_ROW) {
    return;
  }

  syncApplicantListRow_(sheet, e.range.getRow());
}

function onFormSubmit(e) {
  if (!e || !e.range) {
    return;
  }

  const sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_NAMES.jobs) {
    return;
  }

  const rowNumber = e.range.getRow();
  if (rowNumber <= HEADER_ROW) {
    return;
  }

  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    prepareJobRowForPublish_(sheet, rowNumber);
    SpreadsheetApp.flush();
    triggerGitHubWorkflowDispatch_(getDefaultGitHubRef_());
  } finally {
    lock.releaseLock();
  }
}

function runGitHubActionsFromMenu_() {
  const ui = SpreadsheetApp.getUi();

  try {
    const result = runWebPublish_();
    const lines = [
      `Webページ反映が完了しました。`,
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

function runWebPublish_() {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    prepareJobsForPublish_(getJobsSheet_());
    SpreadsheetApp.flush();
    return triggerGitHubWorkflowDispatch_(getDefaultGitHubRef_());
  } finally {
    lock.releaseLock();
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
    if (/failed to parse workflow/i.test(message)) {
      return [
        base,
        "workflow ファイルの構文エラーです。GitHub Actions の YAML を修正してください。"
      ].join("\n");
    }
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
  const columns = getJobColumns_(headers);
  const applicantStore = getApplicantListStore_();

  if (columns.title < 0) {
    throw apiError_("config_error", "案件名列が見つかりません");
  }

  const jobs = values.slice(1).map((row, i) => {
    const displayRow = displayValues[i + 1] || [];
    return buildJobFromRow_(row, displayRow, headers, i + 2, columns, applicantStore);
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
  const applicantStore = getApplicantListStore_();
  const rowIndex = findJobRowIndex_(values, headers, jobId, displayValues, applicantStore);

  if (rowIndex < 1) {
    throw apiError_("not_found", "案件が見つかりません");
  }

  const row = values[rowIndex];
  const displayRow = displayValues[rowIndex] || [];
  const columns = getJobColumns_(headers);
  const job = buildJobFromRow_(row, displayRow, headers, rowIndex + 1, columns, applicantStore);

  return { ok: true, job };
}

function buildJobFromRow_(row, displayRow, headers, sheetRowNumber, columns, applicantStore) {
  const resolvedColumns = columns || getJobColumns_(headers);
  const generatedId = getJobIdFromRow_(row, displayRow, headers, sheetRowNumber);
  const sourceKey = getJobSourceKeyFromRow_(row, displayRow, headers, sheetRowNumber, resolvedColumns);
  const applicantRecord = applicantStore
    ? getApplicantRecordForJob_(applicantStore, generatedId, sourceKey)
    : null;
  const resolvedJobId = applicantRecord?.jobId || generatedId;
  const deadlineText = colDisplay_(displayRow, resolvedColumns.deadline, "");
  const remainingText = colDisplay_(displayRow, resolvedColumns.remaining, "");
  const computedRemaining = calculateRemainingDaysLabel_(colValue_(row, resolvedColumns.deadline, ""));
  const remaining = computedRemaining || remainingText;
  const shootDates = getShootDatesFromRow_(row, displayRow, resolvedColumns);
  const shootDateText = shootDates.join(" / ");
  const rewardRaw = colValue_(row, resolvedColumns.reward, "");
  const rewardDisplay = formatRewardDisplay_(rewardRaw, colDisplay_(displayRow, resolvedColumns.reward, ""));
  const durationRaw = colValue_(row, resolvedColumns.duration, "");
  const durationMinutes = normalizeNumber_(durationRaw);
  const durationDisplay = formatDurationDisplay_(durationRaw, colDisplay_(displayRow, resolvedColumns.duration, ""));
  const hourlyWageValue = computeHourlyWage_(rewardRaw, durationRaw);
  const titleText = colDisplay_(displayRow, resolvedColumns.title, "");
  const mediaText = colDisplay_(displayRow, resolvedColumns.media, "");
  const maxApplicants = normalizeNumber_(colValue_(row, resolvedColumns.max, 0));
  const applicantCount = applicantRecord
    ? applicantRecord.applicantCount
    : (resolvedColumns.count >= 0 ? normalizeNumber_(colValue_(row, resolvedColumns.count, 0)) : 0);
  const applicantText = applicantRecord?.applicantsText || colDisplay_(displayRow, resolvedColumns.applicants, "");
  const notifiedAt = applicantRecord?.deadlineNotifiedAt || colDisplay_(displayRow, resolvedColumns.notified, "");

  return {
    id: resolvedJobId,
    job_id: resolvedJobId,
    title: titleText,
    name: titleText,
    product_name: colDisplay_(displayRow, resolvedColumns.productName, ""),
    product_url: colDisplay_(displayRow, resolvedColumns.productUrl, ""),
    reward: rewardDisplay,
    fee: rewardDisplay,
    reward_amount: normalizeNumber_(rewardRaw),
    duration: durationDisplay,
    duration_minutes: durationMinutes,
    hourly_wage: hourlyWageValue,
    date: shootDateText,
    candidate_shoot_dates: shootDateText,
    shoot_dates: shootDates,
    location: colDisplay_(displayRow, resolvedColumns.location, ""),
    requirements: colDisplay_(displayRow, resolvedColumns.requirements, ""),
    max_applicants: maxApplicants,
    recruitment_number: maxApplicants,
    description: colDisplay_(displayRow, resolvedColumns.description, ""),
    concept: colDisplay_(displayRow, resolvedColumns.concept, "") || colDisplay_(displayRow, resolvedColumns.makeupImage, ""),
    makeup: colDisplay_(displayRow, resolvedColumns.makeup, ""),
    makeup_image: colDisplay_(displayRow, resolvedColumns.makeupImage, ""),
    belongings: colDisplay_(displayRow, resolvedColumns.belongings, ""),
    media: mediaText,
    shooting_format: colDisplay_(displayRow, resolvedColumns.shootingFormat, ""),
    period: colDisplay_(displayRow, resolvedColumns.period, ""),
    usage_period: colDisplay_(displayRow, resolvedColumns.period, ""),
    competition: colDisplay_(displayRow, resolvedColumns.competition, ""),
    outfit_availability: colDisplay_(displayRow, resolvedColumns.outfitAvailability, ""),
    outfit: colDisplay_(displayRow, resolvedColumns.outfit, ""),
    emergency_contact: colDisplay_(displayRow, resolvedColumns.emergencyContact, ""),
    remaining: remaining,
    selection_method: colDisplay_(displayRow, resolvedColumns.selection, ""),
    deadline: deadlineText,
    client_email: colDisplay_(displayRow, resolvedColumns.email, ""),
    form_url: colDisplay_(displayRow, resolvedColumns.form, ""),
    category: colDisplay_(displayRow, resolvedColumns.category, "") || mediaText || colDisplay_(displayRow, resolvedColumns.shootingFormat, ""),
    applicant_count: applicantCount,
    deadline_notified_at: notifiedAt,
    applicants: applicantText
  };
}

/* =========================================
   job_id 採番
========================================= */

function syncApplicantListSheet_() {
  const jobsSheet = getJobsSheet_();
  const range = jobsSheet.getDataRange();
  const values = range.getValues();
  const displayValues = range.getDisplayValues();

  if (values.length < 2) {
    return;
  }

  const headers = values[0].map(h => String(h).trim());
  const columns = getJobColumns_(headers);
  const applicantStore = getApplicantListStore_();

  for (let i = 1; i < values.length; i++) {
    syncApplicantListRecord_(values[i], displayValues[i] || [], headers, i + 1, columns, applicantStore);
  }
}

function fillMissingJobIds() {
  syncApplicantListSheet_();
}

function prepareJobsForPublish_(sheet) {
  const jobIdCol = ensureJobIdColumn_(sheet);
  const lastRow = sheet.getLastRow();

  if (lastRow <= HEADER_ROW) {
    return;
  }

  for (let rowNumber = HEADER_ROW + 1; rowNumber <= lastRow; rowNumber += 1) {
    prepareJobRowForPublish_(sheet, rowNumber, jobIdCol);
  }
}

function prepareJobRowForPublish_(sheet, rowNumber, cachedJobIdCol) {
  if (rowNumber <= HEADER_ROW) {
    return "";
  }

  const jobIdCol = cachedJobIdCol || ensureJobIdColumn_(sheet);
  const lastCol = sheet.getLastColumn();
  if (lastCol <= 0) {
    return "";
  }

  const headers = sheet
    .getRange(HEADER_ROW, 1, 1, lastCol)
    .getDisplayValues()[0]
    .map(h => String(h).trim());
  const columns = getJobColumns_(headers);
  const row = sheet.getRange(rowNumber, 1, 1, lastCol).getValues()[0];
  const displayRow = sheet.getRange(rowNumber, 1, 1, lastCol).getDisplayValues()[0];
  const title = String(colDisplay_(displayRow, columns.title, "") || "").trim();

  if (!title) {
    return "";
  }

  const idCell = sheet.getRange(rowNumber, jobIdCol);
  let jobId = String(idCell.getDisplayValue()).trim();

  if (!jobId) {
    const legacyJobIdCol = findColumn_(headers, "job_id", "id");
    if (legacyJobIdCol >= 0 && legacyJobIdCol + 1 !== jobIdCol) {
      jobId = String(displayRow[legacyJobIdCol] || row[legacyJobIdCol] || "").trim();
    }
  }

  if (!jobId) {
    jobId = generateNextJobId_(sheet, jobIdCol, resolveJobBaseDate_(row, columns));
    idCell.setValue(jobId);
  }

  const pageUrl = buildJobPageUrl_(jobId);
  const folder = ensureJobImageFolder_(jobId);
  const noteLines = [`Webページ: ${pageUrl}`];

  if (folder) {
    noteLines.push(`画像フォルダ: ${folder.getUrl()}`);
  }

  const richText = SpreadsheetApp.newRichTextValue()
    .setText(jobId)
    .setLinkUrl(pageUrl)
    .build();

  idCell.setRichTextValue(richText);
  idCell.setNote(noteLines.join("\n"));
  return jobId;
}

function syncApplicantListRow_(sheet, rowNumber) {
  if (rowNumber <= HEADER_ROW) {
    return;
  }

  const lastCol = sheet.getLastColumn();
  if (lastCol <= 0) {
    return;
  }

  const headers = sheet
    .getRange(HEADER_ROW, 1, 1, lastCol)
    .getValues()[0]
    .map(h => String(h).trim());
  const columns = getJobColumns_(headers);
  const row = sheet.getRange(rowNumber, 1, 1, lastCol).getValues()[0];
  const displayRow = sheet.getRange(rowNumber, 1, 1, lastCol).getDisplayValues()[0];
  const applicantStore = getApplicantListStore_();

  syncApplicantListRecord_(row, displayRow, headers, rowNumber, columns, applicantStore);
}

function syncApplicantListRecord_(row, displayRow, headers, sheetRowNumber, columns, applicantStore) {
  const resolvedColumns = columns || getJobColumns_(headers);
  const title = colDisplay_(displayRow, resolvedColumns.title, "");
  if (!String(title || "").trim()) {
    return null;
  }

  const generatedId = getJobIdFromRow_(row, displayRow, headers, sheetRowNumber);
  const sourceKey = getJobSourceKeyFromRow_(row, displayRow, headers, sheetRowNumber, resolvedColumns);
  const record = applicantStore
    ? getApplicantRecordForJob_(applicantStore, generatedId, sourceKey)
    : null;

  return upsertApplicantRecord_(applicantStore || getApplicantListStore_(), {
    jobId: record?.jobId || generatedId,
    sourceKey,
    title
  });
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
  const applicationTimestamp = new Date().toISOString();

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const sheet = getJobsSheet_();
    const range = sheet.getDataRange();
    const values = range.getValues();
    const displayValues = range.getDisplayValues();
    if (values.length < 2) {
      throw apiError_("not_found", "案件が見つかりません");
    }

    const headers = values[0].map(h => String(h).trim());
    const columns = getJobColumns_(headers);
    const applicantStore = getApplicantListStore_();

    if (columns.title < 0) {
      throw apiError_("config_error", "案件名列が見つかりません");
    }

    const rowIndex = findJobRowIndex_(values, headers, jobId, displayValues, applicantStore);
    if (rowIndex < 1) {
      throw apiError_("not_found", "案件が見つかりません");
    }

    const row = values[rowIndex];
    const displayRow = displayValues[rowIndex] || [];
    const sheetRowNumber = rowIndex + 1;

    const deadline = columns.deadline >= 0 ? row[columns.deadline] : "";
    const max = normalizeNumber_(columns.max >= 0 ? row[columns.max] : 0);
    const title = String(displayRow[columns.title] || row[columns.title] || "");
    const generatedId = getJobIdFromRow_(row, displayRow, headers, sheetRowNumber);
    const sourceKey = getJobSourceKeyFromRow_(row, displayRow, headers, sheetRowNumber, columns);
    const applicantRecord = getApplicantRecordForJob_(applicantStore, generatedId, sourceKey);
    const canonicalJobId = applicantRecord?.jobId || generatedId;

    const existingApplicantsText = applicantRecord?.applicantsText || "";
    const applicantsList = splitLines_(existingApplicantsText);
    const applicantEmailsList = splitLines_(applicantRecord?.applicantEmailsText || "");
    const cancelPolicyConsentsList = splitLines_(applicantRecord?.cancelPolicyConsentsText || "");
    const cancelPolicyCheckedAtList = splitLines_(applicantRecord?.cancelPolicyCheckedAtText || "");
    const appliedAtList = splitLines_(applicantRecord?.appliedAtText || "");
    const currentCount = applicantRecord ? applicantRecord.applicantCount : applicantsList.length;

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
    applicantEmailsList.push(contactEmail);
    cancelPolicyConsentsList.push(acceptedCancelPolicy ? "TRUE" : "FALSE");
    cancelPolicyCheckedAtList.push(acceptedCancelPolicy ? applicationTimestamp : "");
    appliedAtList.push(applicationTimestamp);
    const newCount = applicantsList.length;

    upsertApplicantRecord_(applicantStore, {
      jobId: canonicalJobId,
      sourceKey,
      title,
      applicantCount: newCount,
      applicantsText: applicantsList.join("\n"),
      applicantEmailsText: applicantEmailsList.join("\n"),
      cancelPolicyConsentsText: cancelPolicyConsentsList.join("\n"),
      cancelPolicyCheckedAtText: cancelPolicyCheckedAtList.join("\n"),
      appliedAtText: appliedAtList.join("\n"),
      deadlineNotifiedAt: applicantRecord?.deadlineNotifiedAt || ""
    });

    sendConfirmationEmail_(contactEmail, applicantName, title, deadline);

    return {
      ok: true,
      job_id: canonicalJobId,
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

  MailApp.sendEmail(to, subject, body);
}

/* =========================================
   締切後通知（時間トリガーで定期実行）
========================================= */

function notifyDeadlinePassed() {
  const sheet = getJobsSheet_();
  const range = sheet.getDataRange();
  const values = range.getValues();
  const displayValues = range.getDisplayValues();
  if (values.length < 2) {
    return;
  }

  const headers = values[0].map(h => String(h).trim());
  const columns = getJobColumns_(headers);
  const applicantStore = getApplicantListStore_();

  if (columns.title < 0 || columns.deadline < 0 || columns.email < 0) {
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
    const displayRow = displayValues[i + 1] || [];
    const sheetRowNumber = i + 2;
    const generatedId = getJobIdFromRow_(row, displayRow, headers, sheetRowNumber);
    const sourceKey = getJobSourceKeyFromRow_(row, displayRow, headers, sheetRowNumber, columns);
    const applicantRecord = getApplicantRecordForJob_(applicantStore, generatedId, sourceKey);
    const canonicalJobId = applicantRecord?.jobId || generatedId;
    const deadline = row[columns.deadline];
    const notified = applicantRecord?.deadlineNotifiedAt || "";
    const clientEmail = String(row[columns.email] || "").trim();
    const title = String(displayRow[columns.title] || row[columns.title] || "");

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

    const applicantsText = applicantRecord?.applicantsText || "";
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

    MailApp.sendEmail(clientEmail, subject, body);
    upsertApplicantRecord_(applicantStore, {
      jobId: canonicalJobId,
      sourceKey,
      title,
      applicantCount: names.length,
      applicantsText,
      deadlineNotifiedAt: new Date().toISOString()
    });
  });
}

// README互換のトリガー名
function sendDeadlineMorningEmails() {
  notifyDeadlinePassed();
}

function getApplicantListStore_() {
  const sheet = getApplicantListSheet_();
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(h => String(h).trim());
  const columns = getApplicantListColumns_(headers);
  const records = values.slice(1).map((row, i) => ({
    rowNumber: i + 2,
    jobId: String(colValue_(row, columns.jobId, "") || "").trim(),
    sourceKey: String(colValue_(row, columns.sourceKey, "") || "").trim(),
    title: String(colValue_(row, columns.title, "") || "").trim(),
    applicantCount: normalizeNumber_(colValue_(row, columns.count, 0)),
    applicantsText: String(colValue_(row, columns.applicants, "") || "").trim(),
    applicantEmailsText: String(colValue_(row, columns.applicantEmails, "") || "").trim(),
    cancelPolicyConsentsText: String(colValue_(row, columns.cancelPolicyConsents, "") || "").trim(),
    cancelPolicyCheckedAtText: String(colValue_(row, columns.cancelPolicyCheckedAt, "") || "").trim(),
    appliedAtText: String(colValue_(row, columns.appliedAt, "") || "").trim(),
    deadlineNotifiedAt: String(colValue_(row, columns.notified, "") || "").trim()
  }));
  const byJobId = {};
  const bySourceKey = {};

  records.forEach(record => {
    if (record.jobId) {
      byJobId[record.jobId] = record;
    }
    if (record.sourceKey) {
      bySourceKey[record.sourceKey] = record;
    }
  });

  return { sheet, headers, columns, records, byJobId, bySourceKey };
}

function getApplicantListColumns_(headers) {
  const find = (...candidates) => findColumn_(headers, ...candidates);

  return {
    jobId: find(JOB_ID_HEADER, "job_id", "id"),
    sourceKey: find("source_key"),
    title: find("案件名", "title"),
    count: find("applicant_count"),
    applicants: find("applicants", "応募者", "応募者名"),
    applicantEmails: find("応募者メールアドレス", "applicant_emails"),
    cancelPolicyConsents: find("キャンセルポリシー確認済み", "cancel_policy_consents"),
    cancelPolicyCheckedAt: find("キャンセルポリシー確認日時", "cancel_policy_checked_at"),
    appliedAt: find("応募日時", "applied_at"),
    notified: find("deadline_notified_at", "締切通知日時", "通知日時"),
    updatedAt: find("updated_at")
  };
}

function getApplicantRecordForJob_(store, jobId, sourceKey) {
  if (!store) {
    return null;
  }

  return store.byJobId[jobId] || store.bySourceKey[sourceKey] || null;
}

function upsertApplicantRecord_(store, recordInput) {
  const record = getApplicantRecordForJob_(store, recordInput.jobId, recordInput.sourceKey);
  const sheet = store.sheet;
  const nowIso = new Date().toISOString();
  const resolvedApplicantsText = String(recordInput.applicantsText ?? record?.applicantsText ?? "").trim();
  const resolvedApplicantEmailsText = String(recordInput.applicantEmailsText ?? record?.applicantEmailsText ?? "").trim();
  const resolvedCancelPolicyConsentsText = String(recordInput.cancelPolicyConsentsText ?? record?.cancelPolicyConsentsText ?? "").trim();
  const resolvedCancelPolicyCheckedAtText = String(recordInput.cancelPolicyCheckedAtText ?? record?.cancelPolicyCheckedAtText ?? "").trim();
  const resolvedAppliedAtText = String(recordInput.appliedAtText ?? record?.appliedAtText ?? "").trim();
  const resolvedApplicantCount = recordInput.applicantCount != null
    ? normalizeNumber_(recordInput.applicantCount)
    : (resolvedApplicantsText ? splitLines_(resolvedApplicantsText).length : 0);
  const values = [
    String(record?.jobId || recordInput.jobId || "").trim(),
    String(recordInput.sourceKey || record?.sourceKey || "").trim(),
    String(recordInput.title || record?.title || "").trim(),
    resolvedApplicantCount,
    resolvedApplicantsText,
    resolvedApplicantEmailsText,
    resolvedCancelPolicyConsentsText,
    resolvedCancelPolicyCheckedAtText,
    resolvedAppliedAtText,
    String(recordInput.deadlineNotifiedAt ?? record?.deadlineNotifiedAt ?? "").trim(),
    nowIso
  ];

  if (record) {
    sheet.getRange(record.rowNumber, 1, 1, values.length).setValues([values]);
    record.jobId = values[0];
    record.sourceKey = values[1];
    record.title = values[2];
    record.applicantCount = resolvedApplicantCount;
    record.applicantsText = values[4];
    record.applicantEmailsText = values[5];
    record.cancelPolicyConsentsText = values[6];
    record.cancelPolicyCheckedAtText = values[7];
    record.appliedAtText = values[8];
    record.deadlineNotifiedAt = values[9];
    store.byJobId[record.jobId] = record;
    store.bySourceKey[record.sourceKey] = record;
    return record;
  }

  sheet.appendRow(values);
  const newRecord = {
    rowNumber: sheet.getLastRow(),
    jobId: values[0],
    sourceKey: values[1],
    title: values[2],
    applicantCount: resolvedApplicantCount,
    applicantsText: values[4],
    applicantEmailsText: values[5],
    cancelPolicyConsentsText: values[6],
    cancelPolicyCheckedAtText: values[7],
    appliedAtText: values[8],
    deadlineNotifiedAt: values[9]
  };
  store.records.push(newRecord);
  if (newRecord.jobId) {
    store.byJobId[newRecord.jobId] = newRecord;
  }
  if (newRecord.sourceKey) {
    store.bySourceKey[newRecord.sourceKey] = newRecord;
  }
  return newRecord;
}

function getJobColumns_(headers) {
  const find = (...candidates) => findColumn_(headers, ...candidates);

  return {
    jobId: find("job_id", "id"),
    timestamp: find("タイムスタンプ", "timestamp"),
    title: find("案件名（サイト上の見出し）", "案件名", "商品名", "title", "案件タイトル"),
    productName: find("商品名（サービス名、ブランド名等）", "商品名", "product_name", "product"),
    productUrl: find("商品URL（サービスの場合はHP等）", "商品URL", "product_url", "url"),
    description: find("案件説明", "description", "shoot_description", "shooting_content"),
    media: find("媒体", "media", "media_usage"),
    reward: find("報酬・交通費込（数値のみ）", "報酬（交通費込）", "報酬", "fee"),
    duration: find("拘束時間（分単位）※数字のみ", "拘束時間", "duration", "duration_hours"),
    hourlyWage: find("時給", "hourly_wage", "wage"),
    date: find("実施日時", "date", "candidate_shoot_dates"),
    shootDate1: find("撮影候補日①", "撮影候補日1"),
    shootDate2: find("撮影候補日②", "撮影候補日2"),
    shootDate3: find("撮影候補日③", "撮影候補日3"),
    shootDate4: find("撮影候補日④", "撮影候補日4"),
    shootDate5: find("撮影候補日⑤", "撮影候補日5"),
    location: find("実施場所", "location", "shoot_location"),
    requirements: find("応募条件", "requirements"),
    max: find("募集人数", "max_applicants", "recruitment_number"),
    concept: find("コンセプト", "concept"),
    shootingFormat: find("撮影形式", "shooting_format", "format"),
    makeup: find("メイク・ヘアメイク", "メイク・ヘアメイクの有無", "メイク・ヘアメイクスタッフの有無", "makeup"),
    makeupImage: find("メイク・ヘアメイクのイメージ", "メイクイメージ", "makeup_image"),
    outfitAvailability: find("衣装の有無", "衣装有無", "outfit_availability"),
    outfit: find("衣装", "wardrobe", "outfit"),
    belongings: find("その他持ち物", "持ち物", "belongings", "items_to_bring"),
    period: find("使用期間", "試用期間", "period", "usage_period"),
    competition: find("競合", "competition", "competition_presence"),
    remaining: find("残り日数"),
    selection: find("選考方法", "selection_method"),
    deadline: find("締切日", "deadline", "締切"),
    emergencyContact: find("撮影当日の緊急連絡先", "緊急連絡先", "emergency_contact"),
    email: find("client_email", "クライアントE-mail", "クライアントEmail", "クライアントメール"),
    form: find("form_url"),
    category: find("category"),
    count: find("applicant_count"),
    notified: find("deadline_notified_at", "締切通知日時", "通知日時"),
    applicants: find("applicants", "応募者", "応募者名")
  };
}

function getShootDatesFromRow_(row, displayRow, columns) {
  const candidateCols = [
    columns.shootDate1,
    columns.shootDate2,
    columns.shootDate3,
    columns.shootDate4,
    columns.shootDate5
  ].filter(col => col >= 0);

  const dates = candidateCols
    .map(col => colDisplay_(displayRow, col, ""))
    .map(value => String(value || "").trim())
    .filter(Boolean);

  if (dates.length > 0) {
    return dates;
  }

  const fallback = colDisplay_(displayRow, columns.date, "");
  return fallback ? [String(fallback).trim()] : [];
}

function formatRewardDisplay_(rawValue, displayValue) {
  const display = String(displayValue || "").trim();
  if (display && /円/.test(display)) {
    return display;
  }

  const amount = normalizeNumber_(rawValue);
  if (!amount) {
    return display;
  }

  return `${amount.toLocaleString("ja-JP")}円（交通費込）`;
}

function formatDurationDisplay_(rawValue, displayValue) {
  const display = String(displayValue || "").trim();
  if (display && /分|時間/.test(display)) {
    return display;
  }

  const minutes = normalizeNumber_(rawValue);
  if (!minutes) {
    return display;
  }
  if (minutes < 60) {
    return `${minutes}分`;
  }

  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours}時間${remainMinutes}分` : `${hours}時間`;
}

function computeHourlyWage_(rewardValue, durationValue) {
  const reward = normalizeNumber_(rewardValue);
  const durationMinutes = normalizeNumber_(durationValue);

  if (!reward || !durationMinutes) {
    return 0;
  }

  return Math.round((reward * 60) / durationMinutes);
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

function getSpreadsheet_() {
  const id = getProperty_("SPREADSHEET_ID");
  return runWithRetry_(function() {
    return SpreadsheetApp.openById(id);
  }, DEFAULT_RETRY_COUNT, DEFAULT_RETRY_BASE_MS);
}

function getJobsSheet_() {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(SHEET_NAMES.jobs);

  if (!sheet) {
    throw apiError_("config_error", `${SHEET_NAMES.jobs} シート不存在`);
  }
  return sheet;
}

function getApplicantListSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(SHEET_NAMES.applicants);

  if (!sheet) {
    const jobsSheet = ss.getSheetByName(SHEET_NAMES.jobs);
    const insertIndex = jobsSheet ? jobsSheet.getIndex() + 1 : ss.getNumSheets() + 1;
    sheet = ss.insertSheet(SHEET_NAMES.applicants, insertIndex);
  }

  ensureApplicantListHeaderRow_(sheet);
  return sheet;
}

function ensureApplicantListHeaderRow_(sheet) {
  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();

  if (lastCol === 0 || lastRow === 0) {
    sheet.getRange(HEADER_ROW, 1, 1, APPLICANT_LIST_HEADERS.length).setValues([APPLICANT_LIST_HEADERS]);
    return;
  }

  const headers = sheet
    .getRange(HEADER_ROW, 1, 1, Math.max(lastCol, APPLICANT_LIST_HEADERS.length))
    .getValues()[0]
    .map(h => String(h).trim());
  if (isExactHeaderSequence_(headers, APPLICANT_LIST_HEADERS)) {
    return;
  }

  if (isExactHeaderSequence_(headers, LEGACY_APPLICANT_LIST_HEADERS)) {
    migrateLegacyApplicantListSheet_(sheet);
    return;
  }

  sheet.getRange(HEADER_ROW, 1, 1, APPLICANT_LIST_HEADERS.length).setValues([APPLICANT_LIST_HEADERS]);
}

function isExactHeaderSequence_(headers, expected) {
  return expected.every((header, index) => String(headers[index] || "").trim() === header);
}

function migrateLegacyApplicantListSheet_(sheet) {
  const values = sheet.getDataRange().getValues();
  const legacyRows = values.slice(1);
  const migratedRows = legacyRows.map(row => ([
    String(row[0] || "").trim(),
    String(row[1] || "").trim(),
    String(row[2] || "").trim(),
    normalizeNumber_(row[3]),
    String(row[4] || "").trim(),
    "",
    "",
    "",
    "",
    String(row[5] || "").trim(),
    String(row[6] || "").trim()
  ]));

  sheet.getRange(HEADER_ROW, 1, 1, APPLICANT_LIST_HEADERS.length).setValues([APPLICANT_LIST_HEADERS]);
  if (migratedRows.length > 0) {
    sheet.getRange(HEADER_ROW + 1, 1, migratedRows.length, APPLICANT_LIST_HEADERS.length).setValues(migratedRows);
  }
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

function ensureJobIdColumn_(sheet) {
  const headers = sheet
    .getRange(HEADER_ROW, 1, 1, Math.max(sheet.getLastColumn(), 1))
    .getDisplayValues()[0];

  for (let i = 0; i < headers.length; i += 1) {
    if (String(headers[i] || "").trim() === JOB_ID_HEADER) {
      return i + 1;
    }
  }

  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const nextCol = lastCol + 1;
  sheet.insertColumnAfter(lastCol);
  sheet.getRange(HEADER_ROW, nextCol).setValue(JOB_ID_HEADER);
  return nextCol;
}

function resolveJobBaseDate_(row, columns) {
  const timestampValue = columns.timestamp >= 0 ? row[columns.timestamp] : "";
  return parseDate_(timestampValue) || new Date();
}

function generateNextJobId_(sheet, jobIdCol, baseDate) {
  const datePart = Utilities.formatDate(baseDate, TZ, "yyyyMMdd");
  const prefix = `${JOB_ID_PREFIX}${datePart}_`;
  const lastRow = sheet.getLastRow();
  const existingValues = lastRow > HEADER_ROW
    ? sheet.getRange(HEADER_ROW + 1, jobIdCol, lastRow - HEADER_ROW, 1).getDisplayValues().flat()
    : [];
  let maxSequence = 0;

  existingValues.forEach((value) => {
    const text = String(value || "").trim();
    if (!text.startsWith(prefix)) {
      return;
    }
    const sequence = Number(text.slice(prefix.length));
    if (Number.isFinite(sequence)) {
      maxSequence = Math.max(maxSequence, sequence);
    }
  });

  const nextSequence = String(maxSequence + 1).padStart(JOB_ID_SEQUENCE_WIDTH, "0");
  return `${prefix}${nextSequence}`;
}

function buildJobPageUrl_(jobId) {
  const baseUrl = getOptionalProperty_("JOB_PUBLIC_BASE_URL") || DEFAULT_JOB_PUBLIC_BASE_URL;
  return `${String(baseUrl).replace(/\/+$/, "")}/${encodeURIComponent(jobId)}/`;
}

function ensureJobImageFolder_(jobId) {
  const parentFolderId = getOptionalProperty_("JOB_IMAGE_FOLDER_PARENT_ID");
  if (!parentFolderId) {
    return null;
  }

  const parentFolder = DriveApp.getFolderById(parentFolderId);
  const existing = parentFolder.getFoldersByName(jobId);
  if (existing.hasNext()) {
    return existing.next();
  }
  return parentFolder.createFolder(jobId);
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
  const normalizedHeaders = headers.map(normalizeHeaderLabel_);

  for (const candidate of candidates) {
    const i = headers.indexOf(candidate);
    if (i >= 0) {
      return i;
    }

    const normalizedCandidate = normalizeHeaderLabel_(candidate);
    const normalizedExactIndex = normalizedHeaders.findIndex(header => header === normalizedCandidate);

    if (normalizedExactIndex >= 0) {
      return normalizedExactIndex;
    }

    const normalizedPrefixIndex = normalizedHeaders.findIndex(header =>
      header.indexOf(normalizedCandidate) === 0
    );

    if (normalizedPrefixIndex >= 0) {
      return normalizedPrefixIndex;
    }
  }
  return -1;
}

function normalizeHeaderLabel_(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function colValue_(row, colIndex, fallback = "") {
  return colIndex >= 0 ? row[colIndex] : fallback;
}

function colDisplay_(row, colIndex, fallback = "") {
  return colIndex >= 0 ? row[colIndex] : fallback;
}

function getJobSourceKeyFromRow_(row, displayRow, headers, sheetRowNumber, columns) {
  const resolvedColumns = columns || getJobColumns_(headers);
  const timestampValue = resolvedColumns.timestamp >= 0
    ? (colValue_(row, resolvedColumns.timestamp, "") || colDisplay_(displayRow, resolvedColumns.timestamp, ""))
    : "";
  const timestampText = normalizeSourceValue_(timestampValue);

  if (timestampText) {
    return `timestamp:${hash_(timestampText)}`;
  }

  const fallbackSeed = [
    colDisplay_(displayRow, resolvedColumns.title, "") || colValue_(row, resolvedColumns.title, ""),
    colDisplay_(displayRow, resolvedColumns.productName, "") || colValue_(row, resolvedColumns.productName, ""),
    String(sheetRowNumber || "")
  ]
    .map(value => normalizeSourceValue_(value))
    .filter(Boolean)
    .join("|");

  return `row:${hash_(fallbackSeed || String(sheetRowNumber || ""))}`;
}

function getJobIdFromRow_(row, displayRow, headers, sheetRowNumber) {
  const jobIdCol = findColumn_(headers, JOB_ID_HEADER, "job_id", "id");
  const raw = jobIdCol >= 0 ? (displayRow[jobIdCol] || row[jobIdCol]) : "";
  const explicitId = String(raw || "").trim();
  if (explicitId) {
    return explicitId;
  }

  const columns = getJobColumns_(headers);
  const identitySource = [
    colDisplay_(displayRow, columns.timestamp, "") || colValue_(row, columns.timestamp, ""),
    colDisplay_(displayRow, columns.title, "") || colValue_(row, columns.title, ""),
    colDisplay_(displayRow, columns.productName, "") || colValue_(row, columns.productName, "")
  ]
    .map(value => String(value || "").trim())
    .filter(Boolean)
    .join("|");

  return identitySource ? `${JOB_ID_PREFIX}${hash_(identitySource).slice(0, 12)}` : `job_${sheetRowNumber}`;
}

function findJobRowIndex_(values, headers, jobId, displayValues, applicantStore) {
  const jobIdCol = findColumn_(headers, JOB_ID_HEADER, "job_id", "id");

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const displayRow = Array.isArray(displayValues?.[i]) ? displayValues[i] : row;
    const explicitId = jobIdCol >= 0 ? String(row[jobIdCol] || "").trim() : "";
    const fallbackId = getJobIdFromRow_(row, displayRow, headers, i + 1);
    const sourceKey = getJobSourceKeyFromRow_(row, displayRow, headers, i + 1);
    const applicantRecord = applicantStore
      ? getApplicantRecordForJob_(applicantStore, fallbackId, sourceKey)
      : null;
    const storedJobId = applicantRecord?.jobId || "";

    if (jobId === explicitId || jobId === fallbackId || (storedJobId && jobId === storedJobId)) {
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

  const normalized = text.replace(/,/g, "");
  const matched = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!matched) {
    return 0;
  }

  const num = Number(matched[0]);
  return Number.isFinite(num) ? num : 0;
}

function normalizeSourceValue_(value) {
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, TZ, "yyyy-MM-dd'T'HH:mm:ss.SSS");
  }

  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
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
