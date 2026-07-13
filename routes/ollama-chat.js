/**
 * ollama-chat
 * -----------
 * 後端 handler，搭配 public/apps/ollama-chat 前端使用。兩類端點：
 *
 * Ollama proxy（免 CORS 設定；base URL 收在 .env 的 OLLAMA_BASE_URL）：
 *   GET  /api/ollama-chat/models   → 轉 Ollama /api/tags，回 { ok, models }
 *   POST /api/ollama-chat/chat     → 轉 Ollama /api/chat（stream:true），
 *                                    成功時「NDJSON 串流直通」（非 { ok } 信封，唯一例外，見 DESIGN.md）；
 *                                    失敗（含 upstream 4xx/5xx、連不上）回 JSON { ok:false, error }
 *   POST /api/ollama-chat/title    → { model, prompt } 非串流呼叫 Ollama，依首個 prompt 生一句短標題
 *                                    → { ok, title }；20s 逾時；標題只做輕度清理（去引號/markdown），
 *                                    最終合法檔名交前端 autoName() 與後端 /rename 的 sanitizeName 把關
 *
 * 對話存取（project=資料夾、subject=JSON 檔；純檔案掃描，無 registry）：
 *   GET  /api/ollama-chat/tree      → 掃 chats/ 建 project→subject 樹（讀各檔 meta）
 *   GET  /api/ollama-chat/subject   → ?project=&name= 或 ?uid=<uid> 讀一個 subject JSON
 *                                     （讀到 v1 舊格式扁平陣列會自動遷移成 v2 turn 結構再回傳，見 migrateFlatToTurns；
 *                                     缺 chat.uid 會即時補一個並落地——uid 要穩定，這裡是唯一的「讀順手寫」例外，見 DESIGN.md §1.2）
 *   POST /api/ollama-chat/subject   → { project, name, chat } 整檔覆寫存檔
 *                                     （訊息追加型覆寫，不留 .bak——設計決議見 DESIGN.md）
 *   POST /api/ollama-chat/rename    → { project, name, newProject, newName } 改名／搬 project
 *                                     （fs.rename；目標已存在則 409 拒絕，不覆蓋。只搬檔案，
 *                                     不動內容，chat.uid 隨檔案內容原封不動——這正是 URL 用 uid
 *                                     而非明文 project/subject 就不怕改名的原因，見 DESIGN.md §1.2）
 *   POST /api/ollama-chat/delete    → { project, name } 移到 chats/.bak/ 備份（不直接 unlink）
 *
 * Prompt 樣板庫（全域單檔 prompts.json；owner registry 式整清單覆寫，§3.5 精神）：
 *   GET  /api/ollama-chat/prompts   → { ok, prompts: [{ content, ts, title? }] }
 *   POST /api/ollama-chat/prompts   → { prompts: [...] } 整清單覆寫（覆寫前 .bak）
 *
 * 資料模型（v2，request-response 結構；見 lib 檔頭與 DESIGN.md §1）：
 *   chat.messages[] 一筆＝一個 turn = { uid, serial, role:'user', content, ts, hidden?, response }
 *   response = { uid, role:'assistant', content, ts, model? } | null
 *   v1 舊格式（扁平陣列、role 交替）只在 GET /subject 讀取時偵測並即時遷移，不主動改寫既有檔案
 *   （下次 POST /subject 存檔時才落地成 v2；自然汰換，見 migrateFlatToTurns）。
 *
 * 安全限制：
 *   - 操作目標固定為 public/upload/ollama-chat/chats，不接受任意路徑參數
 *   - project / subject 名稱經 sanitizeName（擋 / \ 空字元、..、開頭 .、" ' < > & ` 與控制字元）；
 *     長度上限 project 255／subject 80（見 PROJECT_NAME_MAX 註解）
 *   - 絕對路徑落點檢查 startsWith(CHATS_DIR + sep)
 *   - 存檔只收白名單欄位（見 cleanChat／cleanTurn）
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { Readable } = require('stream');

const router = express.Router();

// 對話內容根（與前端對齊；.bak 備份也收在這棵樹下）
const UPLOAD_ROOT = path.join(__dirname, '..', 'public', 'upload', 'ollama-chat');
const CHATS_DIR = path.join(UPLOAD_ROOT, 'chats');
const BAK_DIR = path.join(CHATS_DIR, '.bak');

// Prompt 樣板庫：全域單檔（另一個儲存面，與對話分開）；備份收 UPLOAD_ROOT/.bak/
const PROMPTS_FILE = path.join(UPLOAD_ROOT, 'prompts.json');
const ROOT_BAK = path.join(UPLOAD_ROOT, '.bak');

// Ollama base URL：讀取時才取值（.env 由 app.js 載入）
function ollamaBase() {
  return (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
}

/* ---------- 工具 ---------- */

