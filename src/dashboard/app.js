const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'connection', 'login', 'login-form', 'login-error', 'token', 'dashboard', 'lock',
  'agents', 'tasks', 'queue-count', 'empty-detail', 'task-detail', 'task-title', 'task-status',
  'task-meta', 'activity', 'result', 'result-output', 'result-files', 'controls', 'control-note',
  'directions', 'direct-form', 'direction', 'send-direction', 'stop', 'stop-confirm', 'stop-description',
  'control-error',
].map((id) => [id, byId(id)]));

const labels = { pending: 'Queued', claimed: 'Running', success: 'Completed', failed: 'Failed', cancelled: 'Stopped' };
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const open = (task) => task.status === 'pending' || task.status === 'claimed';
const isStopping = (task) => task.status === 'cancelled' && task.managed && task.stopRequestedAt && !task.stoppedAt;
const statusLabel = (task) => isStopping(task) ? 'Stopping' : (labels[task.status] ?? task.status);
const taskPath = (id) => '/tasks/' + encodeURIComponent(id);
let connection;
let snapshot = { tasks: [], agents: [] };
let scope = '';
let filter = 'active';
let selected;
let current;
let cursor = 0;
let busy = false;
let stopping;
const views = new WeakMap();

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function renderWhenChanged(node, data, render) {
  const signature = JSON.stringify(data);
  if (views.get(node) === signature) return;
  const focused = node.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
  node.replaceChildren(...render());
  views.set(node, signature);
  if (focused !== undefined) {
    [...node.querySelectorAll('button')].find((button) => button.dataset.key === focused)?.focus({ preventScroll: true });
  }
}

function option(label, key, pressed, choose) {
  const button = element('button', label);
  button.type = 'button';
  button.dataset.key = key;
  button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', choose);
  return button;
}

function listItem(child) {
  const item = element('li');
  item.append(child);
  return item;
}

function badge(task) {
  const badge = element('span', statusLabel(task), 'state');
  badge.dataset.state = task.status;
  return badge;
}

function connectionStatus(label, live) {
  if (ui.connection.textContent !== label) ui.connection.textContent = label;
  ui.connection.classList.toggle('is-live', live);
}

function showError(node, message = '') {
  node.textContent = message;
  node.hidden = !message;
}

async function request(conn, path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + conn.token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.any([conn.stop.signal, AbortSignal.timeout(8000)]),
  });
  if (response.status === 401) {
    if (connection === conn) clearConnection('That token did not match the relay.');
    throw new Error('The relay rejected the token.');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'The relay returned HTTP ' + response.status + '.');
  }
  return response.json();
}

function clearConnection(reason = '') {
  connection?.stop.abort();
  connection = undefined;
  snapshot = { tasks: [], agents: [] };
  select(undefined);
  scope = '';
  ui.dashboard.hidden = true;
  ui.lock.hidden = true;
  ui.login.hidden = false;
  ui.agents.replaceChildren();
  ui.tasks.replaceChildren();
  views.delete(ui.agents);
  views.delete(ui.tasks);
  connectionStatus('Locked', false);
  showError(ui['login-error'], reason);
  ui.token.focus();
}

