import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
const coreUrl = pathToFileURL(fileURLToPath(new URL('../dashboard/chat-core.mjs', import.meta.url))).href;
const indexSource = readFile(new URL('../dashboard/index.js', import.meta.url), 'utf8');

test('routes the Bot Screen gateway and RFB stream to the selected bot profile', async () => {
  const source = await indexSource;
  assert.match(source, /class RpcClient[\s\S]*?constructor\(profile =/);
  assert.match(source, /buildWsUrl\(["']\/api\/ws["'], this\.profile \? \{ profile: this\.profile \} : undefined\)/);
  assert.match(source, /new RpcClient\(bot\.name\)/);
  assert.match(source, /display\.observe/);
  assert.match(source, /display_ticket/);
});

test('Gateway monitor transport coalesces connects and resets server-request capability after cleanup', async () => {
  const source = await indexSource;
  assert.match(source, /this\.connectPromise = null/);
  assert.match(source, /if \(this\.connectPromise\) return this\.connectPromise/);
  assert.match(source, /this\.capabilitiesSent = false/);
  assert.match(source, /this\.connectReject\?\.\(error\)/);
});

test('starts the Bot Screen lifecycle lazily and retries fresh RFB tickets', async () => {
  const source = await indexSource;
  assert.match(source, /waitForScreenReady/);
  assert.match(source, /setBusy\(true\); setError\(""\); setScreenState\("connecting"\); setConnection\("connecting"\)/);
  assert.match(source, /screenStateLabel/);
  assert.match(source, /screenRequest/);
  assert.match(source, /Gateway tardó demasiado/);
  assert.match(source, /display\.start/);
  assert.match(source, /for \(let attempt = 0; attempt < 4; attempt\+\+\)/);
  assert.match(source, /socket\.onerror/);
  assert.match(source, /viewerRef\.current = ""; void start\(\)/);
  assert.match(source, /setTimeout\([^\n]*12000\)/);
});

test('does not abandon display startup before the backend launcher deadline', async () => {
  const source = await indexSource;
  assert.match(source, /request\("display\.start", \{ profile: bot\.name \}, 30000\)/);
  assert.match(source, /importWithTimeout\(\(\) => import\(`\$\{ASSET\}\/novnc\/rfb\.bundle\.js`\), 15000, controller\.signal\)/);
  assert.match(source, /try \{ rpc\.close\(\); \} catch/);
});

test('bounds noVNC WebCodecs detection on mobile browsers', async () => {
  const browser = await readFile(new URL('../dashboard/novnc/core/util/browser.js', import.meta.url), 'utf8');
  assert.match(browser, /Android\|iPhone\|iPad/);
  assert.match(browser, /Promise\.race/);
});

test('mobile screen uses a full-frame touch viewer with zoom, pan and clipboard controls', async () => {
  const source = await indexSource;
  const css = await readFile(new URL('../dashboard/style.css', import.meta.url), 'utf8');
  assert.match(source, /hb-screen-mobile-toolbar/);
  assert.match(source, /hb-screen-mobile-controls/);
  assert.match(source, /hb-screen-touch-layer/);
  assert.match(source, /showDotCursor = false/);
  assert.match(source, /onPointerDown/);
  assert.match(source, /clipboardPasteFrom/);
  assert.match(source, /setZoom/);
  assert.match(source, /onKeyUp/);
  assert.match(source, /ShiftLeft/);
  assert.match(source, /keyboardRef\.current\.tabIndex = 0/);
  assert.match(source, /recordRemoteVoice/);
  assert.match(source, /Grabar audio remoto/);
  assert.match(source, /audio\/transcribe/);
  assert.match(source, /h\("div", \{ className: "hb-screen-overlay mobile-screen" \}, h\(ScreenPanel, \{ key: screenBot\.name, bot: screenBot/);
  assert.match(source, /requestFullscreen/);
  assert.match(source, /mobileModeRef/);
  assert.match(source, /focusOnClick = !mobileModeRef\.current/);
  assert.match(source, /hideCursor = mobileModeRef\.current/);
  assert.match(source, /rfbRef\.current\.viewOnly = false/);
  assert.match(source, /mobileMode && connection === "live"/);
  assert.match(css, /\.hb-screen-overlay\.mobile-screen/);
  assert.match(css, /\.hb-screen-panel:fullscreen/);
  assert.match(css, /\.hb-screen-host canvas \{ display:block; width:auto/);
  assert.match(css, /\.hb-screen-touch-layer/);
  assert.match(css, /\.hb-mobile-surface\.is-chat \{[^}]*height:100%[^}]*min-height:0[^}]*overflow:hidden/);
  assert.match(css, /\.hb-screen-overlay\.mobile-screen \.hb-screen-viewport \{[^}]*position:absolute[^}]*inset:0/);
});

test('mobile touch semantics reserve one finger for the remote mouse and two fingers for camera movement', async () => {
  const source = await indexSource;
  const css = await readFile(new URL('../dashboard/style.css', import.meta.url), 'utf8');
  assert.match(source, /dispatchRemoteMouse/);
  assert.match(source, /remoteMouseDown/);
  assert.match(source, /twoFingerPan/);
  assert.match(source, /visualViewport/);
  assert.match(source, /setKeyboardOpen\(false\)/);
  assert.doesNotMatch(source, /points\.length === 1 && zoomRef\.current > 1/);
  assert.match(css, /overscroll-behavior:\s*contain/);
});

test('noVNC exposes a hard cursor-hide mode for the tap-only mobile viewer', async () => {
  const rfb = await readFile(new URL('../dashboard/novnc/core/rfb.js', import.meta.url), 'utf8');
  assert.match(rfb, /get hideCursor\(\)/);
  assert.match(rfb, /this\._cursor\.clear\(\)/);
});

test('mobile groups use the native Hermes room driver for live bot coordination', async () => {
  const source = await indexSource;
  const css = await readFile(new URL('../dashboard/style-v040.css', import.meta.url), 'utf8');
  assert.match(source, /function GroupRoomView/);
  assert.match(source, /groups\.capabilities/);
  assert.match(source, /groups\.create/);
  assert.match(source, /groups\.log/);
  assert.match(source, /groups\.send/);
  assert.match(source, /groups\.state/);
  assert.match(source, /groups\.stop/);
  assert.match(source, /event_id/);
  assert.match(source, /thread_id/);
  assert.match(source, /message\.member/);
  assert.match(source, /turn\.started/);
  assert.match(source, /turn\.settled/);
  assert.match(source, /view === "group"/);
  assert.match(css, /\.hb-group-room/);
});

test('creates profile-scoped session, streams and exposes durable resume id', async () => {
  const { ChatSession } = await import(coreUrl);
  const calls = [];
  const listeners = {};
  const rpc = {
    on(name, fn) { listeners[name] = fn; return () => {}; },
    async connect() {}, close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session.create') return { session_id: 'runtime', stored_session_id: 'durable', messages: [] };
      return { status: 'streaming' };
    }
  };
  const chat = new ChatSession({ rpc, profile: 'researcher', history: async () => [] });
  await chat.open();
  await chat.submit('Hola');
  listeners.event({ type: 'message.start', session_id: 'runtime', seq: 1, payload: {} });
  listeners.event({ type: 'message.delta', session_id: 'runtime', seq: 2, payload: { text: 'Buenas' } });
  listeners.event({ type: 'message.complete', session_id: 'runtime', seq: 3, payload: { text: 'Buenas tardes', status: 'complete' } });
  assert.equal(chat.state.storedId, 'durable');
  assert.deepEqual(chat.state.messages.map(x => [x.role, x.text]), [['user', 'Hola'], ['assistant', 'Buenas tardes']]);
  assert.equal(chat.state.busy, false);
  assert.equal(calls.find(x => x.method === 'session.create').params.profile, 'researcher');
  assert.equal('inline_images' in calls.find(x => x.method === 'session.create').params, false);
  assert.equal(calls.find(x => x.method === 'prompt.submit').params.profile, 'researcher');
  assert.equal('surface' in calls.find(x => x.method === 'prompt.submit').params, false);
  chat.close();
});

test('hydrates the durable transcript after resuming a stored session', async () => {
  const { ChatSession } = await import(coreUrl);
  const calls = [];
  const rpc = {
    on() { return () => {}; },
    async connect() {}, close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session.resume') return { session_id: 'runtime-resumed', stored_session_id: 'durable', messages: [{ role: 'assistant', text: '' }] };
      if (method === 'session.history') return { count: 2, messages: [{ role: 'user', text: 'Hola' }, { role: 'assistant', text: 'CONEXIÓN OK.' }] };
      return {};
    }
  };
  const chat = new ChatSession({ rpc, profile: 'researcher' });
  await chat.open('durable');
  assert.equal(calls.some(call => call.method === 'session.history'), true);
  assert.deepEqual(chat.state.messages.map(message => [message.role, message.text]), [['user', 'Hola'], ['assistant', 'CONEXIÓN OK.']]);
  chat.close();
});

test('uses the durable REST transcript when a resumed gateway snapshot is incomplete', async () => {
  const { ChatSession } = await import(coreUrl);
  const calls = [];
  const rpc = {
    on() { return () => {}; },
    async connect() {}, close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session.resume') return { session_id: 'runtime-resumed', stored_session_id: 'durable', messages: [{ role: 'user', text: 'Hola' }, { role: 'assistant', text: '' }] };
      if (method === 'session.history') return { count: 2, messages: [{ role: 'user', text: 'Hola' }, { role: 'assistant', text: '' }] };
      return {};
    }
  };
  const fetchCalls = [];
  const fetchJSON = async url => { fetchCalls.push(url); return { messages: [{ role: 'user', text: 'Hola' }, { role: 'assistant', text: '', display_content: 'CONEXIÓN OK.' }] }; };
  const chat = new ChatSession({ rpc, fetchJSON, profile: 'researcher' });
  await chat.open('durable');
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0], /\/api\/sessions\/durable\/messages/);
  assert.deepEqual(chat.state.messages.map(message => [message.role, message.text]), [['user', 'Hola'], ['assistant', 'CONEXIÓN OK.']]);
  chat.close();
});

