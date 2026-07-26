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

  window.SideTool = {
    setIconDone: setIconDone,
    DONE_ICON: DONE_ICON,
    DONE_MS: DONE_MS
  };
})(window);
