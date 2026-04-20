// State
const state = {
  sessions: [],
  activeSessionId: null,
  stream: null,
  activeMessages: [],
  models: [],
  defaultModelRef: null,
  attachments: []
};

// Elements
const els = {
  sessionList: document.getElementById('sessionList'),
  messages: document.getElementById('messages'),
  sessionTitle: document.getElementById('sessionTitle'),
  sessionMeta: document.getElementById('sessionMeta'),
  modelSelect: document.getElementById('modelSelect'),
  composer: document.getElementById('composer'),
  attachmentsArea: document.getElementById('attachmentsArea'),
  fileInput: document.getElementById('fileInput'),
  sendBtn: document.getElementById('sendBtn'),
  attachBtn: document.getElementById('attachBtn'),
  copyIdBtn: document.getElementById('copyIdBtn'),
  interruptBtn: document.getElementById('interruptBtn'),
  newSessionBtn: document.getElementById('newSessionBtn'),
  mobileNewSessionBtn: document.getElementById('mobileNewSessionBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  sidebar: document.getElementById('sidebar'),
  mobileMenuBtn: document.getElementById('mobileMenuBtn'),
  closeSidebarBtn: document.getElementById('closeSidebarBtn'),
  sidebarBackdrop: document.getElementById('sidebarBackdrop'),
  dropOverlay: document.getElementById('dropOverlay')
};

// --- Initialization ---

async function init() {
  // Configure Marked options
  if (window.marked) {
    marked.setOptions({
      gfm: true,
      breaks: true,
      sanitize: false,
      smartLists: true,
      smartypants: true
    });
  }

  setupEventListeners();
  
  await Promise.all([
    refreshModels(),
    refreshSessions()
  ]);
}

function setupEventListeners() {
  els.refreshBtn.addEventListener('click', refreshSessions);
  els.newSessionBtn.addEventListener('click', createSession);
  els.mobileNewSessionBtn.addEventListener('click', createSession);
  els.sendBtn.addEventListener('click', sendMessage);
  els.interruptBtn.addEventListener('click', interruptSession);
  
  els.composer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (e.shiftKey) {
        // Let it grow naturally
        setTimeout(autoResizeComposer, 0);
      } else {
        e.preventDefault();
        sendMessage();
      }
    }
  });

  els.composer.addEventListener('input', autoResizeComposer);

  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', (e) => {
    if (e.target.files?.length) {
      handleFiles(Array.from(e.target.files));
      e.target.value = '';
    }
  });

  els.copyIdBtn.addEventListener('click', copySessionId);

  // Mobile Sidebar
  const openSidebar = () => {
    els.sidebar.classList.add('open');
    els.sidebarBackdrop.classList.add('active');
  };
  const closeSidebar = () => {
    els.sidebar.classList.remove('open');
    els.sidebarBackdrop.classList.remove('active');
  };

  els.mobileMenuBtn.addEventListener('click', openSidebar);
  els.closeSidebarBtn.addEventListener('click', closeSidebar);
  els.sidebarBackdrop.addEventListener('click', closeSidebar);

  // Drag & Drop
  const prevent = e => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(name => {
    document.body.addEventListener(name, prevent, false);
  });

  ['dragenter', 'dragover'].forEach(name => {
    document.body.addEventListener(name, () => els.dropOverlay.classList.add('active'), false);
  });

  ['dragleave', 'drop'].forEach(name => {
    document.body.addEventListener(name, () => els.dropOverlay.classList.remove('active'), false);
  });

  document.body.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length) handleFiles(Array.from(files));
  });
}

// --- API Helpers ---

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : `Request failed: ${response.status}`);
  }
  return body;
}

// --- Data Fetching ---

async function refreshModels() {
  try {
    const data = await request('/api/v1/models');
    state.models = data.models || [];
    state.defaultModelRef = data.defaultModel;
    renderModelSelect();
  } catch (err) {
    console.error('Failed to load models:', err);
  }
}

async function refreshSessions() {
  try {
    const data = await request('/api/v1/sessions');
    state.sessions = data.sessions || [];
    renderSessionsList();
    
    // Auto open first session if none active
    if (!state.activeSessionId && state.sessions.length > 0) {
      await openSession(state.sessions[0].sessionId);
    }
  } catch (err) {
    console.error('Failed to load sessions:', err);
    els.sessionList.innerHTML = `<div class="session-item-meta" style="padding: 16px; color: var(--danger-color)">Failed to load.</div>`;
  }
}

