const SHEET_NAMES = {
  users: "users",
  jobs: "jobs",
  applications: "applications"
};

const APPLICATION_HEADERS = [
  "application_id",
  "job_id",
  "user_name",
  "user_email",
  "user_role",
  "submitted_at",
  "status"
];

const TALENT_HEADERS = [
  "タイムスタンプ",
  "名前",
  "ふりがな",
  "大学",
  "性別",
  "年齢",
  "身長",
  "特技・趣味",
  "ミスコン出場年度",
  "タグ",
  "画像・動画",
  "instagram_url",
  "x_url",
  "tiktok_url"
];

function doGet(e) {
  return handleRequest_(e);
}

function doPost(e) {
  return handleRequest_(e);
}

function handleRequest_(e) {
  let callback = "";

  try {
    const params = collectParams_(e);
    callback = sanitizeCallback_(params.callback);
    const action = String(params.action || "").trim();

    if (!action) {
      throw apiError_("invalid_action", "action が指定されていません。");
    }

    let payload = null;
    if (action === "health") {
      payload = { ok: true, message: "ok" };
    } else if (action === "login") {
      payload = login_(params);
    } else if (action === "listJobs") {
      payload = listJobs_(params);
    } else if (action === "apply") {
      payload = apply_(params);
    } else {
      throw apiError_("invalid_action", "対応していない action です。");
    }

    return respond_(callback, payload);
  } catch (error) {
    const code = String(error?.code || "internal_error");
    const message = String(error?.message || "予期しないエラーが発生しました。");

    if (code === "internal_error") {
      console.error(error);
    }

    return respond_(callback, {
      ok: false,
      errorCode: code,
      message
    });
  }
}

function login_(params) {
  const name = String(params.name || "");
  const normalizedName = normalizeLoginName_(name);
  const password = String(params.password || "").trim();

  if (!normalizedName || !password) {
    throw apiError_("invalid_credentials", "名前とパスワードを入力してください。");
  }

  const loginPassword = getLoginPassword_();
  if (password !== loginPassword) {
    throw apiError_("invalid_credentials", "名前またはパスワードが正しくありません。");
  }

  const users = readUsers_();
  const matched = users.find((user) => normalizeLoginName_(user.name) === normalizedName);

  if (!matched) {
    throw apiError_("invalid_credentials", "名前またはパスワードが正しくありません。");
  }

  const now = Date.now();
  const expiresAt = now + 12 * 60 * 60 * 1000;
  const sessionPayload = {
    name: matched.name,
    role: matched.role,
    email: matched.email,
    exp: expiresAt
  };

  const token = signToken_(sessionPayload);

  return {
    ok: true,
    session: {
      token,
      name: matched.name,
      role: matched.role,
      email: matched.email,
      expiresAt
    }
  };
}

