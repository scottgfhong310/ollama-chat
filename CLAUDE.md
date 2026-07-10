# ollama-chat — Session context

> 版本 v1.0｜最後更新 2026-07-11

本地 **Ollama** 模型的全版面 Web 聊天介面：**project（資料夾）→ subject（一組對話＝一個 JSON 檔）
→ prompt 索引**。串流回覆（NDJSON 直通）、markdown 渲染（marked + DOMPurify）、
自動命名（首句 → subject、落 `inbox`）、匯出 Markdown、深連結 `?project=&subject=`。
輕量 Express 後端（Ollama proxy＋對話存取），無資料庫、無 registry——純檔案掃描。

本 app 屬於 **nodeapp WebApp 家族**；共同規範與流程在
<https://github.com/scottgfhong310/nodeapp-webapp-family>（`DESIGN_GUIDELINES.md` 規範、`WORKFLOW.md` 流程）。**改動前請先讀那兩份，照其中 canon 做。**

**設計細節（架構 / 決策 / 限制）見 [DESIGN.md](./DESIGN.md)。**

## 結構

```
app.js                              # Express 入口：port 3000；/ → 302 /apps/ollama-chat/；dotenv
routes/ollama-chat.js               # GET /models、POST /chat（串流直通）、GET /tree、GET|POST /subject、POST /delete
public/apps/ollama-chat/            # 前端（服務於 /apps/ollama-chat/）
├─ index.html · ollama-chat.css · ollama-chat.js · ollama-chat-lib.js
├─ materialize-dark.css             # 家族共用（Materialize 深色；materialize.css 之後載入）
├─ side-tool.css                    # 〔正統〕flex .side-tools 版（§5.5）
├─ thinking-dot.css                 # 共用載入點 utility（與 markdown-library 同步、本份消費）
├─ i18n.js · locales/{zh-Hant,en,ja}.js
public/upload/ollama-chat/chats/    # 對話內容：<project>/<subject>.json（不進版控）；.bak/ 收刪除備份
.env（.env.example）                # OLLAMA_BASE_URL（預設 http://localhost:11434）、PORT
```

## 執行 / 驗證

```bash
npm install && node app.js          # → http://localhost:3000/apps/ollama-chat/
# 需要運行中的 Ollama（ollama serve）＋至少一個已 pull 的模型
```

## 本 app 的 canon 重點

- **可嵌入 lib** `ollama-chat-lib.js`（`window.OllamaChatLib`，純邏輯、不碰 DOM）：
  `chatStream()`（fetch ReadableStream 逐行解析 NDJSON、AbortController 中止）、
  `promptIndex()`（user 發言 → 索引）、`autoName`/`isSafeName`/`uniqueName`（鏡射後端消毒）、
  `newChat`/`userMessage`/`assistantMessage`、`exportMarkdown`、tree/subject CRUD、
  `timestamp`/`stampFilename`/`formatTs`/`formatSize`/`downloadText`。
- **markdown → HTML 在控制器不在 lib**（DOM 工作）：marked（鎖 `12.0.2`）+ DOMPurify（鎖 `3.1.6`），
  連結一律 `target=_blank rel=noopener`；串流中 120ms 節流全文重繪；完成後補 §4.5 式複製鈕
  （light DOM，可用 Material Icons，不必 inline SVG）。
- **`{ ok }` 信封的唯一例外**：`POST /chat` 成功時是 NDJSON 串流直通（失敗仍回 `{ ok:false }`）。
- **.bak 策略**：訊息追加型整檔覆寫**不留** .bak（每輪都寫，會爆量）；**刪除**才移到 `chats/.bak/` 備份。
- **名稱即路徑**：project/subject 名稱＝資料夾/檔名（單一真相），後端 `sanitizeName`
  擋 `/ \ ..`、開頭 `.`、`" ' < > & \`` 與控制字元；前端 `isSafeName` 鏡射同規則。
- **IME 防誤送**：輸入列 Enter 送出，但 `e.isComposing || keyCode===229`（組字中）不觸發。
- **主題**：CSS 變數 light/dark，**預設 dark**（`localStorage('ollama-chat-theme')`）；
  防閃爍開機腳本同時 toggle `dark-mode`/`light-mode` class 驅動 `materialize-dark.css`（§5.1）。
- **i18n**：`i18n.js` 引擎 + `locales/*.js`，`data-i18n` 屬性，預設 `zh-Hant`。對話內容是 **data，永不翻譯**。
- **side-tool**：`#setting-menu`（左欄對話庫開合，`.active`＝開）/ `#setting-prompts`（prompt 清單 sidenav，開檔才顯示）/
  `#setting-new`（新對話 modal）/ `#setting-download`（匯出 .md，開檔才顯示）/
  `#setting-delete`（刪除，開檔才顯示、hover 轉紅）/ `#setting-mode` / `#setting-lang`。
- **複製件登記**（共用件改版時靠這份清單同步）：`materialize-dark.css` ←家族 repo、
  `side-tool.css` ←html-viewer（〔正統〕flex 版）、`thinking-dot.css` ←markdown-library（canonical）、
  `i18n.js` ←html-viewer（家族 30 份複製點之一）、`LICENSE` ←家族。
- **InProgress 鏡像**：同名前端回灌到 `InProgress/public/apps/ollama-chat/`，route 掛在 InProgress 的
  `/api/ollama-chat`；本 app 無檔案上傳，不用共用 `/api/upload`。GitHub 版是權威，改版後要再回灌。
