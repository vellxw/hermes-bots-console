// Pure policy, attachment and Markdown primitives shared by the Bot Command UI and tests.
export const TURBO_MODES = ['planning', 'simulation', 'autonomous'];
export const TURBO_MODE_LABELS = {
  planning: 'Planificación Turbo',
  simulation: 'Simulación Turbo',
  autonomous: 'Turbo Autónomo',
};
export const TURBO_MODE_EXPLANATIONS = {
  planning: 'Descompone la tarea y no realiza escrituras externas.',
  simulation: 'Puede leer y preparar borradores, pero nunca confirma acciones externas.',
  autonomous: 'Ejecuta con grants vigentes y solo detiene el flujo ante excepciones protegidas.',
};
export const TURBO_EXCEPTIONS = Object.freeze([
  'ambiguous_account', 'identity_required', 'mfa_or_captcha', 'payment',
  'irreversible_delete', 'security_change', 'legal_action', 'high_risk',
]);
export const TURBO_EXCEPTION_LABELS = Object.freeze({
  ambiguous_account: 'Cuenta ambigua', identity_required: 'Identidad obligatoria',
  mfa_or_captcha: 'MFA/CAPTCHA', payment: 'Pago',
  irreversible_delete: 'Borrado irreversible o masivo', security_change: 'Cambio de seguridad',
  legal_action: 'Acción legal', high_risk: 'Riesgo alto',
});
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const MODE_CAPABILITIES = {
  planning: new Set(['read', 'plan', 'explain']),
  simulation: new Set(['read', 'plan', 'explain', 'prepare']),
  autonomous: new Set(['read', 'plan', 'explain', 'prepare', 'confirm', 'write']),
};
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_MIME = new Set([
  'application/pdf', 'application/msword', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/rtf', 'text/plain', 'text/markdown', 'text/csv',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp',
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm',
  'video/mp4', 'video/webm', 'video/quicktime', 'application/octet-stream',
]);
const EXT_MIME = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  rtf: 'application/rtf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', webm: 'video/webm', mp4: 'video/mp4', mov: 'video/quicktime',
};

export function modeLabel(mode) {
  if (!Object.hasOwn(TURBO_MODE_LABELS, mode)) throw new Error('Modo Turbo inválido');
  return TURBO_MODE_LABELS[mode];
}

export function modeAllows(mode, capability) {
  return Boolean(MODE_CAPABILITIES[mode]?.has(capability));
}

export function modePolicy(mode) {
  if (!TURBO_MODES.includes(mode)) throw new Error('Modo Turbo inválido');
  return {
    mode,
    label: modeLabel(mode),
    explanation: TURBO_MODE_EXPLANATIONS[mode],
    canRead: modeAllows(mode, 'read'),
    canPlan: modeAllows(mode, 'plan'),
    canPrepare: modeAllows(mode, 'prepare'),
    canConfirm: modeAllows(mode, 'confirm'),
    canWrite: modeAllows(mode, 'write'),
    usesPersistentGrants: mode === 'autonomous',
  };
}

export function requiresConfirmation(mode, operation = {}) {
  if (!TURBO_MODES.includes(mode)) throw new Error('Modo Turbo inválido');
  const exceptions = [...(Array.isArray(operation.exceptions) ? operation.exceptions : []), operation.exception, operation.risk].filter(Boolean);
  if (exceptions.length) return true;
  const capability = String(operation.capability || operation.action || '').trim();
  return capability === 'confirm' || capability === 'write'
    ? !modeAllows(mode, capability)
    : false;
}

export function createTurboState(profile, { clock = Date.now } = {}) {
  if (!PROFILE_RE.test(String(profile || ''))) throw new Error('Perfil inválido');
  return { profile, mode: 'planning', grants: [], audit: [], updatedAt: clock() };
}

