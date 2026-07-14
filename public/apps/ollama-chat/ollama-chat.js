/**
 * ollama-chat — 頁面控制器（glue）
 *
 * DOM 行為：主題切換、i18n（透過 I18n 引擎）、對話庫樹（project→subject）、
 * 訊息渲染（marked + DOMPurify）、串流中節流重繪、prompt 清單跳轉、
 * 新對話 modal、刪除／匯出、輸入列（Enter 送出、IME 組字不誤送）。
 * 串流讀取、對話物件、prompt 索引、與伺服器溝通在 ollama-chat-lib.js；
 * i18n 引擎在 i18n.js，語言字典在 locales/<code>.js。
 *
 * 依賴（皆於 index.html 先載入）：jQuery / Materialize / Lodash / marked / DOMPurify /
 * OllamaChatLib / I18n（+ locales）。
 */

(function () {
  'use strict';

  var L = window.OllamaChatLib;
  var THEME_KEY = 'ollama-chat-theme';
  var MODEL_KEY = 'ollama-chat-model';
  var DEFAULT_PROJECT = 'inbox';   // 直接輸入（未先建 subject）時的落點資料夾

  var chatScroll = document.getElementById('chat-scroll');
  var chatList = document.getElementById('chat-list');
  var inputEl = document.getElementById('chat-text');
  var sendBtn = document.getElementById('send-btn');
  var clearBtn = document.getElementById('clear-btn');
  var treeEl = document.getElementById('tree');
  var modelSelect = document.getElementById('model-select');
  var crumbProject = document.getElementById('crumb-project');
  var crumbSep = document.getElementById('crumb-sep');
  var crumbSubject = document.getElementById('crumb-subject');
  var promptList = document.getElementById('prompt-list');
  var promptPath = document.getElementById('prompt-path');

  var state = {
    theme: 'dark',
    models: [],
    model: '',
    templates: [],   // prompt 樣板庫（全域單檔 prompts.json）
    systemPrompt: '',   // 全域 system prompt（settings.json）；每次送出前 prepend 給 Ollama
    tree: [],
    project: null,   // 目前開啟的 project（資料夾名）
    subject: null,   // 目前開啟的 subject（檔名去 .json）
    chat: null,      // { model, createdAt, updatedAt, messages: [turn] }（turn 結構見 lib 檔頭）
    needsAutoTitle: false,   // 目前 subject 是「新對話留空」的暫時檔名；只在真正改名成功後才清（失敗會重試）
    autoTitleInFlight: false,   // 防止上一次還沒回來就又送一個 title 生成請求（不代表已完成）
    streaming: false,
    abortCtl: null,
    collapsed: {}    // project name → true（樹狀收合狀態，僅記憶體）
  };

  /* ---------- 主題（light / dark） ---------- */

  function applyTheme(theme) {
    theme = theme === 'light' ? 'light' : 'dark';
    state.theme = theme;
    var r = document.documentElement;
    r.setAttribute('data-theme', theme);
    r.classList.toggle('dark-mode', theme === 'dark');
    r.classList.toggle('light-mode', theme === 'light');
    var icon = document.querySelector('#setting-mode i');
    if (icon) icon.textContent = theme === 'dark' ? 'dark_mode' : 'light_mode';
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  }

  // 「已執行」微回饋：icon 暫時變 check 800ms（家族 §5.5）
  function setIconDone(el) {
    var i = el && el.querySelector('i');
    if (!i) return;
    var orig = i.textContent;
    i.textContent = 'check';
    setTimeout(function () { i.textContent = orig; }, 800);
  }

  /* ---------- Markdown 渲染（DOM 工作，故在控制器不在 lib） ---------- */

  marked.use({ gfm: true, breaks: true });

  // 外部連結一律新分頁 + noopener（LLM 輸出裡的連結不該奪走本頁）
  DOMPurify.addHook('afterSanitizeAttributes', function (node) {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  function renderMarkdown(text) {
    return DOMPurify.sanitize(marked.parse(String(text || '')));
  }

  /* ---------- 程式碼區塊複製鈕（比照家族 §4.5；冪等） ---------- */

  function addCopyButtons(container) {
    container.querySelectorAll('pre').forEach(function (pre) {
      if (pre.parentElement && pre.parentElement.classList.contains('code-wrap')) return;
      var wrap = document.createElement('div');
      wrap.className = 'code-wrap';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      var btn = document.createElement('button');
      btn.className = 'code-copy';
      btn.type = 'button';
      btn.title = I18n.t('tool.copyCode');
      btn.innerHTML = '<i class="material-icons">content_copy</i>';
      btn.addEventListener('click', function () {
        var code = pre.querySelector('code');
        var text = code ? code.textContent : pre.textContent;
        navigator.clipboard.writeText(text).then(function () {
          btn.classList.add('copied');
          btn.querySelector('i').textContent = 'check';
          setTimeout(function () {
            btn.classList.remove('copied');
            btn.querySelector('i').textContent = 'content_copy';
          }, 1200);
          M.toast({ html: I18n.t('toast.copied'), classes: 'teal' });
        }).catch(function () {
          M.toast({ html: I18n.t('toast.copyFail'), classes: 'red' });
        });
      });
      wrap.appendChild(btn);
    });
  }

  /* ---------- 訊息渲染（一個 turn＝一個 request 泡泡＋選填的 response 泡泡） ---------- */

  function buildBubble(role, content) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    var bubble = document.createElement('div');
    if (role === 'assistant') {
      bubble.className = 'bubble md';
      bubble.innerHTML = renderMarkdown(content);
      addCopyButtons(bubble);
    } else {
      bubble.className = 'bubble';
      bubble.textContent = content;
    }
    wrap.appendChild(bubble);
    return wrap;
  }

  function buildTurnEl(turn) {
    var wrap = document.createElement('div');
    wrap.className = 'turn';
    wrap.id = 'msg-' + turn.uid;

    var userWrap = buildBubble('user', turn.content);
    var userMeta = document.createElement('div');
    userMeta.className = 'meta';
    userMeta.textContent = L.formatTs(turn.ts);
    userWrap.appendChild(userMeta);
    wrap.appendChild(userWrap);

    if (turn.response) {
      var aWrap = buildBubble('assistant', turn.response.content);
      var aMeta = document.createElement('div');
      aMeta.className = 'meta';
      aMeta.textContent = (turn.response.model ? turn.response.model + ' · ' : '') + L.formatTs(turn.response.ts);
      aWrap.appendChild(aMeta);
      wrap.appendChild(aWrap);
    }
    return wrap;
  }

  function renderMessages() {
    chatList.innerHTML = '';
    var turns = (state.chat && state.chat.messages) || [];
    var shown = 0;
    turns.forEach(function (t) {
      if (t.hidden) return;   // 隱藏＝索引與對話區同時隱藏（家族/DESIGN §5.5）
      chatList.appendChild(buildTurnEl(t));
      shown++;
    });
    document.body.classList.toggle('is-empty', !shown);
    renderPromptList();
  }

  function nearBottom() {
    return chatScroll.scrollTop + chatScroll.clientHeight >= chatScroll.scrollHeight - 120;
  }

  function scrollBottom() {
    chatScroll.scrollTop = chatScroll.scrollHeight;
  }

  /* ---------- 頁面狀態（topbar / 側鍵可見性 / 標題） ---------- */

  function updateChrome() {
    var open = !!state.subject;
    crumbProject.textContent = open ? state.project : '';
    crumbSep.style.display = open ? '' : 'none';
    if (open) {
      crumbSubject.removeAttribute('data-i18n');
      crumbSubject.textContent = state.subject;
      document.title = state.subject + ' | ' + I18n.t('title.suffix');
    } else {
      crumbSubject.setAttribute('data-i18n', 'topbar.none');
      crumbSubject.textContent = I18n.t('topbar.none');
      document.title = I18n.t('title.suffix');
    }
    // subject 相關側鍵只在有開啟對話時顯示（.side-tool 預設 flex，顯示要給明確值）
    ['setting-prompts', 'setting-download'].forEach(function (id) {
      document.getElementById(id).style.display = open ? 'flex' : 'none';
    });
    promptPath.textContent = open ? (state.project + '／' + state.subject) : '';
  }

  /* ---------- 對話庫樹 ---------- */

  function refreshTree() {
    return L.getTree().then(function (projects) {
      state.tree = projects;
      renderTree();
    }).catch(function (err) {
      M.toast({ html: I18n.t('toast.treeFail', { m: err.message }), classes: 'red' });
    });
  }

  // 全部收合是單向動作，不是 toggle——展開永遠是個別 project 自己的事（點 proj-head）。
  // 按鈕圖示／文字固定，不必反映聚合狀態。
  function collapseAll() {
    if (!state.tree.length) return;
    state.tree.forEach(function (p) { state.collapsed[p.name] = true; });
    renderTree();
  }

  function renderTree() {
    if (!state.tree.length) {
      treeEl.innerHTML = '<div class="tree-empty">' + I18n.t('tree.empty') + '</div>';
      return;
    }
    treeEl.innerHTML = state.tree.map(function (p) {
      var subjects = p.subjects.map(function (s) {
        var active = (p.name === state.project && s.name === state.subject);
        return '<li data-project="' + _.escape(p.name) + '" data-name="' + _.escape(s.name) + '"' +
          (active ? ' class="active"' : '') + '>' +
          '<i class="material-icons">chat_bubble_outline</i>' +
          '<span class="subj-name">' + _.escape(s.name) + '</span>' +
          '<span class="subj-meta">' + (s.turnCount || 0) + '</span>' +
          // more_vert 展開該列的 改名／刪除（動作對象＝這一列，不必先開啟該 subject）
          '<span class="subj-actions">' +
          '<i class="material-icons subj-act subj-act-edit" title="' + _.escape(I18n.t('tool.rename')) + '">edit</i>' +
          '<i class="material-icons subj-act subj-act-del" title="' + _.escape(I18n.t('tool.delete')) + '">delete</i>' +
          '</span>' +
          '<i class="material-icons subj-more" title="' + _.escape(I18n.t('tool.subjActions')) + '">more_vert</i>' +
          '</li>';
      }).join('');
      // inbox＝未歸類 bucket，受保護：不出現改名／刪除動作（見 DESIGN.md project 一級公民）
      var actions = (p.name === DEFAULT_PROJECT) ? '' :
        '<span class="proj-actions">' +
        '<i class="material-icons proj-act proj-act-edit" title="' + _.escape(I18n.t('proj.rename')) + '">edit</i>' +
        '<i class="material-icons proj-act proj-act-del" title="' + _.escape(I18n.t('proj.delete')) + '">delete</i>' +
        '</span>' +
        '<i class="material-icons proj-more" title="' + _.escape(I18n.t('proj.actions')) + '">more_vert</i>';
      return '<div class="proj' + (state.collapsed[p.name] ? ' collapsed' : '') + '" data-project="' + _.escape(p.name) + '">' +
        '<div class="proj-head">' +
        '<i class="material-icons">folder</i>' +
        '<span class="proj-name">' + _.escape(p.name) + '</span>' +
        '<span class="count">' + p.subjects.length + '</span>' +
        '<i class="material-icons caret">expand_more</i>' +
        actions +
        '</div>' +
        '<ul class="subjects">' + subjects + '</ul>' +
        '</div>';
    }).join('');
  }

  function markTreeActive() {
    treeEl.querySelectorAll('.subjects li').forEach(function (li) {
      li.classList.toggle('active',
        li.getAttribute('data-project') === state.project &&
        li.getAttribute('data-name') === state.subject);
    });
  }

  /* ---------- 新對話／改名 modal：Project 欄位（Materialize 原生 <select>） ----------
     用 Materialize <select>（M.FormSelect）純挑既有 project（含 inbox）——建立新 project 是
     project 管理的事、走左欄「＋ 新 project」，不在這裡順手建（見 DESIGN.md project 一級公民）。
     Materialize Select 的下拉在 modal 裡顯示正常（實測，家族 §5.11）；別用原生 <datalist>。 */

  // 依對話庫樹重建 select 的 options；selected 為要預選的 project（rename＝目前所在，new＝預設）。
  // selected 不在樹裡時補進去（new 模式預設 inbox，但沒任何對話時 inbox 夾尚不存在＝不在樹裡）。
  function renderProjectSelect(selected) {
    var sel = document.getElementById('new-project-select');
    var names = state.tree.map(function (p) { return p.name; });
    if (selected && names.indexOf(selected) === -1) names.unshift(selected);
    sel.innerHTML = names.map(function (n) {
      return '<option value="' + _.escape(n) + '"' + (n === selected ? ' selected' : '') + '>' +
        _.escape(n) + '</option>';
    }).join('');
    var inst = M.FormSelect.getInstance(sel);
    if (inst) inst.destroy();   // 每次開啟樹可能已變，重建才不會殘留舊選項
    M.FormSelect.init(sel);
  }

  // 該 project 下已存在的 subject 名（避免自動命名整檔覆寫掉既有對話）
  function takenNames(project) {
    var hit = state.tree.filter(function (p) { return p.name === project; })[0];
    return hit ? hit.subjects.map(function (s) { return s.name; }) : [];
  }

  /* ---------- 開啟 / 建立 subject ---------- */

  // 套用「已載入的 chat」到畫面／state／網址。網址一律走 ?uid=（rename/搬 project 不失效）；
  // historyMode：undefined→pushState（新開一筆歷史）、true→不動網址（popstate／已就位的深連結）、
  // 'replace'→replaceState（舊格式 ?project=&subject= 深連結，開啟後就地升級成 ?uid=，不多留歷史筆數）。
  function applyOpenedSubject(project, name, chat, historyMode) {
    state.project = project;
    state.subject = name;
    state.chat = chat;
    // subject 記錄的模型若仍可用，跟著切換
    if (chat.model && state.models.some(function (m) { return m.name === chat.model; })) {
      setModel(chat.model);
    }
    if (historyMode !== true) {
      try {
        var url = '?uid=' + encodeURIComponent(chat.uid);
        if (historyMode === 'replace') history.replaceState({ uid: chat.uid }, '', url);
        else history.pushState({ uid: chat.uid }, '', url);
      } catch (e) {}
    }
    state.needsAutoTitle = false;   // 開啟既有 subject 一律視為已命名（邊界情況見 DESIGN.md）
    renderMessages();
    updateChrome();
    markTreeActive();
    scrollBottom();
  }

  function openSubject(project, name, historyMode) {
    if (state.streaming) {
      M.toast({ html: I18n.t('toast.busy'), classes: 'orange' });
      return Promise.resolve();
    }
    return L.loadSubject(project, name).then(function (chat) {
      applyOpenedSubject(project, name, chat, historyMode);
    }).catch(function (err) {
      M.toast({ html: I18n.t('toast.loadFail', { n: project + '／' + name, m: err.message }), classes: 'red' });
    });
  }

  // uid 定位版：deep link（?uid=）與 popstate 用。找不到（改名前的舊 uid 亂入等）給明確錯誤 toast。
  function openSubjectByUid(uid, historyMode) {
    if (state.streaming) {
      M.toast({ html: I18n.t('toast.busy'), classes: 'orange' });
      return Promise.resolve();
    }
    return L.loadSubjectByUid(uid).then(function (d) {
      applyOpenedSubject(d.project, d.name, d.chat, historyMode);
    }).catch(function (err) {
      M.toast({ html: I18n.t('toast.loadFail', { n: uid, m: err.message }), classes: 'red' });
    });
  }

  function closeSubject() {
    state.needsAutoTitle = false;
    state.project = null;
    state.subject = null;
    state.chat = null;
    try { history.replaceState({}, '', './'); } catch (e) {}
    renderMessages();
    updateChrome();
    markTreeActive();
  }

  // 直接輸入（尚未開啟 subject）→ 以首個 prompt 自動命名、落 inbox
  function ensureSubject(firstText) {
    if (state.chat) return false;
    var project = DEFAULT_PROJECT;
    var name = L.autoName(firstText) || 'chat-' + L.timestamp();
    name = L.uniqueName(name, takenNames(project));
    state.project = project;
    state.subject = name;
    state.chat = L.newChat(state.model);
    try {
      history.pushState({ uid: state.chat.uid }, '', '?uid=' + encodeURIComponent(state.chat.uid));
    } catch (e) {}
    updateChrome();
    return true;
  }

  /* ---------- 存檔 ---------- */

  function persist() {
    if (!state.subject || !state.chat) return Promise.resolve();
    return L.saveSubject(state.project, state.subject, state.chat).then(function (d) {
      state.chat.updatedAt = d.updatedAt;
      return refreshTree();
    }).catch(function (err) {
      M.toast({ html: I18n.t('toast.saveFail', { m: err.message }), classes: 'red' });
    });
  }

  /* ---------- 送出 / 串流 ---------- */

  // 清除鈕只在輸入框有內容時顯示（.style.display 給明確值，家族 §4.7 顯示坑）
  function updateClearBtn() {
    clearBtn.style.display = inputEl.value ? 'flex' : 'none';
  }

  function setSendBtn(streaming) {
    sendBtn.classList.toggle('stop', streaming);
    sendBtn.querySelector('i').textContent = streaming ? 'stop' : 'send';
    sendBtn.title = I18n.t(streaming ? 'btn.stop' : 'btn.send');
  }

  function send() {
    if (state.streaming) {           // 串流中，送出鍵＝停止鍵
      if (state.abortCtl) state.abortCtl.abort();
      return;
    }
    var text = inputEl.value.replace(/\s+$/, '');
    if (!text.trim()) return;
    if (!state.model) {
      M.toast({ html: I18n.t('toast.noModel'), classes: 'orange' });
      return;
    }
    ensureSubject(text);
    inputEl.value = '';
    M.textareaAutoResize(inputEl);
    updateClearBtn();
    state.chat.model = state.model;
    var turn = L.newTurn(text, state.chat.messages.length + 1);
    state.chat.messages.push(turn);
    renderMessages();
    updateChrome();
    scrollBottom();
    persist();
    // needsAutoTitle 只在真正改名成功後才清（見 maybeAutoTitle）——失敗／逾時會保留，
    // 下一則訊息自動重試；autoTitleInFlight 只是防同時併發兩個請求，不是「已完成」的意思。
    if (state.needsAutoTitle && !state.autoTitleInFlight) {
      maybeAutoTitle(state.project, state.subject, text);
    }
    startStream(turn);
  }

  // 背景任務：依 prompt 向 Ollama 要一句標題，成功則把暫時檔名（chat-<ts>）改成該標題。
  // 與主串流並行（不等它）。失敗／逾時只記 console、**不清 needsAutoTitle**——保留暫時檔名
  // （本身已是可用的合法 subject，不影響對話），讓下一則訊息送出時自動再試一次，直到成功
  // 或使用者切走／手動改名（見 openSubject/closeSubject 對 needsAutoTitle 的處理）。
  function maybeAutoTitle(project, placeholder, promptText) {
    state.autoTitleInFlight = true;
    L.generateTitle({ model: state.model, prompt: promptText }).then(function (raw) {
      var title = L.autoName(raw);   // 借用既有消毒/截斷規則，確保合法檔名
      if (!title) throw new Error('empty title after sanitize');
      // 期間使用者可能已切走／手動改名——只有「目前仍是那個暫時檔名」才套用
      if (state.project !== project || state.subject !== placeholder) return;
      title = L.uniqueName(title, takenNames(project).filter(function (n) { return n !== placeholder; }));
      return L.renameSubject(project, placeholder, project, title).then(function (d) {
        if (state.project === project && state.subject === placeholder) {
          state.project = d.project;
          state.subject = d.name;
          state.needsAutoTitle = false;   // 真正改名成功才清，失敗維持 true 讓下一則訊息重試
          // 網址不必動：?uid= 是 rename-stable，改名不改 chat.uid（見 applyOpenedSubject）
          updateChrome();
        }
        return refreshTree();   // 重繪樹（renderTree 依 state.project/subject 自行標記 active）
      });
    }).catch(function (err) {
      console.warn('[ollama-chat] auto-title 失敗，暫時保留現有名稱，下一則訊息會再試一次：', err.message);
    }).then(function () {
      state.autoTitleInFlight = false;
    });
  }

  function startStream(turn) {
    state.streaming = true;
    setSendBtn(true);

    // 佔位訊息掛在該 turn 容器內：先「思考中」脈動點，第一個 token 到就換成串流內容
    var container = document.getElementById('msg-' + turn.uid);
    var pendingWrap = document.createElement('div');
    pendingWrap.className = 'msg assistant streaming';
    var pendingBubble = document.createElement('div');
    pendingBubble.className = 'bubble md';
    pendingBubble.innerHTML = '<span class="thinking-dot"></span>';
    pendingWrap.appendChild(pendingBubble);
    container.appendChild(pendingWrap);
    scrollBottom();

    var ctl = new AbortController();
    state.abortCtl = ctl;
    var lastRender = 0;

    function renderPending(full) {
      var stick = nearBottom();
      pendingBubble.innerHTML = renderMarkdown(full);
      if (stick) scrollBottom();
    }

    L.chatStream({
      model: state.model,
      // 全域 system prompt（非空時）prepend 在最前，接著才是對話 turns（見 withSystemPrompt）
      messages: L.withSystemPrompt(state.chat.messages, state.systemPrompt),
      signal: ctl.signal,
      onChunk: function (delta, full) {
        var now = Date.now();
        if (now - lastRender > 120) {   // 節流重繪：markdown 全文重 parse，120ms 一次足夠順
          lastRender = now;
          renderPending(full);
        }
      }
    }).then(function (r) {
      state.streaming = false;
      state.abortCtl = null;
      setSendBtn(false);
      pendingWrap.remove();
      if (r.content) {
        var model = (r.stats && r.stats.model) || state.model;
        turn.response = L.newResponse(r.content, model);
        renderMessages();
        scrollBottom();
        persist();
      }
      if (r.aborted) M.toast({ html: I18n.t('toast.aborted'), classes: 'grey' });
    }).catch(function (err) {
      state.streaming = false;
      state.abortCtl = null;
      setSendBtn(false);
      pendingWrap.remove();
      renderMessages();   // is-empty 等狀態復原
      M.toast({ html: I18n.t('toast.chatFail', { m: err.message }), classes: 'red' });
    });
  }

  /* ---------- 模型清單 ---------- */

  function setModel(name) {
    state.model = name;
    try { localStorage.setItem(MODEL_KEY, name); } catch (e) {}
    if (modelSelect.value !== name) {
      modelSelect.value = name;
      M.FormSelect.init(modelSelect);
    }
  }

  function loadModels() {
    return L.listModels().then(function (models) {
      state.models = models;
      modelSelect.innerHTML = models.map(function (m) {
        return '<option value="' + _.escape(m.name) + '">' +
          _.escape(m.name) + '（' + L.formatSize(m.size) + '）</option>';
      }).join('');
      var saved = null;
      try { saved = localStorage.getItem(MODEL_KEY); } catch (e) {}
      var pick = models.some(function (m) { return m.name === saved; }) ? saved
        : (models.length ? models[0].name : '');
      if (pick) setModel(pick);
      M.FormSelect.init(modelSelect);
      if (!models.length) M.toast({ html: I18n.t('toast.noModel'), classes: 'orange' });
    }).catch(function (err) {
      M.FormSelect.init(modelSelect);
      M.toast({ html: I18n.t('toast.modelsFail', { m: err.message }), classes: 'red' });
    });
  }

  /* ---------- prompt 清單（右側 sidenav） ---------- */

  var showHiddenPrompts = false;   // 是否展開已隱藏的 prompt（僅記憶體、每 session）

  function promptRow(it, n, hidden) {
    var icon = hidden ? 'visibility' : 'visibility_off';
    var title = _.escape(I18n.t(hidden ? 'prompt.unhide' : 'prompt.hide'));
    return '<li><a href="#!" class="prompt-item' + (hidden ? ' is-hidden' : '') + '" data-uid="' + _.escape(it.uid) + '">' +
      '<span class="prompt-no">' + (n === null ? '' : (n + 1) + '.') + '</span>' +
      '<span class="prompt-text">' + _.escape(it.text) + '</span>' +
      '<i class="material-icons prompt-hide" data-uid="' + _.escape(it.uid) + '" title="' + title + '">' + icon + '</i>' +
      '</a></li>';
  }

  function renderPromptList() {
    var items = L.promptIndex((state.chat && state.chat.messages) || []);
    var visible = items.filter(function (it) { return !it.hidden; });
    var hidden = items.filter(function (it) { return it.hidden; });

    if (!items.length) {
      promptList.innerHTML = '<div class="prompt-empty">' + I18n.t('prompt.empty') + '</div>';
      return;
    }

    var html = '';
    // 頂端：有隱藏項才出現的展開/收合切換
    if (hidden.length) {
      html += '<li><a href="#!" id="prompt-toggle-hidden" class="prompt-toggle">' +
        '<i class="material-icons">' + (showHiddenPrompts ? 'expand_less' : 'visibility_off') + '</i>' +
        '<span>' + I18n.t(showHiddenPrompts ? 'prompt.hideHidden' : 'prompt.showHidden', { n: hidden.length }) + '</span>' +
        '</a></li>';
    }
    // 可見列
    html += visible.map(function (it, n) { return promptRow(it, n, false); }).join('');
    // 全部被隱藏且未展開時，給個提示
    if (!visible.length && !showHiddenPrompts) {
      html += '<div class="prompt-empty">' + I18n.t('prompt.allHidden') + '</div>';
    }
    // 展開的隱藏列
    if (showHiddenPrompts) {
      html += hidden.map(function (it) { return promptRow(it, null, true); }).join('');
    }
    promptList.innerHTML = html;
  }

  // 設定某 turn 的隱藏狀態（uid 定位、持久化）。renderMessages() 同時重繪對話區與
  // prompt 索引——一次呼叫達成「hide 時對話區內容同步隱藏」（家族/DESIGN §5.5）。
  function setPromptHidden(uid, hide) {
    var turns = (state.chat && state.chat.messages) || [];
    var turn = null;
    for (var i = 0; i < turns.length; i++) { if (turns[i].uid === uid) { turn = turns[i]; break; } }
    if (!turn) return;
    if (hide) turn.hidden = true; else delete turn.hidden;
    renderMessages();
    persist();
  }

  function jumpToMessage(uid) {
    var el = document.getElementById('msg-' + uid);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('flash');
    void el.offsetWidth;   // 重觸發動畫
    el.classList.add('flash');
  }

  /* ---------- Prompt 樣板庫（全域、跨對話；點樣板插入輸入框游標處） ---------- */

  var templateList = document.getElementById('template-list');

  function renderTemplates() {
    if (!state.templates.length) {
      templateList.innerHTML = '<div class="prompt-empty">' + I18n.t('tpl.empty') + '</div>';
      return;
    }
    templateList.innerHTML = state.templates.map(function (p, i) {
      return '<li><a href="#!" class="tpl-item" data-i="' + i + '" title="' + _.escape(I18n.t('tpl.insert')) + '">' +
        '<i class="material-icons">notes</i>' +
        '<span class="tpl-text">' + _.escape(L.promptTitle(p)) + '</span>' +
        '<i class="material-icons tpl-del" title="' + _.escape(I18n.t('tpl.delete')) + '">delete</i>' +
        '</a></li>';
    }).join('');
  }

  function loadTemplates() {
    return L.getPrompts().then(function (prompts) {
      state.templates = prompts;
      renderTemplates();
    }).catch(function (err) {
      M.toast({ html: I18n.t('toast.tplLoadFail', { m: err.message }), classes: 'red' });
    });
  }

  function saveTemplates() {
    return L.savePrompts(state.templates).catch(function (err) {
      M.toast({ html: I18n.t('toast.tplSaveFail', { m: err.message }), classes: 'red' });
      return loadTemplates();   // 存失敗 → 回讀伺服器現況，避免畫面與檔案分歧
    });
  }

  /* ---------- 全域 system prompt（輸出格式指示等） ---------- */

  function loadSettings() {
    return L.getSettings().then(function (s) {
      state.systemPrompt = s.systemPrompt || '';
    }).catch(function (err) {
      M.toast({ html: I18n.t('toast.settingsLoadFail', { m: err.message }), classes: 'red' });
    });
  }

  function openSystemModal() {
    var ta = document.getElementById('system-prompt-text');
    ta.value = state.systemPrompt;
    M.updateTextFields();
    M.Modal.getInstance(document.getElementById('system-modal')).open();
    setTimeout(function () { M.textareaAutoResize(ta); }, 50);   // modal 開啟後才量得到高度
  }

  function saveSystemPrompt() {
    var val = document.getElementById('system-prompt-text').value;
    var modal = M.Modal.getInstance(document.getElementById('system-modal'));
    L.saveSettings(val).then(function (d) {
      state.systemPrompt = (d.settings && d.settings.systemPrompt) || '';
      modal.close();
      M.toast({ html: I18n.t('toast.settingsSaved'), classes: 'teal' });
    }).catch(function (err) {
      M.toast({ html: I18n.t('toast.settingsSaveFail', { m: err.message }), classes: 'red' });
    });
  }

  // 插入輸入框游標處（無游標則接在尾端），並同步 label／清除鈕／高度
  function insertTemplate(text) {
    var start = inputEl.selectionStart != null ? inputEl.selectionStart : inputEl.value.length;
    var end = inputEl.selectionEnd != null ? inputEl.selectionEnd : start;
    inputEl.value = inputEl.value.slice(0, start) + text + inputEl.value.slice(end);
    var pos = start + text.length;
    inputEl.focus();
    try { inputEl.setSelectionRange(pos, pos); } catch (e) {}
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    M.textareaAutoResize(inputEl);
  }

  function addTemplateFromInput() {
    var content = inputEl.value;
    if (!content.trim()) {
      M.toast({ html: I18n.t('toast.tplEmpty'), classes: 'orange' });
      return;
    }
    var dup = state.templates.some(function (p) { return p.content === content; });
    if (dup) {
      M.toast({ html: I18n.t('toast.tplExists'), classes: 'grey' });
      return;
    }
    state.templates.unshift({ content: content, ts: L.timestamp() });
    renderTemplates();
    saveTemplates().then(function (d) {
      if (d) M.toast({ html: I18n.t('toast.tplSaved'), classes: 'teal' });
    });
  }

  function deleteTemplate(index) {
    var p = state.templates[index];
    if (!p) return;
    if (!confirm(I18n.t('confirm.tplDelete', { n: L.promptTitle(p) }))) return;
    state.templates.splice(index, 1);
    renderTemplates();
    saveTemplates().then(function (d) {
      if (d) M.toast({ html: I18n.t('toast.tplDeleted'), classes: 'teal' });
    });
  }

  /* ---------- 新對話／改名搬移 modal（同一個 modal 兩種模式） ---------- */

  var modalMode = 'new';   // 'new' | 'rename'

  // 標題與確認鍵依模式換字：改 data-i18n 屬性再填字，語言切換時 I18n.apply 會自動跟上
  function setModalMode(mode) {
    modalMode = mode;
    var title = document.getElementById('new-modal-title');
    var confirmBtn = document.getElementById('new-create');
    var hint = document.getElementById('new-subject-hint');
    var tKey = mode === 'rename' ? 'modal.renameTitle' : 'modal.title';
    var cKey = mode === 'rename' ? 'modal.rename' : 'modal.create';
    title.setAttribute('data-i18n', tKey);
    title.textContent = I18n.t(tKey);
    confirmBtn.setAttribute('data-i18n', cKey);
    confirmBtn.textContent = I18n.t(cKey);
    // 「留空自動命名」提示只在新建時成立；改名不允許留空
    hint.style.visibility = mode === 'rename' ? 'hidden' : 'visible';
  }

  function openNewModal() {
    setModalMode('new');
    renderProjectSelect(state.project || DEFAULT_PROJECT);
    document.getElementById('new-subject').value = '';
    M.updateTextFields();
    M.Modal.getInstance(document.getElementById('new-modal')).open();
  }

  // 改名對象（樹上任一列，不限目前開啟的 subject）
  var renameTarget = null;   // { project, name }

  function openRenameModal(project, name) {
    // 只有「目標＝正在串流的那組對話」才需要擋（改名會讓存檔落到舊路徑）
    if (state.streaming && project === state.project && name === state.subject) {
      M.toast({ html: I18n.t('toast.busy'), classes: 'orange' });
      return;
    }
    renameTarget = { project: project, name: name };
    setModalMode('rename');
    renderProjectSelect(project);
    document.getElementById('new-subject').value = name;
    M.updateTextFields();
    M.Modal.getInstance(document.getElementById('new-modal')).open();
  }

  function confirmModal() {
    var project = document.getElementById('new-project-select').value;
    var subject = document.getElementById('new-subject').value.trim();
    if (!L.isSafeName(project, L.PROJECT_NAME_MAX)) {
      M.toast({ html: I18n.t('toast.nameBad'), classes: 'orange' });
      return;
    }
    if (modalMode === 'rename') {
      if (!L.isSafeName(subject)) {   // 改名不允許留空
        M.toast({ html: I18n.t('toast.nameBad'), classes: 'orange' });
        return;
      }
      return renameFromModal(project, subject);
    }

    // 新對話：Subject 可留空——先用暫時檔名頂著，等第一個 prompt 送出後
    // 由 Ollama 依內容生標題、自動改名（見 maybeAutoTitle）
    var pendingTitle = !subject;
    if (subject && !L.isSafeName(subject)) {
      M.toast({ html: I18n.t('toast.nameBad'), classes: 'orange' });
      return;
    }
    if (pendingTitle) subject = 'chat-' + L.timestamp();
    subject = L.uniqueName(subject, takenNames(project));
    state.project = project;
    state.subject = subject;
    state.needsAutoTitle = pendingTitle;
    state.chat = L.newChat(state.model);
    try {
      history.pushState({ uid: state.chat.uid }, '', '?uid=' + encodeURIComponent(state.chat.uid));
    } catch (e) {}
    M.Modal.getInstance(document.getElementById('new-modal')).close();
    renderMessages();
    updateChrome();
    persist().then(function () {
      markTreeActive();
      M.toast({ html: I18n.t('toast.created', { n: project + '／' + subject }), classes: 'teal' });
    });
    inputEl.focus();
  }

  // 改名／搬 project：名稱即路徑（fs.rename），目標已存在由後端 409 擋下、不覆蓋
  function renameFromModal(project, subject) {
    var modal = M.Modal.getInstance(document.getElementById('new-modal'));
    var src = renameTarget;
    if (!src || (project === src.project && subject === src.name)) {
      modal.close();
      return;
    }
    L.renameSubject(src.project, src.name, project, subject).then(function (d) {
      var label = d.project + '／' + d.name;
      // 改到的是目前開啟的對話 → 同步 state；其他列只需更新樹。
      // 網址不必動：?uid= 是 rename-stable，改名/搬 project 不改 chat.uid（見 applyOpenedSubject）
      if (state.subject && src.project === state.project && src.name === state.subject) {
        state.project = d.project;
        state.subject = d.name;
        updateChrome();
      }
      modal.close();
      M.toast({ html: I18n.t('toast.renamed', { n: label }), classes: 'teal' });
      return refreshTree();
    }).catch(function (err) {
      if (err.message === 'target exists') {
        M.toast({ html: I18n.t('toast.renameExists', { n: project + '／' + subject }), classes: 'orange' });
      } else {
        M.toast({ html: I18n.t('toast.renameFail', { m: err.message }), classes: 'red' });
      }
    });
  }

  /* ---------- 刪除 / 匯出 ---------- */

  // 刪除樹上任一列的 subject（刪到目前開啟的那組才需要收畫面）
  function deleteSubjectRow(project, name) {
    var isOpen = (project === state.project && name === state.subject);
    if (state.streaming && isOpen) {
      M.toast({ html: I18n.t('toast.busy'), classes: 'orange' });
      return;
    }
    var label = project + '／' + name;
    if (!confirm(I18n.t('confirm.delete', { n: label }))) return;
    L.deleteSubject(project, name).then(function () {
      M.toast({ html: I18n.t('toast.deleted', { n: label }), classes: 'teal' });
      if (isOpen) closeSubject();
      return refreshTree();
    }).catch(function (err) {
      M.toast({ html: I18n.t('toast.deleteFail', { m: err.message }), classes: 'red' });
    });
  }

  function exportCurrent() {
    if (!state.chat) return;
    var md = L.exportMarkdown(state.project, state.subject, state.chat);
    L.downloadText(L.stampFilename(state.subject + '.md'), md);
    setIconDone(document.getElementById('setting-download'));
  }

  /* ---------- Project 管理（建立／改名／刪除；一級公民） ---------- */

  var projectModalMode = 'new';   // 'new' | 'rename'
  var projectRenameTarget = null;

  // 單一名稱輸入的小 modal，建立空 project 與改 project 名共用（mode 換標題/確認鍵字）
  function openProjectModal(mode, name) {
    projectModalMode = mode;
    projectRenameTarget = (mode === 'rename') ? name : null;
    var title = document.getElementById('project-modal-title');
    var btn = document.getElementById('project-create');
    var tKey = mode === 'rename' ? 'proj.renameTitle' : 'proj.newTitle';
    var cKey = mode === 'rename' ? 'modal.rename' : 'modal.create';
    title.setAttribute('data-i18n', tKey); title.textContent = I18n.t(tKey);
    btn.setAttribute('data-i18n', cKey); btn.textContent = I18n.t(cKey);
    var input = document.getElementById('project-name');
    input.value = (mode === 'rename') ? name : '';
    M.updateTextFields();
    M.Modal.getInstance(document.getElementById('project-modal')).open();
    input.focus();
  }

  function confirmProjectModal() {
    var name = document.getElementById('project-name').value.trim();
    var modal = M.Modal.getInstance(document.getElementById('project-modal'));
    if (!L.isSafeName(name, L.PROJECT_NAME_MAX)) {
      M.toast({ html: I18n.t('toast.nameBad'), classes: 'orange' });
      return;
    }
    if (projectModalMode === 'rename') {
      var src = projectRenameTarget;
      if (!src || src === name) { modal.close(); return; }
      L.renameProject(src, name).then(function (d) {
        // 動到目前開啟對話所在的 project → 同步 state（subject 的 ?uid= 網址不受影響）
        if (state.project === src) { state.project = d.name; updateChrome(); }
        modal.close();
        M.toast({ html: I18n.t('toast.projRenamed', { n: d.name }), classes: 'teal' });
        return refreshTree();
      }).catch(function (err) { projModalError(err); });
    } else {
      L.createProject(name).then(function (d) {
        modal.close();
        M.toast({ html: I18n.t('toast.projCreated', { n: d.name }), classes: 'teal' });
        return refreshTree();
      }).catch(function (err) { projModalError(err); });
    }
  }

  function projModalError(err) {
    if (err.message === 'project exists' || err.message === 'target exists') {
      M.toast({ html: I18n.t('toast.projExists'), classes: 'orange' });
    } else if (err.message === 'protected project') {
      M.toast({ html: I18n.t('toast.projProtected'), classes: 'orange' });
    } else {
      M.toast({ html: I18n.t('toast.projFail', { m: err.message }), classes: 'red' });
    }
  }

  // 刪除整個 project（含所有 subjects，搬 .bak）。破壞性——先 confirm（沿用 subject 刪除的
  // 原生 confirm 風格，訊息帶對話數）；刪到目前開啟對話所在的 project 就收畫面。
  function deleteProjectRow(name) {
    var hit = state.tree.filter(function (p) { return p.name === name; })[0];
    var count = hit ? hit.subjects.length : 0;
    var openInside = (state.project === name);
    if (state.streaming && openInside) {
      M.toast({ html: I18n.t('toast.busy'), classes: 'orange' });
      return;
    }
    if (!confirm(I18n.t('confirm.deleteProject', { n: name, c: count }))) return;
    L.deleteProject(name).then(function () {
      M.toast({ html: I18n.t('toast.projDeleted', { n: name }), classes: 'teal' });
      if (openInside) closeSubject();
      return refreshTree();
    }).catch(function (err) { projModalError(err); });
  }

  /* ---------- 語系（i18n） ---------- */

  function cycleLang() {
    var next = I18n.cycle();
    M.toast({ html: I18n.t('toast.lang', { name: I18n.name(next) }), classes: 'teal' });
  }

  function onLangChanged() {
    renderTree();          // 「尚無對話」訊息隨語系
    renderPromptList();
    renderTemplates();
    updateChrome();
    setSendBtn(state.streaming);
  }

  /* ---------- 事件繫結 ---------- */

  function bindEvents() {
    // 樹：project 收合 / subject 開啟
    $(document).on('click', '#tree .proj-head', function () {
      var proj = $(this).closest('.proj');
      var name = proj.attr('data-project');
      state.collapsed[name] = !state.collapsed[name];
      proj.toggleClass('collapsed', !!state.collapsed[name]);
    });
    $('#tree-collapse-all').on('click', collapseAll);
    $(document).on('click', '#tree .subjects li', function () {
      openSubject($(this).attr('data-project'), $(this).attr('data-name'));
      if (window.innerWidth <= 800) document.body.classList.add('tree-closed');
    });

    // subject 列的動作：more_vert 展開（一次只展一列），edit / delete 對該列動作
    $(document).on('click', '#tree .subj-more', function (e) {
      e.stopPropagation();
      var li = $(this).closest('li');
      var wasExpanded = li.hasClass('expanded');
      $('#tree .subjects li.expanded').removeClass('expanded');
      li.toggleClass('expanded', !wasExpanded);
    });
    $(document).on('click', '#tree .subj-act-edit', function (e) {
      e.stopPropagation();
      var li = $(this).closest('li');
      openRenameModal(li.attr('data-project'), li.attr('data-name'));
      li.removeClass('expanded');
    });
    $(document).on('click', '#tree .subj-act-del', function (e) {
      e.stopPropagation();
      var li = $(this).closest('li');
      deleteSubjectRow(li.attr('data-project'), li.attr('data-name'));
      li.removeClass('expanded');
    });

    // 樣板庫：插入 / 存目前輸入 / 刪除
    $(document).on('click', '#template-list a.tpl-item', function (e) {
      e.preventDefault();
      var p = state.templates[Number($(this).data('i'))];
      if (!p) return;
      var inst = M.Sidenav.getInstance(document.getElementById('template-nav'));
      if (inst && inst.isOpen) inst.close();
      insertTemplate(p.content);
    });
    $(document).on('click', '#template-list .tpl-del', function (e) {
      e.preventDefault();
      e.stopPropagation();
      deleteTemplate(Number($(this).closest('a.tpl-item').data('i')));
    });
    document.getElementById('tpl-add').addEventListener('click', function (e) {
      e.preventDefault();
      addTemplateFromInput();
    });

    // prompt 清單：隱藏/還原 icon（先攔，stopPropagation 不觸發跳轉）
    $(document).on('click', '#prompt-list .prompt-hide', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var li = $(this).closest('a.prompt-item');
      setPromptHidden(String($(this).data('uid')), !li.hasClass('is-hidden'));
    });
    // 展開/收合已隱藏
    $(document).on('click', '#prompt-list #prompt-toggle-hidden', function (e) {
      e.preventDefault();
      showHiddenPrompts = !showHiddenPrompts;
      renderPromptList();
    });
    // prompt 清單：點列跳到對話中該處
    $(document).on('click', '#prompt-list a.prompt-item', function (e) {
      e.preventDefault();
      var uid = String($(this).data('uid'));
      var inst = M.Sidenav.getInstance(document.getElementById('prompt-nav'));
      if (inst && inst.isOpen) inst.close();
      jumpToMessage(uid);
    });

    // 浮動 label 同步（Materialize 語意：focus／有內容→浮起，blur 且空→回位。
    // Materialize 1.0 對動態情境的自動繫結不可靠，這裡自己掛，行為與其原生一致）
    var inputLabel = document.querySelector('label[for="chat-text"]');
    inputEl.addEventListener('focus', function () { inputLabel.classList.add('active'); });
    inputEl.addEventListener('input', function () {
      inputLabel.classList.add('active');
      updateClearBtn();
    });
    inputEl.addEventListener('blur', function () {
      if (!inputEl.value.trim()) inputLabel.classList.remove('active');
    });

    // 清除輸入：清空、收回高度、保持焦點（label 因 focus 續浮）
    clearBtn.addEventListener('click', function () {
      inputEl.value = '';
      M.textareaAutoResize(inputEl);
      updateClearBtn();
      inputEl.focus();
    });

    // 輸入列：Enter 送出、Shift+Enter 換行；IME 組字中（isComposing）不觸發
    inputEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey) return;
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      send();
    });
    sendBtn.addEventListener('click', send);

    // 模型切換
    modelSelect.addEventListener('change', function () {
      setModel(modelSelect.value);
      if (state.chat) state.chat.model = state.model;   // 下次存檔帶上
    });

    // 右側工具列
    document.getElementById('setting-menu').addEventListener('click', function () {
      var closed = document.body.classList.toggle('tree-closed');
      this.classList.toggle('active', !closed);
    });
    document.getElementById('setting-prompts').addEventListener('click', function () {
      var inst = M.Sidenav.getInstance(document.getElementById('prompt-nav'));
      if (inst) inst.open();
    });
    document.getElementById('setting-templates').addEventListener('click', function () {
      var inst = M.Sidenav.getInstance(document.getElementById('template-nav'));
      if (inst) inst.open();
    });
    document.getElementById('setting-new').addEventListener('click', openNewModal);
    document.getElementById('setting-system').addEventListener('click', openSystemModal);
    document.getElementById('system-save').addEventListener('click', function (e) {
      e.preventDefault();
      saveSystemPrompt();
    });
    document.getElementById('setting-download').addEventListener('click', exportCurrent);
    document.getElementById('setting-mode').addEventListener('click', function () {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    });
    document.getElementById('setting-lang').addEventListener('click', cycleLang);
    document.getElementById('new-create').addEventListener('click', function (e) {
      e.preventDefault();   // <a href="#!">：不讓 hash 變化污染網址／觸發 popstate
      confirmModal();
    });

    // ── Project 管理（一級公民）：新增鈕、列動作、modal 確認鍵 ──
    document.getElementById('tree-new-project').addEventListener('click', function () {
      openProjectModal('new');
    });
    document.getElementById('project-create').addEventListener('click', function (e) {
      e.preventDefault();
      confirmProjectModal();
    });
    // 每個 project 列尾端的 more_vert / edit / delete（inbox 列不渲染這些，見 renderTree）
    $(document).on('click', '#tree .proj-more', function (e) {
      e.stopPropagation();   // 不觸發 proj-head 的收合
      var head = $(this).closest('.proj-head');
      var wasExpanded = head.hasClass('expanded');
      $('#tree .proj-head.expanded').removeClass('expanded');
      head.toggleClass('expanded', !wasExpanded);
    });
    $(document).on('click', '#tree .proj-act-edit', function (e) {
      e.stopPropagation();
      openProjectModal('rename', $(this).closest('.proj').attr('data-project'));
      $(this).closest('.proj-head').removeClass('expanded');
    });
    $(document).on('click', '#tree .proj-act-del', function (e) {
      e.stopPropagation();
      deleteProjectRow($(this).closest('.proj').attr('data-project'));
      $(this).closest('.proj-head').removeClass('expanded');
    });

    // 上一頁／下一頁：優先看 ?uid=，沒有才退回舊格式 ?project=&subject=（相容舊分頁/書籤）。
    // 注意：hash 變化（modal 內 href="#!" 的取消鍵等）也會觸發 popstate，
    // 此時網址對應的對話與目前 state 相同 → 忽略，避免無謂重載（改名後用舊格式更會 404）。
    window.addEventListener('popstate', function () {
      var q = new URLSearchParams(location.search);
      var uid = q.get('uid');
      if (uid) {
        if (state.chat && state.chat.uid === uid) return;
        openSubjectByUid(uid, true);
        return;
      }
      var p = q.get('project'), s = q.get('subject');
      if (p === state.project && s === state.subject) return;
      if (p && s) openSubject(p, s, true);
      else closeSubject();
    });
  }

  /* ---------- 初始化 ---------- */

  document.addEventListener('DOMContentLoaded', function () {
    M.Sidenav.init(document.getElementById('prompt-nav'), {
      edge: 'right',
      onOpenStart: function () { document.body.classList.add('sidenav-open'); },
      onCloseEnd: function () { document.body.classList.remove('sidenav-open'); }
    });
    M.Sidenav.init(document.getElementById('template-nav'), {
      edge: 'right',
      onOpenStart: function () { document.body.classList.add('sidenav-open'); },
      onCloseEnd: function () { document.body.classList.remove('sidenav-open'); }
    });
    M.Modal.init(document.getElementById('new-modal'));
    M.Modal.init(document.getElementById('project-modal'));
    M.Modal.init(document.getElementById('system-modal'));
    M.FormSelect.init(modelSelect);

    var saved = 'dark';
    try { saved = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) {}
    applyTheme(saved === 'light' ? 'light' : 'dark');

    // i18n：套用靜態文字 / 標題（引擎自解析初始語系：?lang → localStorage('lang') → 瀏覽器 → zh-Hant）
    I18n.apply(document);
    document.addEventListener('i18n:changed', onLangChanged);

    // 窄螢幕預設收起左欄；#setting-menu 的 .active 表示樹開啟中
    var treeClosed = window.innerWidth <= 800;
    document.body.classList.toggle('tree-closed', treeClosed);
    document.getElementById('setting-menu').classList.toggle('active', !treeClosed);

    bindEvents();
    updateChrome();
    document.body.classList.add('is-empty');

    // 深連結：優先 ?uid=（rename-stable，網址不動）；沒有才退回舊格式 ?project=&subject=，
    // 開啟後就地把網址升級成 ?uid=（historyMode:'replace'，不多留一筆歷史）。
    // 模型清單先就緒（openSubject/openSubjectByUid 會比對模型），再開啟。
    var q = new URLSearchParams(location.search);
    var uid = q.get('uid');
    var p = q.get('project'), s = q.get('subject');
    Promise.all([loadModels(), refreshTree()]).then(function () {
      if (uid) openSubjectByUid(uid, true);
      else if (p && s) openSubject(p, s, 'replace');
    });
    loadTemplates();
    loadSettings();

    inputEl.focus();
  });
})();
