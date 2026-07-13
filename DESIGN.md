# ollama-chat — 設計決議（為什麼長這樣）

> 版本 v1.1｜最後更新 2026-07-12

「怎麼用」見 [README](./README.zh-Hant.md)；家族共同規範見
[nodeapp-webapp-family](https://github.com/scottgfhong310/nodeapp-webapp-family)（此處只記本 app 特有的取捨）。

## 1. 資料模型：project → subject → turn（request-response）

- **一組對話＝一個 JSON 檔**（`chats/<project>/<subject>.json`），project 就是資料夾。
  過 DATABASE_GUIDELINES §0 決策階梯：單人本地工具、無並發、無關聯查詢 → **檔案，不用 DB**。
- **純檔案掃描、無 registry**：`GET /tree` 掃目錄建樹、逐檔讀 meta（updatedAt / model / turnCount）。
  單一真相來源＝檔案系統，不會失同步；規模小（數百 subject 內）掃描成本可忽略。
- **名稱即路徑**：subject 標題直接當檔名（title-as-filename），JSON 內**不重複存** project/subject
  ——避免「檔名 vs 內文標題」雙真相。代價：改名＝改檔名——由 `POST /rename`（`fs.rename`）承擔：
  目標已存在回 409 拒絕（upsert 語意只留給存檔端點）、404 驗證放在 `mkdir` 之前（免留空目標夾）、
  來源 project 夾清空後順手 `rmdir`。UI 與「新對話」共用同一個 modal（rename 模式預填現值）。
- **`messages[]` 一筆＝一個 turn（v2，request-response 結構）**：
  `{ uid, serial, role:'user', content, ts, hidden?, response }`，
  `response = { uid, role:'assistant', content, ts, model? } | null`。
  - **`uid`**：request↔response 的配對 key，取代原本「陣列位置相鄰＝配對」的隱性關係——
    也是 DOM 錨點（`#msg-<uid>`）與 prompt 清單操作（跳轉／隱藏）的定位 key，換頁重繪不受陣列增刪影響。
  - **`serial`**：建立時指派一次（`messages.length + 1`）、**永不重編**。存在的理由是匯出／引用要的是
    「這是對話裡第幾個 prompt」這個穩定編號，不是「目前還看得到的第幾個」——後者會因隱藏/未來若支援
    刪除單筆而跳動，讓「Prompt 3」這個引用失去意義。因為目前沒有插入/刪除單筆 turn 的功能，
    `serial` 與建立當下的陣列位置必然一致，不需要額外的計數器物件。
  - **`response` 巢狀而非扁平交替**：assistant 永遠是某個 user turn 的回覆，巢狀結構讓這個關係
    在型別層級就成立，不必靠「下一個陣列元素」這種脆弱假設；`response: null` 自然表達「還沒回覆／
    中止且無內容」，不用另外判斷懸空的孤兒訊息。
  - **prompt 清單仍是衍生資料**：由 `messages[]`（`role==='user'`）即時推導（`promptIndex()`），
    不另外持久化——沒有可失同步的第二份清單，只是現在每筆帶著 `uid`/`serial` 而非陣列 `index`。
- **與 Ollama context 的關係**：`flattenForApi(messages)` 把 turns 攤平回 `[{role,content}]`
  （user 接著 assistant，來源就是 `t.content` 與 `t.response.content`）送給 `/api/chat`；
  這一步只在送出前做、不落地，持久化格式與 Ollama wire format 脫鉤，換上游 API 形狀不影響存檔結構。

### 1.1 v1 → v2 遷移（讀時遷移，不主動改寫）

v1 是扁平陣列、`role` user/assistant 交替；v2 引入後**只在 `GET /subject` 讀取時偵測**
（陣列中出現過頂層 `role==='assistant'` 即判定為 v1）並即時轉換成 turn 結構回傳給前端，
**不會**在讀取當下順手覆寫檔案——維持「讀不改檔」的最小驚訝，遷移在使用者下次存檔
（送出新訊息、或任何觸發 `POST /subject` 的操作）時自然落地。轉換規則：
每個 `role==='user'` 開一個新 turn，緊接的下一筆若是 `role==='assistant'` 就配成 `response`，
否則 `response:null`（對應「送出後串流被中止、什麼都沒收到」那種歷史懸空 prompt）。

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

## 5.5 Prompt 樣板庫：另一個儲存面

「prompt 清單」是**衍生**索引（§1），樣板庫則是**使用者維護的資產**——兩者語意不同，儲存也分開：
全域單檔 `prompts.json`（跨對話重用，不掛在任何 subject 下）。維護走 §3.5 owner registry 模式：
前端記憶體 state 為唯一真相、`POST /prompts` **整清單覆寫**、覆寫前 `.bak`（寫入頻率低，不會爆量；
與 §3 對話存檔「追加型不留 .bak」形成對比——樣板刪除是破壞性的，備份成本又低）。
樣板無獨立 title 欄（顯示＝內容首行，同 prompt 索引），插入語意＝**輸入框游標處**（不覆蓋已打內容）。

### hide＝當作沒發生過，不只是視覺隱藏

Prompt 清單每列可隱藏（`turn.hidden = true`，只存 `true`）。**隱藏不是清單專屬的顯示旗標**，
而是整個 turn（`uid` 定位、request＋response 一起）的狀態，三處同時反映：

1. **對話主畫面**：`renderMessages()` 跳過 `hidden` 的 turn，索引與對話區一次重繪同步（同一顆
   `setPromptHidden()` 呼叫觸發），不是「清單裡打勾、畫面另外處理」兩條邏輯。
2. **送給模型的 context**：`flattenForApi()` 排除 hidden 的 turn——不只是不顯示，下一輪對話
   模型也不會看到它，語意對齊「這輪是誤送，當作沒發生過」而非「我知道但不想看」。
3. **匯出 Markdown**：`exportMarkdown()` 同樣跳過 hidden 的 turn。

這三處共用同一個判準（`t.hidden`），沒有「index 隱藏了但 context 還在」這種分裂狀態。
清單本身仍可展開查看已隱藏項（淡化＋刪節線），還原是可逆的（刪掉 `hidden` 旗標即可，訊息本體
從未被移除或改寫）——與「刪除」不同，隱藏不觸發 `.bak` 備份，因為沒有資料被破壞。

## 6. v1 刻意不做

- **語法上色（highlight.js）**：先有複製鈕；要加時注意主題同步（github-dark ↔ github）。
- **system prompt／參數（temperature 等）**：資料格式已預留 `role:'system'`（後端白名單含之），UI 未出。
- **附檔／多模態**：故省略家族上傳骨架（`routes/upload.js`＋multer，比照 user-admin 先例）；要餵檔案給模型時再補。

## 7. 已知限制

- 對話 body 上限 5MB（`express.json` 家族標準）——單一 subject 極長時會撞到；屆時再議分檔或提限。
- `GET /tree` 逐檔全讀 JSON 抓 meta，數千 subject 級距才需要優化（meta sidecar 或快取）。
- 剪貼簿複製鈕需 localhost / HTTPS＋真實使用者手勢（嵌入式 preview pane 內會 fallback 到 red toast）。
