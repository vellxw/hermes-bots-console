// Profile-scoped conversation state. No credentials or DOM access.
function displayText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(displayText).join('');
  if (typeof value === 'object') return displayText(value.text ?? value.display_content ?? value.content ?? value.value ?? '');
  return String(value);
}

export function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message && message.display_kind !== 'hidden' && message.role !== 'tool')
    .map(message => {
      const text = [message.text, message.display_content, message.content, message.value]
        .map(displayText)
        .find(value => value.trim()) || '';
      return { ...message, text };
    })
    .filter(message => message.role === 'user' || message.text.trim() || message.streaming);
}

function activityLabel(payload, phase = 'working') {
  const name = String(payload?.name || payload?.tool_name || payload?.tool || '').toLowerCase();
  const labels = name.includes('skill') ? 'revisando capacidades' : name.includes('terminal') ? 'trabajando en el sistema' : name.includes('web_') || name.includes('search') || name.includes('extract') ? 'consultando información' : name.includes('computer') || name.includes('browser') ? 'usando el navegador' : name.includes('connector') || name.includes('connect') ? 'preparando una conexión' : 'ejecutando una acción';
  return phase === 'done' ? `Listo · ${labels}` : `Trabajando · ${labels}`;
}

export class ChatSession {
  constructor({ rpc, profile, history, fetchJSON, onChange = () => {} }) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) throw new Error('Perfil inválido');
    this.rpc = rpc; this.profile = profile; this.history = history; this.fetchJSON = fetchJSON; this.onChange = onChange;
    this.state = { messages: [], storedId: '', runtimeId: '', busy: false, connected: false, error: '', status: '', actions: [], info: {}, pendingConnection: null, openRequests: [] };
    this.seq = 0; this.active = null; this.closed = false;
    this.unsub = rpc.on('event', event => this.event(event));
  }
  publish(patch = {}) { this.state = { ...this.state, ...patch }; this.onChange(this.state); }
  async open(storedId = '') {
    await this.rpc.connect();
    const result = await this.rpc.request(storedId ? 'session.resume' : 'session.create', {
      profile: this.profile, ...(storedId ? { session_id: storedId } : { source: 'bot_mobile', follow_profile_config: true }),
      close_on_disconnect: false, ...(storedId ? { inline_images: false } : {})
    });
    let messages = normalizeMessages(result.messages);
    if (storedId && result.session_id) {
      try {
        const history = await this.rpc.request('session.history', { profile: this.profile, session_id: result.session_id });
        if (Array.isArray(history?.messages)) messages = normalizeMessages(history.messages);
      } catch (_) {
        // Older gateways may not expose session.history; keep the resume snapshot.
      }
      if (this.fetchJSON) {
        try {
          const path = `/api/sessions/${encodeURIComponent(storedId)}/messages?profile=${encodeURIComponent(this.profile)}&order=oldest&inline_images=false`;
          const durable = await this.fetchJSON(path);
          if (Array.isArray(durable?.messages)) messages = normalizeMessages(durable.messages);
        } catch (_) {
          // The Gateway snapshot remains a valid fallback when the REST prefetch is unavailable.
        }
      }
    }
    this.publish({ runtimeId: result.session_id, storedId: result.stored_session_id || result.resumed || storedId,
      messages, info: result.info || {}, connected: true, busy: !!result.running, error: '', status: result.running ? 'Trabajando…' : '', pendingConnection: result.pending_connection || null, openRequests: Array.isArray(result.open_requests) ? result.open_requests : [] });
  }
  async submit(text, mode = 'queue') {
    text = String(text).trim();
    if (!text || !this.state.connected) return false;
    const busy = this.state.busy;
    const messages = busy && mode === 'steer' ? this.state.messages : [...this.state.messages, { role: 'user', text, queued: busy }];
    this.publish({ messages, busy: true, error: '', status: busy ? (mode === 'steer' ? 'Cambiando el foco…' : 'En cola para después…') : 'Pensando…' });
    try {
      const method = busy && mode === 'steer' ? 'session.steer' : 'prompt.submit';
      const submitParams = { profile: this.profile, session_id: this.state.runtimeId, text };
      if (method === 'prompt.submit' && busy && mode !== 'steer') submitParams.queued = true;
      let result = await this.rpc.request(method, submitParams);
      let steerRejected = false;
      if (method === 'session.steer' && result?.status === 'rejected') {
        steerRejected = true;
        this.publish({ messages: [...this.state.messages, { role: 'user', text, queued: true }], busy: true, status: 'En cola para después…' });
        result = await this.rpc.request('prompt.submit', { profile: this.profile, session_id: this.state.runtimeId, text, queued: true });
      }
      if (busy && mode === 'steer' && !steerRejected) this.publish({ busy: true, status: 'Cambiando el foco…' });
      else if (result?.status === 'queued') this.publish({ busy: true, status: 'En cola para después…' });
      return true;
    } catch (error) {
      this.publish({ error: error.message, connected: false, status: 'Envío sin confirmar. Reconecta antes de volver a enviar.' });
      throw error;
    }
  }
  event(event) {
    if (event.session_id !== this.state.runtimeId) return;
    if (Number.isInteger(event.seq)) { if (event.seq <= this.seq) return; this.seq = event.seq; }
    const p = event.payload || {};
    if (event.type === 'session.info') { this.publish({ info: p }); return; }
    if (event.type === 'tool.start') { this.publish({ busy: true, status: activityLabel(p, 'working') }); return; }
    if (event.type === 'tool.complete') { this.publish({ busy: true, status: activityLabel(p, 'done') }); return; }
    if (event.type === 'message.start') { this.active = null; this.publish({ busy: true, status: 'Pensando…' }); return; }
    if (event.type === 'message.delta' || event.type === 'message.complete') {
      const messages = [...this.state.messages];
      if (this.active === null) { this.active = messages.length; messages.push({ role: 'assistant', text: '' }); }
      const old = messages[this.active];
      messages[this.active] = { ...old, text: event.type === 'message.delta' ? old.text + String(p.text || '') : String(p.text ?? old.text), streaming: event.type === 'message.delta' };
      this.publish({ messages, busy: event.type !== 'message.complete', status: event.type === 'message.complete' ? '' : 'Respondiendo…', error: p.error || '' });
      if (event.type === 'message.complete') this.active = null;
    }
  }
  close() { this.closed = true; this.unsub(); this.rpc.close(); }
}
