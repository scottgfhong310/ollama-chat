/**
 * OllamaChatLib — ollama-chat 前端核心 library（可嵌入式、純邏輯、不碰 DOM）
 *
 * 把「Ollama 串流讀取」「對話物件操作」「prompt 索引」「Markdown 匯出」
 * 「與伺服器溝通」「名稱/時間戳工具」等可重用邏輯抽成一支 library；
 * index.html / ollama-chat.js 只負責 DOM（訊息渲染、事件繫結、toast、markdown→HTML）。
 *
 * 資料模型（與後端 routes/ollama-chat.js 對齊）：
 *   project（資料夾）→ subject（一個 JSON 檔 = 一組對話）→ messages[]
 *   chat = { model, createdAt, updatedAt, messages: [{ role, content, ts, model? }] }
 *   儲存位置： public/upload/ollama-chat/chats/<project>/<subject>.json
 *
 * 後端對應：
 *   - 模型清單： GET  /api/ollama-chat/models          （proxy Ollama /api/tags）
 *   - 對話串流： POST /api/ollama-chat/chat            （proxy Ollama /api/chat，NDJSON 直通）
 *   - 樹：       GET  /api/ollama-chat/tree
 *   - 讀/存/刪： GET|POST /api/ollama-chat/subject、POST /api/ollama-chat/delete
 *
 * 依賴：無（原生 fetch / ReadableStream / TextDecoder）。
 * 與 jQuery / Materialize / Lodash / marked / DOMPurify 並存但不依賴它們。
 *
 * Public API：
 *   OllamaChatLib.FOLDER                        → 'ollama-chat'
 *   OllamaChatLib.newChat(model)                → chat        空對話物件
 *   OllamaChatLib.userMessage(text)             → message     （帶 ts）
 *   OllamaChatLib.assistantMessage(text, model) → message     （帶 ts）
 *   OllamaChatLib.promptIndex(messages)         → [{ index, ts, text }]  user 發言索引（text 截首行）
 *   OllamaChatLib.autoName(text)                → string|null 由首個 prompt 推 subject 名（消毒後）
 *   OllamaChatLib.isSafeName(name)              → boolean     project/subject 名稱是否合法（鏡射後端）
 *   OllamaChatLib.uniqueName(name, taken)       → string      與既有清單衝突時加 -2、-3…
 *   OllamaChatLib.listModels()                  → Promise<Array<{name,size,modifiedAt}>>
 *   OllamaChatLib.chatStream({model,messages,signal,onChunk}) → Promise<{content,stats,aborted}>
 *   OllamaChatLib.getTree()                     → Promise<Array<project>>
 *   OllamaChatLib.loadSubject(project, name)    → Promise<chat>
 *   OllamaChatLib.saveSubject(project, name, chat) → Promise<{updatedAt}>
 *   OllamaChatLib.renameSubject(project, name, newProject, newName) → Promise<{project,name}>
 *   OllamaChatLib.deleteSubject(project, name)  → Promise<{ok}>
 *   OllamaChatLib.getPrompts()                  → Promise<Array<{content,ts,title?}>>  樣板庫
 *   OllamaChatLib.savePrompts(prompts)          → Promise<{count}>  整清單覆寫
 *   OllamaChatLib.promptTitle(p)                → string  樣板顯示名（title 或內容首行）
 *   OllamaChatLib.exportMarkdown(project, name, chat) → string
 *   OllamaChatLib.downloadText(name, text)      → void        Blob → <a download>
 *   OllamaChatLib.timestamp(date)               → 'yyyyMMddHHmmss'
 *   OllamaChatLib.stampFilename(name, ts)       → string      結尾已有時間戳則取代
 *   OllamaChatLib.formatTs(ts)                  → 'yyyy-MM-dd HH:mm' 顯示用
 *   OllamaChatLib.formatSize(bytes)             → 'xx GB'     模型大小顯示
 */
