// @ts-nocheck

/* =========================================
   Constants
========================================= */

const SHEET_NAMES = {
  jobs: "jobs"
};

const GITHUB_API_BASE = "https://api.github.com";

/* =========================================
   Spreadsheet Menu
========================================= */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("運用")
    .addItem("GitHub Actions 実行", "runGitHubActionsFromMenu_")
    .addToUi();
}

function runGitHubActionsFromMenu_() {
  const ui = SpreadsheetApp.getUi();
  const ref = getDefaultGitHubRef_();

  try {
    const result = triggerGitHubWorkflowDispatch_(ref);
    ui.alert("GitHub Actions", `ワークフローを起動しました。\n${result}`, ui.ButtonSet.OK);
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
  const workflowId = mustGetScriptProperty_("GITHUB_WORKFLOW_ID");
  const token = mustGetScriptProperty_("GITHUB_TOKEN");
  const inputsJson = String(props.getProperty("GITHUB_WORKFLOW_INPUTS_JSON") || "").trim();

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
  const payload = {
    ref,
    inputs
  };

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

  return `repo=${owner}/${repo}, workflow=${workflowId}, ref=${ref}`;
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
  if (!value)
    throw apiError_("config_error", `${key} 未設定`);
  return value;
}

/* =========================================
   Entry
========================================= */

function doGet(e) { return handleRequest_(e); }
function doPost(e) { return handleRequest_(e); }

/* =========================================
   Router
========================================= */

function handleRequest_(e) {
  let callback = "";

  try {
    const params = e?.parameter || {};
    callback = sanitizeCallback_(params.callback);
    const action = String(params.action || "").trim();

    if (!action)
      throw apiError_("invalid_action", "action 必須");

    let payload;

    if (action === "health") {
      payload = { ok: true };

    } else if (action === "login") {
      payload = login_(params);

    } else if (action === "listJobs") {
      payload = listJobs_(params);

    } else if (action === "apply") {
      payload = apply_(params);

    } else {
      throw apiError_("invalid_action", "未対応 action");
    }

    return respond_(callback, payload);

  } catch (err) {
    return respond_(callback, {
      ok: false,
      errorCode: err.code || "internal_error",
      message: err.message || "内部エラー"
    });
  }
}

/* =========================================
   LOGIN（名簿=TALENT_SPREADSHEET_ID）
========================================= */

function login_(params) {
  const name = String(params.name || "").trim();
  const password = String(params.password || "").trim();

  if (!name || !password)
    throw apiError_("invalid_credentials", "認証情報不足");

  if (password !== getLoginPassword_())
    throw apiError_("invalid_credentials", "パスワード不一致");

  const users = readUsers_();
  const user = users.find(u => u.name === name);

  if (!user)
    throw apiError_("invalid_credentials", "ユーザー不存在");

  const expiresAt = Date.now() + 12 * 60 * 60 * 1000;

  const token = signToken_({
    uid:  user.uid,
    name: user.name,
    role: "talent",
    email: user.email,
    exp:  expiresAt
  });

  return {
    ok: true,
    session: {
      token,
      uid:      user.uid,
      name:     user.name,
      role:     "talent",
      email:    user.email,
      expiresAt
    }
  };
}

/* =========================================
   名簿読取（TALENT_SPREADSHEET_ID）
========================================= */

function readUsers_() {
  const id = getProperty_("TALENT_SPREADSHEET_ID");
  const sheetName = getProperty_("TALENT_SHEET_NAME") || "名簿";

  const ss = SpreadsheetApp.openById(id);
  const sheet = ss.getSheetByName(sheetName);

  if (!sheet)
    throw apiError_("config_error", "名簿シート不存在");

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(h => String(h).trim());

  const nameCol    = headers.indexOf("名前");
  const instaCol   = headers.indexOf("instagram_url");
  const pageUrlCol = headers.indexOf("個別ページURL");

  if (nameCol < 0)
    throw apiError_("config_error", "名前列不存在");

  return values.slice(1).map(row => {
    const name = String(row[nameCol] || "").trim();
    if (!name) return null;

    return {
      uid:     hash_(name),
      name,
      email:   instaCol   >= 0 ? String(row[instaCol]   || "").trim() : "",
      pageUrl: pageUrlCol >= 0 ? String(row[pageUrlCol] || "").trim() : ""
    };
  }).filter(Boolean);
}

/* =========================================
   JOBS取得（SPREADSHEET_ID）
========================================= */

function listJobs_(params) {
  verifyToken_(params.token);

  const id = getProperty_("SPREADSHEET_ID");
  const ss = SpreadsheetApp.openById(id);
  const sheet = ss.getSheetByName("jobs");

  if (!sheet)
    throw apiError_("config_error", "jobs シート不存在");

  const values = sheet.getDataRange().getValues();
  if (values.length < 2)
    return { ok: true, jobs: [] };

  const headers = values[0].map(h => String(h).trim());

  const getCol = (name) => {
    const i = headers.indexOf(name);
    if (i < 0)
      throw apiError_("config_error", `列 ${name} 不存在`);
    return i;
  };

  const titleCol        = getCol("title");
  const deadlineCol     = getCol("deadline");
  const maxCol          = getCol("max_applicants");
  const emailCol        = getCol("client_email");
  const formCol         = getCol("form_url");
  const categoryCol     = getCol("category");
  const countCol        = getCol("applicant_count");
  const notifiedCol     = getCol("deadline_notified_at");
  const applicantsCol   = headers.indexOf("applicants");
  const applicantUrlCol = headers.indexOf("applicant_url");

  const jobs = values.slice(1).map((row, i) => ({
    id:                   "job_" + (i + 2),
    title:                row[titleCol],
    deadline:             row[deadlineCol],
    max_applicants:       row[maxCol],
    client_email:         row[emailCol],
    form_url:             row[formCol],
    category:             row[categoryCol],
    applicant_count:      row[countCol],
    deadline_notified_at: row[notifiedCol],
    applicants:           applicantsCol >= 0 ? row[applicantsCol] : "",
    applicant_url:        applicantUrlCol >= 0 ? row[applicantUrlCol] : ""
  }));

  return { ok: true, jobs };
}

/* =========================================
   応募処理
========================================= */

function apply_(params) {
  const tokenPayload = verifyToken_(params.token);
  const jobId        = String(params.jobId        || "").trim();
  const contactEmail = String(params.contactEmail || "").trim();

  if (!jobId)
    throw apiError_("invalid_param", "jobId 必須");

  if (!contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))
    throw apiError_("invalid_email", "メールアドレスが不正です");

  const id    = getProperty_("SPREADSHEET_ID");
  const ss    = SpreadsheetApp.openById(id);
  const sheet = ss.getSheetByName("jobs");

  if (!sheet)
    throw apiError_("config_error", "jobs シート不存在");

  const values  = sheet.getDataRange().getValues();
  const headers = values[0].map(h => String(h).trim());

  const titleCol          = headers.indexOf("title");
  const deadlineCol       = headers.indexOf("deadline");
  const maxCol            = headers.indexOf("max_applicants");
  const countCol          = headers.indexOf("applicant_count");
  const applicantsCol     = headers.indexOf("applicants");
  const applicantUrlCol   = headers.indexOf("applicant_url");

  if (applicantsCol < 0)
    throw apiError_("config_error", "applicants 列不存在");

  const rowIndex = parseInt(jobId.replace("job_", ""), 10) - 2;
  if (rowIndex < 0 || rowIndex >= values.length - 1)
    throw apiError_("not_found", "案件が見つかりません");

  const row      = values[rowIndex + 1];
  const deadline = row[deadlineCol];
  const max      = Number(row[maxCol]   || 0);
  let   count    = Number(row[countCol] || 0);
  const title    = String(row[titleCol] || "");

  if (deadline && new Date(deadline) < new Date())
    throw apiError_("deadline_passed", "応募締切を過ぎています");

  if (max > 0 && count >= max)
    throw apiError_("quota_full", "定員に達しています");

  // 既存の応募者名リストを取得
  const existingApplicantsText = String(row[applicantsCol] || "").trim();
  const applicantsList = existingApplicantsText ? existingApplicantsText.split("\n").map(s => s.trim()).filter(Boolean) : [];
  
  // 既に応募済みかチェック
  const alreadyApplied = applicantsList.includes(tokenPayload.name);
  if (alreadyApplied)
    throw apiError_("already_applied", "既に応募済みです");

  // 名簿から該当ユーザーのURLを取得
  const users = readUsers_();
  const user = users.find(u => u.uid === tokenPayload.uid);
  const userUrl = user?.pageUrl || "";

  // 応募者名を追加
  applicantsList.push(tokenPayload.name);
  
  // URLリストを更新
  const existingUrlsText = applicantUrlCol >= 0 ? String(row[applicantUrlCol] || "").trim() : "";
  const urlsList = existingUrlsText ? existingUrlsText.split("\n").map(s => s.trim()).filter(Boolean) : [];
  urlsList.push(userUrl);

  const sheetRow = rowIndex + 2;
  sheet.getRange(sheetRow, countCol + 1).setValue(count + 1);
  sheet.getRange(sheetRow, applicantsCol + 1).setValue(applicantsList.join("\n"));
  
  if (applicantUrlCol >= 0) {
    sheet.getRange(sheetRow, applicantUrlCol + 1).setValue(urlsList.join("\n"));
  }

  sendConfirmationEmail_(contactEmail, tokenPayload.name, title, deadline);

  return { ok: true, applicantCount: count + 1 };
}

