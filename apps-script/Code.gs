// @ts-nocheck

/* =========================================
   Constants
========================================= */

const SHEET_NAMES = {
  jobs: "案件",
  applicants: "応募者リスト",
  modelDecisionResponses: "モデル決定回答"
};

const API_BUILD = "2026-04-16-1";
const GITHUB_API_BASE = "https://api.github.com";
const TZ = "Asia/Tokyo";
const TALENT_USERS_CACHE_KEY = "talent_users_v2";
const DEFAULT_TALENT_USERS_CACHE_SECONDS = 300;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_GITHUB_WORKFLOW_ID = "deploy-jobs.yml";
const GITHUB_RUN_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const GITHUB_RUN_POLL_INTERVAL_MS = 5000;
const DEFAULT_DEADLINE_NOTIFICATION_HOUR = 9;
const DEFAULT_TALENT_SPREADSHEET_ID = "1wiLixuePcfzZpzzVcZ7ulUsVNkvLunzucoqK6DH4M9M";
const CLIENT_NOTIFICATION_CC = "kaito.suzuki@missconnect.jp";
const MAIL_SENDER_NAME = "MissConnect";
const MAIL_SENDER_EMAIL = "info@missconnect.jp";
const STORED_TIMESTAMP_FORMAT = "yyyy-MM-dd'T'HH:mm";
const JOB_ID_HEADER = "案件ID";
const JOB_ID_PREFIX = "job-";
const JOB_ID_FALLBACK_PREFIX = "job_tmp_";
const JOB_ID_SEQUENCE_WIDTH = 4;
const DEFAULT_JOB_PUBLIC_BASE_URL = "https://job-list.missconnect.jp/jobs";
const HEADER_ROW = 1;
const MODEL_DECISION_CONTACT_NAME_TITLE = "ご担当者名";
const MODEL_DECISION_CONTACT_EMAIL_TITLE = "ご担当者メールアドレス";
const MODEL_DECISION_PRIMARY_TITLE = "起用するモデル名";
const MODEL_DECISION_SECONDARY_TITLE = "起用するモデル名（2人目・任意）";
const MODEL_DECISION_TERTIARY_TITLE = "起用するモデル名（3人目・任意）";
const MODEL_DECISION_MESSAGE_TITLE = "モデルへの連絡事項";
const JOB_STATUS_HEADER = "案件状況";
const JOB_STATUS_WAITING_CLIENT = "クライアント連絡待ち";
const JOB_STATUS_MODEL_DECIDED = "モデル決定済";
const JOB_DISPLAY_STATUS_HEADER = "表示状態";
const DEADLINE_NOTIFICATION_STATUS_HEADER = "締切通知状況";
const JOB_DISPLAY_STATUS_VISIBLE = "表示";
const JOB_DISPLAY_STATUS_HIDDEN = "非表示";
const JOB_DISPLAY_STATUS_PAUSED = "一時停止";
const JOB_DISPLAY_STATUS_ENDED = "募集終了";
const MODEL_DECISION_RESPONSE_HEADERS = [
  "回答日時",
  "案件ID",
  "source_key",
  "案件名",
  "モデル決定フォームURL",
  MODEL_DECISION_CONTACT_NAME_TITLE,
  MODEL_DECISION_CONTACT_EMAIL_TITLE,
  MODEL_DECISION_PRIMARY_TITLE,
  MODEL_DECISION_SECONDARY_TITLE,
  MODEL_DECISION_TERTIARY_TITLE,
  MODEL_DECISION_MESSAGE_TITLE
];
const APPLICANT_LIST_HEADERS = [
  "job_id",
  "source_key",
  "案件名",
  "応募者数",
  "応募者名",
  "応募者メールアドレス",
  "キャンセルポリシー確認済み",
  "キャンセルポリシー確認日時",
  "応募日時",
  "締切日",
  "応募者更新日時",
  "応募可能日程"
];
const PREVIOUS_APPLICANT_LIST_HEADERS = [
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
  "updated_at",
  "応募可能日程"
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
  } finally {
    lock.releaseLock();
  }

  triggerGitHubWorkflowDispatch_(getDefaultGitHubRef_());
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
  } finally {
    lock.releaseLock();
  }

  return triggerGitHubWorkflowDispatch_(getDefaultGitHubRef_());
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
  const spreadsheetId = getProperty_("SPREADSHEET_ID");
  const inputsJson = String(props.getProperty("GITHUB_WORKFLOW_INPUTS_JSON") || "").trim();
  const dispatchedAt = new Date();
  const existingRunIds = listWorkflowRuns_(owner, repo, workflowId, ref, token)
    .map((run) => Number(run?.id))
    .filter((id) => Number.isFinite(id));

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

  if (spreadsheetId && !inputs.sheet_id) {
    inputs.sheet_id = spreadsheetId;
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

  const run = waitForWorkflowRunCompletion_(
    owner,
    repo,
    workflowId,
    ref,
    token,
    dispatchedAt,
    existingRunIds
  );
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

function waitForWorkflowRunCompletion_(owner, repo, workflowId, ref, token, dispatchedAt, existingRunIds) {
  const deadline = Date.now() + GITHUB_RUN_POLL_TIMEOUT_MS;
  let run = null;

  while (Date.now() < deadline) {
    run = findDispatchedWorkflowRun_(
      owner,
      repo,
      workflowId,
      ref,
      token,
      dispatchedAt,
      existingRunIds
    );

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

function findDispatchedWorkflowRun_(owner, repo, workflowId, ref, token, dispatchedAt, existingRunIds) {
  const existingIdMap = buildIdMap_(existingRunIds || []);
  const runs = listWorkflowRuns_(owner, repo, workflowId, ref, token);
  const dispatchedTime = dispatchedAt.getTime() - 30000;

  for (const candidate of runs) {
    const runId = Number(candidate?.id);
    const createdAt = Date.parse(String(candidate?.created_at || ""));
    if (!Number.isFinite(runId) || !Number.isFinite(createdAt)) {
      continue;
    }
    if (existingIdMap[runId]) {
      continue;
    }
    if (createdAt >= dispatchedTime) {
      return candidate;
    }
  }

  return null;
}

function listWorkflowRuns_(owner, repo, workflowId, ref, token) {
  const encodedRef = encodeURIComponent(ref);
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowId)}/runs?event=workflow_dispatch&branch=${encodedRef}&per_page=20`;

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

  return Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
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
    const params = getRequestParams_(e);
    callback = sanitizeCallback_(params.callback);
    const action = String(params.action || "").trim();

    if (!action) {
      throw apiError_("invalid_action", "action 必須");
    }

    let payload;

    if (action === "health") {
      payload = { ok: true, build: API_BUILD };
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

function getRequestParams_(e) {
  const queryParams = e?.parameter || {};
  const postData = e?.postData;
  const body = String(postData?.contents || "").trim();

  if (!body) {
    return queryParams;
  }

  const contentType = String(postData?.type || "").toLowerCase();
  if (contentType.indexOf("application/json") >= 0) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.assign({}, queryParams, parsed);
      }
    } catch (err) {
      throw apiError_("invalid_json", `JSON 解析失敗: ${err.message}`);
    }
  }

  return queryParams;
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
    return readTalentUsersFromSheet_();
  }, DEFAULT_RETRY_COUNT, DEFAULT_RETRY_BASE_MS);

  try {
    cache.put(cacheKey, JSON.stringify(users), getTalentUsersCacheSeconds_());
  } catch (err) {
    // キャッシュ保存失敗でも処理は継続
  }

  return users;
}

function readTalentUsersFromSheet_() {
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
}

function hasTalentUserByName_(name) {
  const normalizedName = normalizeName_(name).toLowerCase();
  if (!normalizedName) {
    return false;
  }

  return readUsers_().some((user) => {
    const userName = String(user?.normalizedName || user?.name || "").trim().toLowerCase();
    return userName === normalizedName;
  });
}

function getTalentSheet_() {
  const id = getTalentSpreadsheetId_();
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
  const sheet = getJobsSheet_();
  prepareJobsForPublish_(sheet);
  syncApplicantListSheet_();
}

function prepareJobsForPublish_(sheet) {
  const jobIdCol = ensureJobIdColumn_(sheet);
  const lastRow = sheet.getLastRow();

  if (lastRow <= HEADER_ROW) {
    return;
  }

  assignMissingJobIdsInChronologicalOrder_(sheet, jobIdCol);

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
  const title = getJobTitleFromRow_(row, displayRow, columns);

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
    assignMissingJobIdsInChronologicalOrder_(sheet, jobIdCol);
    jobId = String(idCell.getDisplayValue()).trim();
  }

  if (!jobId) {
    jobId = generateNextJobId_(sheet, jobIdCol);
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
  const title = getJobTitleFromRow_(row, displayRow, resolvedColumns);
  const deadline = resolvedColumns.deadline >= 0
    ? (colDisplay_(displayRow, resolvedColumns.deadline, "") || colValue_(row, resolvedColumns.deadline, ""))
    : "";
  if (!String(title || "").trim()) {
    return null;
  }

  const generatedId = getJobIdFromRow_(row, displayRow, headers, sheetRowNumber);
  const sourceKey = getJobSourceKeyFromRow_(row, displayRow, headers, sheetRowNumber, resolvedColumns);
  const record = applicantStore
    ? getApplicantRecordForJob_(applicantStore, generatedId, sourceKey)
    : null;

  return upsertApplicantRecord_(applicantStore || getApplicantListStore_(), {
    jobId: generatedId,
    sourceKey,
    title,
    deadline
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
  const acceptedShootDates = String(params.acceptedShootDates || "").trim().toLowerCase() === "true";
  const selectedShootDates = parseSelectedShootDates_(params.selectedShootDates);

  if (!jobId) {
    throw apiError_("invalid_param", "jobId 必須");
  }

  if (!applicantName) {
    throw apiError_("invalid_param", "応募者名 必須");
  }

  if (!hasTalentUserByName_(applicantName)) {
    throw apiError_(
      "model_not_found",
      "モデルデータベースにお名前がありません。誤字・脱字がないかご確認ください。"
    );
  }

  if (!acceptedCancelPolicy || !acceptedShootDates || selectedShootDates.length === 0) {
    throw apiError_("consent_required", "キャンセルポリシーと撮影候補日の確認が必要です");
  }

  const contactEmail = resolveApplicantEmail_(params, tokenPayload);
  if (!contactEmail || !isValidEmail_(contactEmail)) {
    throw apiError_("invalid_email", "メールアドレスが不正です");
  }
  if (tokenPayload?.action && String(tokenPayload.action).trim() !== "apply") {
    throw apiError_("invalid_token", "token action 不正");
  }
  if (tokenPayload?.jobId && String(tokenPayload.jobId).trim() !== jobId) {
    throw apiError_("invalid_token", "token jobId 不一致");
  }
  const applicationTimestamp = formatStoredTimestamp_(new Date());

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
    const title = getJobTitleFromRow_(row, displayRow, columns);
    const generatedId = getJobIdFromRow_(row, displayRow, headers, sheetRowNumber);
    const sourceKey = getJobSourceKeyFromRow_(row, displayRow, headers, sheetRowNumber, columns);
    const applicantRecord = getApplicantRecordForJob_(applicantStore, generatedId, sourceKey);
    const canonicalJobId = resolvePreferredJobId_(generatedId, applicantRecord?.jobId);
    const availableShootDates = getShootDatesFromRow_(row, displayRow, columns);
    const availableShootDateMap = {};
    availableShootDates.forEach((value) => {
      const normalized = normalizeShootDateValue_(value);
      if (normalized) {
        availableShootDateMap[normalized] = String(value || "").trim();
      }
    });
    const selectedShootDatesDisplay = selectedShootDates.map((value) => availableShootDateMap[normalizeShootDateValue_(value)] || "");

    const existingApplicantsText = applicantRecord?.applicantsText || "";
    const applicantsList = splitLines_(existingApplicantsText);
    const applicantEmailsList = splitLines_(applicantRecord?.applicantEmailsText || "");
    const cancelPolicyConsentsList = splitLines_(applicantRecord?.cancelPolicyConsentsText || "");
    const cancelPolicyCheckedAtList = splitLines_(applicantRecord?.cancelPolicyCheckedAtText || "");
    const appliedAtList = splitLines_(applicantRecord?.appliedAtText || "");
    const selectedShootDatesList = splitLines_(applicantRecord?.selectedShootDatesText || "");

    const availability = getJobApplicationAvailability_(row, displayRow, columns);
    if (!availability.canApply) {
      throw apiError_(availability.code, availability.message);
    }

    if (selectedShootDatesDisplay.some((value) => !value)) {
      throw apiError_("invalid_param", "撮影候補日の選択内容が不正です");
    }

    if (applicantsList.includes(applicantName)) {
      throw apiError_("already_applied", "既に応募済みです");
    }

    applicantsList.push(applicantName);
    applicantEmailsList.push(contactEmail);
    cancelPolicyConsentsList.push(acceptedCancelPolicy ? "TRUE" : "FALSE");
    cancelPolicyCheckedAtList.push(acceptedCancelPolicy ? applicationTimestamp : "");
    appliedAtList.push(applicationTimestamp);
    selectedShootDatesList.push(selectedShootDatesDisplay.join(" / "));
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
      deadline,
      selectedShootDatesText: selectedShootDatesList.join("\n"),
    });

    sendConfirmationEmail_(contactEmail, applicantName, {
      jobTitle: title,
      detailLines: buildConfirmationEmailDetailLines_(
        row,
        displayRow,
        columns,
        applicationTimestamp,
        selectedShootDatesDisplay
      )
    });

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

function sendConfirmationEmail_(to, name, details) {
  const jobTitle = String(details?.jobTitle || "").trim() || "案件";
  const detailLines = Array.isArray(details?.detailLines) && details.detailLines.length > 0
    ? details.detailLines
    : [`案件名：${jobTitle}`];

  const subject = `【応募確認】${jobTitle}`;
  const body = [
    `${name} 様`,
    "",
    "このたびはご応募いただき、誠にありがとうございます。",
    `下記案件へのご応募を受け付けましたので、ご連絡申し上げます。`,
    "",
    "■ ご応募内容",
    detailLines.join("\n"),
    "",
    "今後のご案内につきましては、内容が決まり次第、あらためてご連絡いたします。",
    "また、今回はご希望に添えない結果となった場合にも、その旨をご連絡いたします。",
    "内容に誤りやご不明な点がございましたら、本メールにご返信ください。",
    "",
    "何卒よろしくお願いいたします。",
    "",
    "MissConnect"
  ].join("\n");

  sendMail_(to, subject, body);
}

function buildConfirmationEmailDetailLines_(row, displayRow, columns, appliedAt, selectedShootDates) {
  const lines = [];
  const pushLine = (label, value) => {
    const text = String(value || "").trim();
    if (!text) {
      return;
    }
    lines.push(`${label}：${text}`);
  };
  const pushShootDateLine = (label, values) => {
    const items = Array.isArray(values)
      ? values.map((value) => formatShootDateForDisplay_(value)).filter(Boolean)
      : [];
    if (items.length === 0) {
      return;
    }
    if (items.length === 1) {
      lines.push(`${label}：${items[0]}`);
      return;
    }
    lines.push(`${label}：`);
    items.forEach((item) => {
      lines.push(`・${item}`);
    });
  };

  const shootDates = getShootDatesFromRow_(row, displayRow, columns);
  const rewardValue = formatRewardDisplay_(
    colValue_(row, columns.reward, ""),
    colDisplay_(displayRow, columns.reward, "")
  );
  const durationValue = formatDurationDisplay_(
    colValue_(row, columns.duration, ""),
    colDisplay_(displayRow, columns.duration, "")
  );
  const hourlyWageValue = formatHourlyWageDisplay_(
    colValue_(row, columns.hourlyWage, ""),
    colDisplay_(displayRow, columns.hourlyWage, ""),
    colValue_(row, columns.reward, ""),
    colValue_(row, columns.duration, "")
  );
  const outfitValue = String(
    colDisplay_(displayRow, columns.outfit, "")
    || colDisplay_(displayRow, columns.outfitAvailability, "")
    || colValue_(row, columns.outfit, "")
    || colValue_(row, columns.outfitAvailability, "")
    || ""
  ).trim();

  let appliedAtStr = "";
  const appliedAtDate = parseDate_(appliedAt);
  if (appliedAtDate) {
    appliedAtStr = Utilities.formatDate(appliedAtDate, TZ, "yyyy年MM月dd日 HH:mm");
  } else if (appliedAt) {
    appliedAtStr = String(appliedAt);
  }

  pushLine("案件名", getJobTitleFromRow_(row, displayRow, columns));
  pushLine("商品名", colDisplay_(displayRow, columns.productName, "") || colValue_(row, columns.productName, ""));
  pushLine("商品URL", colDisplay_(displayRow, columns.productUrl, "") || colValue_(row, columns.productUrl, ""));
  pushLine("報酬", rewardValue);
  pushLine("想定時給", hourlyWageValue);
  pushLine("拘束時間", durationValue);
  pushShootDateLine("撮影候補日", shootDates);
  pushShootDateLine("参加可能日程", selectedShootDates);
  pushLine("応募条件", colDisplay_(displayRow, columns.requirements, "") || colValue_(row, columns.requirements, ""));
  pushLine("募集人数", formatRecruitmentDisplay_(
    colValue_(row, columns.max, ""),
    colDisplay_(displayRow, columns.max, "")
  ));
  pushLine("案件説明", colDisplay_(displayRow, columns.description, "") || colValue_(row, columns.description, ""));
  pushLine("実施場所", colDisplay_(displayRow, columns.location, "") || colValue_(row, columns.location, ""));
  pushLine("撮影形式", colDisplay_(displayRow, columns.shootingFormat, "") || colValue_(row, columns.shootingFormat, ""));
  pushLine("媒体", colDisplay_(displayRow, columns.media, "") || colValue_(row, columns.media, ""));
  pushLine("メイク・ヘアメイク", colDisplay_(displayRow, columns.makeup, "") || colValue_(row, columns.makeup, ""));
  pushLine("メイク・ヘアメイクのイメージ", colDisplay_(displayRow, columns.makeupImage, "") || colValue_(row, columns.makeupImage, ""));
  pushLine("衣装", outfitValue);
  pushLine("持ち物", colDisplay_(displayRow, columns.belongings, "") || colValue_(row, columns.belongings, ""));
  pushLine("使用期間", colDisplay_(displayRow, columns.period, "") || colValue_(row, columns.period, ""));
  pushLine("競合", colDisplay_(displayRow, columns.competition, "") || colValue_(row, columns.competition, ""));
  pushLine("応募日時", appliedAtStr);

  return lines;
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

  const headers = values[0].map((h) => String(h).trim());
  const columns = getJobColumns_(headers);
  const applicantStore = getApplicantListStore_();

  if (columns.title < 0 || columns.deadline < 0) {
    return;
  }

  const notifiedAtCol = columns.notified >= 0
    ? columns.notified + 1
    : ensureColumnByHeader_(sheet, DEADLINE_NOTIFICATION_STATUS_HEADER);
  const now = new Date();
  const users = readUsers_();
  const pageUrlByName = {};

  users.forEach((user) => {
    if (user?.normalizedName) {
      pageUrlByName[user.normalizedName] = String(user.pageUrl || "").trim();
    }
  });

  values.slice(1).forEach((row, i) => {
    const displayRow = displayValues[i + 1] || [];
    const sheetRowNumber = i + 2;
    const generatedId = getJobIdFromRow_(row, displayRow, headers, sheetRowNumber);
    const sourceKey = getJobSourceKeyFromRow_(row, displayRow, headers, sheetRowNumber, columns);
    const applicantRecord = getApplicantRecordForJob_(applicantStore, generatedId, sourceKey);
    const canonicalJobId = resolvePreferredJobId_(generatedId, applicantRecord?.jobId);
    const deadline = colValue_(row, columns.deadline, "") || colDisplay_(displayRow, columns.deadline, "");
    const notified = String(sheet.getRange(sheetRowNumber, notifiedAtCol).getDisplayValue() || "").trim();
    const clientEmails = getNotificationEmailsFromRow_(row, displayRow, columns);
    const title = getJobTitleFromRow_(row, displayRow, columns);
    const applicantsText = applicantRecord?.applicantsText || "";
    const names = splitLines_(applicantsText);

    if (!deadline || notified || clientEmails.length === 0 || !title) {
      return;
    }

    const deadlineDate = parseDate_(deadline);
    if (!deadlineDate) {
      return;
    }

    const notifyAt = new Date(deadlineDate);
    notifyAt.setDate(notifyAt.getDate() + 1);
    notifyAt.setHours(getDeadlineNotificationHour_(), 0, 0, 0);

    if (now < notifyAt) {
      return;
    }

    const applicantContacts = buildApplicantContactsFromRecord_(applicantRecord);
    const applicantLines = applicantContacts.map((contact) => {
      const url = pageUrlByName[contact.normalizedName] || "（URLなし）";
      const selectedDates = String(contact.selectedShootDates || "").trim();
      return [
        `・${contact.rawName}`,
        `  ${url}`,
        selectedDates ? `  参加可能日程: ${selectedDates}` : "  参加可能日程: （未回答）"
      ].join("\n");
    });

    const formInfo = names.length > 0
      ? ensureModelDecisionFormForJob_(sheet, sheetRowNumber, title, names)
      : { url: "", editUrl: "" };

    const deadlineStr = Utilities.formatDate(deadlineDate, TZ, "yyyy年MM月dd日");
    const subject = `【応募者一覧】${title}`;
    const body = [
      "お世話になっております。MissConnectでございます。",
      "",
      `「${title}」につきまして、${deadlineStr}をもちまして応募受付を終了いたしました。`,
      "応募状況を以下のとおりご共有申し上げます。",
      "",
      `応募者数：${names.length}名`,
      "",
      "■ 応募者一覧",
      applicantLines.length > 0 ? applicantLines.join("\n") : "（応募者なし）",
      "",
      ...(formInfo.url ? [
        "起用するモデルが決まりましたら、以下のフォームよりご回答ください。",
        formInfo.url,
        ""
      ] : []),
      "ご確認のほど、よろしくお願いいたします。",
      "ご不明な点等がございましたら、お気軽にご連絡ください。",
      "",
      "何卒よろしくお願いいたします。",
      "",
      "MissConnect"
    ].join("\n");

    sendMail_(clientEmails.join(","), subject, body, {
      cc: CLIENT_NOTIFICATION_CC
    });

    if (formInfo.url) {
      setJobStatus_(sheet, sheetRowNumber, JOB_STATUS_WAITING_CLIENT);
    }

    sheet.getRange(sheetRowNumber, notifiedAtCol).setValue(
      `完了：${Utilities.formatDate(new Date(), TZ, "yyyy/MM/dd HH:mm")}`
    );

    upsertApplicantRecord_(applicantStore, {
      jobId: canonicalJobId,
      sourceKey,
      title,
      applicantCount: names.length,
      applicantsText,
      applicantEmailsText: applicantRecord?.applicantEmailsText || "",
      cancelPolicyConsentsText: applicantRecord?.cancelPolicyConsentsText || "",
      cancelPolicyCheckedAtText: applicantRecord?.cancelPolicyCheckedAtText || "",
      appliedAtText: applicantRecord?.appliedAtText || "",
      deadline: String(deadline || "").trim(),
      selectedShootDatesText: applicantRecord?.selectedShootDatesText || ""
    });
  });
}

function sendDeadlineMorningEmails() {
  notifyDeadlinePassed();
}

function ensureModelDecisionFormSubmitTrigger_(form) {
  const formId = form.getId();
  const exists = ScriptApp.getProjectTriggers().some((trigger) => {
    if (trigger.getHandlerFunction() !== "onModelDecisionFormSubmit_") {
      return false;
    }
    if (typeof trigger.getTriggerSourceId !== "function") {
      return false;
    }
    return trigger.getTriggerSourceId() === formId;
  });

  if (!exists) {
    ScriptApp.newTrigger("onModelDecisionFormSubmit_")
      .forForm(form)
      .onFormSubmit()
      .create();
  }
}

function setModelDecisionFormDescription_(form, jobTitle) {
  form.setDescription([
    `案件名：${jobTitle}`,
    "",
    "起用するモデルが決まりましたら、本フォームよりご回答ください。",
    "1人目は必須です。2人目と3人目は必要な場合のみご選択ください。"
  ].join("\n"));
}

function findFormItemByTitle_(form, title) {
  return form.getItems().find((item) => String(item.getTitle() || "").trim() === String(title || "").trim()) || null;
}

function deleteFormItemsByTitles_(form, titles) {
  const titleMap = {};
  titles.forEach((title) => {
    titleMap[String(title || "").trim()] = true;
  });

  const items = form.getItems();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (titleMap[String(item.getTitle() || "").trim()]) {
      form.deleteItem(item);
    }
  }
}

function setJobStatus_(sheet, rowNumber, status) {
  if (!sheet || rowNumber <= HEADER_ROW) {
    return;
  }

  const statusCol = ensureColumnByHeader_(sheet, JOB_STATUS_HEADER);
  sheet.getRange(rowNumber, statusCol).setValue(String(status || "").trim());
}

function buildModelDecisionChoiceValues_(applicantNames) {
  const seen = {};
  return (Array.isArray(applicantNames) ? applicantNames : [])
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .filter((name) => {
      const key = normalizeName_(name).toLowerCase();
      if (!key || seen[key]) {
        return false;
      }
      seen[key] = true;
      return true;
    });
}

function syncModelDecisionFormSelectionItems_(form, applicantNames) {
  const choiceValues = buildModelDecisionChoiceValues_(applicantNames);
  if (choiceValues.length === 0) {
    return;
  }

  deleteFormItemsByTitles_(form, [
    MODEL_DECISION_PRIMARY_TITLE,
    MODEL_DECISION_SECONDARY_TITLE,
    MODEL_DECISION_TERTIARY_TITLE
  ]);

  const primaryItem = form.addListItem()
    .setTitle(MODEL_DECISION_PRIMARY_TITLE)
    .setChoiceValues(choiceValues)
    .setRequired(true);
  const secondaryItem = form.addListItem()
    .setTitle(MODEL_DECISION_SECONDARY_TITLE)
    .setChoiceValues(choiceValues)
    .setRequired(false);
  const tertiaryItem = form.addListItem()
    .setTitle(MODEL_DECISION_TERTIARY_TITLE)
    .setChoiceValues(choiceValues)
    .setRequired(false);

  const memoItem = findFormItemByTitle_(form, MODEL_DECISION_MESSAGE_TITLE);
  if (!memoItem) {
    return;
  }

  [primaryItem, secondaryItem, tertiaryItem].forEach((item) => {
    const memoIndex = form.getItems().findIndex((formItem) => formItem.getId() === memoItem.getId());
    const itemIndex = form.getItems().findIndex((formItem) => formItem.getId() === item.getId());
    if (memoIndex >= 0 && itemIndex >= 0) {
      form.moveItem(itemIndex, memoIndex);
    }
  });
}

function ensureModelDecisionFormForJob_(sheet, sheetRowNumber, jobTitle, applicantNames) {
  const formUrlCol = ensureColumnByHeader_(sheet, "モデル決定フォームURL");
  const formEditUrlCol = ensureColumnByHeader_(sheet, "モデル決定フォーム編集URL");

  const existingUrl = String(sheet.getRange(sheetRowNumber, formUrlCol).getDisplayValue() || "").trim();
  const existingEditUrl = String(sheet.getRange(sheetRowNumber, formEditUrlCol).getDisplayValue() || "").trim();

  if (existingUrl) {
    if (existingEditUrl) {
      try {
        const existingForm = FormApp.openByUrl(existingEditUrl);
        setModelDecisionFormDescription_(existingForm, jobTitle);
        syncModelDecisionFormSelectionItems_(existingForm, applicantNames);
        existingForm.removeDestination();
        ensureModelDecisionFormSubmitTrigger_(existingForm);
      } catch (err) {
        // 保存済みフォームURLは再利用しつつ、トリガー再設定失敗は運用側で確認できるようにする。
      }
    }

    return {
      url: existingUrl,
      editUrl: existingEditUrl
    };
  }

  const form = FormApp.create(`【モデル決定回答】${jobTitle}`);
  setModelDecisionFormDescription_(form, jobTitle);

  form.addTextItem()
    .setTitle(MODEL_DECISION_CONTACT_NAME_TITLE)
    .setRequired(true);

  form.addTextItem()
    .setTitle(MODEL_DECISION_CONTACT_EMAIL_TITLE)
    .setRequired(true);

  form.addTextItem()
    .setTitle(MODEL_DECISION_MESSAGE_TITLE)
    .setRequired(false);
  syncModelDecisionFormSelectionItems_(form, applicantNames);
  ensureModelDecisionFormSubmitTrigger_(form);

  const publishedUrl = form.getPublishedUrl();
  const editUrl = form.getEditUrl();

  sheet.getRange(sheetRowNumber, formUrlCol).setValue(publishedUrl);
  sheet.getRange(sheetRowNumber, formEditUrlCol).setValue(editUrl);

  return {
    url: publishedUrl,
    editUrl
  };
}

function findJobRowByModelDecisionFormUrl_(sheet, formUrl) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROW) {
    return -1;
  }

  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet
    .getRange(HEADER_ROW, 1, 1, lastCol)
    .getDisplayValues()[0]
    .map((h) => String(h || "").trim());

  const formUrlCol = findColumn_(headers, "モデル決定フォームURL");
  if (formUrlCol < 0) {
    return -1;
  }

  const values = sheet
    .getRange(HEADER_ROW + 1, formUrlCol + 1, lastRow - HEADER_ROW, 1)
    .getDisplayValues()
    .flat();

  const target = String(formUrl || "").trim();
  for (let i = 0; i < values.length; i += 1) {
    if (String(values[i] || "").trim() === target) {
      return HEADER_ROW + 1 + i;
    }
  }

  return -1;
}

function getFormResponseValueMap_(e) {
  const map = {};
  const itemResponses = e?.response?.getItemResponses ? e.response.getItemResponses() : [];

  itemResponses.forEach((itemResponse) => {
    const title = String(itemResponse.getItem().getTitle() || "").trim();
    const rawResponse = itemResponse.getResponse();
    map[title] = Array.isArray(rawResponse)
      ? rawResponse.join("\n")
      : String(rawResponse || "").trim();
  });

  return map;
}

function parseSelectedModelNames_(text) {
  const seen = {};
  return String(text || "")
    .split(/[\r\n,、;／/]+/)
    .map((value) => normalizeName_(value))
    .filter(Boolean)
    .filter((name) => {
      const key = name.toLowerCase();
      if (seen[key]) {
        return false;
      }
      seen[key] = true;
      return true;
    });
}

function parseSelectedShootDates_(value) {
  const raw = Array.isArray(value)
    ? value.join("\n")
    : String(value || "").trim();

  if (!raw) {
    return [];
  }

  const seen = {};
  return raw
    .split(/[\r\n]+/)
    .map((entry) => normalizeShootDateValue_(entry))
    .filter(Boolean)
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (seen[key]) {
        return false;
      }
      seen[key] = true;
      return true;
    });
}

function getSelectedModelNamesFromResponseMap_(responseMap) {
  return parseSelectedModelNames_([
    responseMap[MODEL_DECISION_PRIMARY_TITLE],
    responseMap[MODEL_DECISION_SECONDARY_TITLE],
    responseMap[MODEL_DECISION_TERTIARY_TITLE]
  ].join("\n"));
}

function buildApplicantContactsFromRecord_(record) {
  const names = splitLines_(record?.applicantsText || "");
  const emails = splitLines_(record?.applicantEmailsText || "");
  const selectedShootDates = splitLines_(record?.selectedShootDatesText || "");
  const contacts = [];

  for (let i = 0; i < names.length; i += 1) {
    const rawName = String(names[i] || "").trim();
    if (!rawName) {
      continue;
    }

    contacts.push({
      rawName,
      normalizedName: normalizeName_(rawName),
      email: String(emails[i] || "").trim(),
      selectedShootDates: String(selectedShootDates[i] || "").trim()
    });
  }

  return contacts;
}

function appendModelDecisionResponseRow_(data) {
  const sheet = getModelDecisionResponsesSheet_();
  const values = [
    String(data?.submittedAt || "").trim(),
    String(data?.jobId || "").trim(),
    String(data?.sourceKey || "").trim(),
    String(data?.jobTitle || "").trim(),
    String(data?.formUrl || "").trim(),
    String(data?.contactName || "").trim(),
    String(data?.contactEmail || "").trim(),
    String(data?.selectedPrimary || "").trim(),
    String(data?.selectedSecondary || "").trim(),
    String(data?.selectedTertiary || "").trim(),
    String(data?.clientMessage || "").trim()
  ];

  sheet.appendRow(values);
}

function sendModelSelectionResultEmail_(to, name, details) {
  const jobTitle = String(details?.jobTitle || "").trim() || "案件";
  const isSelected = !!details?.isSelected;
  const clientMessage = String(details?.clientMessage || "").trim();

  const subject = isSelected
    ? `【起用のご連絡】${jobTitle}`
    : `【選考結果のご連絡】${jobTitle}`;

  const body = isSelected
    ? [
        `${name} 様`,
        "",
        "お世話になっております。MissConnectでございます。",
        "",
        `このたびは「${jobTitle}」にご応募いただき、誠にありがとうございます。`,
        "選考の結果、今回はご起用をお願いしたく、ご連絡申し上げます。",
        "",
        ...(clientMessage ? ["■ ご連絡事項", clientMessage, ""] : []),
        "詳細につきましては、必要に応じてあらためてご連絡いたします。",
        "ご不明な点がございましたら、本メールにご返信ください。",
        "",
        "何卒よろしくお願いいたします。",
        "",
        "MissConnect"
      ].join("\n")
    : [
        `${name} 様`,
        "",
        "お世話になっております。MissConnectでございます。",
        "",
        `このたびは「${jobTitle}」にご応募いただき、誠にありがとうございました。`,
        "慎重に選考を行いました結果、今回は見送りとさせていただくことになりました。",
        "",
        "ご期待に沿えず恐縮ですが、何卒ご理解賜れますと幸いです。",
        "またご縁がございましたら、ぜひよろしくお願いいたします。",
        "",
        "このたびはご応募いただき、誠にありがとうございました。",
        "",
        "MissConnect"
      ].join("\n");

  sendMail_(to, subject, body, {
    cc: CLIENT_NOTIFICATION_CC
  });
}

function onModelDecisionFormSubmit_(e) {
  if (!e || !e.response || !e.source) {
    return;
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const sheet = getJobsSheet_();
    const formUrl = String(e.source.getPublishedUrl() || "").trim();
    const rowNumber = findJobRowByModelDecisionFormUrl_(sheet, formUrl);

    if (rowNumber <= HEADER_ROW) {
      return;
    }

    const lastCol = sheet.getLastColumn();
    const headers = sheet
      .getRange(HEADER_ROW, 1, 1, lastCol)
      .getDisplayValues()[0]
      .map((h) => String(h || "").trim());

    const columns = getJobColumns_(headers);
    const row = sheet.getRange(rowNumber, 1, 1, lastCol).getValues()[0];
    const displayRow = sheet.getRange(rowNumber, 1, 1, lastCol).getDisplayValues()[0];
    const title = getJobTitleFromRow_(row, displayRow, columns);

    const notifiedAtCol = ensureColumnByHeader_(sheet, "選考結果通知日時");
    const selectedModelsCol = ensureColumnByHeader_(sheet, "起用モデル名");
    const memoCol = ensureColumnByHeader_(sheet, "選考結果通知メモ");
    const errorCol = ensureColumnByHeader_(sheet, "選考結果通知エラー");

    const alreadyNotified = String(sheet.getRange(rowNumber, notifiedAtCol).getDisplayValue() || "").trim();
    if (alreadyNotified) {
      return;
    }

    const responseMap = getFormResponseValueMap_(e);
    const selectedNames = getSelectedModelNamesFromResponseMap_(responseMap);
    const clientMessage = String(responseMap[MODEL_DECISION_MESSAGE_TITLE] || "").trim();
    const submittedAt = e?.response?.getTimestamp ? e.response.getTimestamp() : new Date();
    const submittedAtIso = formatStoredTimestamp_(submittedAt || new Date());

    if (selectedNames.length === 0) {
      sheet.getRange(rowNumber, errorCol).setValue("起用するモデル名が未入力です。");
      return;
    }

    const applicantStore = getApplicantListStore_();
    const generatedId = getJobIdFromRow_(row, displayRow, headers, rowNumber);
    const sourceKey = getJobSourceKeyFromRow_(row, displayRow, headers, rowNumber, columns);
    const applicantRecord = getApplicantRecordForJob_(applicantStore, generatedId, sourceKey);
    const contacts = buildApplicantContactsFromRecord_(applicantRecord);

    if (contacts.length === 0) {
      sheet.getRange(rowNumber, errorCol).setValue("応募者情報が見つかりません。");
      return;
    }

    const applicantMap = {};
    contacts.forEach((contact) => {
      applicantMap[contact.normalizedName] = contact;
    });

    const unknownNames = selectedNames.filter((name) => !applicantMap[normalizeName_(name)]);
    if (unknownNames.length > 0) {
      sheet.getRange(rowNumber, errorCol).setValue(
        `応募者一覧と一致しない名前: ${unknownNames.join("、")}`
      );
      return;
    }

    const selectedSet = {};
    selectedNames.forEach((name) => {
      selectedSet[normalizeName_(name)] = true;
    });

    const selectedContacts = contacts.filter((contact) => selectedSet[contact.normalizedName]);
    const nonSelectedContacts = contacts.filter((contact) => !selectedSet[contact.normalizedName]);
    const skippedNames = [];

    selectedContacts.forEach((contact) => {
      if (!isValidEmail_(contact.email)) {
        skippedNames.push(contact.rawName);
        return;
      }

      sendModelSelectionResultEmail_(contact.email, contact.rawName, {
        jobTitle: title,
        isSelected: true,
        clientMessage
      });
    });

    nonSelectedContacts.forEach((contact) => {
      if (!isValidEmail_(contact.email)) {
        skippedNames.push(contact.rawName);
        return;
      }

      sendModelSelectionResultEmail_(contact.email, contact.rawName, {
        jobTitle: title,
        isSelected: false
      });
    });

    sheet.getRange(rowNumber, selectedModelsCol).setValue(
      selectedContacts.map((contact) => contact.rawName).join("\n")
    );
    appendModelDecisionResponseRow_({
      submittedAt: submittedAtIso,
      jobId: canonicalJobId,
      sourceKey,
      jobTitle: title,
      formUrl,
      contactName: responseMap[MODEL_DECISION_CONTACT_NAME_TITLE],
      contactEmail: responseMap[MODEL_DECISION_CONTACT_EMAIL_TITLE],
      selectedPrimary: responseMap[MODEL_DECISION_PRIMARY_TITLE],
      selectedSecondary: responseMap[MODEL_DECISION_SECONDARY_TITLE],
      selectedTertiary: responseMap[MODEL_DECISION_TERTIARY_TITLE],
      clientMessage
    });
    sheet.getRange(rowNumber, notifiedAtCol).setValue(formatStoredTimestamp_(new Date()));
    setJobStatus_(sheet, rowNumber, JOB_STATUS_MODEL_DECIDED);
    sheet.getRange(rowNumber, memoCol).setValue(
      skippedNames.length > 0
        ? `メールアドレス未登録または不正のため未送信: ${skippedNames.join("、")}`
        : ""
    );
    sheet.getRange(rowNumber, errorCol).setValue("");
  } finally {
    lock.releaseLock();
  }
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
    deadline: String(colValue_(row, columns.deadline, "") || "").trim(),
    selectedShootDatesText: String(colValue_(row, columns.selectedShootDates, "") || "").trim()
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
    count: find("応募者数", "applicant_count"),
    applicants: find("応募者名", "applicants", "応募者"),
    applicantEmails: find("応募者メールアドレス", "applicant_emails"),
    cancelPolicyConsents: find("キャンセルポリシー確認済み", "cancel_policy_consents"),
    cancelPolicyCheckedAt: find("キャンセルポリシー確認日時", "cancel_policy_checked_at"),
    appliedAt: find("応募日時", "applied_at"),
    deadline: find("締切日", "deadline", "締切"),
    updatedAt: find("応募者更新日時", "updated_at"),
    selectedShootDates: find("応募可能日程", "selected_shoot_dates")
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
  const nowIso = formatStoredTimestamp_(new Date());
  const previousJobId = String(record?.jobId || "").trim();
  const nextJobId = resolvePreferredJobId_(recordInput.jobId, previousJobId);
  const resolvedApplicantsText = String(recordInput.applicantsText ?? record?.applicantsText ?? "").trim();
  const resolvedApplicantEmailsText = String(recordInput.applicantEmailsText ?? record?.applicantEmailsText ?? "").trim();
  const resolvedCancelPolicyConsentsText = String(recordInput.cancelPolicyConsentsText ?? record?.cancelPolicyConsentsText ?? "").trim();
  const resolvedCancelPolicyCheckedAtText = String(recordInput.cancelPolicyCheckedAtText ?? record?.cancelPolicyCheckedAtText ?? "").trim();
  const resolvedAppliedAtText = String(recordInput.appliedAtText ?? record?.appliedAtText ?? "").trim();
  const resolvedSelectedShootDatesText = String(recordInput.selectedShootDatesText ?? record?.selectedShootDatesText ?? "").trim();
  const resolvedDeadline = String(recordInput.deadline ?? record?.deadline ?? "").trim();
  const resolvedApplicantCount = recordInput.applicantCount != null
    ? normalizeNumber_(recordInput.applicantCount)
    : (resolvedApplicantsText ? splitLines_(resolvedApplicantsText).length : 0);
  const values = [
    nextJobId,
    String(recordInput.sourceKey || record?.sourceKey || "").trim(),
    String(recordInput.title || record?.title || "").trim(),
    resolvedApplicantCount,
    resolvedApplicantsText,
    resolvedApplicantEmailsText,
    resolvedCancelPolicyConsentsText,
    resolvedCancelPolicyCheckedAtText,
    resolvedAppliedAtText,
    resolvedDeadline,
    nowIso,
    resolvedSelectedShootDatesText
  ];

  if (record) {
    sheet.getRange(record.rowNumber, 1, 1, values.length).setValues([values]);
    if (previousJobId && previousJobId !== values[0] && store.byJobId[previousJobId] === record) {
      delete store.byJobId[previousJobId];
    }
    record.jobId = values[0];
    record.sourceKey = values[1];
    record.title = values[2];
    record.applicantCount = resolvedApplicantCount;
    record.applicantsText = values[4];
    record.applicantEmailsText = values[5];
    record.cancelPolicyConsentsText = values[6];
    record.cancelPolicyCheckedAtText = values[7];
    record.appliedAtText = values[8];
    record.deadline = values[9];
    record.selectedShootDatesText = values[11];
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
    deadline: values[9],
    selectedShootDatesText: values[11]
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
    jobId: find(JOB_ID_HEADER, "job_id", "id"),
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
    displayStatus: find(JOB_DISPLAY_STATUS_HEADER, "display_status", "公開状態", "掲載状態"),
    emergencyContact: find("撮影当日の緊急連絡先", "緊急連絡先", "emergency_contact"),
    email: find("ご担当者様のメールアドレス①", "担当者メールアドレス①", "client_email", "クライアントE-mail", "クライアントEmail", "クライアントメール"),
    email2: find("【任意】ご担当者様のメールアドレス②", "ご担当者様のメールアドレス②", "担当者メールアドレス②", "client_email_2"),
    email3: find("【任意】ご担当者様のメールアドレス③", "ご担当者様のメールアドレス③", "担当者メールアドレス③", "client_email_3"),
    form: find("form_url"),
    category: find("category"),
    count: find("applicant_count"),
    notified: find(DEADLINE_NOTIFICATION_STATUS_HEADER, "deadline_notified_at", "締切通知日時", "通知日時"),
    applicants: find("applicants", "応募者", "応募者名")
  };
}

function getNotificationEmailsFromRow_(row, displayRow, columns) {
  const candidateCols = [columns.email, columns.email2, columns.email3].filter(col => col >= 0);
  const emails = [];
  const seen = {};

  candidateCols.forEach((col) => {
    const raw = String(colDisplay_(displayRow, col, "") || colValue_(row, col, "") || "").trim();
    if (!raw) {
      return;
    }

    raw
      .split(/[\s,;、]+/)
      .map(value => String(value || "").trim())
      .filter(Boolean)
      .forEach((email) => {
        if (!isValidEmail_(email)) {
          return;
        }

        const key = email.toLowerCase();
        if (seen[key]) {
          return;
        }

        seen[key] = true;
        emails.push(email);
      });
  });

  return emails;
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

function stripSecondsFromTime_(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\b([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)\b/g, "$1:$2")
    .trim();
}

function formatShootDateForDisplay_(value) {
  const raw = stripSecondsFromTime_(value);
  if (!raw) {
    return "";
  }

  const hasTime = /\b([01]?\d|2[0-3]):[0-5]\d\b/.test(raw);
  const hasRange = /[~〜～]/.test(raw)
    || /\b([01]?\d|2[0-3]):[0-5]\d\s*[-ー−–]\s*([01]?\d|2[0-3]):[0-5]\d\b/.test(raw)
    || /\b([01]?\d|2[0-3]):[0-5]\d\s*to\s*([01]?\d|2[0-3]):[0-5]\d\b/i.test(raw);

  if (!hasTime || hasRange) {
    return raw;
  }

  return `${raw}～`;
}

function formatShootDateListForDisplay_(values) {
  if (!Array.isArray(values)) {
    return "";
  }

  return values
    .map((value) => formatShootDateForDisplay_(value))
    .filter(Boolean)
    .join(" / ");
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

function formatRecruitmentDisplay_(rawValue, displayValue) {
  const display = String(displayValue || "").trim();
  if (display && /名/.test(display)) {
    return display;
  }

  const amount = normalizeNumber_(rawValue);
  if (!amount) {
    return display;
  }

  return `${amount.toLocaleString("ja-JP")}名`;
}

function formatHourlyWageDisplay_(rawValue, displayValue, rewardValue, durationValue) {
  const display = String(displayValue || "").trim();
  if (display) {
    const amount = normalizeNumber_(rawValue);
    const normalizedDisplay = display.normalize("NFKC").replace(/[,\uFF0C]/g, "");
    if (amount && !/[¥円]/.test(display) && /^-?\d+(?:\.\d+)?$/.test(normalizedDisplay)) {
      return `${amount.toLocaleString("ja-JP")}円/時`;
    }
    return display;
  }

  const amount = normalizeNumber_(rawValue);
  if (amount) {
    return `${amount.toLocaleString("ja-JP")}円/時`;
  }

  const computed = computeHourlyWage_(rewardValue, durationValue);
  if (computed) {
    return `${computed.toLocaleString("ja-JP")}円/時`;
  }

  return "";
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

  const exp = Number(payload.exp);
  if (!Number.isFinite(exp)) {
    throw apiError_("invalid_token", "token exp 不正");
  }
  if (exp <= Date.now()) {
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

function getModelDecisionResponsesSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(SHEET_NAMES.modelDecisionResponses);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.modelDecisionResponses, ss.getNumSheets() + 1);
  }

  ensureModelDecisionResponsesHeaderRow_(sheet);
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

  if (isExactHeaderSequence_(headers, PREVIOUS_APPLICANT_LIST_HEADERS)) {
    migratePreviousApplicantListSheet_(sheet);
    return;
  }

  if (isExactHeaderSequence_(headers, LEGACY_APPLICANT_LIST_HEADERS)) {
    migrateLegacyApplicantListSheet_(sheet);
    return;
  }

  sheet.getRange(HEADER_ROW, 1, 1, APPLICANT_LIST_HEADERS.length).setValues([APPLICANT_LIST_HEADERS]);
}

function ensureModelDecisionResponsesHeaderRow_(sheet) {
  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();

  if (lastCol === 0 || lastRow === 0) {
    sheet.getRange(HEADER_ROW, 1, 1, MODEL_DECISION_RESPONSE_HEADERS.length).setValues([MODEL_DECISION_RESPONSE_HEADERS]);
    return;
  }

  const headers = sheet
    .getRange(HEADER_ROW, 1, 1, Math.max(lastCol, MODEL_DECISION_RESPONSE_HEADERS.length))
    .getValues()[0]
    .map(h => String(h).trim());

  if (isExactHeaderSequence_(headers, MODEL_DECISION_RESPONSE_HEADERS)) {
    return;
  }

  sheet.getRange(HEADER_ROW, 1, 1, MODEL_DECISION_RESPONSE_HEADERS.length).setValues([MODEL_DECISION_RESPONSE_HEADERS]);
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
    "",
    String(row[6] || "").trim(),
    ""
  ]));

  sheet.getRange(HEADER_ROW, 1, 1, APPLICANT_LIST_HEADERS.length).setValues([APPLICANT_LIST_HEADERS]);
  if (migratedRows.length > 0) {
    sheet.getRange(HEADER_ROW + 1, 1, migratedRows.length, APPLICANT_LIST_HEADERS.length).setValues(migratedRows);
  }
}

function migratePreviousApplicantListSheet_(sheet) {
  const values = sheet.getDataRange().getValues();
  const rows = values.slice(1);
  const deadlineMap = buildJobDeadlineMap_();

  const migratedRows = rows.map((row) => {
    const jobId = String(row[0] || "").trim();
    const sourceKey = String(row[1] || "").trim();

    return [
      jobId,
      sourceKey,
      String(row[2] || "").trim(),
      normalizeNumber_(row[3]),
      String(row[4] || "").trim(),
      String(row[5] || "").trim(),
      String(row[6] || "").trim(),
      String(row[7] || "").trim(),
      String(row[8] || "").trim(),
      resolveDeadlineFromMap_(deadlineMap, jobId, sourceKey),
      String(row[10] || "").trim(),
      String(row[11] || "").trim()
    ];
  });

  sheet.getRange(HEADER_ROW, 1, 1, APPLICANT_LIST_HEADERS.length).setValues([APPLICANT_LIST_HEADERS]);
  if (migratedRows.length > 0) {
    sheet.getRange(HEADER_ROW + 1, 1, migratedRows.length, APPLICANT_LIST_HEADERS.length).setValues(migratedRows);
  }
}

function ensureColumnByHeader_(sheet, headerName) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet
    .getRange(HEADER_ROW, 1, 1, lastCol)
    .getDisplayValues()[0]
    .map((h) => String(h || "").trim());

  const existingIndex = headers.findIndex((header) => header === headerName);
  if (existingIndex >= 0) {
    return existingIndex + 1;
  }

  const nextCol = lastCol + 1;
  sheet.insertColumnAfter(lastCol);
  sheet.getRange(HEADER_ROW, nextCol).setValue(headerName);
  return nextCol;
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

function getJobTitleFromRow_(row, displayRow, columns) {
  return [
    colDisplay_(displayRow, columns.title, ""),
    colValue_(row, columns.title, ""),
    colDisplay_(displayRow, columns.productName, ""),
    colValue_(row, columns.productName, "")
  ]
    .map((value) => String(value || "").trim())
    .find(Boolean) || "";
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

function generateNextJobId_(sheet, jobIdCol) {
  const lastRow = sheet.getLastRow();
  const existingValues = lastRow > HEADER_ROW
    ? sheet.getRange(HEADER_ROW + 1, jobIdCol, lastRow - HEADER_ROW, 1).getDisplayValues().flat()
    : [];
  const usedSequences = {};

  existingValues.forEach((value) => {
    const sequence = parseJobIdSequence_(value);
    if (!Number.isFinite(sequence) || sequence <= 0) {
      return;
    }
    usedSequences[sequence] = true;
  });

  let nextSequence = 1;
  while (usedSequences[nextSequence]) {
    nextSequence += 1;
  }

  return formatJobIdSequence_(nextSequence);
}

function assignMissingJobIdsInChronologicalOrder_(sheet, jobIdCol) {
  if (!sheet) {
    return;
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow <= HEADER_ROW || lastCol <= 0) {
    return;
  }

  const headers = sheet
    .getRange(HEADER_ROW, 1, 1, lastCol)
    .getDisplayValues()[0]
    .map((h) => String(h || "").trim());
  const columns = getJobColumns_(headers);
  const values = sheet.getRange(HEADER_ROW + 1, 1, lastRow - HEADER_ROW, lastCol).getValues();
  const displayValues = sheet.getRange(HEADER_ROW + 1, 1, lastRow - HEADER_ROW, lastCol).getDisplayValues();
  const legacyJobIdCol = findColumn_(headers, "job_id", "id");
  const usedSequences = {};
  const rowsToAssign = [];

  values.forEach((row, index) => {
    const displayRow = displayValues[index] || [];
    const rowNumber = HEADER_ROW + 1 + index;
    const title = getJobTitleFromRow_(row, displayRow, columns);

    if (!title) {
      return;
    }

    const mainJobId = String(displayRow[jobIdCol - 1] || row[jobIdCol - 1] || "").trim();
    const legacyJobId = legacyJobIdCol >= 0 && legacyJobIdCol + 1 !== jobIdCol
      ? String(displayRow[legacyJobIdCol] || row[legacyJobIdCol] || "").trim()
      : "";
    const resolvedJobId = mainJobId || legacyJobId;
    const sequence = parseJobIdSequence_(resolvedJobId);

    if (resolvedJobId) {
      if (!mainJobId) {
        sheet.getRange(rowNumber, jobIdCol).setValue(resolvedJobId);
      }

      if (Number.isFinite(sequence) && sequence > 0) {
        usedSequences[sequence] = true;
      }
      return;
    }

    const timestampValue = columns.timestamp >= 0
      ? (colValue_(row, columns.timestamp, "") || colDisplay_(displayRow, columns.timestamp, ""))
      : "";
    const timestampDate = parseDate_(timestampValue);

    rowsToAssign.push({
      rowNumber,
      timestampMs: timestampDate ? timestampDate.getTime() : Number.POSITIVE_INFINITY
    });
  });

  rowsToAssign.sort((a, b) => {
    if (a.timestampMs !== b.timestampMs) {
      return a.timestampMs - b.timestampMs;
    }

    return a.rowNumber - b.rowNumber;
  });

  let nextSequence = 1;
  rowsToAssign.forEach((entry) => {
    while (usedSequences[nextSequence]) {
      nextSequence += 1;
    }

    sheet.getRange(entry.rowNumber, jobIdCol).setValue(formatJobIdSequence_(nextSequence));
    usedSequences[nextSequence] = true;
    nextSequence += 1;
  });
}

function parseJobIdSequence_(value) {
  const text = String(value || "").trim();
  if (!text) {
    return NaN;
  }

  const match = text.match(/^job-(\d+)$/i);
  if (match) {
    const sequence = Number(match[1]);
    return Number.isFinite(sequence) ? sequence : NaN;
  }

  const legacyMatch = text.match(/^job_(?:\d{8}_)?(\d+)$/i);
  if (!legacyMatch) {
    return NaN;
  }

  const legacySequence = Number(legacyMatch[1]);
  return Number.isFinite(legacySequence) ? legacySequence : NaN;
}

function formatJobIdSequence_(sequence) {
  return `${JOB_ID_PREFIX}${String(sequence).padStart(JOB_ID_SEQUENCE_WIDTH, "0")}`;
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
  const id = getTalentSpreadsheetId_();
  const sheetName = getOptionalProperty_("TALENT_SHEET_NAME") || "auto";
  return `${TALENT_USERS_CACHE_KEY}:${id}:${sheetName}`;
}

function buildJobDeadlineMap_() {
  const sheet = getJobsSheet_();
  const values = sheet.getDataRange().getValues();
  const displayValues = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) {
    return { byJobId: {}, bySourceKey: {} };
  }

  const headers = values[0].map((h) => String(h || "").trim());
  const columns = getJobColumns_(headers);
  const byJobId = {};
  const bySourceKey = {};

  values.slice(1).forEach((row, index) => {
    const displayRow = displayValues[index + 1] || [];
    const rowNumber = index + 2;
    const jobId = getJobIdFromRow_(row, displayRow, headers, rowNumber);
    const sourceKey = getJobSourceKeyFromRow_(row, displayRow, headers, rowNumber, columns);
    const deadline = columns.deadline >= 0
      ? String(colDisplay_(displayRow, columns.deadline, "") || colValue_(row, columns.deadline, "") || "").trim()
      : "";

    if (jobId) {
      byJobId[jobId] = deadline;
    }
    if (sourceKey) {
      bySourceKey[sourceKey] = deadline;
    }
  });

  return { byJobId, bySourceKey };
}

function resolveDeadlineFromMap_(map, jobId, sourceKey) {
  if (!map) {
    return "";
  }
  return String(
    map.byJobId?.[String(jobId || "").trim()]
    || map.bySourceKey?.[String(sourceKey || "").trim()]
    || ""
  ).trim();
}

function getTalentUsersCacheSeconds_() {
  const raw = getOptionalProperty_("TALENT_USERS_CACHE_SECONDS");
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TALENT_USERS_CACHE_SECONDS;
  }
  return Math.min(Math.floor(parsed), 21600);
}

function getDeadlineNotificationHour_() {
  const raw = getOptionalProperty_("DEADLINE_NOTIFICATION_HOUR");
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed < 0 || parsed > 23) {
    return DEFAULT_DEADLINE_NOTIFICATION_HOUR;
  }
  return Math.floor(parsed);
}

function getTalentSpreadsheetId_() {
  return getOptionalProperty_("TALENT_SPREADSHEET_ID") || DEFAULT_TALENT_SPREADSHEET_ID || getProperty_("SPREADSHEET_ID");
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

function buildIdMap_(values) {
  const map = {};
  values.forEach((value) => {
    const key = Number(value);
    if (Number.isFinite(key)) {
      map[key] = true;
    }
  });
  return map;
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
    getJobTitleFromRow_(row, displayRow, resolvedColumns),
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
    getJobTitleFromRow_(row, displayRow, columns),
    colDisplay_(displayRow, columns.productName, "") || colValue_(row, columns.productName, "")
  ]
    .map(value => String(value || "").trim())
    .filter(Boolean)
    .join("|");

  return identitySource
    ? `${JOB_ID_FALLBACK_PREFIX}${hash_(identitySource).slice(0, 12)}`
    : `${JOB_ID_FALLBACK_PREFIX}${sheetRowNumber}`;
}

function resolvePreferredJobId_(incomingJobId, existingJobId) {
  const incoming = String(incomingJobId || "").trim();
  const existing = String(existingJobId || "").trim();

  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }
  if (isTemporaryJobId_(existing) && !isTemporaryJobId_(incoming)) {
    return incoming;
  }
  return existing;
}

function isTemporaryJobId_(jobId) {
  return String(jobId || "").trim().indexOf(JOB_ID_FALLBACK_PREFIX) === 0;
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

  const text = String(value).normalize("NFKC").trim();
  if (!text) {
    return null;
  }

  if (/^\d+\s*日$/.test(text)) {
    return null;
  }

  if (/^残り\s*\d+\s*日$/.test(text) || text === "期限切れ") {
    return null;
  }

  const normalized = text.replace(/\./g, "/").replace(/-/g, "/");
  const ymdMatch = normalized.match(
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?$/
  );

  if (ymdMatch) {
    const year = Number(ymdMatch[1]);
    const month = Number(ymdMatch[2]);
    const day = Number(ymdMatch[3]);
    const hour = Number(ymdMatch[4] || 0);
    const minute = Number(ymdMatch[5] || 0);
    const second = Number(ymdMatch[6] || 0);
    const parsedYmd = new Date(year, month - 1, day, hour, minute, second);

    if (!isNaN(parsedYmd.getTime())) {
      return parsedYmd;
    }
  }

  const parsed = new Date(text);

  if (isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function formatStoredTimestamp_(value) {
  const date = parseDate_(value);
  return date ? Utilities.formatDate(date, TZ, STORED_TIMESTAMP_FORMAT) : "";
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

function normalizeJobDisplayStatus_(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase();

  if (!normalized || normalized === "表示" || normalized === "公開" || normalized === "published") {
    return JOB_DISPLAY_STATUS_VISIBLE;
  }
  if (normalized === "非表示" || normalized === "hidden") {
    return JOB_DISPLAY_STATUS_HIDDEN;
  }
  if (normalized === "一時停止" || normalized === "停止" || normalized === "paused" || normalized === "pause") {
    return JOB_DISPLAY_STATUS_PAUSED;
  }
  if (
    normalized === "案件終了"
    || normalized === "募集終了"
    || normalized === "終了"
    || normalized === "closed"
  ) {
    return JOB_DISPLAY_STATUS_ENDED;
  }

  return JOB_DISPLAY_STATUS_VISIBLE;
}

function getJobDisplayStatusFromRow_(row, displayRow, columns) {
  const raw = columns.displayStatus >= 0
    ? (colDisplay_(displayRow, columns.displayStatus, "") || colValue_(row, columns.displayStatus, ""))
    : "";
  return normalizeJobDisplayStatus_(raw);
}

function getJobApplicationAvailability_(row, displayRow, columns) {
  const displayStatus = getJobDisplayStatusFromRow_(row, displayRow, columns);

  if (displayStatus === JOB_DISPLAY_STATUS_HIDDEN) {
    return {
      canApply: false,
      code: "job_hidden",
      message: "現在非公開中のため応募できません"
    };
  }

  if (displayStatus === JOB_DISPLAY_STATUS_PAUSED) {
    return {
      canApply: false,
      code: "job_paused",
      message: "現在一時停止中のため応募できません"
    };
  }

  if (displayStatus === JOB_DISPLAY_STATUS_ENDED) {
    return {
      canApply: false,
      code: "job_closed",
      message: "この案件は募集終了のため応募できません"
    };
  }

  const deadline = columns.deadline >= 0
    ? (colValue_(row, columns.deadline, "") || colDisplay_(displayRow, columns.deadline, ""))
    : "";
  if (isDeadlinePassed_(deadline)) {
    return {
      canApply: false,
      code: "deadline_passed",
      message: "応募締切を過ぎています"
    };
  }

  return {
    canApply: true,
    code: "",
    message: ""
  };
}

function calculateRemainingDaysLabel_(deadlineValue) {
  const raw = String(deadlineValue || "").normalize("NFKC").trim();
  if (/^残り\s*0+\s*日$/.test(raw) || /^0+\s*日$/.test(raw)) {
    return "本日締切";
  }
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
  if (diffDays === 0) {
    return "本日締切";
  }
  return `残り${diffDays}日`;
}

function normalizeNumber_(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const text = String(value ?? "")
    .normalize("NFKC")
    .trim();
  if (!text) {
    return 0;
  }

  const normalized = text.replace(/[,\uFF0C]/g, "");
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

function normalizeShootDateValue_(value) {
  return normalizeSourceValue_(String(value || "").replace(/\b([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)\b/g, "$1:$2"));
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

function sendMail_(to, subject, body, options) {
  const mailOptions = Object.assign({
    name: MAIL_SENDER_NAME,
    replyTo: MAIL_SENDER_EMAIL
  }, options || {});

  const senderEmail = MAIL_SENDER_EMAIL.toLowerCase();
  const activeUserEmail = String(Session.getActiveUser().getEmail() || "").trim().toLowerCase();
  const aliases = GmailApp.getAliases()
    .map((alias) => String(alias || "").trim().toLowerCase())
    .filter(Boolean);
  const canSendFromConfiguredAddress = senderEmail === activeUserEmail || aliases.includes(senderEmail);

  if (!canSendFromConfiguredAddress) {
    throw new Error(`Gmailの送信元として ${MAIL_SENDER_EMAIL} のエイリアス設定が必要です。`);
  }

  if (senderEmail !== activeUserEmail) {
    mailOptions.from = MAIL_SENDER_EMAIL;
  }

  GmailApp.sendEmail(to, subject, body, mailOptions);
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