test('does not render raw tool results as conversation text', async () => {
  const { normalizeMessages } = await import(coreUrl);
  const messages = normalizeMessages([
    { role: 'user', text: 'Quiero crear un bot' },
    { role: 'assistant', text: '' },
    { role: 'tool', tool_name: 'skill_view', content: JSON.stringify({ success: true, content: 'internal data' }) },
    { role: 'assistant', text: 'Claro. Te hago unas preguntas.' }
  ]);
  assert.deepEqual(messages.map(message => [message.role, message.text]), [['user', 'Quiero crear un bot'], ['assistant', 'Claro. Te hago unas preguntas.']]);
});

test('recognizes a persisted interrupted turn as recoverable after a stale resume', async () => {
  const { isRecoverableFailure, normalizeMessages } = await import(coreUrl);
  assert.equal(isRecoverableFailure({ role: 'assistant', text: 'Operation interrupted: waiting for model response (1435.2s elapsed).' }), true);
  assert.equal(isRecoverableFailure({ role: 'assistant', text: 'Respuesta normal del bot.' }), false);
  const recovered = normalizeMessages([{ role: 'assistant', text: 'Operation interrupted: waiting for model response (1435.2s elapsed).' }]);
  assert.equal(recovered[0].recoverable, true);
  assert.equal(recovered[0].text, '');
});

