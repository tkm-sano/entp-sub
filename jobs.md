---
layout: default
title: 案件一覧
page_id: jobs
---

<section id="jobs-panel">
  <div class="jobs-header">
    <h2>案件一覧</h2>
    <p class="jobs-subtitle">詳細は各案件をクリック！</p>
    <p id="jobs-count" class="jobs-count"></p>
  </div>

  <div class="filters" id="filters">
    <label class="keyword-filter">
      <div class="keyword-row">
        <input type="search" id="search-input" placeholder="キーワード" aria-label="キーワード" />
        <button id="search-button" type="button">検索</button>
      </div>
    </label>
    <div class="wage-filter">
      <label for="wage-range-filter">時給</label>
      <select id="wage-range-filter">
        <option value="">すべて</option>
        <option value="under-5000">5,000円以下</option>
        <option value="5000-7500">5,001円〜7,500円</option>
        <option value="7500-10000">7,501円〜10,000円</option>
        <option value="over-10000">10,001円以上</option>
      </select>
    </div>
  </div>

  <p id="jobs-message" class="system-message"></p>
  <div id="jobs-list" class="jobs-list"></div>
  <div id="jobs-pagination" class="jobs-pagination hidden">
    <button id="jobs-next" type="button">次へ</button>
  </div>

</section>