export function setTurboMode(state, mode, { clock = Date.now } = {}) {
  if (!state || !TURBO_MODES.includes(mode)) throw new Error('Modo Turbo inválido');
  const at = clock();
  return { ...state, mode, updatedAt: at, audit: [...(state.audit || []), { event: 'mode.changed', mode, at }] };
}

export function createGrantLedger(profile) {
  if (!PROFILE_RE.test(String(profile || ''))) throw new Error('Perfil inválido');
  return { profile, grants: [], updatedAt: Date.now() };
}

function cleanGrant(input) {
  const service = String(input?.service || '').trim().slice(0, 80);
  const account = String(input?.account || '').trim().slice(0, 160);
  const capabilities = [...new Set((Array.isArray(input?.capabilities) ? input.capabilities : []).map(String).map(x => x.trim()).filter(Boolean))].slice(0, 32);
  const status = String(input?.status || 'active').trim();
  if (!service || !account || !capabilities.length) throw new Error('Grant incompleto');
  if (!['active', 'revoked', 'pending'].includes(status)) throw new Error('Estado de grant inválido');
  return { service, account, capabilities, persistent: Boolean(input?.persistent), scope: input?.persistent ? 'profile' : 'once', status, grantedAt: Date.now(), ...(input?.expiresAt == null ? {} : { expiresAt: Number(input.expiresAt) }) };
}

export function grant(ledger, input) {
  const next = cleanGrant(input);
  const grants = (ledger.grants || []).filter(item => !(item.service === next.service && item.account === next.account));
  return { ...ledger, grants: [...grants, next], updatedAt: Date.now() };
}

export function requestGrant(ledger, input) {
  return grant(ledger, { ...input, status: 'pending', persistent: Boolean(input?.persistent) });
}

export function revoke(ledger, service, account) {
  return { ...ledger, grants: (ledger.grants || []).map(item => item.service === service && item.account === account ? { ...item, status: 'revoked', capabilities: [], revokedAt: Date.now() } : item), updatedAt: Date.now() };
}

export function isGranted(ledger, service, account, capability, now = Date.now()) {
  return Boolean((ledger?.grants || []).some(item => item.service === service && item.account === account && item.status === 'active' && item.capabilities.includes(capability) && (item.expiresAt == null || Number(item.expiresAt) > now)));
}

export function authorizationDecision(mode, ledger, operation = {}) {
  const { service, account, capability } = operation;
  if (requiresConfirmation(mode, operation)) return { allowed: false, requiresConfirmation: true, reason: operation.exception || operation.risk || 'protected_operation' };
  if (!modeAllows(mode, capability)) return { allowed: false, requiresConfirmation: false, reason: 'mode_restriction' };
  if (mode !== 'autonomous' || !service || !account || !capability) return { allowed: true, requiresConfirmation: false, reason: 'mode_policy' };
  if (!isGranted(ledger, service, account, capability)) return { allowed: false, requiresConfirmation: true, reason: 'grant_required' };
  return { allowed: true, requiresConfirmation: false, reason: 'active_grant' };
}

export function grantChoice(choice) {
  const actions = { once: { action: 'allow_once', persistent: false, scope: 'once', status: 'active' }, always: { action: 'enable_always', persistent: true, scope: 'profile', status: 'active' }, cancel: { action: 'cancel', persistent: false, scope: 'once', status: 'cancelled' } };
  if (!actions[choice]) throw new Error('Decisión de grant inválida');
  return { ...actions[choice] };
}

function cleanName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 240 || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.includes('\0') || /[\u0000-\u001f]/.test(name)) throw new Error('nombre de archivo inválido');
  return name;
}

function mimeKind(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'text/markdown' || mime === 'text/plain' || mime === 'text/csv' || mime.includes('pdf') || mime.includes('word') || mime.includes('excel') || mime.includes('spreadsheet')) return 'document';
  return 'file';
}