test('shows Continue for a stale persisted failure and resumes with a safe prompt', async () => {
  const { ChatSession } = await import(coreUrl);
  const calls = []; const failed = { role: 'assistant', text: 'Operation interrupted: waiting for model response (1435.2s elapsed).' };
  const rpc = {
    on() { return () => {}; },
    async connect() {}, close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session.resume') return { session_id: 'runtime', stored_session_id: 'durable', messages: [failed], running: false };
      if (method === 'session.history') return { messages: [failed] };
      if (method === 'prompt.submit') return { status: 'streaming' };
      return {};
    }
  };
  const fetchJSON = async () => ({ messages: [failed] });
  const chat = new ChatSession({ rpc, fetchJSON, profile: 'default' });
  await chat.open('durable');
  assert.equal(chat.state.recoverable, true);
  assert.equal(chat.state.status, 'El trabajo se detuvo…');
  assert.equal(await chat.continueRun(), true);
  const recovery = calls.find(call => call.method === 'prompt.submit');
  assert.match(recovery.params.text, /Continuá desde el último punto seguro/);
  chat.close();
});

test('accepts a follow-up while busy and sends it through the Gateway queue', async () => {
  const { ChatSession } = await import(coreUrl);
  const calls = [];
  const rpc = {
    on() { return () => {}; },
    async connect() {}, close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session.create') return { session_id: 'runtime', stored_session_id: 'durable', messages: [] };
      if (method === 'prompt.submit') return { status: calls.filter(call => call.method === 'prompt.submit').length === 1 ? 'streaming' : 'queued' };
      return {};
    }
  };
  const chat = new ChatSession({ rpc, profile: 'architect' });
  await chat.open();
  chat.publish({ busy: true, status: 'Trabajando…' });
  assert.equal(await chat.submit('Haz también un resumen'), true);
  assert.equal(calls.filter(call => call.method === 'prompt.submit').length, 1);
  assert.equal(calls.at(-1).params.text, 'Haz también un resumen');
  assert.equal(calls.at(-1).params.queued, true);
  assert.equal(chat.state.status, 'En la siguiente tarea…');
  assert.deepEqual(chat.state.messages.map(message => message.text), ['Haz también un resumen']);
  chat.close();
});

