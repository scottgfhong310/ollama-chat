/**
 * side-tool.js — 右側浮動工具列的共用行為（家族共用 utility，byte-identical 同步）
 *
 * ⚠️ **本檔是家族權威版**（同 side-tool.css / thinking-dot.css / filter-clear.js 的慣例）。
 *    各 app 的 public/apps/<name>/side-tool.js 是它的 **byte-identical 複製件**——
 *    要改就改這裡，再同步所有複製點；**不要在 app 內就地改**。
 *    稽核指令見 DESIGN_GUIDELINES §5.5。
 *
 * ⚠️ **本檔只放「側鍵元件本身的通用行為」**。某支 app 才有的側鍵動作
 *    （下載目前檔案、清空資料夾、切換閱讀風格……）一律留在該 app 的 <name>.js；
 *    這裡只收「每支 app 都長一樣、抄了 N 份的那段」。
 *
 * 提供：
 *   SideTool.setIconDone(target[, ms])
 *     側鍵「已執行」的標準微回饋（§5.5）——把鍵內的 material-icon 暫時換成 check，
 *     800ms 後還原。target 可以是 DOM 元素、id 字串（'setting-x' 或 '#setting-x'）、
 *     或 jQuery 物件（家族三種寫法並存，故一律容忍）。回傳被改動的 <i>，沒有則 null。
 *
 * 不做的事（沿用 §5.5 的既有分工）：
 *   - 不自動綁 click：哪顆鍵要回饋由各 app 自己決定（#setting-mode 的 icon 是狀態指示、
 *     app-icon 徽章鍵沒有 <i>，都不該有 check 動畫——後者本檔會自然略過）。
 *   - 不碰主題／語言／sidenav 狀態：那些各有各的 localStorage key 與 i18n 繫結。
 *
 * 依賴：無（原生；jQuery 物件只是「認得」，不需要 jQuery 在場）。
 * 用法：index.html 於該 app 的控制器 <script> 之前載入本檔，控制器內
 *      `var setIconDone = window.SideTool.setIconDone;` 後照舊呼叫。
 */
