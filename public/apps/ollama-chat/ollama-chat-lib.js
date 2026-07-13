/**
 * OllamaChatLib — ollama-chat 前端核心 library（可嵌入式、純邏輯、不碰 DOM）
 *
 * 把「Ollama 串流讀取」「對話物件操作」「prompt 索引」「Markdown 匯出」
 * 「與伺服器溝通」「名稱/時間戳工具」等可重用邏輯抽成一支 library；
 * index.html / ollama-chat.js 只負責 DOM（訊息渲染、事件繫結、toast、markdown→HTML）。
 *
 * 資料模型（與後端 routes/ollama-chat.js 對齊；v2 request-response 結構）：
 *   project（資料夾）→ subject（一個 JSON 檔 = 一組對話）→ messages[]（一筆＝一個 turn）
 *   chat = { uid, model, createdAt, updatedAt, messages: [turn] }
 *     uid                   // 對話穩定 id（rename/搬 project 不失效）；deep link 用 ?uid= 定位，
 *                           //   免於明文 project/subject 因改名而失連。舊檔缺 uid 時，後端
 *                           //   GET /subject 首次讀取即補產生並落地（唯一「讀觸發寫」例外，見 DESIGN.md §1.2）
 *   turn = {
 *     uid,                 // 穩定 id：request↔response 的配對 key，也是 DOM 錨點（#msg-<uid>）
 *     serial,               // 建立時的序號（1-based）；一經指派永不重編，匯出/引用用它才穩定
 *     role: 'user',         // 頂層＝發起方（未來可擴充 'system'）；assistant 一律巢狀在 response
 *     content, ts,
 *     hidden,               // 選填，僅 true 才存——從 prompt 索引「與對話區」同時隱藏（見 §5.5 hide 語意）
 *     response: { uid, role:'assistant', content, ts, model? } | null   // 尚未產生／中止且無內容 → null
 *   }
 *   儲存位置： public/upload/ollama-chat/chats/<project>/<subject>.json
 *   （v1 舊格式＝扁平陣列 role 交替；後端 GET /subject 讀取時自動遷移，見 DESIGN.md §1.1）
 *
 * 後端對應：
 *   - 模型清單： GET  /api/ollama-chat/models          （proxy Ollama /api/tags）
 *   - 對話串流： POST /api/ollama-chat/chat            （proxy Ollama /api/chat，NDJSON 直通；
 *                                                        body.messages 是 flattenForApi() 攤平後的扁平陣列）
 *   - 樹：       GET  /api/ollama-chat/tree
 *   - 讀/存/刪： GET|POST /api/ollama-chat/subject、POST /api/ollama-chat/delete
 *
 * 依賴：無（原生 fetch / ReadableStream / TextDecoder / crypto.randomUUID，皆瀏覽器內建）。
 * 與 jQuery / Materialize / Lodash / marked / DOMPurify 並存但不依賴它們。
 *
 * Public API：
 *   OllamaChatLib.FOLDER                        → 'ollama-chat'
 *   OllamaChatLib.newChat(model)                → chat        空對話物件
 *   OllamaChatLib.newTurn(content, serial)      → turn        新 request（uid 自動產生、response:null）
 *   OllamaChatLib.newResponse(content, model)   → response    新 reply（掛到 turn.response）
 *   OllamaChatLib.flattenForApi(messages)       → [{role,content}]  turns→扁平陣列，供 Ollama context
 *                                                  （隱藏的 turn 排除在外，見 DESIGN.md §5.5）
 *   OllamaChatLib.promptIndex(messages)         → [{ uid, serial, ts, text, hidden }]  user 發言索引
 *   OllamaChatLib.autoName(text)                → string|null 由首個 prompt 推 subject 名（消毒後）
 *   OllamaChatLib.isSafeName(name, maxLen?)      → boolean     名稱是否合法（鏡射後端；maxLen 預設 80，
 *                                                  project 呼叫端傳 PROJECT_NAME_MAX=255）
 *   OllamaChatLib.PROJECT_NAME_MAX               → 255         project 名稱長度上限（macOS 路徑片段實際上限）
 *   OllamaChatLib.uniqueName(name, taken)       → string      與既有清單衝突時加 -2、-3…
 *   OllamaChatLib.listModels()                  → Promise<Array<{name,size,modifiedAt}>>
 *   OllamaChatLib.chatStream({model,messages,signal,onChunk}) → Promise<{content,stats,aborted}>
 *   OllamaChatLib.generateTitle({model,prompt}) → Promise<string>  非串流，依首個 prompt 生短標題
 *                                                  （新對話 Subject 留空時用；20s 逾時／失敗皆 reject）
 *   OllamaChatLib.getTree()                     → Promise<Array<project>>
 *   OllamaChatLib.loadSubject(project, name)    → Promise<chat>
 *   OllamaChatLib.loadSubjectByUid(uid)         → Promise<{project,name,chat}>  deep link 定位用
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
  var TITLE_API = API_BASE + '/title';
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
  // project（資料夾名）放寬到這個上限——非真無限，是 macOS 單一路徑片段的實際上限
  // （255 UTF-16 code unit，恰好等於 JS 字串 .length）；鏡射後端 PROJECT_NAME_MAX。
  var PROJECT_NAME_MAX = 255;

  function isSafeName(name, maxLen) {
    if (typeof name !== 'string') return false;
    var n = name.trim();
    if (!n || n.length > (maxLen || 80)) return false;
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

  /* ---------- 對話物件（v2：turn = request + 巢狀 response） ---------- */

  // 穩定 id：request↔response 配對 key、DOM 錨點。localhost 視為安全內容脈絡，
  // crypto.randomUUID 可用；缺席時退回時間戳＋亂數尾碼（僅防同 tick 碰撞，非密碼學用途）。
  function genUid() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return timestamp() + '-' + Math.random().toString(36).slice(2, 8);
  }

  function newChat(model) {
    var ts = timestamp();
    return { uid: genUid(), model: model || '', createdAt: ts, updatedAt: ts, messages: [] };
  }

  // 新 request turn。serial 由呼叫端傳入（慣例：messages.length + 1），
  // 一經指派永不重編——即使日後該 turn 被隱藏／刪除，匯出等引用仍指向同一個號碼。
  function newTurn(content, serial) {
    return { uid: genUid(), serial: serial, role: 'user', content: String(content || ''), ts: timestamp(), response: null };
  }

  function newResponse(content, model) {
    var r = { uid: genUid(), role: 'assistant', content: String(content || ''), ts: timestamp() };
    if (model) r.model = model;
    return r;
  }

  // turns → Ollama /api/chat 要的扁平 [{role,content}]。
  // 隱藏的 turn 整組（request＋response）排除在外：hidden 語意是「當作沒發生過」，
  // 不只是 UI 不顯示，也不該再餵給模型當上下文（DESIGN.md §5.5）。
  function flattenForApi(messages) {
    var out = [];
    (messages || []).forEach(function (t) {
      if (!t || t.hidden) return;
      out.push({ role: t.role, content: t.content });
      if (t.response) out.push({ role: 'assistant', content: t.response.content });
    });
    return out;
  }

  // prompt 索引：該對話所有 request turn（uid 供跳轉／隱藏操作的穩定 key，非陣列位置）。
  // hidden＝該 turn 被標記從索引「與對話區」同時隱藏；由 UI 決定顯示與否。
  function promptIndex(messages) {
    var out = [];
    (messages || []).forEach(function (t) {
      if (!t || t.role !== 'user') return;
      var text = String(t.content || '').split('\n')[0].trim();
      if (text.length > 120) text = text.slice(0, 120) + '…';
      out.push({ uid: t.uid, serial: t.serial, ts: t.ts || '', text: text, hidden: t.hidden === true });
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

  // uid 定位（rename/搬 project 不失效——後端整檔掃描比對 chat.uid）；回傳含目前 project/name，
  // 供呼叫端同步 state（deep link 用，不能只回 chat）。
  function loadSubjectByUid(uid) {
    var q = '?uid=' + encodeURIComponent(uid);
    return jsonApi(bust(SUBJECT_API + q), { cache: 'no-store' })
      .then(function (d) { return { project: d.project, name: d.name, chat: d.chat }; });
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

  // 依首個 prompt 生一句短標題（非串流，「新對話」Subject 留空時的背景任務用）。
  // 回傳的原始文字只做過伺服器端輕度清理（去引號/markdown）；呼叫端仍應套 autoName()
  // 才能保證是合法檔名——這裡刻意不重複做，單一套規則在 autoName()。
  function generateTitle(opts) {
    return postJson(TITLE_API, { model: opts.model, prompt: opts.prompt })
      .then(function (d) { return d.title; });
  }

  /* ---------- 匯出 ---------- */

  // 匯出成 Markdown（資料內容原樣、不翻譯；標頭用中性英文欄位名）。
  // 編號用 turn.serial（穩定，不因隱藏/跳過而重排）；隱藏的 turn 整組不匯出
  // ——與 flattenForApi 同一語意：hidden＝當作沒發生過（見 DESIGN.md §5.5）。
  function exportMarkdown(project, name, chat) {
    var lines = [
      '# ' + name,
      '',
      '> Project: ' + project + ' ｜ Model: ' + (chat.model || '-') +
        ' ｜ Exported: ' + formatTs(timestamp()),
      ''
    ];
    (chat.messages || []).forEach(function (t) {
      if (!t || t.hidden) return;
      lines.push('---', '', '### 🙋 Prompt ' + t.serial +
        (t.ts ? '（' + formatTs(t.ts) + '）' : ''), '', t.content, '');
      if (t.response) {
        lines.push('### 🤖 Reply ' + t.serial +
          (t.response.model ? '（' + t.response.model + '）' : ''), '', t.response.content, '');
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
    newTurn: newTurn,
    newResponse: newResponse,
    flattenForApi: flattenForApi,
    promptIndex: promptIndex,
    autoName: autoName,
    isSafeName: isSafeName,
    PROJECT_NAME_MAX: PROJECT_NAME_MAX,
    uniqueName: uniqueName,
    listModels: listModels,
    chatStream: chatStream,
    generateTitle: generateTitle,
    getTree: getTree,
    loadSubject: loadSubject,
    loadSubjectByUid: loadSubjectByUid,
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
