#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const jobsDataPath = path.join(rootDir, "_data", "jobs.json");
const jobsOutputDir = path.join(rootDir, "_jobs");

function toYamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function clearExistingJobPages() {
  if (!fs.existsSync(jobsOutputDir)) {
    return;
  }

  for (const entry of fs.readdirSync(jobsOutputDir)) {
    if (entry.endsWith(".md")) {
      fs.unlinkSync(path.join(jobsOutputDir, entry));
    }
  }
}

function readJobs() {
  const raw = fs.readFileSync(jobsDataPath, "utf8");
  const jobs = JSON.parse(raw);
  if (!Array.isArray(jobs)) {
    throw new Error("_data/jobs.json must be an array.");
  }
  return jobs;
}

function buildFrontMatter(job) {
  const title = job.title || job.name || job.job_title || "案件詳細";
  const jobId = String(job.job_id || job.id || "").trim();

  if (!jobId) {
    throw new Error(`Missing job_id for job: ${title}`);
  }

  return [
    "---",
    'layout: "job"',
    `title: ${toYamlString(title)}`,
    `job_id: ${toYamlString(jobId)}`,
    `permalink: ${toYamlString(`/jobs/${jobId}/`)}`,
    "---",
    "",
    "<!-- This file is auto-generated from _data/jobs.json. -->",
    ""
  ].join("\n");
}

function writeJobPage(job) {
  const jobId = String(job.job_id || job.id || "").trim();
  const outputPath = path.join(jobsOutputDir, `${jobId}.md`);
  fs.writeFileSync(outputPath, buildFrontMatter(job), "utf8");
  return outputPath;
}

function main() {
  ensureDir(jobsOutputDir);
  clearExistingJobPages();
  const jobs = readJobs();
  const writtenFiles = jobs.map(writeJobPage);
  console.log(`Generated ${writtenFiles.length} job pages.`);
  writtenFiles.forEach((filePath) => {
    console.log(path.relative(rootDir, filePath));
  });
}

main();
