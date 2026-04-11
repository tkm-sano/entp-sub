import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

const keyFile = './service-account.json';
const spreadsheetId = process.env.SHEET_ID;
const requestedSheetName = String(process.env.SHEET_NAME || '').trim();
const summaryDir = process.env.WORKFLOW_SUMMARY_DIR;
const outputPath = '../../_data/jobs.json';
const fallbackSheetNames = ['案件', 'jobs'];

if (!fs.existsSync(keyFile)) {
  console.error('Error: service-account.json が見つかりません');
  process.exit(1);
}

if (!spreadsheetId) {
  console.error('Error: SHEET_ID 環境変数が設定されていません');
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  keyFile,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

const sheets = google.sheets({ version: 'v4', auth });

function writeSummary(filename, payload) {
  if (!summaryDir) {
    return;
  }

  fs.mkdirSync(summaryDir, { recursive: true });
  fs.writeFileSync(path.join(summaryDir, filename), JSON.stringify(payload, null, 2), 'utf-8');
}

function escapeSheetName(sheetName) {
  return `'${String(sheetName || '').replace(/'/g, "''")}'`;
}

function normalizeHeaderLabel(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function normalizeSourceValue(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function findColumn(headers, ...candidates) {
  const normalizedHeaders = headers.map(normalizeHeaderLabel);

  for (const candidate of candidates) {
    const exactIndex = headers.indexOf(candidate);
    if (exactIndex >= 0) {
      return exactIndex;
    }

    const normalizedCandidate = normalizeHeaderLabel(candidate);
    const normalizedExactIndex = normalizedHeaders.findIndex(header => header === normalizedCandidate);
    if (normalizedExactIndex >= 0) {
      return normalizedExactIndex;
    }

    const normalizedPrefixIndex = normalizedHeaders.findIndex(header => header.indexOf(normalizedCandidate) === 0);
    if (normalizedPrefixIndex >= 0) {
      return normalizedPrefixIndex;
    }
  }

  return -1;
}

function getJobColumns(headers) {
  const find = (...candidates) => findColumn(headers, ...candidates);

  return {
    jobId: find('job_id', 'id'),
    timestamp: find('タイムスタンプ', 'timestamp'),
    title: find('案件名（サイト上の見出し）', '案件名', '商品名', 'title', '案件タイトル'),
    productName: find('商品名（サービス名、ブランド名等）', '商品名', 'product_name', 'product'),
  };
}

function buildJobId(row, columns, rowNumber) {
  const explicitId = columns.jobId >= 0 ? String(row[columns.jobId] || '').trim() : '';
  if (explicitId) {
    return explicitId;
  }

  const identitySource = [
    columns.timestamp >= 0 ? row[columns.timestamp] : '',
    columns.title >= 0 ? row[columns.title] : '',
    columns.productName >= 0 ? row[columns.productName] : '',
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join('|');

  return identitySource ? `job_${hash(identitySource).slice(0, 12)}` : `job_${rowNumber}`;
}

async function getSheetTitles() {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(title))',
  });

  return Array.isArray(res.data?.sheets)
    ? res.data.sheets.map(sheet => String(sheet.properties?.title || '').trim()).filter(Boolean)
    : [];
}

async function findSheetByHeader(sheetTitles) {
  for (const sheetTitle of sheetTitles) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${escapeSheetName(sheetTitle)}!1:1`,
    });
    const headers = Array.isArray(res.data?.values?.[0]) ? res.data.values[0].map(value => String(value || '').trim()) : [];

    if (getJobColumns(headers).title >= 0) {
      return sheetTitle;
    }
  }

  return '';
}

async function resolveSheetName() {
  const sheetTitles = await getSheetTitles();
  if (!sheetTitles.length) {
    throw new Error('スプレッドシートにシートがありません');
  }

  const candidateNames = [requestedSheetName, ...fallbackSheetNames].filter(Boolean);
  for (const candidate of candidateNames) {
    if (sheetTitles.includes(candidate)) {
      return candidate;
    }
  }

  const detectedByHeader = await findSheetByHeader(sheetTitles);
  if (detectedByHeader) {
    return detectedByHeader;
  }

  throw new Error(`対象シートが見つかりません: ${candidateNames.join(', ')}`);
}

async function fetchSheetValues(sheetName) {
  const range = `${escapeSheetName(sheetName)}!A:ZZZ`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  return {
    range,
    rows: Array.isArray(res.data?.values) ? res.data.values : [],
  };
}

async function fetchJobs() {
  const summary = {
    status: 'started',
    spreadsheetId,
    requestedSheetName: requestedSheetName || null,
    sheetName: '',
    range: '',
    totalRows: 0,
    dataRows: 0,
    validJobs: 0,
    detectedColumns: [],
    missingColumns: [],
    skippedRows: [],
    outputPath,
  };

  try {
    const sheetName = await resolveSheetName();
    const { range, rows } = await fetchSheetValues(sheetName);

    summary.sheetName = sheetName;
    summary.range = range;

    if (!rows.length) {
      throw new Error('スプレッドシートにデータがありません');
    }

    const [headers, ...dataRows] = rows;
    const normalizedHeaders = headers.map(value => String(value || '').trim());
    const columns = getJobColumns(normalizedHeaders);

    summary.totalRows = rows.length;
    summary.dataRows = dataRows.length;
    summary.detectedColumns = normalizedHeaders;

    if (columns.title < 0) {
      summary.missingColumns.push({
        key: 'title',
        labels: ['案件名（サイト上の見出し）', '案件名', '商品名', 'title', '案件タイトル'],
      });
      throw new Error('案件名列が見つかりません');
    }

    const jobs = dataRows
      .map((row, index) => {
        const rowNumber = index + 2;
        const title = String(row[columns.title] || '').trim();

        if (!title) {
          summary.skippedRows.push({
            rowNumber,
            reason: '案件名が空です',
          });
          return null;
        }

        const job = {};
        normalizedHeaders.forEach((header, headerIndex) => {
          if (header) {
            job[header] = row[headerIndex] || '';
          }
        });

        const jobId = buildJobId(row, columns, rowNumber);
        if (!job.job_id) {
          job.job_id = jobId;
        }
        if (!job.id) {
          job.id = jobId;
        }
        if (!job.title) {
          job.title = title;
        }
        if (!job.name) {
          job.name = title;
        }
        if (!job.source_key) {
          const timestampText = columns.timestamp >= 0 ? normalizeSourceValue(row[columns.timestamp]) : '';
          if (timestampText) {
            job.source_key = `timestamp:${hash(timestampText)}`;
          }
        }

        return job;
      })
      .filter(Boolean);

    summary.validJobs = jobs.length;

    fs.writeFileSync(outputPath, JSON.stringify(jobs, null, 2), 'utf-8');
    summary.status = 'success';
    writeSummary('fetch-summary.json', summary);

    console.log(`スプレッドシート ID: ${spreadsheetId}`);
    console.log(`対象シート: ${sheetName}`);
    console.log(`取得範囲: ${range}`);
    console.log(`有効な求人データ: ${jobs.length} 件`);
    console.log(`✓ ${outputPath} を生成しました`);
  } catch (error) {
    summary.status = 'error';
    summary.errorMessage = error.message;
    if (error.code) {
      summary.errorCode = error.code;
    }
    writeSummary('fetch-summary.json', summary);
    console.error('Error: スプレッドシートの取得に失敗しました');
    console.error('詳細:', error.message);
    if (error.code) {
      console.error('エラーコード:', error.code);
    }
    process.exit(1);
  }
}

fetchJobs().catch(error => {
  writeSummary('fetch-summary.json', {
    status: 'error',
    spreadsheetId,
    requestedSheetName: requestedSheetName || null,
    outputPath,
    errorMessage: error.message,
  });
  console.error('Fatal Error:', error.message);
  process.exit(1);
});
