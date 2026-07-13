# ollama-chat — Session context

> 版本 v1.6｜最後更新 2026-07-13

本地 **Ollama** 模型的全版面 Web 聊天介面：**project（資料夾，一級公民＝可建立/改名/刪除、帶穩定
`uid`；`inbox`＝未歸類收容處）→ subject（一組對話＝一個 JSON 檔，帶穩定 `uid`）→ turn（request-response
配對，`uid`/`serial`）**。串流回覆（NDJSON 直通）、
markdown 渲染（marked + DOMPurify）、自動命名（首句 → subject、落 `inbox`；「新對話」Subject
留空時改由 Ollama 依首個 prompt 背景命名）、prompt 可隱藏（索引＋對話區＋context＋匯出同步排除）、
匯出 Markdown、深連結 `?uid=<subject uid>`（rename-stable；舊格式 `?project=&subject=` 仍可開，
開啟後自動升級網址）。輕量 Express 後端（Ollama proxy＋對話存取），無資料庫、無 registry——純檔案掃描。

本 app 屬於 **nodeapp WebApp 家族**；共同規範與流程在
<https://github.com/scottgfhong310/nodeapp-webapp-family>（`DESIGN_GUIDELINES.md` 規範、`WORKFLOW.md` 流程）。**改動前請先讀那兩份，照其中 canon 做。**

**設計細節（架構 / 決策 / 限制）見 [DESIGN.md](./DESIGN.md)。**

## 結構

```
app.js                              # Express 入口：port 3000；/ → 302 /apps/ollama-chat/；dotenv
routes/ollama-chat.js               # GET /models、POST /chat（串流直通）、POST /title（背景命名）、
│                                    #   GET /tree、GET|POST /subject、POST /rename、POST /delete、GET|POST /prompts
public/apps/ollama-chat/            # 前端（服務於 /apps/ollama-chat/）
├─ index.html · ollama-chat.css · ollama-chat.js · ollama-chat-lib.js
├─ materialize-dark.css             # 家族共用（Materialize 深色；materialize.css 之後載入）
├─ side-tool.css                    # 〔正統〕flex .side-tools 版（§5.5）
├─ thinking-dot.css                 # 共用載入點 utility（與 markdown-library 同步、本份消費）
├─ i18n.js · locales/{zh-Hant,en,ja}.js
├─ icons/                           # App icon；兩組 SVG：tile 版 ollama-icon(-light).svg（留白，給側鍵徽章＋apple-touch/PWA）
│                                   #   與 favicon 版 favicon(-light).svg（放大標記，分頁小尺寸用）＋favicon.ico／png／manifest.json（相對路徑）
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

- **資料模型 v2：turn（request-response，非扁平交替陣列）**——`messages[]` 一筆＝一個 turn
  `{ uid, serial, role:'user', content, ts, hidden?, response }`，`response` 巢狀掛 assistant
  回覆或 `null`。`uid` 是 request↔response 配對 key 也是 DOM 錨點（`#msg-<uid>`）；`serial`
  建立時指派一次、永不重編（匯出引用要的穩定編號）。v1 舊格式（扁平陣列）只在 `GET /subject`
  讀取時偵測並即時轉換，不主動改寫檔案，下次存檔自然落地成 v2。詳見 DESIGN.md §1／§1.1。
- **subject 也有 `uid`（chat 頂層），深連結走 `?uid=` 而非明文 `?project=&subject=`**：
  rename／搬 project 只是 `fs.rename`，`uid` 原封不動，網址因此對改名免疫；`GET /subject?uid=`
  全目錄掃描比對定位（`findSubjectByUid()`）。舊檔缺 `uid` 時讀取當下補產生**並立即寫回磁碟**
  ——是全專案唯一的「讀觸發寫」例外（v1→v2 turn 遷移不落地，這裡必須落地，因為 uid 一旦被記進
  網址列就必須穩定）。舊格式 `?project=&subject=` 深連結仍可開，開啟後 `replaceState` 就地升級成
  `?uid=`。改名成功後**不需要**也**不會**改網址。詳見 DESIGN.md §1.2。
- **project 是一級公民（建立／改名／刪除；允許空 project）**：`.project.json` marker
  （`chats/<project>/.project.json`，`{ uid, createdAt }`）＝「project 存在」的權威記錄。三個端點
  `POST /project`（建空 project：`mkdir`+marker，409＝已存在）、`POST /project/rename`（一次
  `fs.rename` 資料夾，subjects＋uid 全跟著走、subject 的 `?uid=` 深連結不受影響，409＝目標存在）、
  `POST /project/delete`（整夾搬 `.bak`，破壞性→前端 `confirm` 帶對話數）。**搬走/刪掉最後一個
  subject 後 project 留著（空的）**——`rmEmptyProjectDir` 已移除，project 只由明確 delete 消失。
  uid 目前只做資料模型、無深連結（不像 subject uid 為 `?uid=` 而做）。詳見 DESIGN.md §1.3／§1.4。
