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

export function conservativeOrder(text, { busy = true } = {}) {
  if (!busy) return { action: 'new_turn', source: 'local-policy', confidence: 1 };
  const value = String(text || '').trim().toLocaleLowerCase('es');
  const activeCorrection = /\b(correg(?:í|i)|cambi(?:á|a)|cambia|ajust(?:á|a)|prioriz(?:á|a)|deten(?:é|e)|pará|cancel(?:á|a)|no hagas|te confund|en realidad|mejor hac|urgente|importante|esto no)\b/.test(value);
  return activeCorrection
    ? { action: 'steer_active', source: 'local-policy', confidence: 0.72 }
    : { action: 'queue_next', source: 'local-policy', confidence: 0.86 };
}

function normalizeOrderDecision(value, text, busy) {
  const allowed = new Set(['steer_active', 'queue_next', 'new_turn']);
  const action = String(value?.action || '').trim();
  if (allowed.has(action) && (!busy || action !== 'new_turn')) {
    return { action, source: String(value.source || 'subagent'), confidence: Number(value.confidence) || 0.5 };
  }
  return conservativeOrder(text, { busy });
}

export class ChatSession {
  constructor({ rpc, profile, history, fetchJSON, routeMessage, onChange = () => {} }) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) throw new Error('Perfil inválido');
    this.rpc = rpc; this.profile = profile; this.history = history; this.fetchJSON = fetchJSON; this.routeMessage = routeMessage; this.onChange = onChange;
    this.state = { messages: [], storedId: '', runtimeId: '', busy: false, connected: false, error: '', status: '', actions: [], info: {}, pendingConnection: null, openRequests: [], lastActivityAt: 0, recoverable: false, recoveryReason: '', stalled: false, orderDecision: null, inflight: null, autoContinue: null };
    this.seq = 0; this.active = null; this.closed = false; this.recoveryInFlight = false;
    this.unsub = rpc.on('event', event => this.event(event));
    this.unsubClose = rpc.on('close', () => {
      if (!this.closed) this.publish({ connected: false, recoverable: this.state.busy || !!this.state.storedId, recoveryReason: 'connection', status: 'Conexión interrumpida…', lastActivityAt: Date.now() });
    });
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
    const inflight = result.inflight || null;
    const autoContinue = result.auto_continue || null;
    this.publish({ runtimeId: result.session_id, storedId: result.stored_session_id || result.resumed || storedId,
      messages, info: result.info || {}, connected: true, busy: !!result.running || !!autoContinue, error: '', status: autoContinue ? 'Reanudando…' : result.running ? 'Trabajando…' : '', pendingConnection: result.pending_connection || null, openRequests: Array.isArray(result.open_requests) ? result.open_requests : [], inflight, autoContinue, recoverable: Boolean(autoContinue || inflight?.recoverable), recoveryReason: inflight?.error ? 'turn' : '', stalled: false, lastActivityAt: Date.now() });
    return result;
  }
  async decideOrder(text, busy = this.state.busy) {
    if (!busy) return conservativeOrder(text, { busy: false });
    try {
      const activeTask = [...this.state.messages].reverse().find(message => message.role === 'assistant')?.text || this.state.status || '';
      const result = this.routeMessage ? await this.routeMessage({ text, busy: true, status: this.state.status, activeTask }) : null;
      return normalizeOrderDecision(result, text, true);
    } catch (_) {
      return { ...conservativeOrder(text, { busy: true }), source: 'local-fallback' };
    }
  }

  async submit(text) {
    text = String(text).trim();
    if (!text || !this.state.connected) return false;
    const busy = this.state.busy;
    const decision = await this.decideOrder(text, busy);
    const steer = busy && decision.action === 'steer_active';
    const messages = [...this.state.messages, { role: 'user', text, queued: busy && !steer, routing: steer ? 'active' : busy ? 'next' : 'now' }];
    this.publish({ messages, busy: true, error: '', recoverable: false, stalled: false, lastActivityAt: Date.now(), orderDecision: decision, status: steer ? 'Ajustando el trabajo…' : busy ? 'En la siguiente tarea…' : 'Pensando…' });
    try {
      const method = steer ? 'session.steer' : 'prompt.submit';
      const submitParams = { profile: this.profile, session_id: this.state.runtimeId, text };
      if (!steer && busy) submitParams.queued = true;
      let result = await this.rpc.request(method, submitParams);
      if (steer && result?.status === 'rejected') {
        result = await this.rpc.request('prompt.submit', { profile: this.profile, session_id: this.state.runtimeId, text, queued: true });
        const nextMessages = this.state.messages.map((message, index) => index === this.state.messages.length - 1 ? { ...message, queued: true, routing: 'next' } : message);
        this.publish({ messages: nextMessages, busy: true, orderDecision: { ...decision, action: 'queue_next', source: 'gateway-fallback' }, status: 'En la siguiente tarea…', lastActivityAt: Date.now() });
      } else if (!steer && result?.status === 'queued') {
        this.publish({ busy: true, status: 'En la siguiente tarea…', lastActivityAt: Date.now() });
      } else if (steer) {
        this.publish({ busy: true, status: 'Ajustando el trabajo…', lastActivityAt: Date.now() });
      }
      return true;
    } catch (error) {
      this.publish({ error: error.message, connected: false, busy: false, recoverable: true, recoveryReason: 'submit', status: 'El trabajo se detuvo…', lastActivityAt: Date.now() });
      throw error;
    }
  }
  async continueRun() {
    if (this.recoveryInFlight) return false;
    this.recoveryInFlight = true;
    this.publish({ status: 'Reanudando…', error: '', stalled: false, lastActivityAt: Date.now() });
    try {
      let resumed = null;
      if (this.state.storedId) resumed = await this.open(this.state.storedId);
      else if (this.state.runtimeId) {
        await this.rpc.connect();
        this.publish({ connected: true, lastActivityAt: Date.now() });
      } else resumed = await this.open();
      if (resumed?.auto_continue) {
        this.publish({ busy: true, connected: true, recoverable: false, autoContinue: resumed.auto_continue, status: 'Reanudando…', lastActivityAt: Date.now() });
        return true;
      }
      const recoveryPrompt = 'Continuá desde el último punto seguro. Revisá qué quedó confirmado antes de repetir cualquier acción externa; informá brevemente el estado y seguí solo con lo que falta.';
      if (this.state.busy) {
        try {
          const steered = await this.rpc.request('session.steer', { profile: this.profile, session_id: this.state.runtimeId, text: recoveryPrompt });
          if (steered?.status !== 'rejected') {
            this.publish({ busy: true, connected: true, recoverable: false, status: 'Reanudando…', lastActivityAt: Date.now() });
            return true;
          }
        } catch (_) {
          // A fresh queued turn below is the safe fallback when the live turn cannot be steered.
        }
      }
      await this.submit(recoveryPrompt);
      return true;
    } catch (error) {
      this.publish({ connected: false, busy: false, recoverable: true, recoveryReason: 'continue', status: 'No se pudo reanudar todavía.', lastActivityAt: Date.now() });
      return false;
    } finally {
      this.recoveryInFlight = false;
    }
  }
  event(event) {
    if (event.session_id !== this.state.runtimeId) return;
    if (Number.isInteger(event.seq)) { if (event.seq <= this.seq) return; this.seq = event.seq; }
    const touched = { lastActivityAt: Date.now(), stalled: false };
    const p = event.payload || {};
    if (event.type === 'session.info') {
      this.publish({ ...touched, info: p, ...(p.running === true ? { busy: true } : {}), ...(p.status === 'error' ? { busy: false, recoverable: true, recoveryReason: 'gateway', status: 'El trabajo se detuvo…' } : {}) });
      return;
    }
    if (event.type === 'error') { this.publish({ ...touched, busy: false, recoverable: true, recoveryReason: 'gateway', status: 'El trabajo se detuvo…', error: p.message || 'Gateway error' }); return; }
    if (event.type === 'tool.start') { this.publish({ ...touched, busy: true, recoverable: false, status: activityLabel(p, 'working') }); return; }
    if (event.type === 'tool.complete') { this.publish({ ...touched, busy: true, status: activityLabel(p, 'done') }); return; }
    if (event.type === 'message.start') { this.active = null; this.publish({ ...touched, busy: true, recoverable: false, status: 'Pensando…' }); return; }
    if (event.type === 'message.delta' || event.type === 'message.complete') {
      const messages = [...this.state.messages];
      if (this.active === null) { this.active = messages.length; messages.push({ role: 'assistant', text: '' }); }
      const old = messages[this.active];
      messages[this.active] = { ...old, text: event.type === 'message.delta' ? old.text + String(p.text || '') : String(p.text ?? old.text), streaming: event.type === 'message.delta' };
      const failed = event.type === 'message.complete' && (!!p.error || p.status === 'error');
      this.publish({ ...touched, messages, busy: event.type !== 'message.complete', status: failed ? 'El trabajo se detuvo…' : event.type === 'message.complete' ? '' : 'Respondiendo…', error: p.error || '', recoverable: failed, recoveryReason: failed ? 'turn' : '' });
      if (event.type === 'message.complete') this.active = null;
    }
  }
  close() { this.closed = true; this.unsub?.(); this.unsubClose?.(); this.rpc.close(); }
}