function normalizeLoginName_(value) {
  return String(value || "")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function listJobs_(params) {
  const session = requireSession_(params.token);
  const ss = getSpreadsheet_();

  const jobs = readJobs_(ss);
  const applications = readApplications_(ss);

  const counts = {};
  const applied = {};

  applications.forEach((application) => {
    if (!application.jobId) {
      return;
    }

    counts[application.jobId] = Number(counts[application.jobId] || 0) + 1;

    if (application.userName === session.name) {
      applied[application.jobId] = true;
    }
  });

  const rows = jobs
    .map((job) => {
      const applicantCount = Number(counts[job.id] || 0);
      return {
        id: job.id,
        title: job.title,
        description: job.description,
        location: job.location,
        deadline: job.deadline,
        maxApplicants: job.maxApplicants,
        applicantCount,
        clientName: job.clientName,
        clientEmail: job.clientEmail,
        formUrl: job.formUrl,
        tags: job.tags,
        applied: Boolean(applied[job.id])
      };
    })
    .sort((a, b) => sortByDeadline_(a.deadline, b.deadline));

  return {
    ok: true,
    profile: {
      name: session.name,
      role: session.role,
      email: session.email
    },
    jobs: rows,
    appliedJobIds: Object.keys(applied)
  };
}

function apply_(params) {
  const session = requireSession_(params.token);

  if (session.role !== "talent") {
    throw apiError_("forbidden", "タレント権限のユーザーのみ応募できます。");
  }

  const jobId = String(params.jobId || "").trim();
  if (!jobId) {
    throw apiError_("invalid_argument", "jobId が必要です。");
  }
  const contactEmail = normalizeEmail_(params.contactEmail);
  if (!isValidEmail_(contactEmail)) {
    throw apiError_("invalid_email", "確認メール送信先のメールアドレスが不正です。");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const ss = getSpreadsheet_();
    const jobs = readJobs_(ss);
    const target = jobs.find((job) => job.id === jobId);

    if (!target) {
      throw apiError_("not_found", "案件が見つかりません。");
    }

    const applications = readApplications_(ss);
    const sameJobApplications = applications.filter((application) => application.jobId === jobId);

    if (sameJobApplications.some((application) => application.userName === session.name)) {
      throw apiError_("already_applied", "この案件には既に応募済みです。");
    }

    const deadline = parseDate_(target.deadline);
    const now = new Date();

    if (!(deadline instanceof Date) || Number.isNaN(deadline.getTime()) || deadline < now) {
      throw apiError_("deadline_passed", "応募締切を過ぎています。");
    }

    if (target.maxApplicants > 0 && sameJobApplications.length >= target.maxApplicants) {
      throw apiError_("quota_full", "応募人数が上限に達しています。");
    }

    const application = {
      applicationId: Utilities.getUuid(),
      jobId,
      userName: session.name,
      userEmail: contactEmail,
      userRole: session.role,
      submittedAt: new Date(),
      status: "applied"
    };

    appendApplication_(ss, application);

    const applicantCount = sameJobApplications.length + 1;
    updateJobApplicantCount_(target, applicantCount);
    sendApplicantReceiptEmail_(target, session.name, contactEmail, applicantCount);

    return {
      ok: true,
      applicantCount
    };
  } finally {
    lock.releaseLock();
  }
}

function sendDeadlineMorningEmails() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const ss = getSpreadsheet_();
    const jobs = readJobs_(ss);
    const applications = readApplications_(ss);
    const now = new Date();

    let sentCount = 0;
    let skippedNoClient = 0;

    jobs.forEach((job) => {
      const deadline = parseDate_(job.deadline);
      if (!shouldSendDeadlineSummary_(deadline, now)) {
        return;
      }

      if (isDeadlineSummarySent_(job)) {
        return;
      }

      const jobApplicants = applications
        .filter((application) => application.jobId === job.id)
        .sort((a, b) => parseDate_(a.submittedAt).getTime() - parseDate_(b.submittedAt).getTime());

      const sent = sendClientDeadlineSummaryEmail_(job, jobApplicants);
      if (!sent) {
        skippedNoClient += 1;
        return;
      }

      markDeadlineSummarySent_(job, now);
      sentCount += 1;
    });

    return {
      ok: true,
      sentCount,
      skippedNoClient
    };
  } finally {
    lock.releaseLock();
  }
}

function collectParams_(e) {
  const params = {};

  if (e && e.parameter) {
    Object.keys(e.parameter).forEach((key) => {
      params[key] = e.parameter[key];
    });
  }

  if (e && e.postData && e.postData.contents) {
    try {
      const body = JSON.parse(e.postData.contents);
      Object.keys(body || {}).forEach((key) => {
        params[key] = body[key];
      });
    } catch (error) {
      console.warn("postData parse failed", error);
    }
  }

  return params;
}

