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
 *
 * 對話存取（project=資料夾、subject=JSON 檔；純檔案掃描，無 registry）：
 *   GET  /api/ollama-chat/tree      → 掃 chats/ 建 project→subject 樹（讀各檔 meta）
 *   GET  /api/ollama-chat/subject   → ?project=&name= 讀一個 subject JSON
 *   POST /api/ollama-chat/subject   → { project, name, chat } 整檔覆寫存檔
 *                                     （訊息追加型覆寫，不留 .bak——設計決議見 DESIGN.md）
 *   POST /api/ollama-chat/rename    → { project, name, newProject, newName } 改名／搬 project
 *                                     （fs.rename；目標已存在則 409 拒絕，不覆蓋）
 *   POST /api/ollama-chat/delete    → { project, name } 移到 chats/.bak/ 備份（不直接 unlink）
 *
 * 安全限制：
 *   - 操作目標固定為 public/upload/ollama-chat/chats，不接受任意路徑參數
 *   - project / subject 名稱經 sanitizeName（擋 / \ 空字元、..、開頭 .、" ' < > & ` 與控制字元）
 *   - 絕對路徑落點檢查 startsWith(CHATS_DIR + sep)
 *   - 存檔只收白名單欄位（model / createdAt / updatedAt / messages[{role,content,ts,model}]）
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { Readable } = require('stream');

const router = express.Router();

// 對話內容根（與前端對齊；.bak 備份也收在這棵樹下）
const CHATS_DIR = path.join(__dirname, '..', 'public', 'upload', 'ollama-chat', 'chats');
const BAK_DIR = path.join(CHATS_DIR, '.bak');

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
function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > 80) return null;
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

// 存檔白名單：只持久化已知欄位，防前端（或手改）夾帶垃圾鍵
const ROLE_WHITELIST = ['user', 'assistant', 'system'];

function cleanChat(chat) {
  if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) return null;
  const messages = [];
  for (const m of chat.messages) {
    if (!m || typeof m !== 'object') return null;
    if (!ROLE_WHITELIST.includes(m.role)) return null;
    if (typeof m.content !== 'string') return null;
    const msg = { role: m.role, content: m.content };
    if (typeof m.ts === 'string') msg.ts = m.ts;
    if (typeof m.model === 'string') msg.model = m.model;
    messages.push(msg);
  }
  const clean = { messages };
  if (typeof chat.model === 'string') clean.model = chat.model;
  clean.createdAt = typeof chat.createdAt === 'string' ? chat.createdAt : timestamp();
  clean.updatedAt = timestamp();   // 一律由 server 蓋章
  return clean;
}

// 解析 project / subject 參數 → 絕對檔案路徑；不合法回 null
function subjectPath(project, name) {
  const p = sanitizeName(project);
  const n = sanitizeName(name);
  if (!p || !n) return null;
  const abs = path.join(CHATS_DIR, p, n + '.json');
  return insideChats(abs) ? { project: p, name: n, abs } : null;
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
        let meta = { updatedAt: '', model: '', messageCount: 0 };
        try {
          const j = JSON.parse(await fs.readFile(path.join(projDir, f.name), 'utf8'));
          meta = {
            updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : '',
            model: typeof j.model === 'string' ? j.model : '',
            messageCount: Array.isArray(j.messages) ? j.messages.length : 0
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

// GET /api/ollama-chat/subject?project=&name= — 讀一個 subject
router.get('/subject', async (req, res) => {
  const loc = subjectPath(req.query.project, req.query.name);
  if (!loc) return res.status(400).json({ ok: false, error: 'invalid project/name' });
  try {
    const chat = JSON.parse(await fs.readFile(loc.abs, 'utf8'));
    return res.json({ ok: true, chat });
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
    return res.json({ ok: true, project: loc.project, name: loc.name, updatedAt: clean.updatedAt });
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

module.exports = router;
