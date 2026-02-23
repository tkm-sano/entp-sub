import fs from 'fs';
import { google } from 'googleapis';

// サービスアカウントの JSON キーを読み込む
const keyFile = './.github/scripts/service-account.json';
const auth = new google.auth.GoogleAuth({
  keyFile,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = process.env.SHEET_ID;
const range = 'Sheet1!A:E'; // データ範囲

async function fetchSheet() {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = res.data.values || [];
  if (!rows.length) return console.error('スプレッドシートにデータがあり