---
layout: default
title: 案件一覧
page_id: login
---

<section class="login-panel">
  <h1 class="login-title">案件一覧</h1>

  <form id="sheet-login-form" class="login-form-min">
    <label>
      名前
      <input type="text" name="name" required autocomplete="username" />
    </label>
    <label>
      パスワード
      <input type="password" name="password" required autocomplete="current-password" />
    </label>
    <button type="submit">ログイン</button>
  </form>
</section>

<p id="login-message" class="system-message"></p>
