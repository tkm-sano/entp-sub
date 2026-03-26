import fs from 'fs';
import path from 'path';

// jobs.json を読み込み
let jobs;
try {
  jobs = JSON.parse(fs.readFileSync('../../_data/jobs.json', 'utf-8'));
  if (!Array.isArray(jobs)) {
    throw new Error('jobs.json がArray形式ではありません');
  }
  console.log(`jobs.json を読み込みました（${jobs.length} 件）`);
} catch (error) {
  console.error('Error: jobs.json の読み込みに失敗しました:', error.message);
  process.exit(1);
}

const jobsDir = '../../_jobs';

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'job';
}

function yamlString(value) {
  return String(value ?? '').replace(/"/g, '\\"');
}

function safeNumber(value) {
  const num = Number(value);
  return isNaN(num) ? 0 : Math.max(0, Math.floor(num));
}

// フィールド値を取得（英語か日本語の列名を自動判定）
function getField(job, enName, jpName = null) {
  return String(job[enName] || job[jpName] || '').trim();
}

// 複数の候補キーから最初の値を取得（列名の揺れ対策）
function getFirstField(job, keys = []) {
  for (const key of keys) {
    const value = job?.[key];
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function safeCount(value) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  const matched = text.match(/\d+/);
  return matched ? safeNumber(matched[0]) : safeNumber(text);
}

// _jobsディレクトリを初期化
if (fs.existsSync(jobsDir)) {
  // 既存のファイルを削除（古いデータをクリーンアップ）
  fs.readdirSync(jobsDir).forEach(file => {
    if (file.endsWith('.md')) {
      fs.unlinkSync(path.join(jobsDir, file));
    }
  });
} else {
  fs.mkdirSync(jobsDir, { recursive: true });
}

let generatedCount = 0;
let skippedCount = 0;

jobs.forEach((job, index) => {
  // 案件タイトルを取得（英語か日本語の列名を試す）
  const title = getFirstField(job, ['title', '案件名', '案件タイトル']);
  if (!title) {
    console.warn(`Warning: 行 ${index + 2} - 案件名が空のためスキップしました`);
    skippedCount++;
    return;
  }

  // Code.gs では job_2, job_3 のような形式で ID を生成
  const rowNumber = index + 2; // ヘッダー行を除く
  const jobId = `job_${rowNumber}`;
  const filename = jobId;
  const categoryValue = getFirstField(job, ['category', 'カテゴリー', 'カテゴリ']);
  const clientNameValue = getFirstField(job, ['client_name', 'クライアント名']);
  const clientEmailValue = getFirstField(job, ['client_email', 'クライアントメール']);
  const shootingContentValue = getFirstField(job, ['shooting_content', 'shoot_description', 'description', '案件説明']);
  const conceptValue = getFirstField(job, ['concept', 'コンセプト']);
  const shootingDatesValue = getFirstField(job, ['shooting_dates', 'candidate_shoot_dates', '実施日時', '日時']);
  const durationValue = getFirstField(job, ['duration', 'duration_hours', '拘束時間']);
  const shootingLocationValue = getFirstField(job, ['shooting_location', 'shoot_location', 'location', '実施場所', '場所']);
  const usageMediaValue = getFirstField(job, ['usage_media', 'media_usage', 'media', '媒体']);
  const usagePeriodValue = getFirstField(job, ['usage_period', 'period', '使用期間']);
  const competitionValue = getFirstField(job, ['competition', 'competition_presence', '競合']);
  const makeupValue = getFirstField(job, ['makeup', 'メイク・ヘアメイクの有無', 'メイク・ヘアメイクスタッフの有無']);
  const feeValue = getFirstField(job, ['fee', '報酬（交通費込）', '報酬']);
  const belongingsValue = getFirstField(job, ['belongings', 'items_to_bring', '持ち物']);
  const maxApplicantsValue = getFirstField(job, ['max_applicants', '募集人数']);
  const applicantCountValue = getFirstField(job, ['applicant_count', '応募者数', '応募数', '現在申し込まれている人数']);
  const deadlineValue = getFirstField(job, ['deadline', '残り日数', '締切', '締切日']);
  const formUrlValue = getFirstField(job, ['form_url', 'フォームURL', 'フォームurl']);
  const deadlineNotifiedAtValue = getFirstField(job, ['deadline_notified_at', '通知日時']);
  const detailHtmlValue = getFirstField(job, ['details', '詳細', '案件説明']) || '<p>案件詳細はここに記載</p>';

  // Code.gs で使用されるフィールドを全て含める（英語・日本語対応）
  const content = `---
layout: job
title: "${yamlString(title)}"
job_id: "${yamlString(jobId)}"
category: "${yamlString(categoryValue)}"
client_name: "${yamlString(clientNameValue)}"
client_email: "${yamlString(clientEmailValue)}"
shooting_content: "${yamlString(shootingContentValue)}"
concept: "${yamlString(conceptValue)}"
shooting_dates: "${yamlString(shootingDatesValue)}"
duration: "${yamlString(durationValue)}"
shooting_location: "${yamlString(shootingLocationValue)}"
usage_media: "${yamlString(usageMediaValue)}"
usage_period: "${yamlString(usagePeriodValue)}"
competition: "${yamlString(competitionValue)}"
makeup: "${yamlString(makeupValue)}"
fee: "${yamlString(feeValue)}"
belongings: "${yamlString(belongingsValue)}"
max_applicants: ${safeCount(maxApplicantsValue)}
applicant_count: ${safeCount(applicantCountValue)}
deadline: "${yamlString(deadlineValue)}"
form_url: "${yamlString(formUrlValue)}"
deadline_notified_at: "${yamlString(deadlineNotifiedAtValue)}"
---
${detailHtmlValue}
`;

  try {
    fs.writeFileSync(path.join(jobsDir, `${filename}.md`), content, 'utf-8');
    generatedCount++;
  } catch (error) {
    console.error(`Error: ${filename}.md の作成に失敗しました:`, error.message);
    skippedCount++;
  }
});

console.log(`_jobs に ${generatedCount} 件の Markdown を生成しました`);
if (skippedCount > 0) {
  console.warn(`${skippedCount} 件の求人をスキップしました`);
}