test('stages multimodal bytes through the declared Gateway attachment RPCs', async () => {
  const { ChatSession } = await import(coreUrl);
  const calls = [];
  const rpc = {
    on() { return () => {}; },
    async connect() {}, close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session.create') return { session_id: 'runtime', stored_session_id: 'durable', messages: [] };
      if (method === 'image.attach_bytes') return { attached: true, path: '/profile-scoped/capture.png' };
      return { status: 'streaming' };
    }
  };
  const chat = new ChatSession({
    rpc,
    profile: 'researcher',
    attachAttachment: async (descriptor, blob, sessionId, profile) => {
      calls.push({ method: 'image.attach_bytes', params: { session_id: sessionId, profile, filename: descriptor.name, content_base64: 'ZmFrZQ==' } });
      assert.equal(blob instanceof Blob, true);
      return { attached: true, path: '/profile-scoped/capture.png' };
    },
  });
  await chat.open();
  await chat.submit('Analizá esta captura', [{ id: 'a1', name: 'screen.png', type: 'image/png', size: 42, kind: 'image' }], {
    files: [{ id: 'a1', file: new Blob(['fixture-bytes'], { type: 'image/png' }) }],
  });
  const prompt = calls.find(call => call.method === 'prompt.submit');
  assert.equal(prompt.params.attachments, undefined);
  assert.equal(JSON.stringify(prompt.params).includes('base64'), false);
  assert.deepEqual(chat.state.messages[0].attachments, [{ id: 'a1', name: 'screen.png', type: 'image/png', size: 42, kind: 'image', source: 'file' }]);
  const attach = calls.find(call => call.method === 'image.attach_bytes');
  assert.equal(attach.params.session_id, 'runtime');
  assert.equal(attach.params.profile, 'researcher');
  assert.equal(attach.params.filename, 'screen.png');
  assert.equal(typeof attach.params.content_base64, 'string');
  assert.equal(attach.params.content_base64.includes('fixture-bytes'), false);
  chat.close();
});


test('steer mode injects a follow-up without interrupting the active turn', async () => {
  const { ChatSession } = await import(coreUrl);
  const calls = [];
  const rpc = {
    on() { return () => {}; },
    async connect() {}, close() {},
    async request(method, params) { calls.push({ method, params }); if (method === 'session.create') return { session_id: 'runtime', stored_session_id: 'durable', messages: [] }; return { status: 'queued' }; }
  };
  const chat = new ChatSession({ rpc, profile: 'architect', routeMessage: async () => ({ action: 'steer_active', source: 'subagent' }) });
  await chat.open();
  chat.publish({ busy: true });
  assert.equal(await chat.submit('Cambiá el foco a soporte'), true);
  assert.equal(calls.at(-1).method, 'session.steer');
  assert.equal(calls.at(-1).params.text, 'Cambiá el foco a soporte');
  assert.equal(Object.hasOwn(calls.at(-1).params, 'queued'), false);
  assert.equal(chat.state.status, 'Ajustando el trabajo…');
  chat.close();
});

test('falls back to the queued next turn when a live focus change is rejected', async () => {
  const { ChatSession } = await import(coreUrl);
  const calls = [];
  const rpc = {
    on() { return () => {}; },
    async connect() {}, close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session.create') return { session_id: 'runtime', stored_session_id: 'durable', messages: [] };
      if (method === 'session.steer') return { status: 'rejected', text: params.text };
      return { status: 'queued' };
    }
  };
  const chat = new ChatSession({ rpc, profile: 'architect', routeMessage: async () => ({ action: 'steer_active', source: 'subagent' }) });
  await chat.open();
  chat.publish({ busy: true });
  assert.equal(await chat.submit('Seguí con el trabajo pero agregá soporte'), true);
  assert.deepEqual(calls.slice(-2).map(call => call.method), ['session.steer', 'prompt.submit']);
  assert.equal(calls.at(-1).params.queued, true);
  assert.deepEqual(chat.state.messages.map(message => message.text), ['Seguí con el trabajo pero agregá soporte']);
  assert.equal(chat.state.status, 'En la siguiente tarea…');
  chat.close();
});