async function openSession(sessionId) {
  state.activeSessionId = sessionId;
  renderSessionsList(); // Update active state
  
  // Close sidebar on mobile after selection
  els.sidebar.classList.remove('open');
  els.sidebarBackdrop.classList.remove('active');

  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }

  try {
    const snapshot = await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot?limit=50`);
    
    els.sessionTitle.textContent = snapshot.metadata.title || snapshot.metadata.sessionId;
    const kind = snapshot.metadata.kind === 'coding' ? 'Coding' : 'Assistant';
    els.sessionMeta.textContent = `${kind} · ${snapshot.status.runState} · ${snapshot.metadata.updatedAt}`;
    
    state.activeMessages = snapshot.messages || [];
    renderMessages();
    connectStream(sessionId);
  } catch (err) {
    console.error('Failed to open session', err);
    els.sessionTitle.textContent = 'Error';
    els.sessionMeta.textContent = 'Could not load session data';
  }
}

function getSelectedModel() {
  const val = els.modelSelect.value;
  return val ? val : undefined;
}

function connectStream(sessionId) {
  const modelRef = getSelectedModel();
  const url = new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}/stream`, window.location.origin);
  if (modelRef) url.searchParams.set('modelRef', modelRef);
  
  const stream = new EventSource(url);
  
  stream.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    
    if (payload.type === 'snapshot') {
      state.activeMessages = payload.session.messages || [];
      renderMessages();
      return;
    }
    
    if (payload.type === 'status') {
      const kind = els.sessionMeta.textContent.split('·')[0].trim();
      els.sessionMeta.textContent = `${kind} · ${payload.status.runState} · ${payload.status.updatedAt}`;
      return;
    }
    
    if (payload.type === 'text_delta') {
      const last = state.activeMessages[state.activeMessages.length - 1];
      if (!last || last.role !== 'assistant') {
        state.activeMessages.push({ role: 'assistant', text: payload.delta });
      } else {
        last.text = (last.text || '') + payload.delta;
      }
      renderMessages();
      return;
    }
    
    if (payload.type === 'tool_start') {
      state.activeMessages.push({ role: 'system', text: `Using tool: ${payload.toolName}...` });
      renderMessages();
      return;
    }
    
    if (payload.type === 'tool_end') {
      state.activeMessages.push({ role: 'system', text: `Finished: ${payload.toolName} ${payload.isError ? '(error)' : ''}` });
      renderMessages();
      return;
    }
    
    if (payload.type === 'error') {
      state.activeMessages.push({ role: 'system', text: `Error: ${payload.error}` });
      renderMessages();
    }
  };
  
  stream.onerror = () => { stream.close(); };
  state.stream = stream;
}

// --- Actions ---

async function createSession() {
  try {
    const modelRef = getSelectedModel();
    // Defaulting to assistant session from web UI for now. Can be expanded to modal later.
    const body = { kind: 'assistant', origin: 'assistant', assistantChannel: 'web', title: 'New Conversation', modelRef };
    
    const result = await request('/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    
    await refreshSessions();
    await openSession(result.sessionId);
  } catch (err) {
    console.error('Failed to create session', err);
  }
}

async function sendMessage() {
  if (!state.activeSessionId) return;
  
  const text = els.composer.value.trim();
  const hasAttachments = state.attachments.length > 0;
  
  if (!text && !hasAttachments) return;
  
  let displayText = text;
  if (hasAttachments) {
    const fileNames = state.attachments.map(f => f.name).join(', ');
    displayText = text ? `${text}\n\n*[Attached: ${fileNames}]*` : `*[Attached: ${fileNames}]*`;
  }
  
  // Optimistic UI update
  state.activeMessages.push({ role: 'user', text: displayText });
  renderMessages();
  
  // Reset composer
  els.composer.value = '';
  els.composer.style.height = 'auto'; // Reset height
  state.attachments = [];
  renderAttachments();
  
  els.sendBtn.disabled = true;
  els.sendBtn.innerHTML = `<svg class="spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`;
  
  try {
    await request(`/api/v1/sessions/${encodeURIComponent(state.activeSessionId)}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: displayText, modelRef: getSelectedModel() }),
    });
  } catch (err) {
    console.error('Failed to send message:', err);
    state.activeMessages.push({ role: 'system', text: `Failed to send: ${err.message}` });
    renderMessages();
  } finally {
    els.sendBtn.disabled = false;
    els.sendBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
  }
}

async function interruptSession() {
  if (!state.activeSessionId) return;
  try {
    await request(`/api/v1/sessions/${encodeURIComponent(state.activeSessionId)}/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(getSelectedModel() ? { modelRef: getSelectedModel() } : {}),
    });
  } catch (err) {
    console.error('Failed to interrupt', err);
  }
}

