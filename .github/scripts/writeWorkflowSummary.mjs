import fs from 'fs';
import path from 'path';

const mode = process.env.WORKFLOW_MODE || 'push';
const summaryOutputPath = process.env.GITHUB_STEP_SUMMARY;
const summaryDir = process.env.WORKFLOW_SUMMARY_DIR || '';
const changeSetPath = process.env.CHANGESET_PATH || '';
const changeSetFormat = process.env.CHANGESET_FORMAT || 'name-status';

function readText(filePath) {
  if (!filePath) {
    return '';
  }

  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    return '';
  }
}

function readJson(filePath) {
  const raw = readText(filePath);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function appendLine(lines, value = '') {
  lines.push(value);
}

function appendBullet(lines, value) {
  lines.push(`- ${value}`);
}

function escapeInline(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').trim();
}

function truncateList(values, limit = 20) {
  if (values.length <= limit) {
    return values;
  }

  return [
    ...values.slice(0, limit),
    `ほか ${values.length - limit} 件`,
  ];
}

function parseNameStatusChanges(raw) {
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split('\t');
      const status = parts[0] || '';

      if (parts.length >= 3 && status.startsWith('R')) {
        return {
          kind: 'renamed',
          label: 'rename',
          path: `${parts[1]} -> ${parts[2]}`,
        };
      }

      const kind =
        status === 'A' ? 'added' :
        status === 'D' ? 'deleted' :
        'modified';
      const label =
        kind === 'added' ? 'added' :
        kind === 'deleted' ? 'deleted' :
        'modified';

      return {
        kind,
        label,
        path: parts[1] || '',
      };
    });
}

function parseStatusChanges(raw) {
  return raw
    .split(/\r?\n/)
    .map(line => line.replace(/\s+$/, ''))
    .filter(Boolean)
    .map(line => {
      const status = line.slice(0, 2);
      const pathText = line.slice(3).trim();
      let kind = 'modified';
      let label = 'modified';

      if (status === '??') {
        kind = 'added';
        label = 'added';
      } else if (status.includes('D')) {
        kind = 'deleted';
        label = 'deleted';
      } else if (status.includes('R')) {
        kind = 'renamed';
        label = 'rename';
      }

      return {
        kind,
        label,
        path: pathText,
      };
    });
}

function parseChanges(raw, format) {
  if (!raw.trim()) {
    return [];
  }

  return format === 'status'
    ? parseStatusChanges(raw)
    : parseNameStatusChanges(raw);
}

function countByKind(changes) {
  return changes.reduce((acc, change) => {
    acc[change.kind] = (acc[change.kind] || 0) + 1;
    return acc;
  }, { added: 0, modified: 0, deleted: 0, renamed: 0 });
}

function readLogTail(filename, lineCount = 20) {
  const raw = readText(summaryDir ? path.join(summaryDir, filename) : '');
  if (!raw) {
    return '';
  }

  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-lineCount)
    .join('\n');
}

function findFailedStep(definitions) {
  for (const definition of definitions) {
    const exitCode = String(process.env[definition.exitKey] || '').trim();
    const conclusion = String(process.env[definition.conclusionKey] || '').trim();

    if (exitCode && exitCode !== '0') {
      return {
        label: definition.label,
        reason: `exit code ${exitCode}`,
        logName: definition.logName,
      };
    }

    if (conclusion === 'failure') {
      return {
        label: definition.label,
        reason: 'step failed',
        logName: definition.logName,
      };
    }
  }

  return null;
}

function writeSummary(lines) {
  const content = `${lines.join('\n')}\n`;

  if (summaryOutputPath) {
    fs.appendFileSync(summaryOutputPath, content, 'utf-8');
    return;
  }

  process.stdout.write(content);
}

function buildPushSummary(lines) {
  const changes = parseChanges(readText(changeSetPath), changeSetFormat);
  const counts = countByKind(changes);
  const failedStep = findFailedStep([
    { label: 'Setup Ruby', conclusionKey: 'SETUP_RUBY_CONCLUSION' },
    { label: 'Build site', exitKey: 'BUILD_SITE_EXIT_CODE', logName: 'build-site.log' },
  ]);

  appendLine(lines, '## 実行結果');
  if (failedStep) {
    appendBullet(lines, `失敗: ${failedStep.label} (${failedStep.reason})`);
  } else {
    appendBullet(lines, '成功: サイトのビルドとデプロイ準備が完了しました。');
  }
  appendBullet(lines, `event: ${escapeInline(process.env.GITHUB_EVENT_NAME || '')}`);
  appendBullet(lines, `branch: ${escapeInline(process.env.GITHUB_REF_NAME || '')}`);
  appendBullet(lines, `commit: ${escapeInline(process.env.GITHUB_SHA || '').slice(0, 7)}`);
  appendLine(lines);

  appendLine(lines, '## 変更内容');
  if (!changes.length) {
    appendBullet(lines, '比較可能な差分は取得できませんでした。');
  } else {
    appendBullet(lines, `added: ${counts.added}, modified: ${counts.modified}, deleted: ${counts.deleted}, renamed: ${counts.renamed}`);
    for (const item of truncateList(changes.map(change => `${change.label}: ${escapeInline(change.path)}`))) {
      appendBullet(lines, item);
    }
  }
  appendLine(lines);

  appendLine(lines, '## 情報不足・未変更');
  appendBullet(lines, 'push ワークフローではスプレッドシート由来の欠損情報は判定していません。');
  appendLine(lines);

  if (failedStep) {
    appendLine(lines, '## エラー詳細');
    appendBullet(lines, `${failedStep.label} で停止しました。`);
    const logTail = failedStep.logName ? readLogTail(failedStep.logName) : '';
    if (logTail) {
      appendLine(lines);
      appendLine(lines, '```text');
      appendLine(lines, logTail);
      appendLine(lines, '```');
    }
  }
}