function respond_(callback, payload) {
  if (callback) {
    const js = `${callback}(${JSON.stringify(payload)});`;
    return ContentService.createTextOutput(js).setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function getSpreadsheet_() {
  const id = String(PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID") || "").trim();

  if (id) {
    return SpreadsheetApp.openById(id);
  }

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    return active;
  }

  throw apiError_("config_error", "SPREADSHEET_ID が未設定です。");
}

function readUsers_() {
  const sheet = getTalentSheet_();
  const table = readTableFromSheet_(sheet);
  const nameCol = findHeaderIndex_(table.headers, ["name", "名前", "氏名", "ユーザー名", "username"]);
  const roleCol = findHeaderIndex_(table.headers, ["role", "権限"]);
  const emailCol = findHeaderIndex_(table.headers, ["email", "mail", "メール", "メールアドレス"]);

  if (nameCol < 0) {
    throw apiError_("config_error", "タレント名簿シートに `名前` 列が必要です。");
  }

  return table.rows
    .map((row) => ({
      name: String(row[nameCol] || "").trim(),
      role: normalizeRole_(roleCol >= 0 ? row[roleCol] : "talent"),
      email: String(emailCol >= 0 ? row[emailCol] || "" : "").trim().toLowerCase()
    }))
    .filter((row) => row.name);
}

function readJobs_(ss) {
  const jobsSheetName = getJobsSheetName_(ss);
  const table = readTable_(ss, jobsSheetName, false);

  const idCol = findHeaderIndex_(table.headers, ["job_id", "jobid", "id", "案件id"]);
  const titleCol = findHeaderIndex_(table.headers, ["title", "案件名"]);
  const descriptionCol = findHeaderIndex_(table.headers, ["description", "詳細", "説明"]);
  const locationCol = findHeaderIndex_(table.headers, ["location", "勤務地"]);
  const deadlineCol = findHeaderIndex_(table.headers, ["deadline", "締切", "締切日時"]);
  const maxApplicantsCol = findHeaderIndex_(table.headers, ["max_applicants", "maxapplicants", "定員", "応募上限"]);
  const clientNameCol = findHeaderIndex_(table.headers, ["client_name", "clientname", "クライアント名"]);
  const clientEmailCol = findHeaderIndex_(table.headers, ["client_email", "clientemail", "クライアントメール"]);
  const formUrlCol = findHeaderIndex_(table.headers, ["form_url", "formurl", "googleform", "選考フォーム"]);
  const tagsCol = findHeaderIndex_(table.headers, ["tags", "tag", "カテゴリ", "category"]);
  const applicantCountCol = findHeaderIndex_(table.headers, ["applicant_count", "applicantcount", "応募人数"]);
  const deadlineNotifiedAtCol = findHeaderIndex_(table.headers, [
    "deadline_notified_at",
    "deadlinenotifiedat",
    "締切通知日時",
    "通知日時",
    "送信日時"
  ]);

  if (titleCol < 0 || deadlineCol < 0) {
    throw apiError_("config_error", "jobs シートに title/deadline 列が必要です。");
  }

  return table.rows
    .map((row, index) => {
      const rowNumber = index + 2;
      const rawId = idCol >= 0 ? String(row[idCol] || "").trim() : "";
      const deadlineIso = toIsoString_(row[deadlineCol]);

      return {
        rowNumber,
        sheet: table.sheet,
        applicantCountCol,
        deadlineNotifiedAtCol,
        id: rawId || `job_${rowNumber}`,
        title: String(row[titleCol] || "").trim(),
        description: descriptionCol >= 0 ? String(row[descriptionCol] || "").trim() : "",
        location: locationCol >= 0 ? String(row[locationCol] || "").trim() : "",
        deadline: deadlineIso,
        maxApplicants: parseNumber_(maxApplicantsCol >= 0 ? row[maxApplicantsCol] : 0),
        clientName: clientNameCol >= 0 ? String(row[clientNameCol] || "").trim() : "",
        clientEmail: clientEmailCol >= 0 ? String(row[clientEmailCol] || "").trim() : "",
        formUrl: formUrlCol >= 0 ? String(row[formUrlCol] || "").trim() : "",
        deadlineNotifiedAt: deadlineNotifiedAtCol >= 0 ? row[deadlineNotifiedAtCol] : "",
        tags: parseTags_(tagsCol >= 0 ? row[tagsCol] : "")
      };
    })
    .filter((row) => row.title);
}

function getJobsSheetName_(ss) {
  const props = PropertiesService.getScriptProperties();
  const explicitName = String(props.getProperty("JOBS_SHEET_NAME") || "").trim();

  if (explicitName) {
    const explicitSheet = ss.getSheetByName(explicitName);
    if (!explicitSheet) {
      throw apiError_("config_error", `JOBS_SHEET_NAME=${explicitName} のシートが見つかりません。`);
    }
    return explicitName;
  }

  if (ss.getSheetByName(SHEET_NAMES.jobs)) {
    return SHEET_NAMES.jobs;
  }

  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i += 1) {
    const table = readTableFromSheet_(sheets[i]);
    const hasTitle = findHeaderIndex_(table.headers, ["title", "案件名"]) >= 0;
    const hasDeadline = findHeaderIndex_(table.headers, ["deadline", "締切", "締切日時"]) >= 0;
    if (hasTitle && hasDeadline) {
      return sheets[i].getName();
    }
  }

  throw apiError_(
    "config_error",
    "jobs シートが見つかりません。JOBS_SHEET_NAME を設定するか、title/deadline 列を持つシートを用意してください。"
  );
}

function readApplications_(ss) {
  const table = readTable_(ss, SHEET_NAMES.applications, true);
  if (!table.sheet) {
    return [];
  }

  const applicationIdCol = findHeaderIndex_(table.headers, ["application_id", "applicationid", "id", "応募id"]);
  const jobIdCol = findHeaderIndex_(table.headers, ["job_id", "jobid", "案件id"]);
  const userNameCol = findHeaderIndex_(table.headers, ["user_name", "username", "name", "応募者名"]);
  const userEmailCol = findHeaderIndex_(table.headers, ["user_email", "useremail", "email", "応募者メール"]);
  const userRoleCol = findHeaderIndex_(table.headers, ["user_role", "userrole", "role"]);
  const submittedAtCol = findHeaderIndex_(table.headers, ["submitted_at", "submittedat", "applied_at", "応募日時"]);
  const statusCol = findHeaderIndex_(table.headers, ["status", "状態"]);

  if (jobIdCol < 0 || userNameCol < 0) {
    return [];
  }

  return table.rows
    .map((row) => ({
      applicationId: applicationIdCol >= 0 ? String(row[applicationIdCol] || "").trim() : "",
      jobId: String(row[jobIdCol] || "").trim(),
      userName: String(row[userNameCol] || "").trim(),
      userEmail: userEmailCol >= 0 ? String(row[userEmailCol] || "").trim() : "",
      userRole: userRoleCol >= 0 ? String(row[userRoleCol] || "").trim() : "",
      submittedAt: submittedAtCol >= 0 ? row[submittedAtCol] : "",
      status: statusCol >= 0 ? String(row[statusCol] || "").trim() : "applied"
    }))
    .filter((row) => row.jobId && row.userName);
}

function appendApplication_(ss, application) {
  const sheet = ensureApplicationsSheet_(ss);
  const row = [
    application.applicationId,
    application.jobId,
    application.userName,
    application.userEmail,
    application.userRole,
    application.submittedAt,
    application.status
  ];

  sheet.appendRow(row);
}

function ensureApplicationsSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_NAMES.applications);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.applications);
    sheet.appendRow(APPLICATION_HEADERS);
    return sheet;
  }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(APPLICATION_HEADERS);
    return sheet;
  }

  if (sheet.getLastRow() === 1 && sheet.getLastColumn() === 0) {
    sheet.appendRow(APPLICATION_HEADERS);
  }

  return sheet;
}

