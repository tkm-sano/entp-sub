import fs from 'fs';
import path from 'path';

const jobs = JSON.parse(fs.readFileSync('../../_data/jobs.json', 'utf-8'));
const jobsDir = '../../_jobs';

if (!fs.existsSync(jobsDir)) fs.mkdirSync(jobsDir);

jobs.forEach(job => {
  const content = `---
layout: job
title: "${job.title}"
job_id: "${job.id}"
category: "${job.category}"
max_applicants: ${job.max_applicants}
applicant_count: ${job.applicant_count}
deadline: ${job.deadline}
---
<p>案件詳細はここに記載</p>
`;
  fs.writeFileSync(path.join(jobsDir, `${job.id}.md`), content);
});
console.log(`_jobs に ${jobs.length} 件の Markdown を生成しました`);