- **inbox＝「未歸到 project 的 subject」收容處**（＝空 project 值）：`DEFAULT_PROJECT`。是結構性
  bucket 不是使用者資料夾，故兩件特別待遇——**保護**（`PROTECTED_PROJECTS` 擋 rename/delete，
  後端 400、前端該列不渲染 more_vert）＋**排序固定墊底**（`GET /tree` 與 modal `<select>` 都把
  inbox 排最後）。建 project 只走左欄「＋ 新 project」（`create_new_folder`）；modal Project
  `<select>` 純挑既有（含 inbox），原本的「＋ 新 project…」哨兵已移除。
- **可嵌入 lib** `ollama-chat-lib.js`（`window.OllamaChatLib`，純邏輯、不碰 DOM）：
  `chatStream()`（fetch ReadableStream 逐行解析 NDJSON、AbortController 中止）、
  `newTurn`/`newResponse`（建構子，`genUid` 用 `crypto.randomUUID`）、
  `flattenForApi()`（turns → 扁平 `[{role,content}]`，供 Ollama context；**排除 hidden 的 turn**）、
  `promptIndex()`（user turn → 索引，含 `uid`/`serial`/`hidden`）、
  `autoName`/`isSafeName`/`uniqueName`（鏡射後端消毒）、`exportMarkdown`（用 `serial` 編號、
  跳過 hidden）、`generateTitle()`（非串流呼叫 `/title`，見下一條）、tree/subject CRUD、
  `timestamp`/`stampFilename`/`formatTs`/`formatSize`/`downloadText`。
- **新對話 Subject 可留空 → Ollama 背景命名**：「新對話」modal 的 Subject 欄留空時，先用
  `'chat-' + timestamp()` 暫時檔名建立（`state.needsAutoTitle=true`）；送出第一則訊息時
  `maybeAutoTitle()` 與正式回覆**並行**呼叫 `POST /title`（20s 逾時、失敗只 `console.warn`
  靜默保留暫時名稱），拿到標題後走**既有的 `renameSubject()`**（非另開一套命名邏輯）換掉檔名。
  詳見 DESIGN.md §5.1（含「切走再回來視同已命名」的邊界情況說明）。
- **輸入列走 Materialize `.input-field` ＋浮動 label**（§5.7）：深色由 materialize-dark.css 處理，
  app CSS 只調間距／寬度。**Materialize 1.0 的 label 自動浮起在動態情境不可靠**——控制器自掛
  focus／input／blur 三個 listener 同步 `.active`（語意與其原生一致）。訊息氣泡則是本 app 自訂設計
  （user `--user-bubble` 圓角泡、assistant 無框全寬），非 Materialize 元件。
- **改名／新對話 modal 的 Project 欄位＝Materialize `<select>`（`M.FormSelect`），純挑既有**
  （家族 §5.7 表單 canon、§5.11 版面坑）：**別用原生 `<datalist>`**——它在 Materialize modal 裡
  常常不彈出/被裁掉；但 Materialize Select 的下拉在同一個 modal 裡顯示正常（實測）。`renderProjectSelect()`
  依 `state.tree` 塞 options（inbox 墊底），每次開 modal 都 `M.FormSelect.getInstance().destroy()` 再
  `init`（樹可能已變）；new 模式預設選 `state.project||inbox`（不在樹裡就 unshift）。**建立新 project
  不在這裡**（原本的「＋ 新 project…」哨兵已移除）——走左欄「＋ 新 project」顯式動作（project 一級
  公民，見上）。**演進史**：`<input list>`+datalist（modal 內不彈）→ 手刻 body 級浮動下拉（不夠原生）
  → Materialize Select＋哨兵可順手建 → Materialize Select 純挑既有＋建立移到 project 管理（現行）。
- **markdown → HTML 在控制器不在 lib**（DOM 工作）：marked（鎖 `12.0.2`）+ DOMPurify（鎖 `3.1.6`），
  連結一律 `target=_blank rel=noopener`；串流中 120ms 節流全文重繪；完成後補 §4.5 式複製鈕
  （light DOM，可用 Material Icons，不必 inline SVG）。
