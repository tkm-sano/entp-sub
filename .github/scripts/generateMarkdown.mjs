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
  const title = getField(job, 'title', '案件名');
  if (!title) {
    console.warn(`Warning: 行 ${index + 2} - 案件名が空のためスキップしました`);
    skippedCount++;
    return;
  }

  // Code.gs では job_2, job_3 のような形式で ID を生成
  const rowNumber = index + 2; // ヘッダー行を除く
  const jobId = `job_${rowNumber}`;
  const filename = jobId;

  // Code.gs で使用されるフィールドを全て含める（英語・日本語対応）
  const content = `---
layout: job
title: "${yamlString(title)}"
job_id: "${yamlString(jobId)}"
category: "${yamlString(getField(job, 'category', 'カテゴリー'))}"
client_name: "${yamlString(getField(job, 'client_name', 'クライアント名'))}"
client_email: "${yamlString(getField(job, 'client_email', 'クライアントメール'))}"
shooting_content: "${yamlString(getField(job, 'shooting_content', '案件説明') || getField(job, 'description'))}"
concept: "${yamlString(getField(job, 'concept', 'コンセプト'))}"
shooting_dates: "${yamlString(getField(job, 'shooting_dates', '実施日時'))}"
duration: "${yamlString(getField(job, 'duration', '拘束時間'))}"
shooting_location: "${yamlString(getField(job, 'shooting_location', '実施場所') || getField(job, 'location'))}"
usage_media: "${yamlString(getField(job, 'usage_media', '媒体'))}"
usage_period: "${yamlString(getField(job, 'usage_period', '使用期間'))}"
competition: "${yamlString(getField(job, 'competition', '競合'))}"
fee: "${yamlString(getField(job, 'fee', '報酬'))}"
belongings: "${yamlString(getField(job, 'belongings', '持ち物'))}"
max_applicants: ${safeNumber(getField(job, 'max_applicants', '募集人数'))}
applicant_count: ${safeNumber(getField(job, 'applicant_count', '応募者数'))}
deadline: "${yamlString(getField(job, 'deadline', '残り日数'))}"
form_url: "${yamlString(getField(job, 'form_url', 'フォームURL'))}"
deadline_notified_at: "${yamlString(getField(job, 'deadline_notified_at', '通知日時'))}"
---
${getField(job, 'details', '詳細') || '<p>案件詳細はここに記載</p>'}
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