function pad2(n) { return String(n).padStart(2, '0'); }

function timestamp(d) {
  d = d || new Date();
  return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

// project / subject 名稱消毒：名稱會成為資料夾名 / 檔名，也會被前端塞進 DOM，
// 除家族基本款（/ \ \0、..、basename）外，比照 rare-glyph 另擋 " ' < > & ` 與控制字元。
// maxLen 預設 80（subject／檔名沿用原上限）；project（資料夾名）呼叫端傳 PROJECT_NAME_MAX——
// 不是真的「無限制」（那會在 fs.mkdir/fs.rename 炸出未處理的 ENAMETOOLONG），而是放寬到
// macOS APFS/HFS+ 單一路徑片段的實際上限（255 UTF-16 code unit，恰好等於 JS 字串 .length）。
const PROJECT_NAME_MAX = 255;

function sanitizeName(raw, maxLen) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > (maxLen || 80)) return null;
  if (name === '.' || name === '..') return null;
  if (name[0] === '.') return null;                          // 擋隱藏檔（含 .bak）
  if (path.basename(name) !== name) return null;             // 擋 /（POSIX basename 不切 \，下行補擋）
  if (/[\/\\<>&"'`]|[\x00-\x1f\x7f]/.test(name)) return null;
  return name;
}

// 落點檢查：絕對路徑必須位於 CHATS_DIR 之下
function insideChats(abs) {
  return abs.startsWith(CHATS_DIR + path.sep);
}

function isVisible(name) {
  return typeof name === 'string' && name.length > 0 && name[0] !== '.';
}

// 扁平信封（POST /chat 傳給 Ollama 的 context）用的角色白名單——與持久化的 turn 結構無關，
// 那是 lib flattenForApi() 攤平後的形狀，assistant 在這裡合法。
const ROLE_WHITELIST = ['user', 'assistant', 'system'];

// 持久化 turn 結構的角色白名單：頂層＝發起方（目前只有 user；system 留待未來擴充），
// assistant 只存在於巢狀的 response 內，不會出現在這裡。
const TURN_ROLE_WHITELIST = ['user', 'system'];

// 存檔白名單：只持久化已知欄位，防前端（或手改）夾帶垃圾鍵
function cleanResponse(r) {
  if (r === null || r === undefined) return null;
  if (typeof r !== 'object') return undefined;   // undefined＝不合法，讓呼叫端判斷
  if (typeof r.uid !== 'string' || !r.uid) return undefined;
  if (r.role !== 'assistant') return undefined;
  if (typeof r.content !== 'string') return undefined;
  const clean = { uid: r.uid, role: 'assistant', content: r.content };
  if (typeof r.ts === 'string') clean.ts = r.ts;
  if (typeof r.model === 'string') clean.model = r.model;
  return clean;
}

function cleanTurn(t) {
  if (!t || typeof t !== 'object') return null;
  if (typeof t.uid !== 'string' || !t.uid) return null;
  if (!Number.isInteger(t.serial) || t.serial < 1) return null;
  if (!TURN_ROLE_WHITELIST.includes(t.role)) return null;
  if (typeof t.content !== 'string') return null;
  const clean = { uid: t.uid, serial: t.serial, role: t.role, content: t.content };
  if (typeof t.ts === 'string') clean.ts = t.ts;
  if (t.hidden === true) clean.hidden = true;   // 從 prompt 索引與對話區同時隱藏（僅存 true，false 免存）
  const r = cleanResponse(t.response);
  if (r === undefined) return null;   // response 存在但形狀不合法 → 整筆拒絕
  clean.response = r;
  return clean;
}

function cleanChat(chat) {
  if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) return null;
  const messages = [];
  for (const t of chat.messages) {
    const clean = cleanTurn(t);
    if (!clean) return null;
    messages.push(clean);
  }
  const clean = {};
  // uid：subject 的穩定識別碼，供 ?uid= 尋址、改名/搬 project 不失效。正常情況下客戶端
  // 一定帶著（newChat() 建立時就生成，GET /subject 讀到舊檔也會補），這裡只是防禦性保底。
  clean.uid = typeof chat.uid === 'string' && chat.uid ? chat.uid : crypto.randomUUID();
  if (typeof chat.model === 'string') clean.model = chat.model;
  clean.createdAt = typeof chat.createdAt === 'string' ? chat.createdAt : timestamp();
  clean.updatedAt = timestamp();   // 一律由 server 蓋章
  clean.messages = messages;
  return clean;
}

