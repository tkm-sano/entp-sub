import fs from 'fs';
import { google } from 'googleapis';

// サービスアカウントの JSON キーを読み込む
const keyFile = './service-account.json';

// サービスアカウントキーの存在確認
if (!fs.existsSync(keyFile)) {
  console.error('Error: service-account.json が見つかりません');
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  keyFile,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = process.env.SHEET_ID;
const range = 'jobs!A:Z'; // Code.gs の SHEET_NAMES に合わせる

// 環境変数の確認
if (!spreadsheetId) {
  console.error('Error: SHEET_ID 環境変数が設定されていません');
  process.exit(1);
}

async function fetchSheet() {
  try {
    console.log(`スプレッドシート ID: ${spreadsheetId}`);
    console.log(`取得範囲: ${range}`);
    
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = res.data.values || [];
    
    if (!rows.length) {
      console.error('Error: スプレッドシートにデータがありません');
      process.exit(1);
    }

    console.log(`取得した行数: ${rows.length} 行（ヘッダー含む）`);

    const [headers, ...dataRows] = rows;
    
    // 日本語と英語の列名の両方に対応
    const requiredColumns = [
      { en: 'title', jp: '案件名' },
      { en: 'deadline', jp: '残り日数' },
      { en: 'max_applicants', jp: '募集人数' },
    ];
    
    // 列名の正規化処理
    const normalizedHeaders = headers.map(h => String(h).trim());
    const headerMap = {};
    
    for (const col of requiredColumns) {
      const found = normalizedHeaders.find(h => h === col.en || h === col.jp);
      if (!found) {
        console.warn(`Warning: "${col.en}" または "${col.jp}" カラムが見つかりません`);
      } else {
        headerMap[col.en] = found;
      }
    }

    console.log(`検出されたカラム: ${normalizedHeaders.join(', ')}`);

    // 各行をオブジェクトに変換（実際の列名のまま保存）
    const jobs = dataRows
      .map((row, index) => {
        const job = {};
        normalizedHeaders.forEach((h, i) => {
          job[h] = row[i] || '';
        });
        
        // titleまたは案件名が空の行はスキップ
        const title = String(job['title'] || job['案件名'] || '').trim();
        if (!title) {
          console.log(`行 ${index + 2} をスキップ: 案件名が空です`);
          return null;
        }
        
        return job;
      })
      .filter(Boolean); // null を除外

    console.log(`有効な求人データ: ${jobs.length} 件`);

    // _data/jobs.json に保存
    const outputPath = '../../_data/jobs.json';
    fs.writeFileSync(outputPath, JSON.stringify(jobs, null, 2), 'utf-8');
    console.log(`✓ ${outputPath} を生成しました（${jobs.length} 件）`);
    
  } catch (error) {
    console.error('Error: スプレッドシートの取得に失敗しました');
    console.error('詳細:', error.message);
    if (error.code) console.error('エラーコード:', error.code);
    process.exit(1);
  }
}

fetchSheet().catch(error => {
  console.error('Fatal Error:', error.message);
  process.exit(1);
});