function renderOverview() {
  const agentNames = new Map(snapshot.agents.map((agent) => [agent.agent, agent.online !== false]));
  for (const task of snapshot.tasks) {
    if (task.claimedBy && !agentNames.has(task.claimedBy)) agentNames.set(task.claimedBy, false);
  }
  const agents = [['', true], ...Array.from(agentNames).sort(([a], [b]) => a.localeCompare(b))];
  renderWhenChanged(ui.agents, [agents, scope], () => agents.map(([name, online]) => {
    const button = option(name || 'All agents', name, scope === name, () => {
      scope = name;
      renderOverview();
    });
    if (name) {
      button.classList.add('presence');
      button.classList.toggle('is-live', online);
      button.title = online ? 'Online' : 'Offline';
    }
    return listItem(button);
  }));
  const tasks = snapshot.tasks
    .filter((task) => (filter === 'active' ? open(task) || isStopping(task) : !open(task) && !isStopping(task)) &&
      (!scope || task.claimedBy === scope || task.to === scope || task.claimedBy?.endsWith('@' + scope)))
    .sort((a, b) => Number(b.status === 'claimed') - Number(a.status === 'claimed') || b.updatedAt.localeCompare(a.updatedAt));
  ui['queue-count'].textContent = String(tasks.length);
  renderWhenChanged(ui.tasks, [tasks, selected], () => tasks.length ? tasks.map((task) => {
    const button = option(undefined, task.id, selected === task.id, () => {
      if (selected === task.id) return;
      select(task.id);
      renderOverview();
      void loadDetail(connection);
    });
    button.append(badge(task), element('strong', task.objective),
      element('span', task.claimedBy ?? task.to ?? 'Unassigned', 'task-label'));
    return listItem(button);
  }) : [element('li', filter === 'active' ? 'No active handovers' : 'No finished handovers', 'empty')]);
}

function select(id) {
  selected = id;
  current = undefined;
  cursor = 0;
  ui['task-detail'].hidden = true;
  ui['empty-detail'].hidden = false;
  ui['empty-detail'].textContent = id ? 'Loading handover…' : 'Select a handover to see its activity.';
  ui.activity.replaceChildren();
  ui.directions.replaceChildren();
  ui['result-output'].textContent = '';
  views.delete(ui.directions);
  ui.direction.value = '';
  showError(ui['control-error']);
}

function addEvents(page) {
  const stickToEnd = ui.activity.scrollHeight - ui.activity.clientHeight - ui.activity.scrollTop < 45;
  if (page.truncated) ui.activity.append(element('li', 'Earlier activity has expired.', 'muted'));
  for (const event of page.events) {
    const item = element('li');
    const time = element('time', clock.format(new Date(event.at)));
    time.dateTime = event.at;
    const message = event.message === event.status ? labels[event.status] ?? event.message : event.message;
    item.append(time, element('span', event.agent ? message + ' · ' + event.agent : message));
    ui.activity.append(item);
  }
  if (stickToEnd) ui.activity.scrollTop = ui.activity.scrollHeight;
  cursor = page.cursor;
}

function setActions() {
  ui['direct-form'].hidden = current?.status !== 'claimed';
  ui['send-direction'].disabled = busy;
  ui.stop.disabled = busy;
}

function renderDetail(data) {
  const { task, directions, activity } = data;
  current = task;
  ui['empty-detail'].hidden = true;
  ui['task-detail'].hidden = false;
  ui['task-title'].textContent = task.objective;
  ui['task-status'].textContent = statusLabel(task);
  ui['task-status'].dataset.state = task.status;
  ui['task-meta'].textContent = [task.id, task.claimedBy ?? task.to, task.attempts && 'Attempt ' + task.attempts,
    task.keyhopSession && 'Local Keyhop approval'].filter(Boolean).join(' · ');
  addEvents(activity);
  ui.result.hidden = !data.output && !task.fileCount;
  ui['result-output'].hidden = !data.output;
  ui['result-output'].textContent = (data.output ?? '') + (data.outputTruncated ? '\n\n[Output truncated]' : '');
  ui['result-files'].textContent = task.fileCount ? task.fileCount + ' attached ' + (task.fileCount === 1 ? 'file' : 'files') : '';
  ui.controls.hidden = task.status !== 'claimed' && !task.stopRequestedAt && directions.length === 0;
  ui.stop.textContent = task.managed ? 'Force stop' : 'Request stop';
  ui['control-note'].textContent = task.stoppedAt ? 'Worker process stopped.' :
    isStopping(task) ? 'Waiting for the worker to confirm that its process stopped.' :
    task.stopRequestedAt ? 'Stop recorded. The external agent sees it at its next check-in.' :
    task.status === 'claimed' ? 'Directions arrive when the agent checks for updates.' : '';
  renderWhenChanged(ui.directions, [directions, task.status], () => directions.map((direction) => {
    const item = element('li');
    const state = direction.deliveredAt ? 'Read by agent' : open(task) ? 'Waiting for agent' : 'Unread when task ended';
    item.append(element('p', direction.message), element('small', state + ' · ' + clock.format(new Date(direction.at))));
    return item;
  }));
  setActions();
}