function updateJobApplicantCount_(job, applicantCount) {
  if (job.applicantCountCol < 0) {
    return;
  }

  job.sheet.getRange(job.rowNumber, job.applicantCountCol + 1).setValue(applicantCount);
}

function sendApplicantReceiptEmail_(job, applicantName, recipientEmail, applicantCount) {
  if (!recipientEmail) {
    return;
  }

  const deadlineText = formatDate_(parseDate_(job.deadline));
  const title = job.title || "案件";

  MailApp.sendEmail({
    to: recipientEmail,
    subject: `【応募完了】${title}`,
    body: [
      `${applicantName || "応募者"} 様`,
      "",
      "案件への応募を受け付けました。",
      `案件名: ${title}`,
      `締切: ${deadlineText}`,
      `現在の応募人数: ${applicantCount}名`,
      "",
      "クライアントへの最終通知は締切日の翌朝に送信されます。"
    ].join("\n")
  });
}

function sendClientDeadlineSummaryEmail_(job, applicants) {
  const clientEmails = splitEmails_(job.clientEmail);
  if (!clientEmails.length) {
    return false;
  }

  const deadlineText = formatDate_(parseDate_(job.deadline));
  const title = job.title || "案件";
  const applicantLines = applicants.length
    ? applicants
        .map((app, idx) => `${idx + 1}. ${app.userName || "(名前未設定)"} / ${app.userEmail || "(メール未設定)"}`)
        .join("\n")
    : "応募者はまだいません。";

  const formAttachmentText = job.formUrl
    ? `Google Form選考リンク\n${job.formUrl}\n\nこのリンクで1名を選定してください。`
    : "Google Form URLが未設定です。jobs シートの form_url を設定してください。";

  MailApp.sendEmail({
    to: clientEmails.join(","),
    subject: `【締切翌朝通知】${title} の応募一覧`,
    body: [
      `${job.clientName || "クライアント"} 様`,
      "",
      `${title} は締切を迎えました。応募一覧を送付します。`,
      `締切: ${deadlineText}`,
      `応募人数: ${applicants.length}名`,
      "",
      "応募者一覧:",
      applicantLines,
      "",
      job.formUrl ? `選考フォーム: ${job.formUrl}` : "選考フォームURL未設定"
    ].join("\n"),
    attachments: [Utilities.newBlob(formAttachmentText, "text/plain", "selection-form.txt")]
  });

  return true;
}

