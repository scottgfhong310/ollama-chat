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
    tree: [],
    project: null,   // 目前開啟的 project（資料夾名）
    subject: null,   // 目前開啟的 subject（檔名去 .json）
    chat: null,      // { model, createdAt, updatedAt, messages }
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

  /* ---------- 訊息渲染 ---------- */

  function buildMsgEl(m, index) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + m.role;
    wrap.id = 'msg-' + index;
    var bubble = document.createElement('div');
    if (m.role === 'assistant') {
      bubble.className = 'bubble md';
      bubble.innerHTML = renderMarkdown(m.content);
      addCopyButtons(bubble);
    } else {
      bubble.className = 'bubble';
      bubble.textContent = m.content;
    }
    wrap.appendChild(bubble);
    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = (m.role === 'assistant' && m.model ? m.model + ' · ' : '') + L.formatTs(m.ts);
    wrap.appendChild(meta);
    return wrap;
  }

  function renderMessages() {
    chatList.innerHTML = '';
    var msgs = (state.chat && state.chat.messages) || [];
    msgs.forEach(function (m, i) { chatList.appendChild(buildMsgEl(m, i)); });
    document.body.classList.toggle('is-empty', !msgs.length);
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
      fillProjectDatalist();
    }).catch(function (err) {
      M.toast({ html: I18n.t('toast.treeFail', { m: err.message }), classes: 'red' });
    });
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
          '<span class="subj-meta">' + (s.messageCount || 0) + '</span>' +
          // more_vert 展開該列的 改名／刪除（動作對象＝這一列，不必先開啟該 subject）
          '<span class="subj-actions">' +
          '<i class="material-icons subj-act subj-act-edit" title="' + _.escape(I18n.t('tool.rename')) + '">edit</i>' +
          '<i class="material-icons subj-act subj-act-del" title="' + _.escape(I18n.t('tool.delete')) + '">delete</i>' +
          '</span>' +
          '<i class="material-icons subj-more" title="' + _.escape(I18n.t('tool.subjActions')) + '">more_vert</i>' +
          '</li>';
      }).join('');
      return '<div class="proj' + (state.collapsed[p.name] ? ' collapsed' : '') + '" data-project="' + _.escape(p.name) + '">' +
        '<div class="proj-head">' +
        '<i class="material-icons">folder</i>' +
        '<span class="proj-name">' + _.escape(p.name) + '</span>' +
        '<span class="count">' + p.subjects.length + '</span>' +
        '<i class="material-icons caret">expand_more</i>' +
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

  function fillProjectDatalist() {
    var dl = document.getElementById('project-datalist');
    dl.innerHTML = state.tree.map(function (p) {
      return '<option value="' + _.escape(p.name) + '"></option>';
    }).join('');
  }

  // 該 project 下已存在的 subject 名（避免自動命名整檔覆寫掉既有對話）
  function takenNames(project) {
    var hit = state.tree.filter(function (p) { return p.name === project; })[0];
    return hit ? hit.subjects.map(function (s) { return s.name; }) : [];
  }

  /* ---------- 開啟 / 建立 subject ---------- */

  function openSubject(project, name, skipHistory) {
    if (state.streaming) {
      M.toast({ html: I18n.t('toast.busy'), classes: 'orange' });
      return Promise.resolve();
    }
    return L.loadSubject(project, name).then(function (chat) {
      state.project = project;
      state.subject = name;
      state.chat = chat;
      // subject 記錄的模型若仍可用，跟著切換
      if (chat.model && state.models.some(function (m) { return m.name === chat.model; })) {
        setModel(chat.model);
      }
      if (!skipHistory) {
        try {
          history.pushState({ project: project, subject: name }, '',
            '?project=' + encodeURIComponent(project) + '&subject=' + encodeURIComponent(name));
        } catch (e) {}
      }
      renderMessages();
      updateChrome();
      markTreeActive();
      scrollBottom();
    }).catch(function (err) {
      M.toast({ html: I18n.t('toast.loadFail', { n: project + '／' + name, m: err.message }), classes: 'red' });
    });
  }

  function closeSubject() {
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
      history.pushState({ project: project, subject: name }, '',
        '?project=' + encodeURIComponent(project) + '&subject=' + encodeURIComponent(name));
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
    state.chat.messages.push(L.userMessage(text));
    renderMessages();
    updateChrome();
    scrollBottom();
    persist();
    startStream();
  }

  function startStream() {
    state.streaming = true;
    setSendBtn(true);

    // 佔位訊息：先掛「思考中」脈動點，第一個 token 到就換成串流內容
    var pendingWrap = document.createElement('div');
    pendingWrap.className = 'msg assistant streaming';
    var pendingBubble = document.createElement('div');
    pendingBubble.className = 'bubble md';
    pendingBubble.innerHTML = '<span class="thinking-dot"></span>';
    pendingWrap.appendChild(pendingBubble);
    chatList.appendChild(pendingWrap);
    document.body.classList.remove('is-empty');
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
      messages: state.chat.messages.map(function (m) { return { role: m.role, content: m.content }; }),
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
        state.chat.messages.push(L.assistantMessage(r.content, model));
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

  function renderPromptList() {
    var items = L.promptIndex((state.chat && state.chat.messages) || []);
    if (!items.length) {
      promptList.innerHTML = '<div class="prompt-empty">' + I18n.t('prompt.empty') + '</div>';
      return;
    }
    promptList.innerHTML = items.map(function (it, n) {
      return '<li><a href="#!" class="prompt-item" data-index="' + it.index + '">' +
        '<span class="prompt-no">' + (n + 1) + '.</span>' +
        '<span class="prompt-text">' + _.escape(it.text) + '</span>' +
        '</a></li>';
    }).join('');
  }

  function jumpToMessage(index) {
    var el = document.getElementById('msg-' + index);
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
    var tKey = mode === 'rename' ? 'modal.renameTitle' : 'modal.title';
    var cKey = mode === 'rename' ? 'modal.rename' : 'modal.create';
    title.setAttribute('data-i18n', tKey);
    title.textContent = I18n.t(tKey);
    confirmBtn.setAttribute('data-i18n', cKey);
    confirmBtn.textContent = I18n.t(cKey);
  }

  function openNewModal() {
    setModalMode('new');
    document.getElementById('new-project').value = state.project || DEFAULT_PROJECT;
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
    document.getElementById('new-project').value = project;
    document.getElementById('new-subject').value = name;
    M.updateTextFields();
    M.Modal.getInstance(document.getElementById('new-modal')).open();
  }

  function confirmModal() {
    var project = document.getElementById('new-project').value.trim();
    var subject = document.getElementById('new-subject').value.trim();
    if (!L.isSafeName(project) || !L.isSafeName(subject)) {
      M.toast({ html: I18n.t('toast.nameBad'), classes: 'orange' });
      return;
    }
    if (modalMode === 'rename') return renameFromModal(project, subject);

    subject = L.uniqueName(subject, takenNames(project));
    state.project = project;
    state.subject = subject;
    state.chat = L.newChat(state.model);
    try {
      history.pushState({ project: project, subject: subject }, '',
        '?project=' + encodeURIComponent(project) + '&subject=' + encodeURIComponent(subject));
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
      // 改到的是目前開啟的對話 → 同步 state 與 URL；其他列只需更新樹
      if (state.subject && src.project === state.project && src.name === state.subject) {
        state.project = d.project;
        state.subject = d.name;
        try {
          history.replaceState({ project: d.project, subject: d.name }, '',
            '?project=' + encodeURIComponent(d.project) + '&subject=' + encodeURIComponent(d.name));
        } catch (e) {}
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

    // prompt 清單
    $(document).on('click', '#prompt-list a.prompt-item', function (e) {
      e.preventDefault();
      var idx = Number($(this).data('index'));
      var inst = M.Sidenav.getInstance(document.getElementById('prompt-nav'));
      if (inst && inst.isOpen) inst.close();
      jumpToMessage(idx);
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
    document.getElementById('setting-download').addEventListener('click', exportCurrent);
    document.getElementById('setting-mode').addEventListener('click', function () {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    });
    document.getElementById('setting-lang').addEventListener('click', cycleLang);
    document.getElementById('new-create').addEventListener('click', function (e) {
      e.preventDefault();   // <a href="#!">：不讓 hash 變化污染網址／觸發 popstate
      confirmModal();
    });

    // 上一頁／下一頁：依 ?project=&subject= 重新載入。
    // 注意：hash 變化（modal 內 href="#!" 的取消鍵等）也會觸發 popstate，
    // 此時 search 對應的對話與目前 state 相同 → 忽略，避免無謂重載（改名後更會 404）。
    window.addEventListener('popstate', function () {
      var q = new URLSearchParams(location.search);
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

    // ?project=&subject= 深連結：模型清單先就緒（openSubject 會比對模型），再開啟
    var q = new URLSearchParams(location.search);
    var p = q.get('project'), s = q.get('subject');
    Promise.all([loadModels(), refreshTree()]).then(function () {
      if (p && s) openSubject(p, s, true);
    });
    loadTemplates();

    inputEl.focus();
  });
})();
