# ollama-chat — 設計決議（為什麼長這樣）

> 版本 v1.0｜最後更新 2026-07-11

「怎麼用」見 [README](./README.zh-Hant.md)；家族共同規範見
[nodeapp-webapp-family](https://github.com/scottgfhong310/nodeapp-webapp-family)（此處只記本 app 特有的取捨）。

## 1. 資料模型：project → subject → prompt 索引

- **一組對話＝一個 JSON 檔**（`chats/<project>/<subject>.json`），project 就是資料夾。
  過 DATABASE_GUIDELINES §0 決策階梯：單人本地工具、無並發、無關聯查詢 → **檔案，不用 DB**。
- **純檔案掃描、無 registry**：`GET /tree` 掃目錄建樹、逐檔讀 meta（updatedAt / model / messageCount）。
  單一真相來源＝檔案系統，不會失同步；規模小（數百 subject 內）掃描成本可忽略。
- **名稱即路徑**：subject 標題直接當檔名（title-as-filename），JSON 內**不重複存** project/subject
  ——避免「檔名 vs 內文標題」雙真相。代價：改名＝改檔名——由 `POST /rename`（`fs.rename`）承擔：
  目標已存在回 409 拒絕（upsert 語意只留給存檔端點）、404 驗證放在 `mkdir` 之前（免留空目標夾）、
  來源 project 夾清空後順手 `rmdir`。UI 與「新對話」共用同一個 modal（rename 模式預填現值）。
- **prompt 清單是衍生資料**：由 `messages[]` 中 `role==='user'` 的項目即時推導（`promptIndex()`），
  不另外持久化——沒有可失同步的第二份清單。點擊以 `#msg-<index>` 錨點捲動＋flash 高亮。

## 2. Ollama 走後端 proxy，不由前端直打 11434

- 免設 `OLLAMA_ORIGINS`（CORS）；base URL 收在 `.env` 的 `OLLAMA_BASE_URL`，
  將來改指 LAN 上另一台機器（如 Mac mini）只改一行，前端零改動。
- **`{ ok }` 信封的唯一例外**：`POST /chat` 成功時把 Ollama 的 NDJSON chunk **原樣直通**
  （`Readable.fromWeb(upstream.body).pipe(res)`）——包信封就得逐行重組、失去直通的簡單性。
  失敗（連不上、upstream 4xx/5xx、參數不合法）仍回標準 `{ ok:false, error }`。
- **中止鏈**：前端 AbortController → fetch 斷線 → 後端 `res.on('close')` 察覺未寫完 →
  abort upstream fetch → Ollama 停止產生。按「停止」不浪費 GPU 時間；部分內容保留並存檔。

## 3. .bak 策略（對家族 canon 的有意偏離）

家族 canon 是「覆寫前 .bak」。聊天**每輪都整檔覆寫**（user 訊息一次、assistant 完成一次），
照做會每輪產生兩個 .bak、很快爆量。收斂為：

- **訊息追加型覆寫不留 .bak**——內容只增不減、風險低；
- **刪除**（破壞性）不 unlink，**整檔移到 `chats/.bak/<project>__<subject>-<ts>.json.bak`**。

## 4. Markdown 渲染：marked + DOMPurify（家族首見 chat 型內容）

- zero-md 是「整份文件」型引擎（shadow DOM、外部樣式表），不適合逐氣泡＋逐 token 更新；
  改用 **marked（鎖 12.0.2）+ DOMPurify（鎖 3.1.6）**，CDN 鎖版本。
- **渲染放控制器不放 lib**：DOMPurify 操作 DOM，依 §4.1/§4.7 判準屬 DOM 工作；
  lib 只回純文字流（`onChunk(delta, full)`）。
- 串流中**120ms 節流全文重 parse**（qwen 級輸出量遠低於 parse 成本，全文重繪最簡單且無狀態）；
  完成後才補程式碼複製鈕（§4.5 模式；light DOM 可用 Material Icons，不需 inline SVG）。
- LLM 輸出經 DOMPurify 消毒；連結一律 `target=_blank rel=noopener noreferrer`。
- 等第一個 token 期間，佔位氣泡內放家族 `thinking-dot`（`--td-size:10px`、accent 色）——
  #loading 全頁覆蓋層對 chat 情境過重，未採用。

## 5. 自動命名與 `inbox`

沒開 subject 直接輸入 → 以首句 `autoName()`（消毒、截 40 字）當 subject、落固定 project **`inbox`**
——把「開始對話」的摩擦降到零，事後再用「新對話」modal 建立有結構的 project/subject。
`uniqueName()` 對既有名單加 `-2、-3…` 後綴，防同名**整檔覆寫**掉舊對話
（後端 `POST /subject` 本身是 upsert 語意，衝突防護做在建立端）。
`inbox` 是資料（資料夾名），不隨 UI 語言翻譯。

## 6. v1 刻意不做

- **語法上色（highlight.js）**：先有複製鈕；要加時注意主題同步（github-dark ↔ github）。
- **system prompt／參數（temperature 等）**：資料格式已預留 `role:'system'`（後端白名單含之），UI 未出。
- **附檔／多模態**：故省略家族上傳骨架（`routes/upload.js`＋multer，比照 user-admin 先例）；要餵檔案給模型時再補。
- **prompt 樣板庫**：prompt 清單先做「對話索引」語意；樣板庫屬另一個儲存面，需要時另開面板。

## 7. 已知限制

- 對話 body 上限 5MB（`express.json` 家族標準）——單一 subject 極長時會撞到；屆時再議分檔或提限。
- `GET /tree` 逐檔全讀 JSON 抓 meta，數千 subject 級距才需要優化（meta sidecar 或快取）。
- 剪貼簿複製鈕需 localhost / HTTPS＋真實使用者手勢（嵌入式 preview pane 內會 fallback 到 red toast）。
