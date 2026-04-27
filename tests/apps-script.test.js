const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CODE_GS_PATH = path.join(__dirname, "..", "apps-script", "Code.gs");
const APPS_SCRIPT_JSON_PATH = path.join(__dirname, "..", "apps-script", "appsscript.json");

function formatInTimeZone(date, timeZone, format) {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  const base = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  if (format === "yyyy-MM-dd'T'HH:mm") {
    return base;
  }
  if (format === "yyyy-MM-dd'T'HH:mm:ss.SSS") {
    return `${base}:${parts.second}.${String(date.getMilliseconds()).padStart(3, "0")}`;
  }
  throw new Error(`Unsupported format: ${format}`);
}

function loadAppsScript(overrides = {}) {
  const sendEmailCalls = [];
  const aliases = overrides.aliases || [];
  const activeUserEmail = overrides.activeUserEmail || "owner@example.com";
  const code = fs.readFileSync(CODE_GS_PATH, "utf8");
  const sandbox = {
    console,
    JSON,
    Math,
    Date,
    String,
    Number,
    Boolean,
    RegExp,
    Array,
    Object,
    Utilities: {
      formatDate(date, timeZone, format) {
        return formatInTimeZone(date, timeZone, format);
      }
    },
    Session: {
      getActiveUser() {
        return {
          getEmail() {
            return activeUserEmail;
          }
        };
      }
    },
    GmailApp: {
      getAliases() {
        return aliases.slice();
      },
      sendEmail(to, subject, body, options) {
        sendEmailCalls.push({ to, subject, body, options });
      }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(
    `${code}
globalThis.__testExports = {
  sendMail_,
  sendConfirmationEmail_,
  sendClientApplicantListEmail_,
  testSendClientApplicantListEmail,
  formatStoredTimestamp_,
  parseDate_,
  MAIL_SENDER_EMAIL,
  MAIL_SENDER_NAME,
  STORED_TIMESTAMP_FORMAT
};`,
    sandbox,
    { filename: "Code.gs" }
  );

  return {
    ...sandbox.__testExports,
    sendEmailCalls
  };
}

function normalizeForAssertion(value) {
  return JSON.parse(JSON.stringify(value));
}

test("formatStoredTimestamp_ stores timestamps only to the minute", () => {
  const { formatStoredTimestamp_ } = loadAppsScript();

  assert.equal(
    formatStoredTimestamp_(new Date("2026-04-24T12:34:56.789+09:00")),
    "2026-04-24T12:34"
  );
  assert.equal(
    formatStoredTimestamp_("2026-04-24T03:04:59.999Z"),
    "2026-04-24T12:04"
  );
});

test("sendMail_ sends from info@missconnect.jp when the alias is available", () => {
  const { sendMail_, sendEmailCalls, MAIL_SENDER_EMAIL, MAIL_SENDER_NAME } = loadAppsScript({
    activeUserEmail: "owner@example.com",
    aliases: ["info@missconnect.jp"]
  });

  sendMail_("talent@example.com", "Subject", "Body", { cc: "staff@example.com" });

  assert.equal(sendEmailCalls.length, 1);
  assert.deepEqual(normalizeForAssertion(sendEmailCalls[0]), {
    to: "talent@example.com",
    subject: "Subject",
    body: "Body",
    options: {
      name: MAIL_SENDER_NAME,
      replyTo: MAIL_SENDER_EMAIL,
      cc: "staff@example.com",
      from: MAIL_SENDER_EMAIL
    }
  });
});

test("sendMail_ does not add from when the active user already matches the sender", () => {
  const { sendMail_, sendEmailCalls, MAIL_SENDER_EMAIL, MAIL_SENDER_NAME } = loadAppsScript({
    activeUserEmail: "info@missconnect.jp",
    aliases: []
  });

  sendMail_("talent@example.com", "Subject", "Body");

  assert.equal(sendEmailCalls.length, 1);
  assert.deepEqual(normalizeForAssertion(sendEmailCalls[0]), {
    to: "talent@example.com",
    subject: "Subject",
    body: "Body",
    options: {
      name: MAIL_SENDER_NAME,
      replyTo: MAIL_SENDER_EMAIL
    }
  });
});

test("sendMail_ fails clearly when the configured sender alias is missing", () => {
  const { sendMail_, sendEmailCalls } = loadAppsScript({
    activeUserEmail: "owner@example.com",
    aliases: ["support@missconnect.jp"]
  });

  assert.throws(
    () => sendMail_("talent@example.com", "Subject", "Body"),
    /Gmailの送信元として info@missconnect\.jp のエイリアス設定が必要です。/
  );
  assert.equal(sendEmailCalls.length, 0);
});

test("sendConfirmationEmail_ sends the applicant confirmation email", () => {
  const { sendConfirmationEmail_, sendEmailCalls, MAIL_SENDER_EMAIL, MAIL_SENDER_NAME } = loadAppsScript({
    activeUserEmail: "info@missconnect.jp"
  });

  sendConfirmationEmail_("talent@example.com", "山田 花子", {
    jobTitle: "美容商材PR",
    detailLines: [
      "案件名：美容商材PR",
      "報酬：10,000円",
      "参加可能日程：2026年05月01日 10:00"
    ]
  });

  assert.equal(sendEmailCalls.length, 1);
  assert.equal(sendEmailCalls[0].to, "talent@example.com");
  assert.equal(sendEmailCalls[0].subject, "【応募確認】美容商材PR");
  assert.match(sendEmailCalls[0].body, /山田 花子 様/);
  assert.match(sendEmailCalls[0].body, /このたびはご応募いただき、誠にありがとうございます。/);
  assert.match(sendEmailCalls[0].body, /参加可能日程：2026年05月01日 10:00/);
  assert.deepEqual(normalizeForAssertion(sendEmailCalls[0].options), {
    name: MAIL_SENDER_NAME,
    replyTo: MAIL_SENDER_EMAIL
  });
});

test("sendClientApplicantListEmail_ sends the client applicant list email", () => {
  const { sendClientApplicantListEmail_, sendEmailCalls, MAIL_SENDER_EMAIL, MAIL_SENDER_NAME } = loadAppsScript({
    activeUserEmail: "info@missconnect.jp"
  });

  sendClientApplicantListEmail_(["client@example.com", "sub@example.com"], {
    title: "美容商材PR",
    deadlineStr: "2026年05月01日",
    applicantCount: 2,
    applicantLines: [
      [
        "・山田 花子",
        "  https://example.com/yamada",
        "  参加可能日程: 2026年05月03日 10:00"
      ].join("\n"),
      [
        "・佐藤 太郎",
        "  （URLなし）",
        "  参加可能日程: （未回答）"
      ].join("\n")
    ],
    formUrl: "https://example.com/model-decision-form"
  });

  assert.equal(sendEmailCalls.length, 1);
  assert.equal(sendEmailCalls[0].to, "client@example.com,sub@example.com");
  assert.equal(sendEmailCalls[0].subject, "【応募者一覧】美容商材PR");
  assert.match(sendEmailCalls[0].body, /2026年05月01日をもちまして応募受付を終了いたしました。/);
  assert.match(sendEmailCalls[0].body, /応募者数：2名/);
  assert.match(sendEmailCalls[0].body, /・山田 花子/);
  assert.match(sendEmailCalls[0].body, /https:\/\/example\.com\/model-decision-form/);
  assert.deepEqual(normalizeForAssertion(sendEmailCalls[0].options), {
    name: MAIL_SENDER_NAME,
    replyTo: MAIL_SENDER_EMAIL,
    cc: "kaito.suzuki@missconnect.jp"
  });
});

test("testSendClientApplicantListEmail sends only to the active user", () => {
  const { testSendClientApplicantListEmail, sendEmailCalls, MAIL_SENDER_EMAIL, MAIL_SENDER_NAME } = loadAppsScript({
    activeUserEmail: "tester@example.com",
    aliases: ["info@missconnect.jp"]
  });

  const result = testSendClientApplicantListEmail();

  assert.equal(result, "クライアント向け応募者一覧メールのテスト送信が完了しました: tester@example.com");
  assert.equal(sendEmailCalls.length, 1);
  assert.equal(sendEmailCalls[0].to, "tester@example.com");
  assert.equal(sendEmailCalls[0].subject, "【応募者一覧】テスト案件");
  assert.match(sendEmailCalls[0].body, /応募者数：2名/);
  assert.match(sendEmailCalls[0].body, /・テスト応募者A/);
  assert.deepEqual(normalizeForAssertion(sendEmailCalls[0].options), {
    name: MAIL_SENDER_NAME,
    replyTo: MAIL_SENDER_EMAIL,
    from: MAIL_SENDER_EMAIL
  });
});

test("appsscript.json includes the Gmail scope required for alias sending", () => {
  const config = JSON.parse(fs.readFileSync(APPS_SCRIPT_JSON_PATH, "utf8"));

  assert.ok(Array.isArray(config.oauthScopes));
  assert.ok(config.oauthScopes.includes("https://mail.google.com/"));
});
