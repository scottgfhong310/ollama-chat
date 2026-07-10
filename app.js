/**
 * ollama-chat — 獨立執行的 Express 伺服器
 *
 * 提供：
 *   - 靜態檔（public/）→ 應用在 /apps/ollama-chat/
 *   - Ollama proxy + 對話存取 API：/api/ollama-chat（routes/ollama-chat.js）
 *
 * Ollama 位址走 .env 的 OLLAMA_BASE_URL（預設 http://localhost:11434），
 * 將來可指向 LAN 上的另一台機器（如 Mac mini）。
 *
 * 啟動： npm install && npm start
 *        預設 http://localhost:3000/apps/ollama-chat/
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const logger = require('morgan');

const ollamaChatRouter = require('./routes/ollama-chat');

const app = express();

app.use(logger('dev'));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/ollama-chat', ollamaChatRouter);

// 根路徑導向應用頁
app.get('/', (req, res) => res.redirect('/apps/ollama-chat/'));

// 404（API 回 JSON，其餘回純文字）
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'Not found' });
  res.status(404).type('text/plain').send('Not found');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ollama-chat →  http://localhost:${PORT}/apps/ollama-chat/`);
});