async function loadDetail(conn) {
  const id = selected;
  if (!conn || !id) return;
  // Only one request per selection uses the activity cursor at a time.
  const marker = { id };
  if (conn.detail?.id === id) return;
  conn.detail = marker;
  try {
    let more;
    do {
      const data = await request(conn, '/dashboard/task/' + encodeURIComponent(id) + '?after=' + cursor);
      if (connection !== conn || selected !== id || conn.detail !== marker) return;
      renderDetail(data);
      more = data.activity.hasMore;
    } while (more);
  } catch (error) {
    if (connection !== conn || selected !== id || conn.detail !== marker) return;
    if (current) showError(ui['control-error'], error.message);
    else ui['empty-detail'].textContent = error.message;
  } finally {
    if (conn.detail === marker) conn.detail = undefined;
  }
}

async function refresh(conn) {
  try {
    const data = await request(conn, '/dashboard/overview');
    if (connection !== conn) return;
    snapshot = data;
    ui.login.hidden = true;
    ui.dashboard.hidden = false;
    ui.lock.hidden = false;
    connectionStatus('Live', true);
    if (!selected && filter === 'active') select(data.tasks.find(open)?.id);
    renderOverview();
    await loadDetail(conn);
  } catch (error) {
    if (connection !== conn) return;
    connectionStatus('Reconnecting', false);
    if (!ui.login.hidden) showError(ui['login-error'], error.message);
  }
}

async function poll(conn) {
  await refresh(conn);
  if (connection === conn) setTimeout(() => void poll(conn), 1600);
}

ui['login-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  const token = ui.token.value.trim();
  if (!token) return;
  connection?.stop.abort();
  connection = { token, stop: new AbortController() };
  ui.token.value = '';
  showError(ui['login-error']);
  connectionStatus('Connecting', false);
  void poll(connection);
});

ui.lock.addEventListener('click', () => clearConnection());
for (const button of document.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    for (const other of document.querySelectorAll('[data-filter]')) other.setAttribute('aria-pressed', String(other === button));
    renderOverview();
  });
}

async function control(task, action, body) {
  const conn = connection;
  if (!conn || busy) return false;
  busy = true;
  setActions();
  showError(ui['control-error']);
  try {
    await request(conn, taskPath(task.id) + '/' + action, { attempt: task.attempts, ...body });
    if (connection === conn) await refresh(conn);
    return connection === conn;
  } catch (error) {
    if (connection === conn && selected === task.id) showError(ui['control-error'], error.message);
    return false;
  } finally {
    busy = false;
    setActions();
  }
}

ui['direct-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  const task = current;
  const message = ui.direction.value.trim();
  if (!task || !message) return;
  if (await control(task, 'direct', { message }) && selected === task.id && ui.direction.value.trim() === message)
    ui.direction.value = '';
});

ui.stop.addEventListener('click', () => {
  if (current?.status !== 'claimed') return;
  stopping = current;
  ui['stop-description'].textContent = current.managed
    ? 'Handover will terminate the worker running this task.'
    : 'The task will be marked stopped. The external agent sees the request at its next check-in.';
  ui['stop-confirm'].returnValue = 'dismiss';
  ui['stop-confirm'].showModal();
});

ui['stop-confirm'].addEventListener('close', () => {
  if (stopping && ui['stop-confirm'].returnValue === 'stop') void control(stopping, 'stop');
  stopping = undefined;
});