// v1 舊格式偵測：扁平陣列裡出現過 role==='assistant' 的頂層項目，即判定為舊格式
// （v2 的 assistant 只會巢狀在 response，不會是頂層項目）。
function isLegacyFlat(messages) {
  return Array.isArray(messages) && messages.some(m => m && m.role === 'assistant');
}

// v1 扁平陣列 → v2 turn 結構：user 訊息緊接的下一筆若是 assistant 就配成 response，
// 否則 response:null（例如串流被中止、沒收到任何內容那種懸空 prompt）。
// 非 user/assistant 的舊角色（理論上不存在，因 v1 UI 從未產生 system）一律略過。
function migrateFlatToTurns(messages) {
  const turns = [];
  let serial = 1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const turn = { uid: crypto.randomUUID(), serial: serial++, role: 'user', content: String(m.content || ''), response: null };
    if (typeof m.ts === 'string') turn.ts = m.ts;
    if (m.hidden === true) turn.hidden = true;
    const next = messages[i + 1];
    if (next && next.role === 'assistant') {
      const r = { uid: crypto.randomUUID(), role: 'assistant', content: String(next.content || '') };
      if (typeof next.ts === 'string') r.ts = next.ts;
      if (typeof next.model === 'string') r.model = next.model;
      turn.response = r;
    }
    turns.push(turn);
  }
  return turns;
}

// 解析 project / subject 參數 → 絕對檔案路徑；不合法回 null
function subjectPath(project, name) {
  const p = sanitizeName(project, PROJECT_NAME_MAX);
  const n = sanitizeName(name);
  if (!p || !n) return null;
  const abs = path.join(CHATS_DIR, p, n + '.json');
  return insideChats(abs) ? { project: p, name: n, abs } : null;
}

// 依 uid 找 subject：掃全部 project/subject 逐檔比對 chat.uid（沒有索引，O(全部 subject)，
// 與 GET /tree 的既有全掃成本同級——見 §7 已知限制）。找不到（含尚未補過 uid 的舊檔）回 null。
async function findSubjectByUid(uid) {
  let dirs;
  try { dirs = await fs.readdir(CHATS_DIR, { withFileTypes: true }); } catch (e) { return null; }
  for (const dir of dirs) {
    if (!dir.isDirectory() || !isVisible(dir.name)) continue;
    const projDir = path.join(CHATS_DIR, dir.name);
    let files;
    try { files = await fs.readdir(projDir, { withFileTypes: true }); } catch (e) { continue; }
    for (const f of files) {
      if (!f.isFile() || !isVisible(f.name) || !f.name.endsWith('.json')) continue;
      const abs = path.join(projDir, f.name);
      try {
        const j = JSON.parse(await fs.readFile(abs, 'utf8'));
        if (j.uid === uid) return { project: dir.name, name: f.name.slice(0, -5), abs };
      } catch (e) { /* 壞檔跳過 */ }
    }
  }
  return null;
}

/* ---------- Ollama proxy ---------- */

