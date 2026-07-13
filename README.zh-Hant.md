# ollama-chat

> 版本 v1.1｜最後更新 2026-07-13

[English](README.md) | [繁體中文] | [日本語](README.ja.md)

本地 [Ollama](https://ollama.com) 模型的全版面 Web 聊天介面，以
**project（資料夾）→ subject（一組對話＝一個 JSON 檔）→ prompt 索引** 組織對話。
串流回覆、markdown 渲染（marked + DOMPurify）、三語 UI（zh-Hant / en / ja）、
light/dark 主題。輕量 Express 後端（Ollama proxy＋對話存取）。
隸屬 [nodeapp WebApp 家族](https://github.com/scottgfhong310/nodeapp-webapp-family)。

不相容 GitHub Pages（需要 Node 後端）。

## 功能

- **串流對話**：任何已安裝的 Ollama 模型（模型選單附大小；停止鍵會一路中止到 Ollama 端）。
- **project / subject 對話庫**：一組對話＝一個 JSON 檔，放在 `chats/<project>/<subject>.json`——純檔案、無資料庫、無 registry 可失同步。
- **Prompt 索引**：subject 內所有 user 發言列成滑出面板，點一條就捲到那一問一答。
- **Prompt 樣板庫**：全域跨對話的樣板清單（單檔 `prompts.json`）——把目前輸入存成樣板、點樣板插入輸入框游標處、刪除有備份。
- **自動命名**：沒開 subject 直接輸入，會以第一句自動命名、存進 `inbox`。「新對話」對話框的 Subject 欄也可留空——送出第一則訊息後，由 Ollama 在背景生成一句短標題並自動改名。
- **Markdown 回覆**：fenced code 附複製鈕；資料內容永不翻譯、不改寫。
- **改名／搬移**：側鍵改 subject 標題或搬到別的 project（名稱即路徑；目標已存在則拒絕、不覆蓋）。
- **匯出**：任一 subject 匯出成 Markdown（`<subject>-yyyyMMddHHmmss.md`）。
- **深連結**：`?project=<p>&subject=<s>` 直接開啟某組對話。
- 三語 i18n、CSS 變數主題（預設 dark）、家族右側工具列。

## 安裝與執行

```bash
npm install
cp .env.example .env        # Ollama 在別台機器時改 OLLAMA_BASE_URL
node app.js                 # → http://localhost:3000/apps/ollama-chat/
```

需要 Node.js ≥ 18 與運行中的 Ollama（`ollama serve`），且至少 pull 一個模型。

## 目錄結構

```
app.js                          # Express 入口：port 3000；/ → 302 /apps/ollama-chat/
routes/ollama-chat.js           # Ollama proxy＋對話存取 API
public/apps/ollama-chat/        # 前端（服務於 /apps/ollama-chat/）
├─ index.html · ollama-chat.css · ollama-chat.js · ollama-chat-lib.js
├─ materialize-dark.css · side-tool.css · thinking-dot.css   # 家族共用資產
├─ i18n.js · locales/{zh-Hant,en,ja}.js
public/upload/ollama-chat/chats/    # 對話內容（不進版控）
```

## API

| Method | Path | 說明 |
|---|---|---|
| GET | `/api/ollama-chat/models` | 轉 Ollama `/api/tags` → `{ ok, models }` |
| POST | `/api/ollama-chat/chat` | 轉 Ollama `/api/chat`（NDJSON 串流直通；失敗回 `{ ok:false, error }`） |
| POST | `/api/ollama-chat/title` | `{ model, prompt }`——非串流，生一句短對話標題 → `{ ok, title }`（20s 逾時） |
| GET | `/api/ollama-chat/tree` | 掃 `chats/` → `{ ok, projects: [{ name, subjects }] }` |
| GET | `/api/ollama-chat/subject?project=&name=` | 讀一個 subject → `{ ok, chat }` |
| POST | `/api/ollama-chat/subject` | `{ project, name, chat }`——整檔覆寫存檔 |
| POST | `/api/ollama-chat/rename` | `{ project, name, newProject, newName }`——改名／搬到別的 project（目標已存在回 409） |
| POST | `/api/ollama-chat/delete` | `{ project, name }`——檔案移到 `chats/.bak/` 備份 |
| GET | `/api/ollama-chat/prompts` | 讀樣板庫 → `{ ok, prompts }` |
| POST | `/api/ollama-chat/prompts` | `{ prompts: [...] }`——整清單覆寫（覆寫前先備份舊檔） |

除成功的 `/chat` 串流（原樣直通 Ollama 的 NDJSON）外，所有端點皆用家族 `{ ok }` 信封。

## 資料結構

```jsonc
// chats/<project>/<subject>.json — 一組對話。
// messages[] 一筆＝一個 turn——request 與其（選填）response 配成一組，靠 uid 而非陣列位置連結。
// serial 建立時指派一次、永不重編，即使日後前面的 turn 被隱藏，匯出／引用的編號仍然穩定。
{
  "model": "qwen2.5:latest",        // 最後使用的模型
  "createdAt": "20260711000000",    // yyyyMMddHHmmss（server 正規化）
  "updatedAt": "20260711000102",    // 每次存檔由 server 蓋章
  "messages": [
    {
      "uid": "b3f1...",              // 穩定 id——request↔response 的配對 key，也是 DOM 錨點
      "serial": 1,                   // 1-based，建立時指派、永不重複使用或重編
      "role": "user",
      "content": "…",
      "ts": "20260711000000",
      "hidden": true,                // 選填，只有 true 才會出現——見下方「Prompt 隱藏」
      "response": {                  // 等待回覆中，或中止且無內容時為 null
        "uid": "9c2a...",
        "role": "assistant",
        "content": "…",
        "ts": "20260711000012",
        "model": "qwen2.5:latest"
      }
    }
  ]
}
```

### Prompt 隱藏

任一 turn 都能從 prompt 清單面板隱藏——隱藏會**同時**把該 turn（request 與 response 一起）從
對話主畫面收起；資料仍留在檔案裡，但**不會**被算進下一輪送給 Ollama 的上下文、也不會出現在
匯出的 Markdown 裡，也就是「隱藏」＝當作這段交流沒發生過，不只是視覺上藏起來。

```jsonc
// prompts.json — 全域 prompt 樣板庫
{
  "prompts": [
    { "content": "請把以下內容翻譯成繁體中文：\n\n", "ts": "20260711073309", "title": "選填的顯示名" }
  ]
}
```

```jsonc
// GET /api/ollama-chat/tree →
{
  "ok": true,
  "projects": [
    {
      "name": "inbox",
      "subjects": [
        { "name": "…", "updatedAt": "20260711000102", "model": "qwen2.5:latest", "turnCount": 4 }
      ]
    }
  ]
}
```

## 核心 library（`OllamaChatLib`）

純邏輯、不碰 DOM（`window.OllamaChatLib`，零依賴）：

```js
const chat = OllamaChatLib.newChat('qwen2.5:latest');
const turn = OllamaChatLib.newTurn('你好', chat.messages.length + 1);
chat.messages.push(turn);
await OllamaChatLib.chatStream({
  model: chat.model,
  messages: OllamaChatLib.flattenForApi(chat.messages),   // turns → 扁平 [{role,content}] 給 Ollama
  onChunk: (delta, full) => render(full)
});                                       // → { content, stats, aborted }
turn.response = OllamaChatLib.newResponse('你好！', chat.model);
OllamaChatLib.promptIndex(chat.messages); // → [{ uid, serial, ts, text, hidden }]
await OllamaChatLib.saveSubject('inbox', 'hello', chat);
```

## License

[MIT](LICENSE) © 2026 [Scott G.F. Hong](https://github.com/scottgfhong310)