test('hydrates a pending connection operation after resuming a stored session', async () => {
  const { ChatSession } = await import(coreUrl);
  const rpc = {
    on() { return () => {}; },
    async connect() {}, close() {},
    async request(method) {
      if (method === 'session.resume') return { session_id: 'runtime-resumed', stored_session_id: 'durable', messages: [], pending_connection: { op_id: 'op-1', seq: 1, targets: [{ name: 'gmail', state: 'pending' }] } };
      if (method === 'session.history') return { messages: [] };
      return {};
    }
  };
  const chat = new ChatSession({ rpc, profile: 'architect' });
  await chat.open('durable');
  assert.equal(chat.state.pendingConnection.op_id, 'op-1');
  assert.equal(chat.state.pendingConnection.targets[0].name, 'gmail');
  chat.close();
});

test('renders deterministic animated bot characters in roster and chat surfaces', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../dashboard/index.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../dashboard/style-v021.css', import.meta.url), 'utf8');
  assert.match(source, /function BotCharacter\(/);
  assert.match(css, /hb-character-work/);
  assert.match(css, /hb-character-breathe/);
  assert.match(source, /profileLabel\(bot\)/);
  assert.match(source, /BotCharacter, \{ bot/);
});

test('system router steers an explicit correction without exposing a queue toggle', async () => {
  const { ChatSession } = await import(coreUrl);
  const calls = []; const rpc = {
    on() { return () => {}; },
    async connect() {}, close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session.create') return { session_id: 'runtime', stored_session_id: 'durable', messages: [] };
      return { status: 'queued' };
    }
  };
  const chat = new ChatSession({ rpc, profile: 'architect', routeMessage: async () => ({ action: 'steer_active', source: 'subagent' }) });
  await chat.open(); chat.publish({ busy: true, lastActivityAt: Date.now() });
  assert.equal(await chat.submit('No, corregí el objetivo y seguí con esta prioridad'), true);
  assert.equal(calls.at(-1).method, 'session.steer');
  assert.equal(calls.at(-1).params.text, 'No, corregí el objetivo y seguí con esta prioridad');
  assert.equal(chat.state.orderDecision.action, 'steer_active');
  assert.equal(chat.state.status, 'Ajustando el trabajo…');
  chat.close();
});

test('system router queues an independent task automatically', async () => {
  const { ChatSession } = await import(coreUrl);
  const calls = []; const rpc = {
    on() { return () => {}; },
    async connect() {}, close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session.create') return { session_id: 'runtime', stored_session_id: 'durable', messages: [] };
      return { status: 'queued' };
    }
  };
  const chat = new ChatSession({ rpc, profile: 'architect', routeMessage: async () => ({ action: 'queue_next', source: 'subagent' }) });
  await chat.open(); chat.publish({ busy: true, lastActivityAt: Date.now() });
  assert.equal(await chat.submit('Además prepará un resumen para mañana'), true);
  assert.equal(calls.at(-1).method, 'prompt.submit');
  assert.equal(calls.at(-1).params.queued, true);
  assert.equal(chat.state.orderDecision.action, 'queue_next');
  assert.equal(chat.state.status, 'En la siguiente tarea…');
  chat.close();
});

test('router failure falls back conservatively to the next task', async () => {
  const { ChatSession } = await import(coreUrl);
  const calls = []; const rpc = {
    on() { return () => {}; },
    async connect() {}, close() {},
    async request(method, params) { calls.push({ method, params }); if (method === 'session.create') return { session_id: 'runtime', stored_session_id: 'durable', messages: [] }; return { status: 'queued' }; }
  };
  const chat = new ChatSession({ rpc, profile: 'architect', routeMessage: async () => { throw new Error('router unavailable'); } });
  await chat.open(); chat.publish({ busy: true, lastActivityAt: Date.now() });
  await chat.submit('Guardá también esta tarea para después');
  assert.equal(calls.at(-1).method, 'prompt.submit');
  assert.equal(calls.at(-1).params.queued, true);
  assert.equal(chat.state.orderDecision.source, 'local-fallback');
  chat.close();
});