/* =========================================
   確認メール送信
========================================= */

function sendConfirmationEmail_(to, name, jobTitle, deadline) {
  const deadlineStr = deadline
    ? Utilities.formatDate(new Date(deadline), "Asia/Tokyo", "yyyy年MM月dd日")
    : "未定";

  const subject = `【応募確認】${jobTitle}`;
  const body    = `${name} 様\n\n「${jobTitle}」へのご応募を受け付けました。\n\n締切：${deadlineStr}\n\nご不明な点はご連絡ください。`;

  GmailApp.sendEmail(to, subject, body);
}

/* =========================================
   締切後通知（時間トリガーで定期実行）
========================================= */

function notifyDeadlinePassed() {
  const id    = getProperty_("SPREADSHEET_ID");
  const ss    = SpreadsheetApp.openById(id);
  const sheet = ss.getSheetByName("jobs");

  if (!sheet) return;

  const values  = sheet.getDataRange().getValues();
  const headers = values[0].map(h => String(h).trim());

  const titleCol          = headers.indexOf("title");
  const deadlineCol       = headers.indexOf("deadline");
  const emailCol          = headers.indexOf("client_email");
  const applicantsCol     = headers.indexOf("applicants");
  const applicantUrlCol   = headers.indexOf("applicant_url");
  const notifiedCol       = headers.indexOf("deadline_notified_at");

  const now = new Date();

  values.slice(1).forEach((row, i) => {
    const deadline    = row[deadlineCol];
    const notified    = row[notifiedCol];
    const clientEmail = String(row[emailCol] || "").trim();
    const title       = String(row[titleCol] || "");

    if (!deadline)    return;
    if (notified)     return;
    if (!clientEmail) return;

    const deadlineDate = new Date(deadline);

    const nextDay = new Date(deadlineDate);
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(0, 0, 0, 0);
    if (now < nextDay) return;

    // 応募者名とURLをテキスト形式で取得
    const applicantsText = String(row[applicantsCol] || "").trim();
    const applicantUrlText = applicantUrlCol >= 0 ? String(row[applicantUrlCol] || "").trim() : "";
    
    const names = applicantsText ? applicantsText.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean) : [];
    const urls = applicantUrlText ? applicantUrlText.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean) : [];

    const applicantLines = names.map((name, index) => {
      const url = urls[index] || "（URLなし）";
      return `・${name}\n  ${url}`;
    });

    const deadlineStr = Utilities.formatDate(deadlineDate, "Asia/Tokyo", "yyyy年MM月dd日");

    const subject = `【応募者一覧】${title}`;
    const body    = [
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

/* =========================================
   Token
========================================= */

function signToken_(payload) {
  const json = JSON.stringify(payload);
  const blob = Utilities.newBlob(json, "application/json", "payload.json");
  const body = Utilities.base64EncodeWebSafe(blob.getBytes());
  const sig  = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(body, getProperty_("APP_SECRET"))
  );
  return body + "." + sig;
}

function verifyToken_(token) {
  if (!token)
    throw apiError_("invalid_token", "token 不存在");

  const [body, signature] = token.split(".");
  const expected = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(body, getProperty_("APP_SECRET"))
  );

  if (signature !== expected)
    throw apiError_("invalid_token", "署名不一致");

  const payload = JSON.parse(
    Utilities.newBlob(
      Utilities.base64DecodeWebSafe(body)
    ).getDataAsString("UTF-8")  // UTF-8 を明示的に指定
  );

  if (payload.exp <= Date.now())
    throw apiError_("token_expired", "期限切れ");

  return payload;
}

/* =========================================
   Utilities
========================================= */

function getProperty_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value)
    throw apiError_("config_error", key + " 未設定");
  return value;
}

function getLoginPassword_() {
  return getProperty_("LOGIN_PASSWORD");
}

function sanitizeCallback_(callback) {
  if (!callback) return "";
  if (!/^[a-zA-Z0-9_$.]+$/.test(callback))
    throw apiError_("invalid_callback", "callback 不正");
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
  e.code  = code;
  return e;
}

function hash_(text) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    text
  );
  return raw.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}