// --- Rendering ---

function renderModelSelect() {
  els.modelSelect.innerHTML = '';
  
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = `Default (${state.defaultModelRef})`;
  els.modelSelect.appendChild(defaultOpt);

  const providers = [...new Set(state.models.map(m => m.provider))];
  providers.forEach(provider => {
    const group = document.createElement('optgroup');
    group.label = provider;
    
    state.models.filter(m => m.provider === provider).forEach(model => {
      const opt = document.createElement('option');
      opt.value = `${model.provider}/${model.id}`;
      opt.textContent = model.name || model.id;
      group.appendChild(opt);
    });
    
    els.modelSelect.appendChild(group);
  });
}

function renderSessionsList() {
  els.sessionList.innerHTML = '';
  
  if (state.sessions.length === 0) {
    els.sessionList.innerHTML = `<div class="session-item-meta" style="padding: 16px;">No sessions found.</div>`;
    return;
  }
  
  state.sessions.forEach(session => {
    const el = document.createElement('div');
    el.className = `session-item ${session.sessionId === state.activeSessionId ? 'active' : ''}`;
    
    const owner = session.owner?.displayName || session.owner?.kind || 'unowned';
    const title = session.title || session.sessionId;
    const kind = session.kind === 'coding' ? 'Coding' : 'Assistant';
    
    el.innerHTML = `
      <div class="session-item-title" title="${title}">${title}</div>
      <div class="session-item-meta">${kind} · ${session.updatedAt.split('T')[0]}</div>
    `;
    
    el.onclick = () => openSession(session.sessionId);
    els.sessionList.appendChild(el);
  });
}

function renderMessages() {
  const container = els.messages;
  
  if (state.activeMessages.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No messages yet.</p>
      </div>`;
    return;
  }

  container.innerHTML = '';
  
  state.activeMessages.forEach(msg => {
    const el = document.createElement('div');
    el.className = `message ${msg.role || 'system'}`;
    
    const content = document.createElement('div');
    content.className = 'message-content markdown-body';
    
    if (msg.role === 'system') {
      content.textContent = msg.text || '';
    } else {
      // Parse markdown
      content.innerHTML = window.marked ? marked.parse(msg.text || '') : (msg.text || '').replace(/\n/g, '<br>');
    }
    
    el.appendChild(content);
    container.appendChild(el);
  });
  
  // Scroll to bottom
  container.parentElement.scrollTop = container.parentElement.scrollHeight;
}

function renderAttachments() {
  els.attachmentsArea.innerHTML = '';
  
  state.attachments.forEach((file, idx) => {
    const el = document.createElement('div');
    el.className = 'attachment-pill';
    el.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
      <span>${file.name}</span>
      <span class="remove-attachment" data-idx="${idx}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </span>
    `;
    
    el.querySelector('.remove-attachment').onclick = () => {
      state.attachments.splice(idx, 1);
      renderAttachments();
    };
    
    els.attachmentsArea.appendChild(el);
  });
}

// --- Utilities ---

function autoResizeComposer() {
  els.composer.style.height = 'auto';
  // 44px is our min-height (approx 1 line + padding)
  els.composer.style.height = Math.max(44, els.composer.scrollHeight) + 'px';
}

function handleFiles(filesArray) {
  filesArray.forEach(file => {
    if (!state.attachments.find(a => a.name === file.name)) {
      state.attachments.push(file);
    }
  });
  renderAttachments();
}

async function copySessionId() {
  if (!state.activeSessionId) return;
  try {
    await navigator.clipboard.writeText(state.activeSessionId);
    const originalHtml = els.copyIdBtn.innerHTML;
    els.copyIdBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    setTimeout(() => { els.copyIdBtn.innerHTML = originalHtml; }, 2000);
  } catch (err) {
    console.error('Failed to copy', err);
  }
}

// Start
init();