// GET /api/ollama-chat/models — 轉 Ollama /api/tags
router.get('/models', async (req, res) => {
  try {
    const r = await fetch(ollamaBase() + '/api/tags');
    if (!r.ok) throw new Error('Ollama HTTP ' + r.status);
    const d = await r.json();
    const models = (d.models || []).map(m => ({
      name: m.name, size: m.size, modifiedAt: m.modified_at
    }));
    return res.json({ ok: true, models });
  } catch (err) {
    console.error('[ollama-chat] GET /models failed:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /api/ollama-chat/chat — 轉 Ollama /api/chat（串流 NDJSON 直通）
router.post('/chat', async (req, res) => {
  const { model, messages } = req.body || {};
  if (typeof model !== 'string' || !model.trim()) {
    return res.status(400).json({ ok: false, error: 'model required' });
  }
  if (!Array.isArray(messages) || !messages.length ||
      messages.some(m => !m || !ROLE_WHITELIST.includes(m.role) || typeof m.content !== 'string')) {
    return res.status(400).json({ ok: false, error: 'invalid messages' });
  }

  const ac = new AbortController();
  // 前端按「停止」或斷線 → 中止 upstream，讓 Ollama 停止產生
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  let upstream;
  try {
    upstream = await fetch(ollamaBase() + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true
      }),
      signal: ac.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') return;   // 客戶端已離線
    console.error('[ollama-chat] POST /chat connect failed:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    let msg = 'Ollama HTTP ' + upstream.status;
    try { msg = JSON.parse(text).error || msg; } catch (e) { /* keep */ }
    console.error('[ollama-chat] POST /chat upstream error:', msg);
    return res.status(502).json({ ok: false, error: msg });
  }

  res.status(200).set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  const body = Readable.fromWeb(upstream.body);
  body.on('error', (err) => {
    if (err.name !== 'AbortError') console.error('[ollama-chat] POST /chat stream error:', err.message);
    res.end();
  });
  body.pipe(res);
});

const TITLE_SYSTEM_PROMPT =
  'You write short titles for chat conversations. Given the user\'s first message below, ' +
  'reply with ONLY a concise title (25 characters or fewer) in the same language as the message. ' +
  'No quotes, no markdown, no trailing punctuation, no explanation — output the title text only.';

// 輕度清理：只做「小型本地模型常見不聽話」的保底處理（多話一行、包引號、掛 Title: 前綴、
// markdown 標記字元）；是否為合法檔名交由呼叫端 autoName() 與 /rename 的 sanitizeName 把關
// （雙層防禦——前端先清一次、/rename 落地前再驗一次），這裡不重複那套規則。
function cleanTitleRaw(s) {
  s = String(s || '').trim().split('\n')[0];
  s = s.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '');
  s = s.replace(/^(title|標題|タイトル)[:：]\s*/i, '');
  s = s.replace(/[*_#>`]/g, '');
  return s.trim();
}

// POST /api/ollama-chat/title — 非串流，依首個 prompt 生一句短標題（新對話 Subject 留空時用）
router.post('/title', async (req, res) => {
  const { model, prompt } = req.body || {};
  if (typeof model !== 'string' || !model.trim()) {
    return res.status(400).json({ ok: false, error: 'model required' });
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ ok: false, error: 'prompt required' });
  }

  const ac = new AbortController();
  // 背景任務，可以比一般請求更寬容——實測 LAN 上較大的模型（如 14b）光生一句標題
  // 就可能耗掉 15-20s（尤其與正式回覆併發搶同一顆模型的執行時），20s 太緊、常誤殺；
  // 前端失敗只留 console.warn 不擋對話，逾時久一點換來成功率更划算。
  const timer = setTimeout(() => ac.abort(), 45000);

  try {
    const upstream = await fetch(ollamaBase() + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: TITLE_SYSTEM_PROMPT },
          { role: 'user', content: prompt.slice(0, 4000) }   // 標題只需開頭意圖，封頂輸入長度
        ],
        stream: false
      }),
      signal: ac.signal
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      let msg = 'Ollama HTTP ' + upstream.status;
      try { msg = JSON.parse(text).error || msg; } catch (e) { /* keep */ }
      console.error('[ollama-chat] POST /title upstream error:', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
    const data = await upstream.json();
    const title = cleanTitleRaw((data.message && data.message.content) || '');
    if (!title) return res.status(502).json({ ok: false, error: 'empty title' });
    return res.json({ ok: true, title });
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ ok: false, error: 'title generation timed out' });
    console.error('[ollama-chat] POST /title failed:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  } finally {
    clearTimeout(timer);
  }
});

/* ---------- 對話存取（project / subject） ---------- */

