const state = {
  sessions: [],
  remoteSessions: [],
  activeSessionId: null,
  stream: null,
  activeMessages: [],
};

const sessionListEl = document.getElementById('sessionList');
const remoteListEl = document.getElementById('remoteList');
const messagesEl = document.getElementById('messages');
const sessionTitleEl = document.getElementById('sessionTitle');
const sessionMetaEl = document.getElementById('sessionMeta');
const modelRefEl = document.getElementById('modelRef');
const composerEl = document.getElementById('composer');

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : `Request failed: ${response.status}`);
  }
  return body;
}

function renderSessions() {
  sessionListEl.innerHTML = '';
  for (const session of state.sessions) {
    const el = document.createElement('button');
    el.className = `session ${session.sessionId === state.activeSessionId ? 'active' : ''}`;
    const owner = session.owner?.displayName || session.owner?.kind || 'unowned';
    el.innerHTML = `
      <div>${session.title || session.sessionId}</div>
      <div class="meta">${session.kind} · ${owner} · ${session.runState} · ${session.updatedAt}</div>
    `;
    el.onclick = () => openSession(session.sessionId);
    sessionListEl.appendChild(el);
  }
}

function renderRemoteSessions() {
  remoteListEl.innerHTML = '';
  for (const session of state.remoteSessions) {
    const el = document.createElement('div');
    el.className = 'session';
    const meta = session.payload?.note ? ` · ${session.payload.note}` : '';
    el.innerHTML = `
      <div>${session.sessionId}</div>
      <div class="meta">remote bundle · ${session.updatedAt}${meta}</div>
      <div class="row" style="margin-top:8px;">
        <button class="secondary view-remote">View archive</button>
        <button class="secondary delete-remote">Archive</button>
      </div>
    `;
    el.querySelector('.view-remote').onclick = () => viewRemote(session.sessionId);
    el.querySelector('.delete-remote').onclick = () => deleteRemote(session.sessionId);
    remoteListEl.appendChild(el);
  }
}

function renderMessages() {
  messagesEl.innerHTML = '';
  for (const message of state.activeMessages) {
    const el = document.createElement('div');
    el.className = `message ${message.role || 'system'}`;
    el.textContent = message.text || '(no text)';
    messagesEl.appendChild(el);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function refreshRemoteSessions() {
  const { sessions } = await request('/api/v1/remote/sessions');
  state.remoteSessions = sessions;
  renderRemoteSessions();
}

async function refreshSessions() {
  const { sessions } = await request('/api/v1/sessions');
  state.sessions = sessions;
  renderSessions();
  if (!state.activeSessionId && sessions[0]) {
    await openSession(sessions[0].sessionId);
  }
}

async function openSession(sessionId) {
  state.activeSessionId = sessionId;
  renderSessions();
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  const snapshot = await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot?limit=50`);
  sessionTitleEl.textContent = snapshot.metadata.title || snapshot.metadata.sessionId;
  const owner = snapshot.metadata.owner?.displayName || snapshot.metadata.owner?.kind || 'unowned';
  sessionMetaEl.textContent = `${snapshot.metadata.kind} · ${owner} · ${snapshot.status.runState} · ${snapshot.metadata.updatedAt}`;
  state.activeMessages = snapshot.messages || [];
  renderMessages();
  connectStream(sessionId);
}

function connectStream(sessionId) {
  const modelRef = modelRefEl.value.trim();
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
      const owner = payload.status.owner?.displayName || payload.status.owner?.kind || 'unowned';
      sessionMetaEl.textContent = `${payload.status.kind} · ${owner} · ${payload.status.runState} · ${payload.status.updatedAt}`;
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
      state.activeMessages.push({ role: 'system', text: `[Tool] ${payload.toolName} starting…` });
      renderMessages();
      return;
    }
    if (payload.type === 'tool_end') {
      state.activeMessages.push({ role: 'system', text: `[Tool] ${payload.toolName} ${payload.isError ? 'error' : 'done'}` });
      renderMessages();
      return;
    }
    if (payload.type === 'error') {
      state.activeMessages.push({ role: 'system', text: `[Error] ${payload.error}` });
      renderMessages();
    }
  };
  stream.onerror = () => {
    stream.close();
  };
  state.stream = stream;
}

async function viewRemote(sessionId) {
  const snapshot = await request(`/api/v1/remote/sessions/${encodeURIComponent(sessionId)}`);
  state.activeSessionId = null;
  sessionTitleEl.textContent = snapshot.metadata.title || snapshot.metadata.sessionId;
  sessionMetaEl.textContent = `remote bundle · ${snapshot.metadata.kind} · ${snapshot.metadata.updatedAt}`;
  state.activeMessages = snapshot.messages || [];
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  renderMessages();
}

async function dispatchActiveSession() {
  if (!state.activeSessionId) return;
  const modelRef = modelRefEl.value.trim();
  const bundle = await request(`/api/v1/sessions/${encodeURIComponent(state.activeSessionId)}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelRef }),
  });
  await request('/api/v1/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      payload: {
        sessionId: state.activeSessionId,
        dispatchedAt: new Date().toISOString(),
        note: 'dispatched from web ui',
      },
      bundle,
    }),
  });
  await refreshRemoteSessions();
}

async function deleteRemote(sessionId) {
  await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetCwd: '' }),
  });
  await refreshRemoteSessions();
}

async function createSession(kind = 'assistant') {
  const title = document.getElementById('newTitle').value.trim();
  const modelRef = modelRefEl.value.trim();
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
}

async function sendMessage() {
  if (!state.activeSessionId) return;
  const text = composerEl.value.trim();
  if (!text) return;
  const modelRef = modelRefEl.value.trim();
  state.activeMessages.push({ role: 'user', text });
  renderMessages();
  composerEl.value = '';
  await request(`/api/v1/sessions/${encodeURIComponent(state.activeSessionId)}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, modelRef }),
  });
}

async function interruptSession() {
  if (!state.activeSessionId) return;
  const modelRef = modelRefEl.value.trim();
  await request(`/api/v1/sessions/${encodeURIComponent(state.activeSessionId)}/interrupt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelRef }),
  });
}

document.getElementById('refreshButton').onclick = refreshSessions;
document.getElementById('refreshRemoteButton').onclick = refreshRemoteSessions;
document.getElementById('dispatchButton').onclick = dispatchActiveSession;
document.getElementById('createCodingButton').onclick = () => createSession('coding');
document.getElementById('createAssistantButton').onclick = () => createSession('assistant');
document.getElementById('sendButton').onclick = sendMessage;
document.getElementById('interruptButton').onclick = interruptSession;
document.getElementById('reloadButton').onclick = () => state.activeSessionId && openSession(state.activeSessionId);
composerEl.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    sendMessage();
  }
});

Promise.all([refreshSessions(), refreshRemoteSessions()]).catch((error) => {
  messagesEl.innerHTML = `<div class="message system">${error.message}</div>`;
});