(function (window) {
  'use strict';

  var document = window.document;
  var DONE_ICON = 'check';
  var DONE_MS = 800;

  // 記住每個 <i> 原本的字與待還原的 timer：連點時若直接讀當下文字，
  // 會把上一次還沒還原的 'check' 當成原字存下去，icon 就永遠停在 check。
  var pending = new WeakMap();

  // 三種傳入形式收斂成一個 DOM 元素（認不得或找不到都回 null，呼叫端不必自己防 null）
  function resolve(target) {
    if (!target) return null;
    if (typeof target === 'string') {
      return document.getElementById(target.charAt(0) === '#' ? target.slice(1) : target);
    }
    if (target.nodeType === 1) return target;
    if (typeof target.length === 'number' && target[0] && target[0].nodeType === 1) {
      return target[0];            // jQuery / NodeList：取第一個
    }
    return null;
  }

  function setIconDone(target, ms) {
    var el = resolve(target);
    if (!el) return null;
    // 家族兩派寫法（'i.material-icons' 與 'i'）在既有 app 等價；先精確、再退回泛用
    var icon = el.querySelector('i.material-icons') || el.querySelector('i');
    if (!icon) return null;        // app-icon 徽章鍵沒有 <i>：靜默略過（§5.5）

    var prev = pending.get(icon);
    if (prev) window.clearTimeout(prev.timer);
    var orig = prev ? prev.orig : icon.textContent;

    icon.textContent = DONE_ICON;
    var state = { orig: orig, timer: 0 };
    state.timer = window.setTimeout(function () {
      icon.textContent = orig;
      pending['delete'](icon);
    }, typeof ms === 'number' ? ms : DONE_MS);
    pending.set(icon, state);
    return icon;
  }

  /* ============================ 溢出收納（§5.5） ============================
   * 矮視窗放不下時，把中段的 app 工具收進一顆 more_vert，點開是一份選單。
   * 舊做法是「icon 縮一號＋整欄可捲」——捲軸是隱藏的，使用者根本不知道下面還有東西。
   *
   * 規則：
   *   - **釘住不收**：第一顆（入口鍵／App icon 徽章，品牌與主要入口）＋ chrome（#setting-mode /
   *     #setting-lang，每支都有、位置要穩）。其餘 app 工具由上而下能塞幾顆算幾顆，剩下的進選單。
   *   - **容量由高度算出來**，不是寫死的數字：可用高度 ÷（--tool-size ＋ --tool-gap）。
   *     視窗一拉高就自動放回去，不必重新整理。
   *   - **不搬 DOM**：溢出的鍵留在原地只是 display:none，選單裡放的是**代理項**，點了轉呼叫
   *     真正那顆的 click()。這樣 app 綁在該元素上的 listener 完全不受影響。
   *   - 只在**真的放不下**時才出現；隱藏中的鍵（如只在開檔時顯示的下載）不計、不列。
   *
   * app 端不必做任何事；若 app 會動態顯示／隱藏側鍵（showDoc 那類），呼叫
   * SideTool.refreshOverflow() 可立即重算（本檔也有 MutationObserver 兜底）。
   */

  var MORE_ID = 'setting-more';
  var rails = [];          // 已接管的 .side-tools

  function isTool(el) {
    return el && el.nodeType === 1 && el.classList.contains('side-tool') && el.id !== MORE_ID;
  }
  // 呼叫前已把 is-overflow 全數清掉，所以這裡看到的 display:none 一定是 app 自己藏的
  function isHidden(el) {
    return getComputedStyle(el).display === 'none';
  }
  function isPinned(el, index) {
    return index === 0 || el.id === 'setting-mode' || el.id === 'setting-lang';
  }

  // 同值就不要寫：寫進去照樣算一次 attribute 變更，會多餘地叫醒 observer
  function setDisplay(el, v) {
    if (el.style.display !== v) el.style.display = v;
  }

  // 選單貼著 more 鍵：水平放在它左邊，垂直「底對底」對齊；
  // 選單比可用空間高時夾在視窗內（上下各留 12px），不做垂直居中——那會離觸發點太遠。
  function positionMenu(rail) {
    var more = rail._more, menu = rail._menu;
    var r = more.getBoundingClientRect();
    menu.style.right = Math.round(window.innerWidth - r.left + 8) + 'px';
    var h = menu.offsetHeight;                       // 必須已 display:block 才量得到
    var top = r.bottom - h;                          // 底對底
    var max = window.innerHeight - h - 12;
    if (top > max) top = max;
    if (top < 12) top = 12;
    menu.style.top = Math.round(top) + 'px';
  }

  function closeMenu(rail) {
    if (rail._menu) rail._menu.classList.remove('open');
    if (rail._more) rail._more.classList.remove('active');
  }

  function buildMenu(rail, items) {
    var menu = rail._menu;
    menu.innerHTML = '';
    items.forEach(function (el) {
      var row = document.createElement('div');
      row.className = 'side-tool-menu-item';
      var icon = el.querySelector('i.material-icons');
      var glyph = document.createElement('i');
      glyph.className = 'material-icons';
      glyph.textContent = icon ? icon.textContent : 'radio_button_unchecked';
      var label = document.createElement('span');
      label.textContent = el.getAttribute('title') || el.id.replace(/^setting-/, '');
      row.appendChild(glyph);
      row.appendChild(label);
      row.addEventListener('click', function () {
        closeMenu(rail);
        el.click();                    // 轉呼叫真正那顆，app 的 listener 照常跑
      });
      menu.appendChild(row);
    });
  }

  function refreshOne(rail) {
    var more = rail._more;
    // ⚠️ 本函式會改子元素的 class 與 more 的 style，而我們又在同一個 rail 上掛了
    //    MutationObserver——不先停掉的話「自己改 → observer 觸發 → 再改」會無限迴圈、
    //    整頁卡在載入狀態（2026-07-26 實際踩過）。標準解法：disconnect → 改 → takeRecords() 丟掉
    //    自己造成的紀錄 → 重新 observe。
    if (rail._mo) rail._mo.disconnect();
    try {
      applyOverflow(rail, more);
    } finally {
      if (rail._mo) { rail._mo.takeRecords(); observeRail(rail); }
    }
    // 選單開著時，重算之後 more 的位置可能變了（視窗縮放、工具增減）→ 一起重貼，
    // 否則選單會停在舊位置甚至跑出畫面（2026-07-26 實測 300px 高的視窗踩到）。
    if (rail._menu && rail._menu.classList.contains('open')) positionMenu(rail);
  }

  function applyOverflow(rail, more) {
    // 消費端若整批重繪側鍵列（rail.innerHTML = '…'），我們加的 more 鍵會被一起洗掉；
    // 每次重算時確認它還在，不在就補回去並移到最後（實驗台切工具數量時實際踩過）。
    if (more.parentNode !== rail) rail.appendChild(more);
    else if (rail.lastElementChild !== more) rail.appendChild(more);

    var kids = Array.prototype.filter.call(rail.children, isTool);
    // 先全部放回去再重算，才不會因為上一輪的 is-overflow 影響量測
    kids.forEach(function (el) { el.classList.remove('is-overflow'); });

    var shown = kids.filter(function (el) { return !isHidden(el); });
    var cs = getComputedStyle(rail);
    var size = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tool-size')) || 46;
    var gap = parseFloat(cs.gap) || 9;
    var avail = parseFloat(cs.maxHeight);
    if (!avail || !isFinite(avail)) avail = window.innerHeight - 24;
    var capacity = Math.max(1, Math.floor((avail + gap) / (size + gap)));

    if (shown.length <= capacity) {           // 放得下 → 收起 more、全部露出
      setDisplay(more, 'none');
      closeMenu(rail);
      return;
    }
    // 放不下：釘住的先佔位，more 自己也佔一格
    var pinned = shown.filter(function (el, i) { return isPinned(el, i); });
    var room = capacity - pinned.length - 1;  // 扣掉 more 自己
    var overflow = [];
    var kept = 0;
    shown.forEach(function (el, i) {
      if (isPinned(el, i)) return;   // i＝在「目前可見的鍵」裡的序，故第一顆＝入口鍵
      if (kept < room) { kept++; return; }
      el.classList.add('is-overflow');
      overflow.push(el);
    });
    if (!overflow.length) { setDisplay(more, 'none'); closeMenu(rail); return; }
    setDisplay(more, '');
    buildMenu(rail, overflow);
  }

  function observeRail(rail) {
    rail._mo.observe(rail, { attributes: true, attributeFilter: ['style', 'class'], subtree: true, childList: true });
  }

  function refreshOverflow() { rails.forEach(refreshOne); }

  function adopt(rail) {
    if (rail._more) return;
    var more = document.createElement('div');
    more.id = MORE_ID;
    more.className = 'side-tool';
    more.setAttribute('title', '更多工具');
    more.setAttribute('data-i18n-title', 'tool.more');   // 有 i18n 的 app 會自動翻譯
    more.innerHTML = '<i class="material-icons">more_vert</i>';
    more.style.display = 'none';

    var menu = document.createElement('div');
    menu.className = 'side-tool-menu';

    more.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = menu.classList.toggle('open');
      more.classList.toggle('active', open);
      if (open) positionMenu(rail);                  // 先開再量，才有高度可算
    });
    document.addEventListener('click', function () { closeMenu(rail); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(rail); });

    rail.appendChild(more);
    document.body.appendChild(menu);
    rail._more = more;
    rail._menu = menu;
    rails.push(rail);

    // 側鍵被 app 顯示／隱藏（showDoc 那類）時自動重算
    rail._mo = new MutationObserver(function () { refreshOne(rail); });
    observeRail(rail);
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('.side-tools'), adopt);
    refreshOverflow();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.addEventListener('resize', function () {
    if (init._t) window.clearTimeout(init._t);
    init._t = window.setTimeout(function () {
      refreshOverflow();
      rails.forEach(function (rail) {               // 開著的選單跟著 more 鍵重貼
        if (rail._menu && rail._menu.classList.contains('open')) positionMenu(rail);
      });
    }, 120);
  });

  window.SideTool = {
    setIconDone: setIconDone,
    refreshOverflow: refreshOverflow,
    DONE_ICON: DONE_ICON,
    DONE_MS: DONE_MS
  };
})(window);
