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
    <p class="muted"><br>詳細は各案件をクリック！</p>
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
    <div class="wage-filter">
      <label>時給</label>
      <div class="wage-range">
        <div class="wage-range-track"></div>
        <input type="range" id="wage-slider-min" min="0" max="10000" step="100" value="1200" />
        <input type="range" id="wage-slider-max" min="0" max="10000" step="100" value="5000" />
      </div>
      <div class="wage-display">
        <span id="wage-display-min">1,200</span>円 〜 <span id="wage-display-max">5,000</span>円
      </div>
    </div>
  </div>

  <p id="jobs-message" class="system-message"></p>
  <div id="jobs-list" class="jobs-list"></div>

</section>