// GET /api/ollama-chat/tree — 掃 chats/ 建 project→subject 樹
router.get('/tree', async (req, res) => {
  try {
    let dirs;
    try {
      dirs = await fs.readdir(CHATS_DIR, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return res.json({ ok: true, projects: [] });
      throw err;
    }
    const projects = [];
    for (const dir of dirs) {
      if (!dir.isDirectory() || !isVisible(dir.name)) continue;
      const projDir = path.join(CHATS_DIR, dir.name);
      const files = await fs.readdir(projDir, { withFileTypes: true });
      const subjects = [];
      for (const f of files) {
        if (!f.isFile() || !isVisible(f.name) || !f.name.endsWith('.json')) continue;
        const name = f.name.slice(0, -5);
        // turnCount：messages[] 一筆＝一個 turn（v1 舊檔尚未遷移時，同一陣列長度含 user+assistant
        // 兩筆，數字會偏大；純展示用途、不影響功能，首次開啟該 subject 即遷移升級）
        let meta = { updatedAt: '', model: '', turnCount: 0 };
        try {
          const j = JSON.parse(await fs.readFile(path.join(projDir, f.name), 'utf8'));
          meta = {
            updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : '',
            model: typeof j.model === 'string' ? j.model : '',
            turnCount: Array.isArray(j.messages) ? j.messages.length : 0
          };
        } catch (e) { /* 壞檔照列，meta 留空 */ }
        subjects.push({ name, ...meta });
      }
      subjects.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      projects.push({ name: dir.name, subjects });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ ok: true, projects });
  } catch (err) {
    console.error('[ollama-chat] GET /tree failed:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 讀一個 subject 檔＋v1→v2 遷移＋確保 chat.uid 存在（缺的話生成並立即落地——
// 跟訊息結構的「讀時遷移、下次存檔才落地」不同：uid 的價值就是穩定，不能等，
// 這是本檔唯一一處「讀順手寫」，見 DESIGN.md §1.2）。
async function readSubjectFile(abs) {
  const chat = JSON.parse(await fs.readFile(abs, 'utf8'));
  if (isLegacyFlat(chat.messages)) chat.messages = migrateFlatToTurns(chat.messages);
  if (typeof chat.uid !== 'string' || !chat.uid) {
    chat.uid = crypto.randomUUID();
    await fs.writeFile(abs, JSON.stringify(chat, null, 2) + '\n', 'utf8');
  }
  return chat;
}

// GET /api/ollama-chat/subject — ?project=&name= 或 ?uid=<uid>
router.get('/subject', async (req, res) => {
  try {
    if (typeof req.query.uid === 'string' && req.query.uid) {
      const loc = await findSubjectByUid(req.query.uid);
      if (!loc) return res.status(404).json({ ok: false, error: 'Not found' });
      const chat = await readSubjectFile(loc.abs);
      return res.json({ ok: true, chat, project: loc.project, name: loc.name });
    }
    const loc = subjectPath(req.query.project, req.query.name);
    if (!loc) return res.status(400).json({ ok: false, error: 'invalid project/name' });
    const chat = await readSubjectFile(loc.abs);
    return res.json({ ok: true, chat, project: loc.project, name: loc.name });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ ok: false, error: 'Not found' });
    console.error('[ollama-chat] GET /subject failed:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/ollama-chat/subject — 整檔覆寫存檔（訊息追加型，不留 .bak）
router.post('/subject', async (req, res) => {
  const { project, name, chat } = req.body || {};
  const loc = subjectPath(project, name);
  if (!loc) return res.status(400).json({ ok: false, error: 'invalid project/name' });
  const clean = cleanChat(chat);
  if (!clean) return res.status(400).json({ ok: false, error: 'invalid chat payload' });
  try {
    await fs.mkdir(path.dirname(loc.abs), { recursive: true });
    await fs.writeFile(loc.abs, JSON.stringify(clean, null, 2) + '\n', 'utf8');
    return res.json({ ok: true, project: loc.project, name: loc.name, updatedAt: clean.updatedAt, uid: clean.uid });
  } catch (err) {
    console.error('[ollama-chat] POST /subject failed:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/ollama-chat/rename — subject 改名／搬 project（名稱即路徑，改名＝fs.rename）
router.post('/rename', async (req, res) => {
  const { project, name, newProject, newName } = req.body || {};
  const src = subjectPath(project, name);
  const dst = subjectPath(newProject, newName);
  if (!src || !dst) return res.status(400).json({ ok: false, error: 'invalid project/name' });
  if (src.abs === dst.abs) {
    return res.json({ ok: true, project: dst.project, name: dst.name });   // 無變化
  }
  try {
    // 先驗來源存在（放在 mkdir 之前，免得 404 時留下空的目標 project 夾）
    await fs.access(src.abs);

    // 目標已存在 → 拒絕（不做同名覆寫，防吃掉另一組對話）
    let exists = true;
    try { await fs.access(dst.abs); } catch (e) { exists = false; }
    if (exists) return res.status(409).json({ ok: false, error: 'target exists' });

    await fs.mkdir(path.dirname(dst.abs), { recursive: true });
    await fs.rename(src.abs, dst.abs);
    // 原 project 夾清空後順手移除（非關鍵，失敗忽略）
    try { await fs.rmdir(path.dirname(src.abs)); } catch (e) { /* ENOTEMPTY 等，忽略 */ }
    console.log('[ollama-chat] POST /rename →',
      src.project + '/' + src.name, '→', dst.project + '/' + dst.name);
    return res.json({ ok: true, project: dst.project, name: dst.name });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ ok: false, error: 'Not found' });
    console.error('[ollama-chat] POST /rename failed:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/ollama-chat/delete — 移到 chats/.bak/ 備份（破壞性操作照家族 canon 先備份）
router.post('/delete', async (req, res) => {
  const { project, name } = req.body || {};
  const loc = subjectPath(project, name);
  if (!loc) return res.status(400).json({ ok: false, error: 'invalid project/name' });
  try {
    await fs.mkdir(BAK_DIR, { recursive: true });
    const bak = path.join(BAK_DIR, loc.project + '__' + loc.name + '-' + timestamp() + '.json.bak');
    await fs.rename(loc.abs, bak);
    // project 夾清空後順手移除（非關鍵，失敗忽略）
    try { await fs.rmdir(path.dirname(loc.abs)); } catch (e) { /* ENOTEMPTY 等，忽略 */ }
    console.log('[ollama-chat] POST /delete →', loc.project + '/' + loc.name, '→ .bak');
    return res.json({ ok: true, project: loc.project, name: loc.name });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ ok: false, error: 'Not found' });
    console.error('[ollama-chat] POST /delete failed:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------- Prompt 樣板庫 ---------- */

// 樣板清單白名單驗證：只收已知欄位，content 必為非空字串；上限防呆
function cleanPrompts(list) {
  if (!Array.isArray(list) || list.length > 200) return null;
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') return null;
    if (typeof p.content !== 'string' || !p.content.trim()) return null;
    const item = { content: p.content };
    if (typeof p.title === 'string' && p.title.trim()) item.title = p.title.trim().slice(0, 80);
    item.ts = typeof p.ts === 'string' ? p.ts : timestamp();
    out.push(item);
  }
  return out;
}

// GET /api/ollama-chat/prompts — 讀樣板庫（無檔＝空清單）
router.get('/prompts', async (req, res) => {
  try {
    const j = JSON.parse(await fs.readFile(PROMPTS_FILE, 'utf8'));
    return res.json({ ok: true, prompts: Array.isArray(j.prompts) ? j.prompts : [] });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ ok: true, prompts: [] });
    console.error('[ollama-chat] GET /prompts failed:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/ollama-chat/prompts — 整清單覆寫（owner registry 式；覆寫前 .bak）
router.post('/prompts', async (req, res) => {
  const clean = cleanPrompts((req.body || {}).prompts);
  if (!clean) return res.status(400).json({ ok: false, error: 'invalid prompts payload' });
  try {
    await fs.mkdir(UPLOAD_ROOT, { recursive: true });
    try {
      await fs.access(PROMPTS_FILE);
      await fs.mkdir(ROOT_BAK, { recursive: true });
      await fs.copyFile(PROMPTS_FILE, path.join(ROOT_BAK, 'prompts-' + timestamp() + '.json.bak'));
    } catch (e) { /* 首寫尚無檔，免備份 */ }
    await fs.writeFile(PROMPTS_FILE, JSON.stringify({ prompts: clean }, null, 2) + '\n', 'utf8');
    return res.json({ ok: true, count: clean.length });
  } catch (err) {
    console.error('[ollama-chat] POST /prompts failed:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
