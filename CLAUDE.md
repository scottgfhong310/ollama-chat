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
routes/ollama-chat.js               # GET /models、POST /chat（串流直通）、GET /tree、GET|POST /subject、POST /rename、POST /delete、GET|POST /prompts
public/apps/ollama-chat/            # 前端（服務於 /apps/ollama-chat/）
├─ index.html · ollama-chat.css · ollama-chat.js · ollama-chat-lib.js
├─ materialize-dark.css             # 家族共用（Materialize 深色；materialize.css 之後載入）
├─ side-tool.css                    # 〔正統〕flex .side-tools 版（§5.5）
├─ thinking-dot.css                 # 共用載入點 utility（與 markdown-library 同步、本份消費）
├─ i18n.js · locales/{zh-Hant,en,ja}.js
├─ icons/                           # App icon（favicon.ico／svg／png 16-512／manifest.json；相對路徑引用）
public/upload/ollama-chat/chats/    # 對話內容：<project>/<subject>.json（不進版控）；.bak/ 收刪除備份
public/upload/ollama-chat/prompts.json  # Prompt 樣板庫（全域單檔，不進版控）；備份在 ../.bak/
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
- **輸入列走 Materialize `.input-field` ＋浮動 label**（§5.7）：深色由 materialize-dark.css 處理，
  app CSS 只調間距／寬度。**Materialize 1.0 的 label 自動浮起在動態情境不可靠**——控制器自掛
  focus／input／blur 三個 listener 同步 `.active`（語意與其原生一致）。訊息氣泡則是本 app 自訂設計
  （user `--user-bubble` 圓角泡、assistant 無框全寬），非 Materialize 元件。
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
  `#setting-templates`（Prompt 樣板庫 sidenav，恆顯示）/
  `#setting-new`（新對話 modal）/ `#setting-download`（匯出 .md，開檔才顯示）/ `#setting-mode` / `#setting-lang`。
- **Prompt 樣板庫**：另一個儲存面（全域單檔 `prompts.json`，與對話分開）；owner registry 式
  **整清單覆寫**、覆寫前 `.bak`（§3.5 精神，寫入頻率低）。前端記憶體 state 為真相、
  存失敗回讀伺服器；點樣板**插入輸入框游標處**（dispatch input 同步 label／清除鈕／高度）。
- **subject 列內動作（改名／刪除）**：左欄每列尾端 `more_vert`（hover 現身、觸控恆顯）展開
  `edit`／`delete` 兩鍵（一次只展一列、`stopPropagation` 不觸發開啟）——**動作對象＝該列**，
  不必先開啟該 subject；改名走與「新對話」共用 modal 的 rename 模式（`renameTarget` 記對象），
  改到／刪到目前開啟中的那組才同步 state／URL 或收畫面；串流中僅擋「目標＝開啟中對話」。
- **popstate 防護**：modal 的 `<a href="#!">` hash 變化也會觸發 popstate——handler 先比對
  `?project/&subject` 與目前 state，相同就忽略（否則改名後會拿舊名重載 → 404）。
- **複製件登記**（共用件改版時靠這份清單同步）：`materialize-dark.css` ←家族 repo、
  `side-tool.css` ←html-viewer（〔正統〕flex 版）、`thinking-dot.css` ←markdown-library（canonical）、
  `i18n.js` ←html-viewer（家族 30 份複製點之一）、`LICENSE` ←家族。
- **InProgress 鏡像**：同名前端回灌到 `InProgress/public/apps/ollama-chat/`，route 掛在 InProgress 的
  `/api/ollama-chat`；本 app 無檔案上傳，不用共用 `/api/upload`。GitHub 版是權威，改版後要再回灌。
