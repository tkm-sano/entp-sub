---
layout: default
title: 案件一覧
page_id: jobs
---

<section id="jobs-panel" class="jobs-shell">
  <div class="jobs-hero">
    <p class="jobs-hero__eyebrow">Open Casting Board</p>
    <div class="jobs-header">
      <h2>案件一覧</h2>
      <p class="jobs-subtitle">撮影内容と条件を比較しながら、気になる案件をすぐ確認できます。</p>
      <p id="jobs-count" class="jobs-count"></p>
    </div>
  </div>

  <div class="jobs-toolbar">
    <div class="filters" id="filters">
      <label class="keyword-filter">
        <span class="jobs-filter-label">キーワード</span>
        <div class="keyword-row">
          <input type="search" id="search-input" placeholder="案件名・条件で検索" aria-label="キーワード" />
          <button id="search-button" type="button">検索</button>
        </div>
      </label>
      <div class="wage-filter">
        <label class="jobs-filter-label" for="wage-range-filter">時給</label>
        <select id="wage-range-filter">
          <option value="">すべて</option>
          <option value="under-5000">5,000円以下</option>
          <option value="5000-7500">5,001円〜7,500円</option>
          <option value="7500-10000">7,501円〜10,000円</option>
          <option value="over-10000">10,001円以上</option>
        </select>
      </div>
    </div>
  </div>

  <p id="jobs-message" class="system-message"></p>
  <div id="jobs-list" class="jobs-list"></div>
  <div id="jobs-pagination" class="jobs-pagination hidden">
    <button id="jobs-next" type="button">さらに見る</button>
  </div>
</section>
