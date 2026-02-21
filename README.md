# menu-talent-site

Jekyll + GitHub Pages（フロント）と Google Apps Script + Google Sheets（バックエンド）で動く、無料構成の案件応募サイトです。

このリポジトリ内に Firebase 関連ファイルが残っていても、現行仕様では使用しません。

## 現在の仕様

- `/` はログイン画面（名前・パスワード・ログインボタンのみ）
- タレント名簿シートの `名前` 列に存在するユーザーがログイン対象
- ログインパスワードは Script Properties の `LOGIN_PASSWORD`（共通）
- `/jobs/` で案件一覧を締切順に表示
- キーワード/カテゴリ/募集状態で絞り込み
- 応募上限チェック、重複応募防止
- 応募人数表示
- 応募時メール通知（応募者のみ）
- クライアント向け応募一覧メールは締切日の翌朝に送信
  - `selection-form.txt` を添付して Google Form リンクを共有

## ディレクトリ

- `index.md`: ログインページ
- `jobs.md`: 案件一覧ページ
- `assets/js/main.js`: フロントロジック
- `assets/js/env.js`: API URL設定
- `apps-script/Code.gs`: Apps Script API
- `apps-script/appsscript.json`: Apps Script マニフェスト

## 1. サイト起動（ローカル）

```bash
cd menu-talent-site
bundle install
bundle exec jekyll serve
```

## 2. Google Sheets を準備

名簿シートと案件シートは別スプレッドシートで運用できます。
（同一スプレッドシートでも可）

### タレント名簿シート（必須）

あなたが提示した列構成に対応しています。必須は `名前` 列のみです。

例:
- `タイムスタンプ`
- `名前`（必須）
- `ふりがな`
- `大学`
- `性別`
- `年齢`
- `身長`
- `特技・趣味`
- `ミスコン出場年度`
- `タグ`
- `画像・動画`
- `instagram_url`
- `x_url`
- `tiktok_url`

### jobs シート（必須）

必須列:

- `title`
- `deadline`

推奨列:

- `job_id`
- `description`
- `location`
- `max_applicants`
- `client_name`
- `client_email`
- `form_url`
- `tags`（カンマ区切り）
- `applicant_count`（任意。あれば自動更新）

### applications シート（任意）

なければ Apps Script が自動作成します。

## 3. Apps Script をデプロイ

1. script.google.com で新規プロジェクト作成
2. `apps-script/Code.gs` の内容を貼り付け
3. `Project Settings > Script properties` に以下を設定

- `SPREADSHEET_ID`: 案件シート（jobs/applications）側のスプレッドシートID
- `TALENT_SPREADSHEET_ID`: 名簿シート側スプレッドシートID（省略時は `SPREADSHEET_ID` を利用）
- `TALENT_SHEET_NAME`: 名簿シート名（省略時は `名前` 列を持つシートを自動探索）
- `LOGIN_PASSWORD`: 全ユーザー共通ログインパスワード
- `APP_SECRET`: 十分長いランダム文字列

4. `Deploy > New deployment > Web app`

- Execute as: `Me`
- Who has access: `Anyone`

5. 発行された Web app URL をコピー

6. 初回実行時は `MailApp` 権限を許可（メール送信機能を使うため）

補足:
- 初期データを作る場合は Apps Script エディタで `setupSampleSheets()` を1回実行。

## 3.1 締切翌朝メールのトリガー設定

1. Apps Script エディタで左メニュー `Triggers` を開く
2. `Add Trigger` を選択
3. 以下で作成
  - Function: `sendDeadlineMorningEmails`
  - Event source: `Time-driven`
  - Type: `Day timer`
  - Time of day: 例 `8am to 9am`（JST）

これで、締切日を過ぎた案件についてクライアント向け応募一覧メールが1回だけ送信されます。

## 4. フロントへ API URL 設定

`assets/js/env.js` を編集:

```js
window.MENU_TALENT_API_URL = "https://script.google.com/macros/s/XXXXXXXX/exec";
window.MENU_TALENT_API_TIMEOUT_MS = 15000;
```

## 5. GitHub Pages 配信

- `main` ブランチに push
- `.github/workflows/deploy-pages.yml` で Pages へデプロイ

## 運用上の注意

- `LOGIN_PASSWORD` は共通パスワードです。定期変更を推奨します。
- Apps Script / MailApp には日次クォータがあります。
- `APP_SECRET` を変更すると既存ログインセッションは無効化されます。