function shouldSendDeadlineSummary_(deadline, now) {
  if (!(deadline instanceof Date) || Number.isNaN(deadline.getTime())) {
    return false;
  }

  const todayStart = startOfDay_(now);
  const deadlineDayStart = startOfDay_(deadline);
  return todayStart.getTime() > deadlineDayStart.getTime();
}

function isDeadlineSummarySent_(job) {
  if (job.deadlineNotifiedAt === "" || job.deadlineNotifiedAt === null || job.deadlineNotifiedAt === undefined) {
    return false;
  }

  if (job.deadlineNotifiedAt instanceof Date) {
    return !Number.isNaN(job.deadlineNotifiedAt.getTime());
  }

  return String(job.deadlineNotifiedAt).trim() !== "";
}

function markDeadlineSummarySent_(job, when) {
  const col = ensureDeadlineNotifiedColumn_(job);
  if (col < 0) {
    return;
  }

  job.sheet.getRange(job.rowNumber, col + 1).setValue(when);
  job.deadlineNotifiedAt = when;
}

function ensureDeadlineNotifiedColumn_(job) {
  if (job.deadlineNotifiedAtCol >= 0) {
    return job.deadlineNotifiedAtCol;
  }

  const sheet = job.sheet;
  const newColIndex = sheet.getLastColumn();
  sheet.getRange(1, newColIndex + 1).setValue("deadline_notified_at");
  job.deadlineNotifiedAtCol = newColIndex;
  return newColIndex;
}

function requireSession_(token) {
  const rawToken = String(token || "").trim();
  if (!rawToken) {
    throw apiError_("unauthorized", "ログインが必要です。");
  }

  const payload = verifyToken_(rawToken);
  return {
    name: String(payload.name || ""),
    role: normalizeRole_(payload.role || "talent"),
    email: String(payload.email || "").trim().toLowerCase(),
    exp: Number(payload.exp || 0)
  };
}

function signToken_(payload) {
  const secret = getSecret_();
  const body = stripPadding_(Utilities.base64EncodeWebSafe(JSON.stringify(payload)));
  const sig = stripPadding_(Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, secret)));
  return `${body}.${sig}`;
}

function verifyToken_(token) {
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw apiError_("invalid_token", "トークン形式が不正です。");
  }

  const [body, signature] = parts;
  const expected = stripPadding_(Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, getSecret_())));

  if (!safeEqual_(signature, expected)) {
    throw apiError_("invalid_token", "トークン署名が一致しません。");
  }

  let payload = null;
  try {
    const json = Utilities.newBlob(Utilities.base64DecodeWebSafe(body)).getDataAsString();
    payload = JSON.parse(json);
  } catch (error) {
    throw apiError_("invalid_token", `トークン解析に失敗しました: ${error.message}`);
  }

  if (!payload || Number(payload.exp || 0) <= Date.now()) {
    throw apiError_("token_expired", "セッションの有効期限が切れています。");
  }

  if (!payload.name) {
    throw apiError_("invalid_token", "トークンに name がありません。");
  }

  return payload;
}

function getSecret_() {
  const secret = String(PropertiesService.getScriptProperties().getProperty("APP_SECRET") || "").trim();
  if (!secret) {
    throw apiError_("config_error", "APP_SECRET が設定されていません。");
  }
  return secret;
}

function readTable_(ss, sheetName, optional) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    if (optional) {
      return {
        sheet: null,
        headers: [],
        rows: []
      };
    }
    throw apiError_("config_error", `${sheetName} シートが見つかりません。`);
  }

  return readTableFromSheet_(sheet);
}

function readTableFromSheet_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow < 1 || lastColumn < 1) {
    return {
      sheet,
      headers: [],
      rows: []
    };
  }

  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = values[0].map((value) => normalizeHeader_(value));
  const rows = values.slice(1);

  return {
    sheet,
    headers,
    rows
  };
}

function getTalentSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const explicitId = String(props.getProperty("TALENT_SPREADSHEET_ID") || "").trim();

  if (explicitId) {
    return SpreadsheetApp.openById(explicitId);
  }

  return getSpreadsheet_();
}

