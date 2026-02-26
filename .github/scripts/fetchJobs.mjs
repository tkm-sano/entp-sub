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
    
    // Code.gs の listJobs_ で必要なカラムが存在するか確認
    const requiredColumns = ['title', 'deadline', 'max_applicants', 'client_email', 
                             'form_url', 'category', 'applicant_count', 'deadline_notified_at'];
    const missingColumns = requiredColumns.filter(col => !headers.includes(col));
    
    if (missingColumns.length > 0) {
      console.warn(`Warning: 以下のカラムが見つかりません: ${missingColumns.join(', ')}`);
    }

    console.log(`検出されたカラム: ${headers.join(', ')}`);

    // 各行をオブジェクトに変換（Code.gs と同じロジック）
    const jobs = dataRows
      .map((row, index) => {
        const job = {};
        headers.forEach((h, i) => {
          const header = String(h || '').trim();
          job[header] = row[i] || '';
        });
        
        // titleが空の行はスキップ（Code.gs の readUsers_ と同様）
        const title = String(job.title || '').trim();
        if (!title) {
          console.log(`行 ${index + 2} をスキップ: title が空です`);
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