test('continue resumes a recoverable session without duplicating the last operation', async () => {
  const { ChatSession } = await import(coreUrl);
  const calls = []; const rpc = {
    on() { return () => {}; },
    async connect() {}, close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session.resume') return { session_id: 'runtime-resumed', stored_session_id: 'durable', messages: [], running: false, auto_continue: { attempt: 1 } };
      if (method === 'session.history') return { messages: [] };
      return {};
    }
  };
  const chat = new ChatSession({ rpc, profile: 'architect' });
  await chat.open('durable'); chat.publish({ connected: false, recoverable: true, error: 'hidden failure' });
  assert.equal(await chat.continueRun(), true);
  assert.equal(calls.filter(call => call.method === 'prompt.submit').length, 0);
  assert.equal(chat.state.status, 'Reanudando…');
  assert.equal(chat.state.error, '');
  chat.close();
});

test('source exposes recovery UI and no manual busy-order selector', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../dashboard/index.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../dashboard/style.css', import.meta.url), 'utf8');
  assert.match(source, /Continuar/);
  assert.doesNotMatch(source, /Poner en cola/);
  assert.doesNotMatch(source, /toggleBusyMode/);
  assert.match(source, /manifest\.json/);
  assert.match(source, /plugins\/rescan/);
  assert.match(source, /window\.location\.reload/);
  assert.match(source, /display\.observe/);
  assert.match(source, /display\.lease\.acquire/);
  assert.match(source, /waitForScreenReady/);
  assert.match(source, /event\.reason/);
  assert.match(source, /socket\.onerror/);
  assert.match(source, /setScreenState\("error"\)/);
  assert.match(source, /screenResourceGate/);
  assert.match(source, /data-contextual-monitor/);
  assert.match(source, /Esperando respuesta del monitor/);
  assert.match(source, /connection !== "live" \? h\("div", \{ className: "hb-screen-placeholder" \}/);
  assert.match(css, /\.hb-screen-placeholder \{ position:absolute;/);
  assert.match(css, /pointer-events:none/);
  assert.match(css, /touch-action:none/);
});

test('keeps Gateway notifications inside the authenticated UI with generic browser text', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../dashboard/index.js', import.meta.url), 'utf8');
  assert.match(source, /event\.type === "notification\.show"/);
  assert.match(source, /event\.type === "notification\.clear"/);
  assert.match(source, /NoticeCard/);
  assert.match(source, /new Notification\("Nuevo aviso de Hermes", \{ body: "Hay un aviso disponible en la conversación\./);
  assert.match(source, /payload\.text \|\| payload\.message \|\| "Aviso del Gateway"/);
});

test('cache-busted release contains the automatic router and continue flow', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../dashboard/index-v043.js', import.meta.url), 'utf8');
  const core = await readFile(new URL('../dashboard/chat-core-v023.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../dashboard/style-v041.css', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../dashboard/manifest.json', import.meta.url), 'utf8'));
  assert.ok(source.includes('chat-core-v023.mjs'));
  assert.ok(source.includes('/route'));
  assert.match(core, /continueRun/);
  assert.match(css, /hb-continue-button/);
  assert.equal(manifest.version, '0.5.0-rc.1');
  assert.equal(manifest.entry, 'index-v054.js');
  assert.equal(manifest.css, 'style-v054.css');
});

test('turbo policy keeps formal modes profile-scoped and blocks external writes in planning and simulation', async () => {
  const core = await import(pathToFileURL(fileURLToPath(new URL('../dashboard/interaction-core.mjs', import.meta.url))).href);
  assert.deepEqual(core.TURBO_MODES, ['planning', 'simulation', 'autonomous']);
  assert.equal(core.modeLabel('planning'), 'Planificación Turbo');
  assert.equal(core.modeLabel('simulation'), 'Simulación Turbo');
  assert.equal(core.modeLabel('autonomous'), 'Turbo Autónomo');
  assert.equal(core.modeAllows('planning', 'read'), true);
  assert.equal(core.modeAllows('planning', 'write'), false);
  assert.equal(core.modeAllows('simulation', 'prepare'), true);
  assert.equal(core.modeAllows('simulation', 'confirm'), false);
  assert.equal(core.modeAllows('autonomous', 'write'), true);
  const state = core.createTurboState('researcher');
  assert.equal(state.profile, 'researcher');
  assert.equal(state.mode, 'planning');
  assert.equal(core.setTurboMode(state, 'simulation').mode, 'simulation');
  assert.throws(() => core.setTurboMode(state, 'unknown'), /Modo Turbo inválido/);
});

test('grant ledger supports once, persistent bot scope and revocation without secrets', async () => {
  const core = await import(pathToFileURL(fileURLToPath(new URL('../dashboard/interaction-core.mjs', import.meta.url))).href);
  let ledger = core.createGrantLedger('default');
  ledger = core.grant(ledger, { service: 'gmail', account: 'demo@example.com', capabilities: ['read', 'draft'], persistent: true });
  assert.equal(core.isGranted(ledger, 'gmail', 'demo@example.com', 'read'), true);
  assert.equal(ledger.profile, 'default');
  assert.equal(JSON.stringify(ledger).includes('password'), false);
  assert.equal(JSON.stringify(ledger).includes('token'), false);
  ledger = core.revoke(ledger, 'gmail', 'demo@example.com');
  assert.equal(core.isGranted(ledger, 'gmail', 'demo@example.com', 'read'), false);
  assert.equal(core.grantChoice('once').persistent, false);
  assert.equal(core.grantChoice('always').persistent, true);
});

test('attachment pipeline validates MIME, size and safe message payloads', async () => {
  const core = await import(pathToFileURL(fileURLToPath(new URL('../dashboard/interaction-core.mjs', import.meta.url))).href);
  const image = core.normalizeAttachment({ name: 'captura.PNG', type: 'image/png', size: 1200, source: 'paste' });
  assert.equal(image.kind, 'image');
  assert.equal(image.source, 'paste');
  assert.equal(core.attachmentPayload([image])[0].name, 'captura.PNG');
  assert.throws(() => core.normalizeAttachment({ name: '../../secret.env', type: 'text/plain', size: 4 }), /nombre de archivo/);
  assert.throws(() => core.normalizeAttachment({ name: 'x.bin', type: 'application/octet-stream', size: core.MAX_ATTACHMENT_BYTES + 1 }), /demasiado grande/);
  assert.throws(() => core.normalizeAttachment({ name: 'photo.jpg', type: 'text/plain', size: 10 }), /tipo MIME/);
});

test('safe markdown parser exposes GFM blocks and never returns executable HTML', async () => {
  const core = await import(pathToFileURL(fileURLToPath(new URL('../dashboard/interaction-core.mjs', import.meta.url))).href);
  const blocks = core.parseMarkdown('# Título\n\n**fuerte** y *cursiva*\n\n- uno\n- dos\n\n> cita\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nalert(1)\n```\n\n<script>alert(2)</script>');
  assert.equal(blocks.some(block => block.type === 'heading'), true);
  assert.equal(blocks.some(block => block.type === 'list'), true);
  assert.equal(blocks.some(block => block.type === 'quote'), true);
  assert.equal(blocks.some(block => block.type === 'table'), true);
  assert.equal(blocks.some(block => block.type === 'code' && block.lang === 'js'), true);
  assert.equal(JSON.stringify(blocks).includes('<script>'), false);
  assert.equal(core.inlineTokens('**ok** [link](https://example.com) ![x](javascript:alert(1))').some(token => token.type === 'raw-html'), false);
});

test('source wires Turbo selector, persistent grants, attachments and clipboard shortcuts', async () => {
  const source = await readFile(new URL('../dashboard/index.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../dashboard/style-v040.css', import.meta.url), 'utf8');
  assert.match(source, /Turbo Aut[oó]nomo/);
  assert.match(source, /Planificaci[oó]n Turbo/);
  assert.match(source, /Permitir una vez/);
  assert.match(source, /Habilitar siempre para este bot/);
  assert.match(source, /grant ledger|grantLedger|grantLedger/i);
  assert.match(source, /type:\s*["']file["']/);
  assert.match(source, /onDrop/);
  assert.match(source, /clipboardData/);
  assert.match(source, /event\.key\.toLowerCase\(\) === "b"|event\.key === "b"|event\.key === 'b'/);
  assert.match(source, /attachments/);
  assert.match(source, /accept:\s*["']image/);
  assert.match(css, /hb-attachment/);
  assert.match(css, /hb-mode/);
});