export function normalizeAttachment(input) {
  const name = cleanName(input?.name);
  const size = Number(input?.size || 0);
  if (!Number.isFinite(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) throw new Error('El adjunto es demasiado grande');
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const type = String(input?.type || EXT_MIME[extension] || 'application/octet-stream').toLowerCase().split(';')[0];
  if (!SAFE_MIME.has(type) && !type.startsWith('image/') && !type.startsWith('audio/') && !type.startsWith('video/')) throw new Error('tipo MIME no permitido');
  if (EXT_MIME[extension] && type !== EXT_MIME[extension] && !(type === 'application/octet-stream' && extension === 'bin')) throw new Error('tipo MIME no coincide con la extensión');
  return { id: String(input?.id || `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`), name, type, size, kind: mimeKind(type), source: String(input?.source || 'file'), status: 'ready' };
}

export function attachmentPayload(attachments) {
  return (Array.isArray(attachments) ? attachments : []).map(item => ({
    id: item.id,
    profile: item.profile,
    name: item.name,
    type: item.type,
    size: item.size,
    kind: item.kind,
    source: item.source,
    status: item.status || 'ready',
    ...(item.storage_key ? { storage_key: item.storage_key } : {}),
  })).map(item => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)));
}

function stripUnsafeHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function safeUrl(value) {
  const url = String(value || '').trim();
  if (/^(?:https?:|mailto:)/i.test(url)) return url;
  return '';
}

export function inlineTokens(input) {
  const source = stripUnsafeHtml(input);
  const tokens = [];
  let rest = source;
  while (rest) {
    const match = rest.match(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*]+)\*|_([^_]+)_/);
    if (!match) { if (rest) tokens.push({ type: 'text', text: rest }); break; }
    if (match.index > 0) {
      tokens.push({ type: 'text', text: rest.slice(0, match.index) });
      rest = rest.slice(match.index);
      continue;
    }
    if (match[1] !== undefined) { const url = safeUrl(match[2]); if (url) tokens.push({ type: 'image', alt: match[1], url }); else tokens.push({ type: 'text', text: match[1] }); }
    else if (match[3] !== undefined) { const url = safeUrl(match[4]); if (url) tokens.push({ type: 'link', text: match[3], url }); else tokens.push({ type: 'text', text: match[3] }); }
    else if (match[5] !== undefined || match[6] !== undefined) tokens.push({ type: 'strong', children: inlineTokens(match[5] ?? match[6]) });
    else if (match[7] !== undefined) tokens.push({ type: 'code', text: match[7] });
    else tokens.push({ type: 'em', children: inlineTokens(match[8] ?? match[9]) });
    rest = rest.slice(match[0].length);
  }
  return tokens;
}

function splitTableRow(row) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

export function parseMarkdown(input) {
  const source = stripUnsafeHtml(input).replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
    if (fence) {
      const code = []; index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', lang: fence[1] || '', text: code.join('\n') });
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, children: inlineTokens(heading[2]) }); index += 1; continue; }
    if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line); const items = [];
      while (index < lines.length && /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[index])) {
        items.push(inlineTokens(lines[index].replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, ''))); index += 1;
      }
      blocks.push({ type: 'list', ordered, items }); continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = []; while (index < lines.length && /^\s*>/.test(lines[index])) { quote.push(lines[index].replace(/^\s*>\s?/, '')); index += 1; }
      blocks.push({ type: 'quote', children: inlineTokens(quote.join('\n')) }); continue;
    }
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])) {
      const headers = splitTableRow(line); const rows = []; index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) { rows.push(splitTableRow(lines[index]).map(inlineTokens)); index += 1; }
      blocks.push({ type: 'table', headers: headers.map(inlineTokens), rows }); continue;
    }
    const paragraph = [line]; index += 1;
    while (index < lines.length && lines[index].trim() && !/^\s*(?:#{1,6}\s|```|[-*+]\s+|\d+[.)]\s+|>|\|)/.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push({ type: 'paragraph', children: inlineTokens(paragraph.join('\n')) });
  }
  return blocks;
}
