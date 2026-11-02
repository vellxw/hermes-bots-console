(function () {
  "use strict";

  const PLUGIN = "hermes-bots-console";
  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !window.__HERMES_PLUGINS__) return;
  const React = SDK.React;
  const h = React.createElement;
  const { useCallback, useEffect, useMemo, useRef, useState } = SDK.hooks;
  const { api, fetchJSON, buildWsUrl } = SDK;
  const BASE = window.__HERMES_BASE_PATH__ || "";
  const ASSET = `${window.location.origin}${BASE}/dashboard-plugins/${PLUGIN}`;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errText = (error) => String(error && error.message ? error.message : error);
  const button = (label, onClick, cls, disabled) => h("button", { className: `hb-btn ${cls || ""}`, onClick, disabled, type: "button" }, label);
  const profileLabel = (bot) => bot.display_name || bot.bot_title || bot.name;
  const profileInitial = (bot) => profileLabel(bot).trim().slice(0, 1).toUpperCase() || "B";
  const avatarTone = (name) => {
    let n = 0;
    for (const ch of String(name || "bot")) n = (n * 31 + ch.charCodeAt(0)) % 360;
    return { background: `linear-gradient(135deg, hsl(${n} 72% 52%), hsl(${(n + 48) % 360} 72% 42%))` };
  };
  const routeFromLocation = () => {
    const q = new URLSearchParams(window.location.search);
    return { view: q.get("view") === "chat" ? "chat" : q.get("view") === "groups" ? "groups" : "roster", profile: q.get("profile") || "", session: q.get("session") || "" };
  };
  const navigate = (route, replace = false) => {
    const q = new URLSearchParams();
    if (route.view && route.view !== "roster") q.set("view", route.view);
    if (route.profile) q.set("profile", route.profile);
    if (route.session) q.set("session", route.session);
    const next = `${BASE}/bots${q.toString() ? `?${q}` : ""}`;
    if (replace) window.history.replaceState({}, "", next);
    else window.history.pushState({}, "", next);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  class RpcClient {
    constructor() { this.ws = null; this.nextId = 1; this.pending = new Map(); this.listeners = new Map(); }
    on(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(fn);
      return () => this.listeners.get(name)?.delete(fn);
    }
    emit(name, value) { for (const fn of this.listeners.get(name) || []) { try { fn(value); } catch (_) {} } }
    async connect() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      const url = await buildWsUrl("/api/ws");
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        let settled = false;
        this.ws = ws;
        ws.onopen = () => { settled = true; this.emit("open"); resolve(); };
        ws.onerror = () => { if (!settled) reject(new Error("No se pudo abrir el Gateway WebSocket")); };
        ws.onclose = () => {
          for (const item of this.pending.values()) item.reject(new Error("Gateway WebSocket cerrado"));
          this.pending.clear();
          this.ws = null;
          this.emit("close");
        };
        ws.onmessage = (event) => {
          let frame;
          try { frame = JSON.parse(String(event.data)); } catch (_) { return; }
          if (frame && frame.id != null && frame.method && !this.pending.has(String(frame.id))) {
            this.emit("server-request", frame);
            return;
          }
          if (frame && frame.id != null && this.pending.has(String(frame.id))) {
            const item = this.pending.get(String(frame.id));
            this.pending.delete(String(frame.id));
            if (frame.error) item.reject(new Error(frame.error.message || "Gateway RPC error"));
            else item.resolve(frame.result || {});
            return;
          }
          if (frame && frame.method === "event") {
            this.emit("event", frame.params || {});
            return;
          }
          if (frame && frame.type) this.emit("event", frame);
        };
      });
    }
    async request(method, params) {
      await this.connect();
      const id = String(this.nextId++);
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        try { this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} })); }
        catch (error) { this.pending.delete(id); reject(error); }
      });
    }
    respond(id, result) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
      return true;
    }
    close() { if (this.ws) this.ws.close(); this.ws = null; }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("No se pudo leer la grabación"));
      reader.readAsDataURL(blob);
    });
  }
  function safeMessageText(message) {
    if (message == null) return "";
    if (typeof message === "string") return message;
    if (Array.isArray(message)) return message.map(safeMessageText).join("\n");
    if (typeof message === "object") return String(message.text || message.content || message.display_content || "");
    return String(message);
  }
  function renderMarkdown(text) {
    const source = safeMessageText(text);
    const parts = source.split("```");
    return parts.map((part, index) => index % 2 === 1
      ? h("details", { className: "hb-code", key: `code-${index}` }, h("summary", null, "Código"), h("pre", null, part.replace(/^\w+\n/, "")))
      : part.split(/\n{2,}/).filter(Boolean).map((paragraph, pIndex) => h("p", { key: `p-${index}-${pIndex}` }, paragraph)));
  }
  function MessageBubble({ message }) {
    if (message.role === "tool") return h("div", { className: `hb-tool ${message.status === "done" ? "done" : ""}` }, h("span", { className: "hb-tool-dot" }, "•"), h("span", null, message.text), message.duration ? h("small", null, `${message.duration}s`) : null);
    return h("div", { className: `hb-message ${message.role === "user" ? "user" : "assistant"}` }, h("div", { className: "hb-message-label" }, message.role === "user" ? "Tú" : "Hermes"), h("div", { className: "hb-message-body" }, renderMarkdown(message.text)), message.streaming ? h("span", { className: "hb-cursor", "aria-label": "respondiendo" }, "▋") : null);
  }

  function ScreenPanel({ bot, onClose }) {
    const hostRef = useRef(null); const rpcRef = useRef(null); const rfbRef = useRef(null); const wsRef = useRef(null); const viewerRef = useRef("");
    const [status, setStatus] = useState(null); const [connection, setConnection] = useState("idle"); const [human, setHuman] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
    const getRpc = useCallback(() => { if (!rpcRef.current) rpcRef.current = new RpcClient(); return rpcRef.current; }, []);
    const cleanup = useCallback(() => { try { rfbRef.current?.disconnect(); } catch (_) {} try { wsRef.current?.close(); } catch (_) {} rfbRef.current = null; wsRef.current = null; if (hostRef.current) hostRef.current.replaceChildren(); setConnection("idle"); }, []);
    const refresh = useCallback(async () => { try { setStatus(await getRpc().request("display.status", { profile: bot.name })); setError(""); } catch (e) { setError(errText(e)); } }, [bot.name, getRpc]);
    const start = useCallback(async () => {
      setBusy(true); setError("");
      try {
        let current = await getRpc().request("display.status", { profile: bot.name });
        if (!current?.running) { current = await getRpc().request("display.start", { profile: bot.name }); await sleep(1000); }
        cleanup(); setConnection("connecting");
        const observed = await getRpc().request("display.observe", { profile: bot.name, viewer_id: viewerRef.current || undefined });
        viewerRef.current = observed.viewer_id || viewerRef.current; setStatus(observed);
        const RFB = (await import(`${ASSET}/novnc/core/rfb.js`)).default;
        if (!hostRef.current) return;
        const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = new URL(`${scheme}//${window.location.host}${BASE}/api/display/ws`); wsUrl.searchParams.set("display_ticket", observed.ticket);
        const socket = new WebSocket(wsUrl); socket.binaryType = "arraybuffer"; wsRef.current = socket;
        const rfb = new RFB(hostRef.current, socket, { shared: true }); rfb.scaleViewport = true; rfb.resizeSession = false; rfb.focusOnClick = true; rfb.viewOnly = true; rfb.background = "transparent";
        rfb.addEventListener("connect", () => setConnection("live")); rfb.addEventListener("disconnect", () => setConnection("idle")); rfbRef.current = rfb;
      } catch (e) { setConnection("error"); setError(errText(e)); } finally { setBusy(false); }
    }, [bot.name, cleanup, getRpc]);
    const takeOver = useCallback(async () => { if (!viewerRef.current) return; setBusy(true); try { const r = await getRpc().request("display.lease.acquire", { profile: bot.name, viewer_id: viewerRef.current, reason: "mobile-console" }); setHuman(true); setStatus((s) => ({ ...(s || {}), lease: r.lease })); if (rfbRef.current) rfbRef.current.viewOnly = false; } catch (e) { setError(errText(e)); } finally { setBusy(false); } }, [bot.name, getRpc]);
    const handBack = useCallback(async () => { if (!viewerRef.current) return; setBusy(true); try { const r = await getRpc().request("display.lease.release", { profile: bot.name, viewer_id: viewerRef.current }); setHuman(false); setStatus((s) => ({ ...(s || {}), lease: r.lease })); if (rfbRef.current) rfbRef.current.viewOnly = true; } catch (e) { setError(errText(e)); } finally { setBusy(false); } }, [bot.name, getRpc]);
    useEffect(() => { refresh(); return () => { cleanup(); rpcRef.current?.close(); }; }, [bot.name, cleanup, refresh]);
    return h("section", { className: "hb-card hb-screen-panel" }, h("div", { className: "hb-panel-heading" }, h("div", { className: "hb-avatar", style: avatarTone(bot.name) }, profileInitial(bot)), h("div", { className: "hb-bot-name" }, h("strong", null, `${profileLabel(bot)} · Monitor`), h("span", null, status?.running ? "Pantalla activa" : "Pantalla detenida")), button("Cerrar", onClose, "ghost")), error ? h("div", { className: "hb-error" }, error) : null, h("div", { className: "hb-screen-frame" }, connection === "live" ? h("div", { className: "hb-screen-host", ref: hostRef }) : h("div", { className: "hb-screen-placeholder", ref: hostRef }, h("strong", null, connection === "connecting" ? "Conectando…" : "Bot Screen"), connection === "idle" ? "Vista solo lectura hasta que la inicies." : "Revisa el error y reintenta.")), h("div", { className: "hb-screen-bar" }, h("span", { className: "hb-status" }, connection === "live" ? (human ? "Tú tienes el control" : "Solo lectura · bot en control") : "Sin conexión"), button(connection === "live" ? "Reconectar" : "Ver escritorio", start, "primary", busy), connection === "live" && !human ? button("Tomar control", takeOver, "", busy) : null, connection === "live" && human ? button("Devolver al bot", handBack, "", busy) : null), h("p", { className: "hb-mobile-note" }, "La vista usa un ticket efímero y el lease del Gateway; no expone VNC ni websockify."));
  }

  function SettingsSheet({ bot, onClose, onSaved }) {
    const [options, setOptions] = useState(null); const [skills, setSkills] = useState([]); const [tools, setTools] = useState([]); const [choice, setChoice] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
    useEffect(() => { Promise.all([api.getModelOptions(bot.name), api.getSkills(bot.name), api.getToolsets(bot.name)]).then(([models, skillRows, toolRows]) => { setOptions(models); setSkills(skillRows || []); setTools(toolRows || []); if (models?.provider && models?.model) setChoice(`${models.provider}\0${models.model}`); }).catch((e) => setError(errText(e))); }, [bot.name]);
    const saveModel = async () => { if (!choice) return; const [provider, model] = choice.split("\0"); setBusy(true); try { await api.setProfileModel(bot.name, provider, model); await onSaved(); } catch (e) { setError(errText(e)); } finally { setBusy(false); } };
    const toggleSkill = async (skill) => { setBusy(true); try { await api.toggleSkill(skill.name, !skill.enabled, bot.name); setSkills((rows) => rows.map((r) => r.name === skill.name ? { ...r, enabled: !r.enabled } : r)); } catch (e) { setError(errText(e)); } finally { setBusy(false); } };
    const toggleTool = async (tool) => { setBusy(true); try { await api.toggleToolset(tool.name, !tool.enabled, bot.name); setTools((rows) => rows.map((r) => r.name === tool.name ? { ...r, enabled: !r.enabled } : r)); } catch (e) { setError(errText(e)); } finally { setBusy(false); } };
    const providers = Array.isArray(options?.providers) ? options.providers : [];
    return h("div", { className: "hb-sheet-backdrop", role: "presentation", onClick: onClose }, h("section", { className: "hb-sheet", role: "dialog", "aria-modal": "true", onClick: (e) => e.stopPropagation() }, h("div", { className: "hb-panel-heading" }, h("div", null, h("h2", null, "Configuración del bot"), h("p", { className: "hb-subtitle" }, profileLabel(bot))), button("Cerrar", onClose, "ghost")), error ? h("div", { className: "hb-error" }, error) : null, h("label", { className: "hb-field" }, "Modelo y proveedor", h("select", { className: "hb-select", value: choice, onChange: (e) => setChoice(e.target.value) }, h("option", { value: "" }, "Usar configuración del perfil"), providers.map((p) => h("optgroup", { key: p.slug, label: p.name || p.slug }, (p.models || []).map((m) => h("option", { key: `${p.slug}-${m}`, value: `${p.slug}\0${m}` }, m))))), choice ? button(busy ? "Guardando…" : "Guardar modelo", saveModel, "primary", busy) : null), h("div", { className: "hb-field" }, h("label", null, "Skills (solo este perfil)"), h("div", { className: "hb-checklist" }, skills.map((s) => h("label", { className: "hb-check", key: s.name }, h("input", { type: "checkbox", checked: !!s.enabled, onChange: () => toggleSkill(s), disabled: busy }), h("span", null, s.name)))), h("div", { className: "hb-field" }, h("label", null, "Herramientas / toolsets (solo este perfil)"), h("div", { className: "hb-checklist" }, tools.map((t) => h("label", { className: "hb-check", key: t.name }, h("input", { type: "checkbox", checked: !!t.enabled, onChange: () => toggleTool(t), disabled: busy }), h("span", null, t.name))))))));
  }

  function CreateBotSheet({ onClose, onCreated }) {
    const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [provider, setProvider] = useState(""); const [model, setModel] = useState(""); const [options, setOptions] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
    useEffect(() => { api.getModelOptions().then(setOptions).catch(() => {}); }, []);
    const create = async () => { const clean = name.trim().toLowerCase(); if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(clean)) { setError("Usa un identificador con letras minúsculas, números, _ o -."); return; } setBusy(true); try { await api.createProfile({ name: clean, description: description.trim(), provider: provider || undefined, model: model || undefined }); await onCreated(); onClose(); } catch (e) { setError(errText(e)); } finally { setBusy(false); } };
    const providers = Array.isArray(options?.providers) ? options.providers : [];
    return h("div", { className: "hb-sheet-backdrop", role: "presentation", onClick: onClose }, h("section", { className: "hb-sheet", role: "dialog", "aria-modal": "true", onClick: (e) => e.stopPropagation() }, h("div", { className: "hb-panel-heading" }, h("div", null, h("h2", null, "Nuevo bot"), h("p", { className: "hb-subtitle" }, "Cada bot conserva su perfil, memoria, skills y pantalla.")), button("Cerrar", onClose, "ghost")), error ? h("div", { className: "hb-error" }, error) : null, h("label", { className: "hb-field" }, "Identificador", h("input", { className: "hb-input", value: name, placeholder: "investigacion", onChange: (e) => setName(e.target.value), autoFocus: true })), h("label", { className: "hb-field" }, "Descripción", h("textarea", { className: "hb-textarea", value: description, rows: 3, placeholder: "Qué función cumple este bot…", onChange: (e) => setDescription(e.target.value) })), h("label", { className: "hb-field" }, "Proveedor", h("select", { className: "hb-select", value: provider, onChange: (e) => { setProvider(e.target.value); setModel(""); } }, h("option", { value: "" }, "Configuración del perfil"), providers.map((p) => h("option", { key: p.slug, value: p.slug }, p.name || p.slug))), provider ? h("label", { className: "hb-field" }, "Modelo", h("select", { className: "hb-select", value: model, onChange: (e) => setModel(e.target.value) }, h("option", { value: "" }, "Elegir modelo"), (providers.find((p) => p.slug === provider)?.models || []).map((m) => h("option", { key: m, value: m }, m)))) : null, button(busy ? "Creando…" : "Crear bot", create, "primary", busy || !name.trim()))));
  }

  function BotCard({ bot, onChat, onScreen, onSettings, onEdit }) {
    return h("article", { className: `hb-bot-card ${bot.is_default ? "director-card" : ""}` }, h("div", { className: "hb-bot-top" }, h("div", { className: "hb-avatar avatar-large", style: avatarTone(bot.name) }, profileInitial(bot)), h("div", { className: "hb-bot-name" }, h("strong", null, profileLabel(bot)), h("span", null, bot.is_default ? "Chief of Staff · director" : bot.description || "Perfil independiente")), bot.is_default ? h("span", { className: "hb-chip director" }, "DIRECTOR") : null), h("div", { className: "hb-chip-row" }, h("span", { className: "hb-chip" }, bot.model || "modelo del perfil"), h("span", { className: `hb-chip ${bot.gateway_running ? "live" : ""}` }, bot.gateway_running ? "Activo" : "Listo"), h("span", { className: "hb-chip" }, `${bot.skill_count || 0} skills`)), h("p", { className: "hb-description" }, bot.is_default ? "Coordina la flota y decide qué capacidades necesita cada trabajo." : bot.description || "Memoria, modelo, skills y escritorio aislados de los demás bots."), h("div", { className: "hb-row-actions" }, button("Abrir chat", () => onChat(bot), "primary"), button("Monitor", () => onScreen(bot)), button("Configurar", () => onSettings(bot), "ghost"), button("Editar", () => onEdit(bot), "ghost")), h("button", { className: "hb-advanced-link", type: "button", onClick: () => window.location.assign(`${BASE}/chat?profile=${encodeURIComponent(bot.name)}`) }, "Terminal avanzado / fallback →"));
  }

  function GroupsView({ bots }) {
    const [groups, setGroups] = useState([]); const [selected, setSelected] = useState(null); const [draft, setDraft] = useState(""); const [members, setMembers] = useState([]); const [skills, setSkills] = useState([]); const [availableSkills, setAvailableSkills] = useState([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
    const load = useCallback(async () => { try { const r = await fetchJSON(`/api/plugins/${PLUGIN}/groups`); setGroups(r.groups || []); } catch (e) { setError(errText(e)); } }, []);
    useEffect(() => { load(); }, [load]);
    useEffect(() => { if (!selected) return; setMembers(selected.members || []); setSkills(selected.skills || []); Promise.all((selected.members || []).map((n) => api.getSkills(n).catch(() => []))).then((lists) => { const map = new Map(); lists.flat().forEach((s) => s?.name && map.set(s.name, s)); setAvailableSkills([...map.values()].sort((a, b) => a.name.localeCompare(b.name))); }); }, [selected]);
    const toggle = (list, value) => list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
    const create = async () => { if (!draft.trim()) return; try { const row = await fetchJSON(`/api/plugins/${PLUGIN}/groups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: draft.trim(), members: [], skills: [] }) }); setDraft(""); await load(); setSelected(row); } catch (e) { setError(errText(e)); } };
    const save = async () => { if (!selected) return; setBusy(true); try { const row = await fetchJSON(`/api/plugins/${PLUGIN}/groups/${encodeURIComponent(selected.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: selected.name, members, skills }) }); await Promise.all(bots.filter((b) => members.includes(b.name)).flatMap((b) => availableSkills.filter((s) => skills.includes(s.name)).map((s) => api.toggleSkill(s.name, true, b.name)))); setSelected(row); await load(); } catch (e) { setError(errText(e)); } finally { setBusy(false); } };
    return h("div", { className: "hb-groups-view" }, error ? h("div", { className: "hb-error" }, error) : null, h("section", { className: "hb-card group-create" }, h("div", null, h("strong", null, "Grupos de trabajo"), h("p", { className: "hb-subtitle" }, "Administración de miembros y skills; la sala nativa de Hermes sigue siendo la fuente del chat grupal.")), h("div", { className: "hb-row-actions" }, h("input", { className: "hb-input", value: draft, placeholder: "Ej. Investigación", onChange: (e) => setDraft(e.target.value) }), button("Crear grupo", create, "primary", !draft.trim()))), h("div", { className: "hb-group-grid" }, groups.map((g) => h("article", { className: `hb-card hb-group-card ${selected?.id === g.id ? "selected" : ""}`, key: g.id }, h("h3", null, g.name), h("p", null, `${(g.members || []).length} bots · ${(g.skills || []).length} skills aplicadas`), h("div", { className: "hb-member-list" }, (g.members || []).map((m) => h("span", { className: "hb-member", key: m }, m))), button("Administrar", () => setSelected(g), "ghost")))), selected ? h("section", { className: "hb-card hb-group-editor" }, h("div", { className: "hb-panel-heading" }, h("h3", null, `Editar ${selected.name}`), button("Cerrar", () => setSelected(null), "ghost")), h("div", { className: "hb-field" }, h("label", null, "Miembros"), h("div", { className: "hb-checklist" }, bots.map((b) => h("label", { className: "hb-check", key: b.name }, h("input", { type: "checkbox", checked: members.includes(b.name), onChange: () => setMembers(toggle(members, b.name)) }), h("span", null, profileLabel(b))))), h("div", { className: "hb-field" }, h("label", null, "Skills del grupo · se aplican por perfil"), h("div", { className: "hb-checklist" }, availableSkills.map((s) => h("label", { className: "hb-check", key: s.name }, h("input", { type: "checkbox", checked: skills.includes(s.name), onChange: () => setSkills(toggle(skills, s.name)) }), h("span", null, s.name)))), h("p", { className: "hb-subtitle" }, "No se habilitan skills globales ni se inventa una semántica de chat grupal: abre la sala nativa desde Hermes Desktop."), button(busy ? "Aplicando…" : "Guardar y aplicar", save, "primary", busy)))) : null);
  }

  function RecentActivity({ bots }) {
    const [rows, setRows] = useState([]);
    useEffect(() => { let alive = true; Promise.all(bots.slice(0, 8).map(async (bot) => { try { const r = await fetchJSON(`/api/sessions?limit=3&order=recent&profile=${encodeURIComponent(bot.name)}`); return (r.sessions || []).map((s) => ({ ...s, profile: bot.name, label: profileLabel(bot) })); } catch (_) { return []; } })).then((lists) => alive && setRows(lists.flat().sort((a, b) => (b.last_active || b.started_at || 0) - (a.last_active || a.started_at || 0)).slice(0, 8))); return () => { alive = false; }; }, [bots]);
    if (!rows.length) return h("div", { className: "hb-empty-activity" }, "Cuando un bot tenga conversaciones, aparecerán aquí.");
    return h("div", { className: "hb-activity-list" }, rows.map((row) => h("button", { className: "hb-activity-row", type: "button", key: `${row.profile}-${row.id}`, onClick: () => navigate({ view: "chat", profile: row.profile, session: row.id }) }, h("span", { className: "hb-activity-avatar", style: avatarTone(row.profile) }, row.label.slice(0, 1)), h("span", { className: "hb-activity-copy" }, h("strong", null, row.title || row.preview || "Conversación"), h("small", null, `${row.label} · ${row.message_count || 0} mensajes`)), h("span", { className: "hb-chevron" }, "›"))));
  }

  function RosterView({ bots, loading, error, onRefresh, onCreate, onSettings, onScreen }) {
    const [search, setSearch] = useState("");
    const director = bots.find((bot) => bot.is_default);
    const filtered = bots.filter((bot) => !search || `${profileLabel(bot)} ${bot.description || ""}`.toLowerCase().includes(search.toLowerCase()));
    const header = h("header", { className: "hb-roster-header" },
      h("div", { className: "hb-brand" }, h("div", { className: "hb-avatar", style: avatarTone("Hermes") }, "H"), h("div", null, h("h1", null, "Bot Command"), h("p", { className: "hb-subtitle" }, "Tu equipo Hermes, en una vista móvil."))),
      h("div", { className: "hb-header-actions" }, h("label", { className: "hb-search" }, h("span", null, "⌕"), h("input", { value: search, placeholder: "Buscar bots", "aria-label": "Buscar bots", onChange: (event) => setSearch(event.target.value) })), button("+", onCreate, "icon primary")));
    const toolbar = h("div", { className: "hb-roster-toolbar" }, h("div", null, h("span", { className: "hb-kicker" }, "FLOTA ACTIVA"), h("h2", null, `${bots.length} ${bots.length === 1 ? "bot" : "bots"} disponibles`)), button("Actualizar", onRefresh, "ghost", loading));
    const featured = director ? h("section", { className: "hb-featured", onClick: () => navigate({ view: "chat", profile: director.name }) }, h("div", { className: "hb-featured-glow" }), h("div", { className: "hb-avatar avatar-featured", style: avatarTone(director.name) }, profileInitial(director)), h("div", { className: "hb-featured-copy" }, h("span", { className: "hb-kicker" }, "CHIEF OF STAFF"), h("h2", null, profileLabel(director)), h("p", null, director.description || "Tu director para organizar trabajo y coordinar especialistas."), h("span", { className: "hb-featured-cta" }, "Abrir conversación ·"))) : null;
    const botSection = h("section", { className: "hb-section" }, h("div", { className: "hb-section-heading" }, h("div", null, h("span", { className: "hb-kicker" }, "MIS BOTS"), h("h2", null, "Listos para trabajar")), h("span", { className: "hb-subtitle" }, "Toca uno para conversar")), h("div", { className: "hb-bot-list" }, filtered.map((bot) => h(BotCard, { bot, key: bot.name, onChat: (item) => navigate({ view: "chat", profile: item.name }), onScreen, onSettings }))));
    const activity = h("section", { className: "hb-section activity-section" }, h("div", { className: "hb-section-heading" }, h("div", null, h("span", { className: "hb-kicker" }, "ACTIVIDAD"), h("h2", null, "Reciente")), button("Grupos", () => navigate({ view: "groups" }), "ghost")), h(RecentActivity, { bots }));
    return h("div", { className: "hb-shell" }, header, toolbar, error ? h("div", { className: "hb-error" }, error) : null, loading ? h("div", { className: "hb-card hb-info" }, "Cargando roster…") : null, featured, botSection, activity);
  }

  function ApprovalCard({ frame, onRespond }) { const [choice, setChoice] = useState("once"); const params = frame.params || {}; return h("div", { className: "hb-approval" }, h("strong", null, "El bot necesita tu aprobación"), h("p", null, params.description || params.command || "Acción protegida"), h("div", { className: "hb-row-actions" }, h("select", { className: "hb-select", value: choice, onChange: (e) => setChoice(e.target.value) }, h("option", { value: "once" }, "Una vez"), h("option", { value: "session" }, "Durante esta sesión"), h("option", { value: "deny" }, "Denegar")), button("Responder", () => onRespond(frame.id, { choice, all: false }), "primary"))); }

  function ChatView({ bot, storedId }) {
    const [core, setCore] = useState(null); const [state, setState] = useState({ messages: [], connected: false, busy: false, error: "", status: "" }); const [approvals, setApprovals] = useState([]); const [screen, setScreen] = useState(false); const rpcRef = useRef(null); const composerRef = useRef(null); const recorderRef = useRef(null); const audioChunksRef = useRef([]); const [draft, setDraft] = useState(""); const [voiceState, setVoiceState] = useState("idle"); const [voiceError, setVoiceError] = useState("");
    useEffect(() => {
      let alive = true; const rpc = new RpcClient(); rpcRef.current = rpc;
      let chat;
      const start = async () => {
        try {
          const { ChatSession } = await import(`${ASSET}/chat-core.mjs`);
          if (!alive) return;
          chat = new ChatSession({ rpc, fetchJSON, profile: bot.name, onChange: (next) => { if (alive) { setState(next); if (next.storedId) { try { localStorage.setItem(`hermes-bots-console.session.${bot.name}`, next.storedId); } catch (_) {} } if (next.storedId && !new URLSearchParams(window.location.search).get("session")) navigate({ view: "chat", profile: bot.name, session: next.storedId }, true); } } });
          setCore(chat);
          let candidate = storedId;
          if (!candidate) { try { candidate = localStorage.getItem(`hermes-bots-console.session.${bot.name}`) || ""; } catch (_) {} }
          if (!candidate) { try { const recent = await fetchJSON(`/api/sessions?limit=1&order=recent&min_messages=1&profile=${encodeURIComponent(bot.name)}`); candidate = recent?.sessions?.[0]?.id || ""; } catch (_) {} }
          let createdFallback = false;
          try { await chat.open(candidate); } catch (resumeError) { if (!candidate) throw resumeError; try { localStorage.removeItem(`hermes-bots-console.session.${bot.name}`); } catch (_) {} createdFallback = true; await chat.open(); }
          if (createdFallback && chat.state.storedId) navigate({ view: "chat", profile: bot.name, session: chat.state.storedId }, true);
          if (alive) composerRef.current?.focus();
        } catch (e) { if (alive) setState((s) => ({ ...s, error: errText(e), connected: false })); }
      };
      const offRequest = rpc.on("server-request", (frame) => { if (frame.method === "approval") setApprovals((old) => [...old.filter((x) => x.id !== frame.id), frame]); });
      start(); return () => { alive = false; try { recorderRef.current?.stop(); } catch (_) {} offRequest(); chat?.close(); rpc.close(); rpcRef.current = null; setCore(null); };
    }, [bot.name, storedId]);
    const send = useCallback(async () => { const text = draft.trim(); if (!text || !core || state.busy) return; setDraft(""); try { await core.submit(text); } catch (_) {} }, [core, draft, state.busy]);
    const stopVoice = useCallback(() => { const recorder = recorderRef.current; if (recorder && recorder.state === "recording") recorder.stop(); }, []);
    const recordVoice = useCallback(async () => {
      if (voiceState === "recording") { stopVoice(); return; }
      if (!core || state.busy || voiceState === "transcribing") return;
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setVoiceError("Este navegador no permite grabar audio aquí."); return; }
      setVoiceError("");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
        const mime = candidates.find((value) => typeof MediaRecorder.isTypeSupported !== "function" || MediaRecorder.isTypeSupported(value)) || "";
        const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        audioChunksRef.current = []; recorderRef.current = recorder;
        recorder.ondataavailable = (event) => { if (event.data?.size) audioChunksRef.current.push(event.data); };
        recorder.onerror = () => { stream.getTracks().forEach((track) => track.stop()); recorderRef.current = null; setVoiceState("idle"); setVoiceError("La grabación de audio falló."); };
        recorder.onstop = async () => {
          stream.getTracks().forEach((track) => track.stop()); recorderRef.current = null; setVoiceState("transcribing");
          try {
            const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || mime || "audio/webm" });
            const dataUrl = await blobToDataUrl(blob);
            const result = await fetchJSON(`/api/audio/transcribe?profile=${encodeURIComponent(bot.name)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data_url: dataUrl, mime_type: blob.type || "audio/webm" }) });
            const transcript = String(result?.transcript || "").trim();
            if (!transcript) throw new Error("No se detectó voz en la grabación.");
            setVoiceState("idle"); await core.submit(transcript);
          } catch (error) { setVoiceState("idle"); setVoiceError(errText(error)); }
        };
        recorder.start(); setVoiceState("recording");
      } catch (error) { setVoiceState("idle"); setVoiceError(error?.name === "NotAllowedError" ? "Permiso de micrófono denegado. Habilítalo para este sitio." : errText(error)); }
    }, [bot.name, core, fetchJSON, state.busy, stopVoice, voiceState]);
    const reconnect = async () => { if (!core) return; try { await core.open(state.storedId || storedId); } catch (e) { setState((s) => ({ ...s, error: errText(e) })); } };
    const respond = (id, result) => { rpcRef.current?.respond(id, result); setApprovals((old) => old.filter((x) => x.id !== id)); };
    return h("div", { className: "hb-chat-layout" }, h("header", { className: "hb-chat-header" }, button("‹", () => navigate({ view: "roster" }), "icon ghost"), h("div", { className: "hb-chat-identity" }, h("div", { className: "hb-avatar", style: avatarTone(bot.name) }, profileInitial(bot)), h("div", null, h("strong", null, profileLabel(bot)), h("span", null, state.connected ? (state.busy ? state.status || "Trabajando…" : "En línea") : "Desconectado"))), h("div", { className: "hb-chat-actions" }, button("Monitor", () => setScreen(true), "ghost"), button("⋯", () => window.location.assign(`${BASE}/chat?profile=${encodeURIComponent(bot.name)}`), "icon ghost"))), h("main", { className: "hb-chat-main" }, h("div", { className: "hb-chat-context" }, h("span", { className: "hb-kicker" }, "CONVERSACIÓN PRIVADA"), h("p", null, bot.description || "Este chat conserva el perfil y la memoria de este bot.")), h("div", { className: "hb-messages", "aria-live": "polite" }, state.messages.length ? state.messages.map((m, i) => h(MessageBubble, { message: m, key: `${m.role}-${m.toolId || i}` })) : h("div", { className: "hb-chat-empty" }, h("div", { className: "hb-empty-orb", style: avatarTone(bot.name) }, profileInitial(bot)), h("h2", null, `¿Qué hacemos, ${profileLabel(bot)}?`), h("p", null, "Escribe una instrucción para comenzar. Este chat usa el Gateway y se reanuda después de recargar.")), approvals.map((frame) => h(ApprovalCard, { frame, key: frame.id, onRespond: respond })), state.error ? h("div", { className: "hb-chat-error" }, h("span", null, state.error), button("Reintentar", reconnect, "ghost")) : null), h("div", { className: "hb-composer-wrap" }, h("textarea", { ref: composerRef, className: "hb-composer", value: draft, rows: 1, placeholder: `Mensaje para ${profileLabel(bot)}…`, "aria-label": "Escribir mensaje", onChange: (e) => setDraft(e.target.value), onKeyDown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } } }), h("div", { className: "hb-composer-bar" }, h("span", { className: "hb-compose-hint" }, "Enter enviar · Shift+Enter nueva línea"), voiceState === "recording" ? button("Detener audio", recordVoice, "voice-recording") : button(voiceState === "transcribing" ? "Transcribiendo…" : "Grabar audio", recordVoice, "voice-button", !state.connected || state.busy || voiceState === "transcribing"), !state.connected ? button("Reconectar", reconnect, "ghost") : null, button("Enviar", send, "primary send-button", !draft.trim() || state.busy)), voiceError ? h("div", { className: "hb-voice-error" }, voiceError) : null, h("div", { className: "hb-chat-note" }, "Perfil explícito: ", bot.name, " · Terminal avanzado disponible desde ⋯"))), screen ? h("div", { className: "hb-screen-overlay" }, h(ScreenPanel, { bot, onClose: () => setScreen(false) })) : null);
  }

  function BotsPage() {
    const [route, setRoute] = useState(routeFromLocation()); const [bots, setBots] = useState([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [sheet, setSheet] = useState(null); const [screenBot, setScreenBot] = useState(null);
    const refresh = useCallback(async () => { setLoading(true); setError(""); try { const result = await api.getProfiles(); setBots(result.profiles || []); } catch (e) { setError(errText(e)); } finally { setLoading(false); } }, []);
    useEffect(() => { const onPop = () => { setRoute(routeFromLocation()); setScreenBot(null); }; window.addEventListener("popstate", onPop); refresh(); return () => window.removeEventListener("popstate", onPop); }, [refresh]);
    const bot = bots.find((b) => b.name === route.profile) || bots.find((b) => b.is_default) || bots[0];
    const content = route.view === "chat" && bot ? h(ChatView, { bot, storedId: route.session }) : route.view === "groups" ? h(GroupsView, { bots }) : h(RosterView, { bots, loading, error, onRefresh: refresh, onCreate: () => setSheet({ type: "create" }), onSettings: (b) => setSheet({ type: "settings", bot: b }), onScreen: setScreenBot, onEdit: (b) => setSheet({ type: "edit", bot: b }) });
    return h("div", { className: "hb-root" }, content, screenBot && route.view !== "chat" ? h("div", { className: "hb-screen-overlay" }, h(ScreenPanel, { bot: screenBot, onClose: () => setScreenBot(null) })) : null, sheet?.type === "create" ? h(CreateBotSheet, { onClose: () => setSheet(null), onCreated: refresh }) : null, sheet?.type === "settings" ? h(SettingsSheet, { bot: sheet.bot, onClose: () => setSheet(null), onSaved: async () => { await refresh(); setSheet(null); } }) : null, sheet?.type === "edit" ? h(CreateBotSheet, { onClose: () => setSheet(null), onCreated: refresh }) : null);
  }

  window.__HERMES_PLUGINS__.register(PLUGIN, BotsPage);
  if (typeof window.__HERMES_PLUGINS__.registerSlot === "function") window.__HERMES_PLUGINS__.registerSlot(PLUGIN, "chat:top", ({}) => null);
})();
