/**
 * I18n — 極簡前端多語系引擎（無相依套件、無 build）
 *
 * 字典與引擎分離：本檔只有引擎，語言字典放在 locales/<code>.js，
 * 每個語言檔以同步 <script> 載入後呼叫 I18n.register() 自我註冊：
 *
 *   I18n.register('ja', { 'btn.run': '校正を実行', ... }, '日本語');
 *
 * 載入順序（HTML）：先 i18n.js，再各 locales/*.js。新增語言＝多一個 locale 檔。
 *
 * 用法：
 *   靜態文字：<span data-i18n="btn.run">…</span>
 *   innerHTML（含 icon）：<div data-i18n-html="drop.hint">…</div>
 *   屬性：data-i18n-placeholder / data-i18n-title / （<body>）data-i18n-doctitle
 *   程式內：I18n.t('meta.rulesLoaded', { n: 5 })
 *   切換：I18n.set('ja')   // persist 並派發 document 事件 'i18n:changed'
 *   循環：I18n.cycle()     // 切到下一個已註冊語言，回傳新 code（供語言切換 toast 顯示 I18n.name(code)）
 *   切換器可用 I18n.langs / I18n.name(code) 自動產生
 *
 * 初始語系：?lang= → localStorage('lang') → 瀏覽器語言 → 'zh-Hant' → 第一個已註冊語言
 */
(function (window) {
  'use strict';

  var DEFAULT = 'zh-Hant';
  var messages = {};   // { code: { key: string } }
  var names = {};      // { code: displayName }
  var lang = null;     // 解析後的語系（惰性）
  var inited = false;

  function register(code, dict, displayName) {
    messages[code] = Object.assign(messages[code] || {}, dict || {});
    if (displayName) names[code] = displayName;
    return window.I18n;
  }

  function readSaved() { try { return localStorage.getItem('lang'); } catch (e) { return null; } }
  function writeSaved(l) { try { localStorage.setItem('lang', l); } catch (e) { /* ignore */ } }

  function resolveInitial() {
    var q = null;
    try { q = new URLSearchParams(location.search).get('lang'); } catch (e) { /* ignore */ }
    if (q && messages[q]) return q;
    var saved = readSaved();
    if (saved && messages[saved]) return saved;
    var nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
    if (nav.indexOf('zh') === 0 && messages['zh-Hant']) return 'zh-Hant';
    if (nav.indexOf('ja') === 0 && messages['ja']) return 'ja';
    if (nav.indexOf('en') === 0 && messages['en']) return 'en';
    if (messages[DEFAULT]) return DEFAULT;
    var ks = Object.keys(messages);
    return ks.length ? ks[0] : DEFAULT;
  }

  function ensureInit() {
    if (!inited) { lang = resolveInitial(); inited = true; }
  }

  function t(key, params) {
    ensureInit();
    var table = messages[lang] || {};
    var s = (key in table) ? table[key]
          : (messages.en && key in messages.en) ? messages.en[key]
          : key;
    if (params) {
      Object.keys(params).forEach(function (k) {
        s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(params[k]));
      });
    }
    return s;
  }

  function apply(root) {
    ensureInit();
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    root.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    var dt = document.querySelector('[data-i18n-doctitle]');
    if (dt) document.title = t(dt.getAttribute('data-i18n-doctitle'));
    document.documentElement.lang = lang;
    if (window.M && M.updateTextFields) { try { M.updateTextFields(); } catch (e) {} }
  }

  function set(l) {
    ensureInit();
    if (!messages[l]) return;
    writeSaved(l);
    if (l === lang) return;
    lang = l;
    apply(document);
    document.dispatchEvent(new Event('i18n:changed'));
  }

  // 切到「下一個」已註冊語言（依註冊順序循環），persist 並派發 i18n:changed。
  // 回傳切換後的語言 code（UI 可用 I18n.name(code) 顯示，如語言切換 toast）。
  function cycle() {
    ensureInit();
    var ks = Object.keys(messages);
    if (!ks.length) return lang;
    var next = ks[(ks.indexOf(lang) + 1) % ks.length];
    set(next);
    return next;
  }

  window.I18n = {
    register: register,
    t: t,
    apply: apply,
    set: set,
    cycle: cycle,
    get lang() { ensureInit(); return lang; },
    get langs() { return Object.keys(messages); },
    name: function (code) { return names[code] || code; },
    names: names,
    messages: messages
  };
})(window);
