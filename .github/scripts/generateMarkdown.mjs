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
  // Code.gs の listJobs_ に合わせて、titleが必須
  const title = String(job.title || '').trim();
  if (!title) {
    console.warn(`Warning: 行 ${index + 2} - titleが空のためスキップしました`);
    skippedCount++;
    return;
  }

  // Code.gs では job_2, job_3 のような形式で ID を生成
  const rowNumber = index + 2; // ヘッダー行を除く
  const jobId = `job_${rowNumber}`;
  const filename = slugify(title);

  // Code.gs で使用されるフィールドを全て含める
  const content = `---
layout: job
title: "${yamlString(title)}"
job_id: "${yamlString(jobId)}"
category: "${yamlString(job.category)}"
client_name: "${yamlString(job.client_name)}"
client_email: "${yamlString(job.client_email)}"
shooting_content: "${yamlString(job.shooting_content || job.description)}"
concept: "${yamlString(job.concept)}"
shooting_dates: "${yamlString(job.shooting_dates)}"
duration: "${yamlString(job.duration)}"
shooting_location: "${yamlString(job.shooting_location || job.location)}"
usage_media: "${yamlString(job.usage_media)}"
usage_period: "${yamlString(job.usage_period)}"
competition: "${yamlString(job.competition)}"
fee: "${yamlString(job.fee)}"
belongings: "${yamlString(job.belongings)}"
max_applicants: ${safeNumber(job.max_applicants)}
applicant_count: ${safeNumber(job.applicant_count)}
deadline: "${yamlString(job.deadline)}"
form_url: "${yamlString(job.form_url)}"
deadline_notified_at: "${yamlString(job.deadline_notified_at)}"
---
${job.details || '<p>案件詳細はここに記載</p>'}
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