- **`{ ok }` 信封的唯一例外**：`POST /chat` 成功時是 NDJSON 串流直通（失敗仍回 `{ ok:false }`）。
- **prompt 隱藏＝當作沒發生過**：`#prompt-list` 每列 hover 出 `visibility_off`，標記該 turn
  `hidden:true`。三處同步（同一個 `setPromptHidden()` → `renderMessages()`）：對話主畫面跳過該
  turn、送給模型的 context（`flattenForApi`）排除、匯出 Markdown 排除——不是只在索引打勾，見
  DESIGN.md §5.5。清單頂端「顯示已隱藏的 N 筆」可展開查看（淡化＋刪節線）並還原，還原不觸發
  `.bak`（訊息本體從未被修改，純加/減一個旗標）。
- **.bak 策略**：訊息追加型整檔覆寫**不留** .bak（每輪都寫，會爆量）；**刪除**才移到 `chats/.bak/` 備份。
- **名稱即路徑**：project/subject 名稱＝資料夾/檔名（單一真相），後端 `sanitizeName`
  擋 `/ \ ..`、開頭 `.`、`" ' < > & \`` 與控制字元；前端 `isSafeName` 鏡射同規則。
- **IME 防誤送**：輸入列 Enter 送出，但 `e.isComposing || keyCode===229`（組字中）不觸發。
- **主題**：CSS 變數 light/dark，**預設 dark**（`localStorage('ollama-chat-theme')`）；
  防閃爍開機腳本同時 toggle `dark-mode`/`light-mode` class 驅動 `materialize-dark.css`（§5.1）。
- **i18n**：`i18n.js` 引擎 + `locales/*.js`，`data-i18n` 屬性，預設 `zh-Hant`。對話內容是 **data，永不翻譯**。
- **App icon 徽章（家族 §5.5 甲）**：`#setting-menu` 用完整 app tile 取代 `folder_open`，兼作對話庫開合鈕＋品牌識別；
  方形圓角（`border-radius:22%`）、`background-image` 隨 `data-theme` 換 `ollama-icon.svg`／`-light.svg`（非 mask，tile 自帶底色），
  `.active`（樹開）用 `box-shadow` accent 外環（tile 無 currentColor，不吃 `.side-tool.active` 的邊色）。favicon/PWA 見 §5.5 乙末段。
- **side-tool**：`#setting-menu`（App icon 徽章＝左欄對話庫開合，`.active`＝開）/ `#setting-prompts`（prompt 清單 sidenav，開檔才顯示）/
  `#setting-templates`（Prompt 樣板庫 sidenav，恆顯示）/
  `#setting-new`（新對話 modal）/ `#setting-download`（匯出 .md，開檔才顯示）/ `#setting-mode` / `#setting-lang`。
- **Prompt 樣板庫**：另一個儲存面（全域單檔 `prompts.json`，與對話分開）；owner registry 式
  **整清單覆寫**、覆寫前 `.bak`（§3.5 精神，寫入頻率低）。前端記憶體 state 為真相、
  存失敗回讀伺服器；點樣板**插入輸入框游標處**（dispatch input 同步 label／清除鈕／高度）。
- **subject 列內動作（改名／刪除）**：左欄每列尾端 `more_vert`（hover 現身、觸控恆顯）展開
  `edit`／`delete` 兩鍵（一次只展一列、`stopPropagation` 不觸發開啟）——**動作對象＝該列**，
  不必先開啟該 subject；改名走與「新對話」共用 modal 的 rename 模式（`renameTarget` 記對象），
  改到／刪到目前開啟中的那組才同步 state（**網址不動**，`?uid=` 對改名免疫，見上）；
  串流中僅擋「目標＝開啟中對話」。
- **popstate 防護**：modal 的 `<a href="#!">` hash 變化也會觸發 popstate——handler 先比對
  `?uid=`（或舊格式 `?project=&subject=`）與目前 state，相同就忽略（避免無謂重載）。
- **`#tree-collapse-all`（對話庫標題列右側 icon）**：一鍵收合全部 project。是**單向動作**
  （`collapseAll()`），不是 toggle——展開永遠是個別 project 自己的事（點 `proj-head`），icon／
  文字固定不反映聚合狀態。收合狀態只在記憶體（`state.collapsed`），不落地。
- **複製件登記**（共用件改版時靠這份清單同步）：`materialize-dark.css` ←家族 repo、
  `side-tool.css` ←html-viewer（〔正統〕flex 版）、`thinking-dot.css` ←markdown-library（canonical）、
  `i18n.js` ←html-viewer（家族 30 份複製點之一）、`LICENSE` ←家族。
- **InProgress 鏡像**：同名前端回灌到 `InProgress/public/apps/ollama-chat/`，route 掛在 InProgress 的
  `/api/ollama-chat`；本 app 無檔案上傳，不用共用 `/api/upload`。GitHub 版是權威，改版後要再回灌。