(function (window) {
  'use strict';

  var FOLDER = 'ollama-chat';
  var API_BASE = '/api/' + FOLDER;
  var MODELS_API = API_BASE + '/models';
  var CHAT_API = API_BASE + '/chat';
  var TREE_API = API_BASE + '/tree';
  var SUBJECT_API = API_BASE + '/subject';
  var DELETE_API = API_BASE + '/delete';
  var RENAME_API = API_BASE + '/rename';
  var PROMPTS_API = API_BASE + '/prompts';

  /* ---------- 工具 ---------- */

  function pad2(n) { return ('0' + n).slice(-2); }

  function timestamp(date) {
    var d = date || new Date();
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  // 下載命名：結尾已是 -yyyyMMddHHmmss 則「取代」而非再附加（家族 §4.2）
  function stampFilename(name, ts) {
    ts = ts || timestamp();
    var m = String(name || '').match(/^(.*?)(-\d{14})?(\.[A-Za-z0-9]+)?$/);
    return (m[1] || 'file') + '-' + ts + (m[3] || '');
  }

  // 'yyyyMMddHHmmss' → 'yyyy-MM-dd HH:mm'（顯示用；非法輸入原樣回傳）
  function formatTs(ts) {
    var m = String(ts || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!m) return String(ts || '');
    return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
  }

  function formatSize(bytes) {
    var n = Number(bytes) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
    return n + ' B';
  }

  // 加上 cache-busting query，確保每次都讀到伺服器最新內容
  function bust(url) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
  }

  // 統一處理 { ok } 信封：ok:false 或 HTTP 錯誤一律 reject(new Error(...))
  function jsonApi(url, options) {
    return fetch(url, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok || !d.ok) throw new Error(d.error || ('HTTP ' + res.status));
        return d;
      });
    });
  }

  function postJson(url, body) {
    return jsonApi(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  /* ---------- 名稱（鏡射後端 sanitizeName 的規則） ---------- */

  var BAD_CHARS_RE = /[\/\\<>&"'`]|[\x00-\x1f\x7f]/;

  function isSafeName(name) {
    if (typeof name !== 'string') return false;
    var n = name.trim();
    if (!n || n.length > 80) return false;
    if (n === '.' || n === '..' || n[0] === '.') return false;
    return !BAD_CHARS_RE.test(n);
  }

  // 由首個 prompt 推 subject 名：取首行、去掉不合法字元、截 40 字；清完為空回 null
  function autoName(text) {
    var line = String(text || '').split('\n')[0].trim()
      .replace(/[\/\\<>&"'`]|[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ').trim()
      .slice(0, 40).trim();
    if (!line || line === '.' || line === '..' || line[0] === '.') return null;
    return line;
  }

  // 與既有名稱衝突時加 -2、-3…（避免整檔覆寫掉別的 subject）
  function uniqueName(name, taken) {
    var set = {};
    (taken || []).forEach(function (t) { set[t] = true; });
    if (!set[name]) return name;
    for (var i = 2; i < 1000; i++) {
      var cand = name + '-' + i;
      if (!set[cand]) return cand;
    }
    return name + '-' + timestamp();
  }

  /* ---------- 對話物件 ---------- */

  function newChat(model) {
    var ts = timestamp();
    return { model: model || '', createdAt: ts, updatedAt: ts, messages: [] };
  }

  function userMessage(text) {
    return { role: 'user', content: String(text || ''), ts: timestamp() };
  }

  function assistantMessage(text, model) {
    var m = { role: 'assistant', content: String(text || ''), ts: timestamp() };
    if (model) m.model = model;
    return m;
  }

  // prompt 索引：該對話所有 user 發言（index 為 messages 內的原始位置，供跳轉）
  function promptIndex(messages) {
    var out = [];
    (messages || []).forEach(function (m, i) {
      if (!m || m.role !== 'user') return;
      var text = String(m.content || '').split('\n')[0].trim();
      if (text.length > 120) text = text.slice(0, 120) + '…';
      out.push({ index: i, ts: m.ts || '', text: text });
    });
    return out;
  }

  /* ---------- 伺服器溝通 ---------- */

  function listModels() {
    return jsonApi(bust(MODELS_API), { cache: 'no-store' })
      .then(function (d) { return d.models || []; });
  }

  function getTree() {
    return jsonApi(bust(TREE_API), { cache: 'no-store' })
      .then(function (d) { return d.projects || []; });
  }

  function loadSubject(project, name) {
    var q = '?project=' + encodeURIComponent(project) + '&name=' + encodeURIComponent(name);
    return jsonApi(bust(SUBJECT_API + q), { cache: 'no-store' })
      .then(function (d) { return d.chat; });
  }

  function saveSubject(project, name, chat) {
    return postJson(SUBJECT_API, { project: project, name: name, chat: chat });
  }

  function deleteSubject(project, name) {
    return postJson(DELETE_API, { project: project, name: name });
  }

  // 改名／搬 project。目標已存在時後端回 409 { error:'target exists' }，由 UI 轉專屬 toast。
  function renameSubject(project, name, newProject, newName) {
    return postJson(RENAME_API, {
      project: project, name: name, newProject: newProject, newName: newName
    });
  }

  /* ---------- Prompt 樣板庫（全域單檔，整清單覆寫語意） ---------- */

  function getPrompts() {
    return jsonApi(bust(PROMPTS_API), { cache: 'no-store' })
      .then(function (d) { return d.prompts || []; });
  }

  function savePrompts(prompts) {
    return postJson(PROMPTS_API, { prompts: prompts });
  }

  // 樣板顯示名：title 優先，否則取內容首行（截 60 字）
  function promptTitle(p) {
    if (p && typeof p.title === 'string' && p.title.trim()) return p.title.trim();
    var line = String((p && p.content) || '').split('\n')[0].trim();
    if (line.length > 60) line = line.slice(0, 60) + '…';
    return line;
  }

  /**
   * 對話串流。
   * opts: { model, messages, signal?, onChunk?(delta, full) }
   * resolve → { content, stats, aborted }
   *   - content：完整回覆（中止時為既收到的部分）
   *   - stats：Ollama done 統計 { model, evalCount, evalDurationMs, totalDurationMs }（中止時 null）
   *   - aborted：是否被 signal 中止
   * 失敗（連不上 / upstream 錯誤 / 串流中 error 行）→ reject(new Error(...))
   */
  function chatStream(opts) {
    var full = '';
    var stats = null;
    return fetch(CHAT_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.model, messages: opts.messages }),
      signal: opts.signal,
      cache: 'no-store'
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          throw new Error(d.error || ('HTTP ' + res.status));
        });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '';

      function handleLine(line) {
        line = line.trim();
        if (!line) return;
        var j;
        try { j = JSON.parse(line); } catch (e) { return; }   // 不完整/雜訊行忽略
        if (j.error) throw new Error(j.error);
        var delta = (j.message && j.message.content) || '';
        if (delta) {
          full += delta;
          if (opts.onChunk) opts.onChunk(delta, full);
        }
        if (j.done) {
          stats = {
            model: j.model || opts.model,
            evalCount: j.eval_count || 0,
            evalDurationMs: Math.round((j.eval_duration || 0) / 1e6),
            totalDurationMs: Math.round((j.total_duration || 0) / 1e6)
          };
        }
      }

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            if (buf.trim()) handleLine(buf);
            return { content: full, stats: stats, aborted: false };
          }
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          lines.forEach(handleLine);
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      if (err && err.name === 'AbortError') {
        return { content: full, stats: null, aborted: true };
      }
      throw err;
    });
  }

  /* ---------- 匯出 ---------- */

  // 匯出成 Markdown（資料內容原樣、不翻譯；標頭用中性英文欄位名）
  function exportMarkdown(project, name, chat) {
    var lines = [
      '# ' + name,
      '',
      '> Project: ' + project + ' ｜ Model: ' + (chat.model || '-') +
        ' ｜ Exported: ' + formatTs(timestamp()),
      ''
    ];
    var qn = 0;
    (chat.messages || []).forEach(function (m) {
      if (m.role === 'user') {
        qn++;
        lines.push('---', '', '### 🙋 Prompt ' + qn +
          (m.ts ? '（' + formatTs(m.ts) + '）' : ''), '', m.content, '');
      } else if (m.role === 'assistant') {
        lines.push('### 🤖 Reply ' + qn + (m.model ? '（' + m.model + '）' : ''), '', m.content, '');
      }
    });
    return lines.join('\n');
  }

  // Blob → <a download>（家族 §4.2 標準工具）
  function downloadText(name, text) {
    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  window.OllamaChatLib = {
    FOLDER: FOLDER,
    newChat: newChat,
    userMessage: userMessage,
    assistantMessage: assistantMessage,
    promptIndex: promptIndex,
    autoName: autoName,
    isSafeName: isSafeName,
    uniqueName: uniqueName,
    listModels: listModels,
    chatStream: chatStream,
    getTree: getTree,
    loadSubject: loadSubject,
    saveSubject: saveSubject,
    renameSubject: renameSubject,
    deleteSubject: deleteSubject,
    getPrompts: getPrompts,
    savePrompts: savePrompts,
    promptTitle: promptTitle,
    exportMarkdown: exportMarkdown,
    downloadText: downloadText,
    timestamp: timestamp,
    stampFilename: stampFilename,
    formatTs: formatTs,
    formatSize: formatSize
  };
})(window);