function getTalentSheet_() {
  const ss = getTalentSpreadsheet_();
  const props = PropertiesService.getScriptProperties();
  const explicitName = String(props.getProperty("TALENT_SHEET_NAME") || "").trim();

  if (explicitName) {
    const sheet = ss.getSheetByName(explicitName);
    if (!sheet) {
      throw apiError_("config_error", `TALENT_SHEET_NAME=${explicitName} のシートが見つかりません。`);
    }
    return sheet;
  }

  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i += 1) {
    const table = readTableFromSheet_(sheets[i]);
    if (findHeaderIndex_(table.headers, ["名前", "name", "氏名"]) >= 0) {
      return sheets[i];
    }
  }

  if (!sheets.length) {
    throw apiError_("config_error", "タレント名簿スプレッドシートにシートが存在しません。");
  }

  return sheets[0];
}

function getLoginPassword_() {
  const password = String(PropertiesService.getScriptProperties().getProperty("LOGIN_PASSWORD") || "").trim();
  if (!password) {
    throw apiError_("config_error", "LOGIN_PASSWORD が設定されていません。");
  }
  return password;
}

function findHeaderIndex_(headers, candidates) {
  for (let i = 0; i < candidates.length; i += 1) {
    const normalized = normalizeHeader_(candidates[i]);
    const index = headers.indexOf(normalized);
    if (index >= 0) {
      return index;
    }
  }
  return -1;
}

function normalizeHeader_(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[＿_\-]/g, "");
}

function normalizeRole_(raw) {
  const value = String(raw || "talent").trim().toLowerCase();

  if (value === "talent" || value === "client" || value === "admin") {
    return value;
  }

  if (value === "タレント" || value === "応募者") {
    return "talent";
  }

  if (value === "クライアント") {
    return "client";
  }

  if (value === "管理者") {
    return "admin";
  }

  return "talent";
}

function parseTags_(raw) {
  return String(raw || "")
    .split(",")
    .map((value) => String(value || "").trim())
    .filter((value) => value);
}

function parseNumber_(raw) {
  const value = Number(raw || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function parseDate_(raw) {
  if (raw instanceof Date) {
    return raw;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function startOfDay_(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDate_(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "未設定";
  }
  return Utilities.formatDate(date, "Asia/Tokyo", "yyyy/MM/dd HH:mm");
}

function toIsoString_(raw) {
  const date = parseDate_(raw);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString();
}

function sortByDeadline_(a, b) {
  const aDate = parseDate_(a);
  const bDate = parseDate_(b);

  const aMs = aDate.getTime();
  const bMs = bDate.getTime();

  const safeA = Number.isNaN(aMs) ? Number.MAX_SAFE_INTEGER : aMs;
  const safeB = Number.isNaN(bMs) ? Number.MAX_SAFE_INTEGER : bMs;

  return safeA - safeB;
}

function splitEmails_(raw) {
  return String(raw || "")
    .split(",")
    .map((value) => normalizeEmail_(value))
    .filter((value) => value);
}

function normalizeEmail_(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail_(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail_(value));
}

function sanitizeCallback_(raw) {
  const value = String(raw || "").trim();
  return /^[a-zA-Z0-9_$.]+$/.test(value) ? value : "";
}

function stripPadding_(value) {
  return String(value || "").replace(/=+$/g, "");
}

function safeEqual_(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}

function apiError_(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function setupSampleSheets() {
  const ss = getSpreadsheet_();

  let jobs = ss.getSheetByName(SHEET_NAMES.jobs);
  if (!jobs) {
    jobs = ss.insertSheet(SHEET_NAMES.jobs);
    jobs.appendRow([
      "job_id",
      "title",
      "description",
      "location",
      "deadline",
      "max_applicants",
      "client_name",
      "client_email",
      "form_url",
      "tags",
      "applicant_count"
    ]);
    jobs.appendRow([
      "job_demo_001",
      "イベントMC（都内）",
      "週末イベントの進行",
      "東京都",
      new Date(new Date().getTime() + 7 * 24 * 60 * 60 * 1000),
      8,
      "ABCイベント制作",
      "client@example.com",
      "https://forms.gle/YOUR_FORM_ID",
      "MC,イベント",
      0
    ]);
  }

  ensureApplicationsSheet_(ss);

  const talentSs = getTalentSpreadsheet_();
  const talentSheetName = String(PropertiesService.getScriptProperties().getProperty("TALENT_SHEET_NAME") || "").trim() || "talent_master";
  let talents = talentSs.getSheetByName(talentSheetName);

  if (!talents) {
    talents = talentSs.insertSheet(talentSheetName);
    talents.appendRow(TALENT_HEADERS);
    talents.appendRow([new Date(), "sample_talent", "", "", "", "", "", "", "", "", "", "", "", ""]);
  }
}