function buildSpreadsheetSummary(lines) {
  const changes = parseChanges(readText(changeSetPath), changeSetFormat);
  const counts = countByKind(changes);
  const fetchSummary = readJson(summaryDir ? path.join(summaryDir, 'fetch-summary.json') : '');
  const generateSummary = readJson(summaryDir ? path.join(summaryDir, 'generate-summary.json') : '');
  const failedStep = findFailedStep([
    { label: 'Verify environment', exitKey: 'VERIFY_ENV_EXIT_CODE', logName: 'verify-env.log' },
    { label: 'Setup Node', conclusionKey: 'SETUP_NODE_CONCLUSION' },
    { label: 'Write service account key', exitKey: 'WRITE_KEY_EXIT_CODE', logName: 'write-key.log' },
    { label: 'Install dependencies', exitKey: 'INSTALL_DEPS_EXIT_CODE', logName: 'install-deps.log' },
    { label: 'Fetch jobs', exitKey: 'FETCH_JOBS_EXIT_CODE', logName: 'fetch-jobs.log' },
    { label: 'Generate markdown', exitKey: 'GENERATE_MARKDOWN_EXIT_CODE', logName: 'generate-markdown.log' },
    { label: 'Verify generated files', exitKey: 'VERIFY_FILES_EXIT_CODE', logName: 'verify-files.log' },
    { label: 'Setup Ruby', conclusionKey: 'SETUP_RUBY_CONCLUSION' },
    { label: 'Build Jekyll site', exitKey: 'BUILD_SITE_EXIT_CODE', logName: 'build-site.log' },
  ]);

  appendLine(lines, '## 実行結果');
  if (failedStep) {
    appendBullet(lines, `失敗: ${failedStep.label} (${failedStep.reason})`);
  } else if (!changes.length) {
    appendBullet(lines, '成功: 生成処理は完了しましたが、リポジトリ上の生成物に差分はありませんでした。');
  } else {
    appendBullet(lines, '成功: スプレッドシートの内容を取り込み、生成物に差分がありました。');
  }
  if (fetchSummary?.validJobs !== undefined) {
    appendBullet(lines, `有効な求人件数: ${fetchSummary.validJobs}`);
  }
  if (generateSummary?.generatedCount !== undefined) {
    appendBullet(lines, `生成した Markdown: ${generateSummary.generatedCount}`);
  }
  appendLine(lines);

  appendLine(lines, '## 変更内容');
  if (!changes.length) {
    appendBullet(lines, '`_data/jobs.json` と `_jobs/` に差分はありませんでした。');
  } else {
    appendBullet(lines, `added: ${counts.added}, modified: ${counts.modified}, deleted: ${counts.deleted}, renamed: ${counts.renamed}`);
    for (const item of truncateList(changes.map(change => `${change.label}: ${escapeInline(change.path)}`))) {
      appendBullet(lines, item);
    }
  }
  appendLine(lines);

  appendLine(lines, '## 情報不足・未変更');
  const missingInfoLines = [];
  const missingColumns = Array.isArray(fetchSummary?.missingColumns) ? fetchSummary.missingColumns : [];
  const skippedRows = Array.isArray(fetchSummary?.skippedRows) ? fetchSummary.skippedRows : [];
  const skippedJobs = Array.isArray(generateSummary?.skippedJobs) ? generateSummary.skippedJobs : [];

  if (missingColumns.length) {
    missingInfoLines.push(`不足カラム: ${missingColumns.map(item => item.labels?.join(' / ') || item.key).join(', ')}`);
  }

  if (skippedRows.length) {
    missingInfoLines.push(`案件名が空のため未反映: ${skippedRows.map(item => `row ${item.rowNumber}`).join(', ')}`);
  }

  if (skippedJobs.length) {
    missingInfoLines.push(`Markdown 生成をスキップ: ${skippedJobs.map(item => item.jobId || `row ${item.rowNumber}`).join(', ')}`);
  }

  if (!missingInfoLines.length) {
    appendBullet(lines, '不足情報によるスキップはありませんでした。');
  } else {
    for (const item of truncateList(missingInfoLines)) {
      appendBullet(lines, item);
    }
  }
  appendLine(lines);

  if (failedStep) {
    appendLine(lines, '## エラー詳細');
    appendBullet(lines, `${failedStep.label} で停止しました。`);
    const logTail = failedStep.logName ? readLogTail(failedStep.logName) : '';
    if (logTail) {
      appendLine(lines);
      appendLine(lines, '```text');
      appendLine(lines, logTail);
      appendLine(lines, '```');
    }
  }
}

const lines = ['# Workflow Summary', ''];

if (mode === 'spreadsheet') {
  buildSpreadsheetSummary(lines);
} else {
  buildPushSummary(lines);
}

writeSummary(lines);
