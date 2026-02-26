import fs from 'fs';
import path from 'path';

const jobs = JSON.parse(fs.readFileSync('../../_data/jobs.json', 'utf-8'));
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

if (!fs.existsSync(jobsDir)) fs.mkdirSync(jobsDir);

jobs.forEach(job => {
  const jobId = String(job.job_id || job.id || '').trim();
  const filename = jobId || slugify(job.title);
  const content = `---
layout: job
title: "${yamlString(job.title)}"
job_id: "${yamlString(jobId || filename)}"
category: "${yamlString(job.category)}"
client_name: "${yamlString(job.client_name)}"
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
max_applicants: ${Number(job.max_applicants || 0)}
applicant_count: ${Number(job.applicant_count || 0)}
deadline: "${yamlString(job.deadline)}"
---
<p>案件詳細はここに記載</p>
`;
  fs.writeFileSync(path.join(jobsDir, `${filename}.md`), content);
});
console.log(`_jobs に ${jobs.length} 件の Markdown を生成しました`);