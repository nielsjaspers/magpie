// State
const state = {
  sessions: [],
  archivedSessions: JSON.parse(localStorage.getItem('magpie_archived_sessions') || '[]'),
  activeSessionId: null,
  stream: null,
  activeMessages: [],
  models: [],
  defaultModelRef: null,
  attachments: [],
  showArchived: false
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
  newAssistantBtn: document.getElementById('newAssistantBtn'),
  newCodingBtn: document.getElementById('newCodingBtn'),
  mobileNewSessionBtn: document.getElementById('mobileNewSessionBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  sidebar: document.getElementById('sidebar'),
  mobileMenuBtn: document.getElementById('mobileMenuBtn'),
  closeSidebarBtn: document.getElementById('closeSidebarBtn'),
  sidebarBackdrop: document.getElementById('sidebarBackdrop'),
  dropOverlay: document.getElementById('dropOverlay'),
  toggleArchivedBtn: document.getElementById('toggleArchivedBtn'),
  archivedList: document.getElementById('archivedList')
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
  els.newAssistantBtn.addEventListener('click', () => createSession('assistant'));
  els.newCodingBtn.addEventListener('click', () => createSession('coding'));
  els.mobileNewSessionBtn.addEventListener('click', () => createSession('assistant'));
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

  els.toggleArchivedBtn.addEventListener('click', () => {
    state.showArchived = !state.showArchived;
    els.toggleArchivedBtn.textContent = state.showArchived ? 'Hide' : 'Show';
    els.archivedList.style.display = state.showArchived ? 'flex' : 'none';
    if (state.showArchived) renderSessionsList(); // render into archived
  });
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
    const response = await fetch('/api/v1/models');
    if (response.ok) {
      const data = await response.json();
      state.models = data.models || [];
      state.defaultModelRef = data.defaultModel;
      
      els.modelSelect.innerHTML = '';
      
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = `Default`; // Shorter text
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
  } catch (err) {
    console.error('Failed to load models:', err);
  }
}

async function refreshSessions() {
  try {
    const data = await request('/api/v1/sessions');
    state.sessions = data.sessions || [];
    renderSessionsList();
    
        // Try to select the first active (unarchived) session
        const activeSessions = state.sessions.filter(s => !state.archivedSessions.includes(s.sessionId));
        if (activeSessions.length > 0) {
          await openSession(activeSessions[0].sessionId);
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

async function createSession(kind = 'assistant') {
  try {
    const modelRef = getSelectedModel();
    const title = 'New ' + (kind === 'coding' ? 'Coding' : 'Conversation');
    
    const body = kind === 'coding'
      ? { kind: 'coding', origin: 'remote', workspaceMode: 'attached', title, modelRef }
      : { kind: 'assistant', origin: 'assistant', assistantChannel: 'web', title, modelRef };
    
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
  const currentAttachments = state.attachments.slice(); // copy before clearing
  const hasAttachments = currentAttachments.length > 0;
  
  if (!text && !hasAttachments) return;
  
  let displayText = text;
  if (hasAttachments) {
    const fileNames = currentAttachments.map(f => f.name).join(', ');
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
  els.sendBtn.classList.add('loading');
  
  try {
    // Upload files to the session workspace first
    if (hasAttachments) {
      const formData = new FormData();
      for (const file of currentAttachments) {
        formData.append('file', file);
      }
      await request(`/api/v1/sessions/${encodeURIComponent(state.activeSessionId)}/files`, {
        method: 'POST',
        body: formData
      });
    }
    
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
    els.sendBtn.classList.remove('loading');
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


async function archiveSession(sessionId, event) {
  event.stopPropagation();
  if (!state.archivedSessions.includes(sessionId)) {
    state.archivedSessions.push(sessionId);
    localStorage.setItem('magpie_archived_sessions', JSON.stringify(state.archivedSessions));
  }
  if (state.activeSessionId === sessionId) {
    state.activeSessionId = null;
    els.sessionTitle.textContent = 'Select a session';
    els.sessionMeta.textContent = '';
    state.activeMessages = [];
    renderMessages();
    if (state.stream) {
      state.stream.close();
      state.stream = null;
    }
  }
  renderSessionsList();
}

async function unarchiveSession(sessionId, event) {
  event.stopPropagation();
  state.archivedSessions = state.archivedSessions.filter(id => id !== sessionId);
  localStorage.setItem('magpie_archived_sessions', JSON.stringify(state.archivedSessions));
  renderSessionsList();
}

function renderSessionsList() {
  els.sessionList.innerHTML = '';
  els.archivedList.innerHTML = '';
  
  const activeList = state.sessions.filter(s => !state.archivedSessions.includes(s.sessionId));
  const archivedList = state.sessions.filter(s => state.archivedSessions.includes(s.sessionId));
  
  if (activeList.length === 0) {
    els.sessionList.innerHTML = `<div class="session-item-meta" style="padding: 16px;">No active sessions.</div>`;
  }
  if (state.showArchived && archivedList.length === 0) {
    els.archivedList.innerHTML = `<div class="session-item-meta" style="padding: 16px;">No archived sessions.</div>`;
  }
  
  const createSessionElement = (session, isArchived) => {
    const el = document.createElement('div');
    el.className = `session-item ${session.sessionId === state.activeSessionId ? 'active' : ''}`;
    
    const title = session.title || session.sessionId;
    const kind = session.kind === 'coding' ? 'Coding' : 'Assistant';
    
    el.innerHTML = `
      <div class="session-item-content">
        <div class="session-item-title" title="${title}">${title}</div>
        <div class="session-item-meta">${kind} · ${session.updatedAt.split('T')[0]}</div>
      </div>
      <button class="hide-session-btn" aria-label="${isArchived ? 'Unarchive' : 'Archive'}" title="${isArchived ? 'Restore session' : 'Archive session'}">
        ${isArchived 
          ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>` 
          : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>`
        }
      </button>
    `;
    
    el.onclick = () => openSession(session.sessionId);
    el.querySelector('.hide-session-btn').onclick = (e) => isArchived ? unarchiveSession(session.sessionId, e) : archiveSession(session.sessionId, e);
    return el;
  };
  
  activeList.forEach(session => els.sessionList.appendChild(createSessionElement(session, false)));
  if (state.showArchived) {
    archivedList.forEach(session => els.archivedList.appendChild(createSessionElement(session, true)));
  }
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