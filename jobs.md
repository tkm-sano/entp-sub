---
layout: default
title: 案件一覧
page_id: jobs
---

<section id="jobs-panel">
  <div class="account-row">
    <button id="logout-button" type="button">ログアウト</button>
  </div>

  <div class="jobs-header">
    <h2>案件一覧</h2>
    <p id="jobs-count" class="jobs-count"></p>
  </div>

  <div class="filters" id="filters">
    <label>
      キーワード
      <input type="search" id="search-input" placeholder="案件名・説明" />
    </label>
    <label>
      カテゴリ
      <select id="category-filter">
        <option value="">すべて</option>
      </select>
    </label>
    <label>
      募集状態
      <select id="status-filter">
        <option value="all">すべて</option>
        <option value="open">募集中</option>
        <option value="closed">締切/定員到達</option>
      </select>
    </label>
  </div>

  <p id="jobs-message" class="system-message"></p>
  <div id="jobs-list" class="jobs-list"></div>

</section>