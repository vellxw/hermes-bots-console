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
  const CURRENT_RELEASE = "0.3.3";
  const CURRENT_ENTRY = "index-v025.js";
  const CURRENT_CSS = "style-v023.css";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errText = (error) => String(error && error.message ? error.message : error);
  const button = (label, onClick, cls, disabled) => h("button", { className: `hb-btn ${cls || ""}`, onClick, disabled, type: "button" }, label);
  const iconButton = (label, icon, onClick, cls, disabled) => h("button", { className: `hb-btn icon hb-icon-button ${cls || ""}`, onClick, disabled, type: "button", title: label, "aria-label": label }, icon);
  const monitorIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("rect", { x: "3", y: "4", width: "18", height: "12", rx: "1.8" }), h("path", { d: "M8 20h8M12 16v4" }));
  const microphoneIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("rect", { x: "8", y: "3", width: "8", height: "12", rx: "4" }), h("path", { d: "M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" }));
  const stopIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("rect", { x: "6", y: "6", width: "12", height: "12", rx: "2" }));
  const bellIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("path", { d: "M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" }));
  const profileLabel = (bot) => bot.display_name || bot.bot_title || bot.name;
  const profileInitial = (bot) => profileLabel(bot).trim().slice(0, 1).toUpperCase() || "B";
  const avatarTone = (name) => {
    let n = 0;
    for (const ch of String(name || "bot")) n = (n * 31 + ch.charCodeAt(0)) % 360;
    return { background: `linear-gradient(135deg, hsl(${n} 72% 52%), hsl(${(n + 48) % 360} 72% 42%))` };
  };
  const characterProfile = (name) => {
    let seed = 2166136261;
    for (const ch of String(name || "bot")) { seed ^= ch.charCodeAt(0); seed = Math.imul(seed, 16777619); }
    seed >>>= 0;
    const hue = seed % 360;
    const shapes = ["round", "organic", "boxy", "capsule", "nub", "cloud", "sun", "triangle"];
    return { hue, shape: shapes[seed % shapes.length], flip: ((seed >>> 8) % 2) ? -1 : 1, eyeGap: 7 + (seed % 3) };
  };
  function BotCharacter({ bot, size = "normal", working = false }) {
    const name = profileLabel(bot);
    const profile = characterProfile(bot.name || name);
    const dark = profile.hue > 205 && profile.hue < 285;
    const ink = dark ? "#fff" : "#17202a";
    const pupil = dark ? "#17202a" : "#fff";
    const body = `hsl(${profile.hue} 68% 58%)`;
    const shade = `hsl(${(profile.hue + 28) % 360} 70% 44%)`;
    const eyeX = profile.flip < 0 ? 33 : 27;
    const eyes = h("g", { className: "hb-character-eyes", fill: ink }, h("ellipse", { cx: eyeX, cy: "31", rx: "3.6", ry: "4.4" }), h("ellipse", { cx: eyeX + profile.eyeGap, cy: "31", rx: "3.6", ry: "4.4" }), h("circle", { cx: eyeX + 1, cy: "31", r: "1.5", fill: pupil }), h("circle", { cx: eyeX + profile.eyeGap + 1, cy: "31", r: "1.5", fill: pupil }));
    const mouth = h("path", { d: "M27 42 Q32 46 37 42", fill: "none", stroke: ink, strokeLinecap: "round", strokeWidth: "1.8" });
    const bodyShape = profile.shape === "round" ? h("circle", { cx: "32", cy: "32", r: "22", fill: body })
      : profile.shape === "organic" ? h("path", { d: "M13 43C7 32 12 15 25 11c10-3 26 2 29 14 3 12-5 25-17 28-12 3-20-1-24-10Z", fill: body })
      : profile.shape === "boxy" ? h("rect", { x: "10", y: "10", width: "44", height: "44", rx: "13", fill: body })
      : profile.shape === "capsule" ? h("rect", { x: "8", y: "18", width: "48", height: "29", rx: "15", fill: body })
      : profile.shape === "nub" ? h("path", { d: "M14 45C9 35 13 21 24 18c3-8 15-8 18 0 11 3 15 17 10 27-5 10-33 10-38 0Z", fill: body })
      : profile.shape === "cloud" ? h("path", { d: "M13 49a12 12 0 0 1 1-23 17 17 0 0 1 32-5 12 12 0 0 1 1 28Z", fill: body })
      : profile.shape === "sun" ? h("g", null, h("path", { d: "M32 4l4 7 8-4-1 8 8 1-6 6 6 6-8 1 1 8-8-4-4 7-4-7-8 4 1-8-8-1 6-6-6-6 8-1-1-8 8 4Z", fill: shade }), h("circle", { cx: "32", cy: "32", r: "18", fill: body }))
      : h("path", { d: "M32 7 55 53H9Z", fill: body });
    return h("div", { className: `hb-character hb-character-${size} ${working ? "is-working" : ""}`, role: "img", "aria-label": `Personaje de ${name}`, title: name }, h("svg", { viewBox: "0 0 64 64", "aria-hidden": "true", focusable: "false" }, h("g", { className: "hb-character-body" }, bodyShape, h("path", { d: "M17 51 Q32 59 47 51", fill: "none", opacity: ".24", stroke: shade, strokeLinecap: "round", strokeWidth: "2" }), eyes, mouth)), working ? h("span", { className: "hb-character-dots", "aria-hidden": "true" }, "•••") : null);
  }
  const SECURE_REQUEST_METHODS = new Set(["secret", "sudo", "vault.code", "vault.save_login", "vault.unlock_prompt"]);
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
    constructor(profile = "") { this.profile = profile; this.ws = null; this.nextId = 1; this.pending = new Map(); this.listeners = new Map(); this.capabilitiesSent = false; }
    on(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(fn);
      return () => this.listeners.get(name)?.delete(fn);
    }
    emit(name, value) { for (const fn of this.listeners.get(name) || []) { try { fn(value); } catch (_) {} } }
    async connect() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      const url = await buildWsUrl("/api/ws", this.profile ? { profile: this.profile } : undefined);
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
            const params = frame.params || {};
            this.emit("event", params);
            if (params.type === "gateway.ready" && !this.capabilitiesSent) { this.capabilitiesSent = true; this.request("client.capabilities", { server_requests: true }).catch(() => {}); }
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
  function WorkingIndicator({ text, recoverable, stalled, onContinue, continuing }) {
    const interrupted = Boolean(recoverable || stalled);
    const label = interrupted ? (stalled ? 'Parece detenido.' : 'El trabajo se detuvo.') : 'Hermes decide automáticamente el orden de cada mensaje.';
    return h("div", { className: `hb-working ${interrupted ? "hb-working-recovery" : ""}`, role: "status", "aria-live": "polite" }, interrupted ? h("span", { className: "hb-recovery-dot", "aria-hidden": "true" }, "!") : h("span", { className: "hb-working-spinner", "aria-hidden": "true" }), h("span", { className: "hb-working-copy" }, h("span", null, interrupted ? "Necesita continuar" : text || "Pensando…"), h("small", null, label)), interrupted ? button(continuing ? "Reanudando…" : "Continuar", onContinue, "hb-continue-button", continuing) : null);
  }
  function MessageBubble({ message }) {
    if (message.role === "tool") return h("div", { className: "hb-tool" }, h("span", { className: "hb-tool-dot" }, "•"), h("span", null, "Trabajando…"));
    if (message.role !== "user" && !message.text?.trim() && !message.streaming) return null;
    return h("div", { className: `hb-message ${message.role === "user" ? "user" : "assistant"}` }, h("div", { className: "hb-message-label" }, message.role === "user" ? "Tú" : "Hermes"), h("div", { className: "hb-message-body" }, renderMarkdown(message.text)), message.streaming ? h("span", { className: "hb-cursor", "aria-label": "respondiendo" }, "▋") : null);
  }

  async function waitForScreenReady(rpc, profile, timeout = 15000) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const status = await rpc.request("display.status", { profile });
        if (status?.running) return status;
      } catch (error) {
        lastError = error;
      }
      await sleep(350);
    }
    throw new Error(lastError ? `Bot Screen no respondió: ${errText(lastError)}` : "Bot Screen no inició a tiempo. Pulsá Reconectar.");
  }

  function ScreenPanel({ bot, onClose }) {
    const hostRef = useRef(null); const rpcRef = useRef(null); const rfbRef = useRef(null); const wsRef = useRef(null); const viewerRef = useRef(""); const reconnectTimerRef = useRef(null);
    const [status, setStatus] = useState(null); const [connection, setConnection] = useState("idle"); const [human, setHuman] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
    const getRpc = useCallback(() => { if (!rpcRef.current) rpcRef.current = new RpcClient(bot.name); return rpcRef.current; }, [bot.name]);
    const cleanup = useCallback(() => { try { if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current); } catch (_) {} try { rfbRef.current?.disconnect(); } catch (_) {} try { wsRef.current?.close(); } catch (_) {} rfbRef.current = null; wsRef.current = null; if (hostRef.current) hostRef.current.replaceChildren(); setHuman(false); setConnection("idle"); }, []);
    const refresh = useCallback(async () => { try { setStatus(await getRpc().request("display.status", { profile: bot.name })); setError(""); } catch (e) { setError(errText(e)); } }, [bot.name, getRpc]);
    const start = useCallback(async () => {
      setBusy(true); setError("");
      try {
        const rpc = getRpc();
        const current = await rpc.request("display.status", { profile: bot.name });
        if (!current?.running) await rpc.request("display.start", { profile: bot.name });
        setStatus(await waitForScreenReady(rpc, bot.name));
        const RFB = (await import(`${ASSET}/novnc/core/rfb.js`)).default;
        let lastError = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          cleanup(); setConnection("connecting");
          try {
            const observed = await rpc.request("display.observe", { profile: bot.name, viewer_id: viewerRef.current || undefined });
            viewerRef.current = observed.viewer_id || viewerRef.current; setStatus(observed);
            if (!hostRef.current) throw new Error("El panel del escritorio ya no está montado");
            const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
            const wsUrl = new URL(`${scheme}//${window.location.host}${BASE}/api/display/ws`); wsUrl.searchParams.set("display_ticket", observed.ticket);
            await new Promise((resolve, reject) => {
              let settled = false;
              let rfb = null;
              const socket = new WebSocket(wsUrl); socket.binaryType = "arraybuffer"; wsRef.current = socket;
              const timer = window.setTimeout(() => fail(new Error("El escritorio tardó demasiado en responder")), 12000);
              const fail = (error) => { if (settled) return; settled = true; window.clearTimeout(timer); try { rfb?.disconnect(); } catch (_) {} try { socket.close(); } catch (_) {} reject(error); };
              const connected = () => { if (settled) return; settled = true; window.clearTimeout(timer); setConnection("live"); resolve(); };
              socket.onerror = () => fail(new Error("No se pudo abrir el canal seguro del Bot Screen"));
              socket.onclose = () => { if (!settled) fail(new Error("El canal del escritorio se cerró antes de mostrar la pantalla")); else setConnection("idle"); };
              try { rfb = new RFB(hostRef.current, socket, { shared: true }); rfb.scaleViewport = true; rfb.resizeSession = false; rfb.focusOnClick = true; rfb.viewOnly = true; rfb.background = "transparent"; rfb.addEventListener("connect", connected); rfb.addEventListener("disconnect", () => { if (!settled) fail(new Error("noVNC desconectó el escritorio antes del primer frame")); }); rfbRef.current = rfb; } catch (error) { fail(error); }
            });
            return;
          } catch (error) {
            lastError = error;
            cleanup();
            if (attempt < 3) await sleep(500 + attempt * 350);
          }
        }
        throw lastError || new Error("No se pudo conectar al Bot Screen");
      } catch (e) { setConnection("error"); setError(errText(e)); } finally { setBusy(false); }
    }, [bot.name, cleanup, getRpc]);
    const takeOver = useCallback(async () => { if (!viewerRef.current) return; setBusy(true); try { const r = await getRpc().request("display.lease.acquire", { profile: bot.name, viewer_id: viewerRef.current, reason: "mobile-console" }); setHuman(true); setStatus((s) => ({ ...(s || {}), lease: r.lease })); if (rfbRef.current) rfbRef.current.viewOnly = false; } catch (e) { setError(errText(e)); } finally { setBusy(false); } }, [bot.name, getRpc]);
    const handBack = useCallback(async () => { if (!viewerRef.current) return; setBusy(true); try { const r = await getRpc().request("display.lease.release", { profile: bot.name, viewer_id: viewerRef.current }); setHuman(false); setStatus((s) => ({ ...(s || {}), lease: r.lease })); if (rfbRef.current) rfbRef.current.viewOnly = true; } catch (e) { setError(errText(e)); } finally { setBusy(false); } }, [bot.name, getRpc]);
    useEffect(() => { viewerRef.current = ""; refresh(); return () => { cleanup(); rpcRef.current?.close(); }; }, [bot.name, cleanup, refresh]);
    return h("section", { className: "hb-card hb-screen-panel" }, h("div", { className: "hb-panel-heading" }, h(BotCharacter, { bot, size: "small" }), h("div", { className: "hb-bot-name" }, h("strong", null, profileLabel(bot)), h("span", null, status?.running ? "Pantalla activa" : "Pantalla detenida")), button("Cerrar", onClose, "ghost")), error ? h("div", { className: "hb-error" }, error) : null, h("div", { className: "hb-screen-frame" }, h("div", { className: "hb-screen-host", ref: hostRef, "aria-label": `Escritorio de ${profileLabel(bot)}` }), connection !== "live" ? h("div", { className: "hb-screen-placeholder" }, h("strong", null, connection === "connecting" ? "Conectando…" : "Bot Screen"), connection === "idle" ? "Vista solo lectura hasta que la inicies." : "Revisa el error y reintenta.") : null), h("div", { className: "hb-screen-bar" }, h("span", { className: "hb-status" }, connection === "live" ? (human ? "Tú tienes el control" : "Solo lectura · bot en control") : "Sin conexión"), button(connection === "live" ? "Reconectar" : "Ver escritorio", start, "primary", busy), connection === "live" && !human ? button("Tomar control", takeOver, "", busy) : null, connection === "live" && human ? button("Devolver al bot", handBack, "", busy) : null), h("p", { className: "hb-mobile-note" }, "La vista usa un ticket efímero y el lease del Gateway; no expone VNC ni websockify."));
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
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [provider, setProvider] = useState("");
    const [model, setModel] = useState("");
    const [options, setOptions] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [confirming, setConfirming] = useState(false);
    useEffect(() => { api.getModelOptions().then(setOptions).catch(() => {}); }, []);
    const validate = () => {
      const clean = name.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(clean)) { setError("Usa un identificador con letras minúsculas, números, _ o -."); return null; }
      setError(""); return clean;
    };
    const review = () => { if (validate()) setConfirming(true); };
    const create = async () => {
      const clean = validate(); if (!clean) return;
      setBusy(true);
      try { await api.createProfile({ name: clean, description: description.trim(), provider: provider || undefined, model: model || undefined }); await onCreated(); onClose(); }
      catch (e) { setError(errText(e)); }
      finally { setBusy(false); }
    };
    const providers = Array.isArray(options?.providers) ? options.providers : [];
    const header = h("div", { className: "hb-panel-heading" }, h("div", null, h("h2", null, "Nuevo bot"), h("p", { className: "hb-subtitle" }, "Cada bot conserva su perfil, memoria, skills y pantalla.")), button("Cerrar", onClose, "ghost"));
    const providerField = h("label", { className: "hb-field" }, "Proveedor", h("select", { className: "hb-select", value: provider, onChange: (e) => { setProvider(e.target.value); setModel(""); setConfirming(false); } }, h("option", { value: "" }, "Configuración del perfil"), providers.map((p) => h("option", { key: p.slug, value: p.slug }, p.name || p.slug))));
    const modelField = provider ? h("label", { className: "hb-field" }, "Modelo", h("select", { className: "hb-select", value: model, onChange: (e) => { setModel(e.target.value); setConfirming(false); } }, h("option", { value: "" }, "Elegir modelo"), (providers.find((p) => p.slug === provider)?.models || []).map((m) => h("option", { key: m, value: m }, m)))) : null;
    const form = h("div", null,
      h("label", { className: "hb-field" }, "Identificador", h("input", { className: "hb-input", value: name, placeholder: "investigacion", onChange: (e) => { setName(e.target.value); setConfirming(false); }, autoFocus: true })),
      h("label", { className: "hb-field" }, "Descripción", h("textarea", { className: "hb-textarea", value: description, rows: 3, placeholder: "Qué función cumple este bot…", onChange: (e) => { setDescription(e.target.value); setConfirming(false); } })),
      providerField,
      modelField,
      button("Revisar y confirmar", review, "primary", !name.trim())
    );
    const confirmation = h("div", { className: "hb-confirmation" }, h("strong", null, "Revisa antes de crear"), h("p", null, `Bot: ${name.trim().toLowerCase()}`), h("p", null, description.trim() || "Sin descripción adicional"), h("p", null, `${provider || "Proveedor del perfil"}${model ? ` · ${model}` : ""}`), h("div", { className: "hb-row-actions" }, button(busy ? "Creando…" : "Confirmar creación", create, "primary", busy), button("Volver a editar", () => setConfirming(false), "ghost", busy)));
    return h("div", { className: "hb-sheet-backdrop", role: "presentation" }, h("section", { className: "hb-sheet", role: "dialog", "aria-modal": "true", onClick: (e) => e.stopPropagation() }, header, error ? h("div", { className: "hb-error" }, error) : null, confirming ? confirmation : form));
  }

  function BotCard({ bot, onChat, onScreen, onSettings, onEdit }) {
    return h("article", { className: `hb-bot-card ${bot.is_default ? "director-card" : ""}` }, h("div", { className: "hb-bot-top" }, h(BotCharacter, { bot, size: "large" }), h("div", { className: "hb-bot-name" }, h("strong", null, profileLabel(bot)), h("span", null, bot.is_default ? "Chief of Staff · director" : bot.description || "Perfil independiente")), bot.is_default ? h("span", { className: "hb-chip director" }, "DIRECTOR") : null), h("div", { className: "hb-chip-row" }, h("span", { className: "hb-chip" }, bot.model || "modelo del perfil"), h("span", { className: `hb-chip ${bot.gateway_running ? "live" : ""}` }, bot.gateway_running ? "Activo" : "Listo"), h("span", { className: "hb-chip" }, `${bot.skill_count || 0} skills`)), h("p", { className: "hb-description" }, bot.is_default ? "Coordina la flota y decide qué capacidades necesita cada trabajo." : bot.description || "Memoria, modelo, skills y escritorio aislados de los demás bots."), h("div", { className: "hb-row-actions" }, button("Abrir chat", () => onChat(bot), "primary"), iconButton("Abrir monitor", monitorIcon(), () => onScreen(bot)), button("Configurar", () => onSettings(bot), "ghost"), button("Editar", () => onEdit(bot), "ghost")), h("button", { className: "hb-advanced-link", type: "button", onClick: () => window.location.assign(`${BASE}/chat?profile=${encodeURIComponent(bot.name)}`) }, "Terminal avanzado / fallback →"));
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
    return h("div", { className: "hb-activity-list" }, rows.map((row) => h("button", { className: "hb-activity-row", type: "button", key: `${row.profile}-${row.id}`, onClick: () => navigate({ view: "chat", profile: row.profile, session: row.id }) }, h(BotCharacter, { bot: { name: row.profile, display_name: row.label }, size: "small" }), h("span", { className: "hb-activity-copy" }, h("strong", null, row.title || row.preview || "Conversación"), h("small", null, `${row.label} · ${row.message_count || 0} mensajes`)), h("span", { className: "hb-chevron" }, "›"))));
  }

  function RosterView({ bots, loading, error, onRefresh, onCreate, onSettings, onScreen }) {
    const [search, setSearch] = useState("");
    const director = bots.find((bot) => bot.is_default);
    const filtered = bots.filter((bot) => !search || `${profileLabel(bot)} ${bot.description || ""}`.toLowerCase().includes(search.toLowerCase()));
    const header = h("header", { className: "hb-roster-header" },
      h("div", { className: "hb-brand" }, h("div", { className: "hb-avatar", style: avatarTone("Hermes") }, "H"), h("div", null, h("h1", null, "Bot Command"), h("p", { className: "hb-subtitle" }, "Tu equipo Hermes, en una vista móvil."))),
      h("div", { className: "hb-header-actions" }, h("label", { className: "hb-search" }, h("span", null, "⌕"), h("input", { value: search, placeholder: "Buscar bots", "aria-label": "Buscar bots", onChange: (event) => setSearch(event.target.value) })), button("+", onCreate, "icon primary")));
    const toolbar = h("div", { className: "hb-roster-toolbar" }, h("div", null, h("span", { className: "hb-kicker" }, "FLOTA ACTIVA"), h("h2", null, `${bots.length} ${bots.length === 1 ? "bot" : "bots"} disponibles`)), button("Actualizar", onRefresh, "ghost", loading));
    const featured = director ? h("section", { className: "hb-featured", onClick: () => navigate({ view: "chat", profile: director.name }) }, h("div", { className: "hb-featured-glow" }), h(BotCharacter, { bot: director, size: "featured" }), h("div", { className: "hb-featured-copy" }, h("span", { className: "hb-kicker" }, "CHIEF OF STAFF"), h("h2", null, profileLabel(director)), h("p", null, director.description || "Tu director para organizar trabajo y coordinar especialistas."), h("span", { className: "hb-featured-cta" }, "Abrir conversación ·"))) : null;
    const botSection = h("section", { className: "hb-section" }, h("div", { className: "hb-section-heading" }, h("div", null, h("span", { className: "hb-kicker" }, "MIS BOTS"), h("h2", null, "Listos para trabajar")), h("span", { className: "hb-subtitle" }, "Toca uno para conversar")), h("div", { className: "hb-bot-list" }, filtered.map((bot) => h(BotCard, { bot, key: bot.name, onChat: (item) => navigate({ view: "chat", profile: item.name }), onScreen, onSettings }))));
    const activity = h("section", { className: "hb-section activity-section" }, h("div", { className: "hb-section-heading" }, h("div", null, h("span", { className: "hb-kicker" }, "ACTIVIDAD"), h("h2", null, "Reciente")), button("Grupos", () => navigate({ view: "groups" }), "ghost")), h(RecentActivity, { bots }));
    return h("div", { className: "hb-shell" }, header, toolbar, error ? h("div", { className: "hb-error" }, error) : null, loading ? h("div", { className: "hb-card hb-info" }, "Cargando roster…") : null, featured, botSection, activity);
  }

  function DirectorQuickActions({ onSelect }) {
    const actions = [
      ["Crear un bot", "Quiero crear un nuevo bot especialista. Pregúntame qué rol, misión, modelo y herramientas necesita."],
      ["Crear una flota", "Quiero crear dentro de Hermes una flota de bots con un orquestador y especialistas. Entiende el proyecto y propón los roles."],
      ["Ver mi flota", "Muéstrame un resumen de mis bots, su estado y para qué sirve cada uno."],
      ["Elegir un modelo", "Ayúdame a elegir el modelo y proveedor adecuados para una tarea."],
      ["Planificar una tarea", "Necesito resolver una tarea. Entiende el objetivo y proponme el siguiente paso."],
    ];
    return h("div", { className: "hb-quick-actions", "aria-label": "Acciones rápidas del director" }, actions.map(([label, prompt]) => h("button", { className: "hb-quick-action", key: label, type: "button", onClick: () => onSelect(prompt) }, label)));
  }

  function ClarifyCard({ frame, profile, rpc, onResolved }) {
    const questions = frame.params?.questions || [];
    const [answers, setAnswers] = useState(() => Object.fromEntries(questions.map((question) => { const value = frame.params?.answers?.[question.qid]; if (question.multi_select && typeof value === "string") { try { return [question.qid, (JSON.parse(value) || []).join("\n")]; } catch (_) {} } return [question.qid, value == null ? "" : String(value)]; })));
    const [other, setOther] = useState({}); const [otherOpen, setOtherOpen] = useState({}); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
    const choose = (qid, value, multi) => setAnswers((current) => { if (!multi) return { ...current, [qid]: value }; const values = String(current[qid] || "").split("\n").filter(Boolean); return { ...current, [qid]: (values.includes(value) ? values.filter((item) => item !== value) : [...values, value]).join("\n") }; });
    const selected = (qid, value) => String(answers[qid] || "").split("\n").includes(value);
    const submit = async () => {
      setBusy(true); setError("");
      try {
        for (const question of questions) {
          const extra = String(other[question.qid] || "").trim(); const values = String(answers[question.qid] || "").split("\n").filter(Boolean); if (extra) values.push(extra);
          const answer = values.length ? question.multi_select ? JSON.stringify(values) : values[values.length - 1] : null;
          await rpc.request("clarify.lock", { request_id: frame.id, question_id: question.qid, answer, profile });
        }
        onResolved(frame.id);
      } catch (e) { setError(errText(e)); } finally { setBusy(false); }
    };
    return h("div", { className: "hb-clarify" }, h("strong", null, "El bot necesita una decisión"), questions.map((question) => h("div", { className: "hb-clarify-question", key: question.qid }, h("p", null, question.question), question.choices?.length ? h("div", { className: "hb-choice-list" }, question.choices.map((choice) => h("button", { className: `hb-choice ${selected(question.qid, choice) ? "selected" : ""}`, type: "button", key: choice, onClick: () => choose(question.qid, choice, question.multi_select) }, choice)), h("button", { className: `hb-choice ${otherOpen[question.qid] ? "selected" : ""}`, type: "button", onClick: () => setOtherOpen((current) => ({ ...current, [question.qid]: !current[question.qid] })) }, "Otra opción"), otherOpen[question.qid] ? h("input", { className: "hb-input", placeholder: "Escribe otra opción", value: other[question.qid] || "", onChange: (event) => setOther((current) => ({ ...current, [question.qid]: event.target.value })) }) : null) : h("input", { className: "hb-input", placeholder: "Escribe tu respuesta", value: answers[question.qid] || "", onChange: (event) => setAnswers((current) => ({ ...current, [question.qid]: event.target.value })) }))), error ? h("div", { className: "hb-voice-error" }, error) : null, button(busy ? "Guardando…" : "Continuar", submit, "primary", busy));
  }

  function ApprovalCard({ frame, onRespond }) { const [choice, setChoice] = useState("once"); const params = frame.params || {}; const accountAccess = /cuenta|account|acceso|access|oauth|credencial|credential|conectar|connect/i.test(`${params.description || ""} ${params.tool_name || ""}`); return h("div", { className: "hb-approval" }, h("strong", null, accountAccess ? "Solicitud de acceso a una cuenta" : "El bot necesita tu aprobación"), h("p", null, params.description || params.command || "Acción protegida"), h("div", { className: "hb-row-actions" }, h("select", { className: "hb-select", value: choice, onChange: (e) => setChoice(e.target.value) }, h("option", { value: "once" }, "Permitir una vez"), h("option", { value: "session" }, "Permitir durante esta sesión"), h("option", { value: "deny" }, "Denegar")), button("Responder", () => onRespond(frame.id, { choice, all: false }), "primary"))); }

  function NoticeCard({ notice }) {
    const payload = notice.payload || notice;
    return h("div", { className: `hb-notice hb-notice-${payload.level || "info"}` }, h("strong", null, payload.title || "Hermes"), h("p", null, payload.text || payload.message || "Aviso del Gateway"));
  }

  function SecureRequestNotice({ frame }) {
    const params = frame.params || {};
    const label = frame.method === "vault.code" ? "Código de verificación" : frame.method === "vault.unlock_prompt" ? "Desbloqueo del gestor de contraseñas" : frame.method === "vault.save_login" ? "Guardar acceso en Vault" : "Dato protegido";
    return h("div", { className: "hb-secure-request" }, h("strong", null, `Flujo seguro pendiente · ${label}`), h("p", null, "Por seguridad, este dato no se solicita ni se almacena en el chat móvil. Completa el aviso seguro de Hermes Desktop o Vault; después el bot continuará en esta misma sesión."), params.site || params.origin || params.display_name ? h("small", null, params.site || params.origin || params.display_name) : null);
  }

  function ConnectionCard({ operation, profile, rpc, onDone }) {
    const targets = Array.isArray(operation.targets) ? operation.targets : [];
    const [selected, setSelected] = useState(() => Object.fromEntries(targets.map((target) => [target.name, false])));
    const [busy, setBusy] = useState(false); const [error, setError] = useState("");
    const owner = operation.owner || { type: "session", session_id: operation.session_id };
    const choose = (name, value) => setSelected((current) => ({ ...current, [name]: value }));
    const respond = async (settledBy = "continue") => {
      if (!owner?.type || !operation.op_id) { setError("La solicitud de acceso no tiene un propietario válido."); return; }
      setBusy(true); setError("");
      try {
        const result = await rpc.request("connection.respond", { profile, owner, op_id: operation.op_id, result: { targets: targets.map((target) => ({ name: target.name, status: selected[target.name] ? "approved" : "skipped" })), settled_by: settledBy } });
        onDone(operation.op_id, result);
      } catch (e) { setError(errText(e)); } finally { setBusy(false); }
    };
    const deadline = operation.deadline_at ? new Date(Number(operation.deadline_at) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    const scope = owner?.type === "account" ? "Alcance de la cuenta de Hermes; no se presenta como una cuenta privada de este bot." : owner?.type === "session" ? "Alcance de esta sesión y perfil." : "Esperando que Hermes confirme el alcance de la operación.";
    return h("div", { className: "hb-connection" }, h("strong", null, "Solicitud de acceso"), h("p", null, "El bot necesita autorización para conectar una cuenta o capacidad. Revisa cada destino antes de continuar."), h("small", { className: "hb-connection-scope" }, scope), targets.map((target) => h("div", { className: "hb-connection-target", key: target.name }, h("div", { className: "hb-connection-copy" }, h("strong", null, target.display || target.name), h("span", null, target.description || target.detail || `${target.action || "connect"} · ${target.state || "pending"}`), target.required_env?.length ? h("small", null, "Este destino requiere configuración segura; no pegues credenciales en el chat.") : null, target.connect_url ? h("a", { className: "hb-connection-link", href: target.connect_url, target: "_blank", rel: "noopener noreferrer" }, "Abrir autorización") : null), h("div", { className: "hb-row-actions" }, h("button", { className: `hb-choice ${selected[target.name] ? "selected" : ""}`, type: "button", onClick: () => choose(target.name, true) }, "Permitir"), h("button", { className: `hb-choice ${selected[target.name] === false ? "selected" : ""}`, type: "button", onClick: () => choose(target.name, false) }, "Omitir")))), error ? h("div", { className: "hb-voice-error" }, error) : null, h("div", { className: "hb-row-actions" }, button("Continuar", () => respond("continue"), "primary", busy || !owner), button("Cancelar acceso", () => respond("interrupt"), "ghost", busy || !owner)), deadline ? h("small", { className: "hb-connection-deadline" }, `Válido hasta ${deadline}`) : null);
  }

  function ChatView({ bot, storedId }) {
    const draftStorageKey = `hermes-bots-console.draft.${bot.name}`;
    const [core, setCore] = useState(null); const [state, setState] = useState({ messages: [], connected: false, busy: false, error: "", status: "" }); const [approvals, setApprovals] = useState([]); const [secureRequests, setSecureRequests] = useState([]); const [notices, setNotices] = useState([]); const [connections, setConnections] = useState([]); const [screen, setScreen] = useState(false); const rpcRef = useRef(null); const composerRef = useRef(null); const recorderRef = useRef(null); const audioChunksRef = useRef([]); const [draft, setDraft] = useState(() => { try { return window.sessionStorage.getItem(draftStorageKey) || ""; } catch (_) { return ""; } }); const [voiceState, setVoiceState] = useState("idle"); const [voiceError, setVoiceError] = useState(""); const [notificationState, setNotificationState] = useState(() => typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported"); const [localStalled, setLocalStalled] = useState(false); const [continuing, setContinuing] = useState(false); const isDirector = Boolean(bot.is_default || /arquitect|architect|chief|director/i.test(`${bot.name || ""} ${profileLabel(bot)}`));
    useEffect(() => {
      let alive = true; const rpc = new RpcClient(bot.name); rpcRef.current = rpc;
      let chat;
      const start = async () => {
        try {
          const { ChatSession } = await import(`${ASSET}/chat-core-v022.mjs`);
          if (!alive) return;
          chat = new ChatSession({ rpc, fetchJSON, profile: bot.name, routeMessage: (context) => fetchJSON(`/api/plugins/${PLUGIN}/route`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: bot.name, ...context }) }), onChange: (next) => { if (alive) { setState(next); if (Array.isArray(next.openRequests)) { const requests = next.openRequests.map((request) => ({ id: request.id, method: request.method, params: request.params || {} })); setApprovals(requests.filter((request) => request.method === "approval" || request.method === "clarify")); setSecureRequests(requests.filter((request) => SECURE_REQUEST_METHODS.has(request.method))); } if (next.pendingConnection) setConnections((old) => [...old.filter((item) => item.op_id !== next.pendingConnection.op_id), { ...next.pendingConnection, session_id: next.runtimeId, owner: { type: "session", session_id: next.runtimeId } }]); if (next.storedId) { try { localStorage.setItem(`hermes-bots-console.session.${bot.name}`, next.storedId); } catch (_) {} } if (next.storedId && !new URLSearchParams(window.location.search).get("session")) navigate({ view: "chat", profile: bot.name, session: next.storedId }, true); } } });
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
      const offEvent = rpc.on("event", (event) => {
        if (!alive) return;
        if (event.type === "notification.show") {
          const payload = event.payload || {}; const key = payload.key || payload.id || `notice-${Date.now()}`;
          setNotices((old) => [...old.filter((item) => item.key !== key), { ...event, key }].slice(-4));
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") new Notification("Nuevo aviso de Hermes", { body: "Hay un aviso disponible en la conversación.", tag: `hermes-notice-${key}` });
          return;
        }
        if (event.type === "notification.clear") { const key = event.payload?.key; if (key) setNotices((old) => old.filter((item) => item.key !== key)); return; }
        if (event.type === "request.cancel") { const id = event.payload?.id; if (id) { setApprovals((old) => old.filter((item) => item.id !== id)); setSecureRequests((old) => old.filter((item) => item.id !== id)); } return; }
        if (event.type !== "connection.request" && event.type !== "connection.update") return;
        if (chat?.state?.runtimeId && event.session_id && event.session_id !== chat.state.runtimeId) return;
        const payload = event.payload || {}; const owner = payload.owner || ((event.session_id || chat?.state?.runtimeId) ? { type: "session", session_id: event.session_id || chat?.state?.runtimeId } : null);
        if (event.type === "connection.request") {
          const operation = { ...payload, session_id: event.session_id || chat?.state?.runtimeId, owner };
          setConnections((old) => [...old.filter((item) => item.op_id !== operation.op_id), operation]);
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") { const names = (operation.targets || []).map((target) => target.display || target.name).filter(Boolean).join(", "); new Notification("Autorización requerida", { body: names ? `El bot solicita acceso a ${names}.` : "El bot necesita tu decisión.", tag: `hermes-connection-${operation.op_id}` }); }
        } else {
          if (payload.settled) setConnections((old) => old.filter((item) => item.op_id !== payload.op_id));
          else setConnections((old) => { const current = old.find((item) => item.op_id === payload.op_id); if (current && Number(current.seq || 0) >= Number(payload.seq || 0)) return old; return [...old.filter((item) => item.op_id !== payload.op_id), { ...payload, session_id: event.session_id || chat?.state?.runtimeId, owner }]; });
        }
      });
      const offRequest = rpc.on("server-request", (frame) => {
        if (frame.method === "approval" || frame.method === "clarify") {
          setApprovals((old) => [...old.filter((x) => x.id !== frame.id), frame]);
          if (frame.method === "approval" && typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") { const params = frame.params || {}; new Notification("Hermes necesita tu aprobación", { body: params.description || params.command || "Acción protegida", tag: `hermes-approval-${frame.id}` }); }
        } else if (SECURE_REQUEST_METHODS.has(frame.method)) {
          setSecureRequests((old) => [...old.filter((x) => x.id !== frame.id), frame]);
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") new Notification("Flujo seguro pendiente", { body: "Completa el aviso seguro de Hermes Desktop o Vault.", tag: `hermes-secure-${frame.id}` });
        }
      });
      start(); return () => { alive = false; try { recorderRef.current?.stop(); } catch (_) {} offEvent(); offRequest(); chat?.close(); rpc.close(); rpcRef.current = null; setCore(null); };
    }, [bot.name, storedId]);
    useEffect(() => {
      try {
        if (draft) window.sessionStorage.setItem(draftStorageKey, draft);
        else window.sessionStorage.removeItem(draftStorageKey);
      } catch (_) {}
    }, [draft, draftStorageKey]);
    useEffect(() => {
      if (!state.busy) { setLocalStalled(false); return undefined; }
      setLocalStalled(false);
      const startedAt = state.lastActivityAt || Date.now();
      const wait = Math.max(0, 45000 - (Date.now() - startedAt));
      const timer = window.setTimeout(() => setLocalStalled(true), wait);
      return () => window.clearTimeout(timer);
    }, [state.busy, state.lastActivityAt]);
    const send = useCallback(async () => { const text = draft.trim(); if (!text || !core || !state.connected) return; setDraft(""); try { await core.submit(text); } catch (_) {} }, [core, draft, state.connected]);
    const quickPrompt = useCallback(async (text) => { if (!core || !state.connected) return; try { await core.submit(text); } catch (_) {} }, [core, state.connected]);
    const continueRun = useCallback(async () => { if (!core || continuing) return; setContinuing(true); setLocalStalled(false); try { await core.continueRun(); } finally { setContinuing(false); } }, [core, continuing]);
    const enableNotifications = useCallback(async () => { if (!(typeof window !== "undefined" && "Notification" in window)) { setNotificationState("unsupported"); return; } if (Notification.permission === "denied") { setNotificationState("denied"); return; } const permission = await Notification.requestPermission(); setNotificationState(permission); }, []);
    const stopVoice = useCallback(() => { const recorder = recorderRef.current; if (recorder && recorder.state === "recording") recorder.stop(); }, []);
    const recordVoice = useCallback(async () => {
      if (voiceState === "recording") { stopVoice(); return; }
      if (!core || voiceState === "transcribing") return;
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
    const reconnect = async () => { if (!core) return; try { await core.open(state.storedId || storedId); } catch (e) { setState((s) => ({ ...s, error: errText(e), connected: false, recoverable: true, recoveryReason: "connection", status: "La conexión se detuvo…" })); } };
    const respond = (id, result) => { rpcRef.current?.respond(id, result); setApprovals((old) => old.filter((x) => x.id !== id)); };
    const clearRequest = (id) => setApprovals((old) => old.filter((x) => x.id !== id));
    const connectionDone = (opId, result) => { if (result?.settled) setConnections((old) => old.filter((item) => item.op_id !== opId)); else setConnections((old) => old.map((item) => item.op_id === opId ? { ...item, status: "initiated" } : item)); };
    return h("div", { className: "hb-chat-layout" }, h("header", { className: "hb-chat-header" }, button("‹", () => navigate({ view: "roster" }), "icon ghost"), h("div", { className: "hb-chat-identity" }, h(BotCharacter, { bot, size: "small", working: state.busy }), h("div", null, h("strong", null, profileLabel(bot)), h("span", null, state.connected ? (state.busy ? state.status || "Trabajando…" : "En línea") : "Desconectado"))), h("div", { className: "hb-chat-actions" }, iconButton("Abrir monitor", monitorIcon(), () => setScreen(true)), notificationState === "granted" ? iconButton("Avisos activos", bellIcon(), () => {}, "notification-icon") : notificationState === "unsupported" ? null : iconButton(notificationState === "denied" ? "Avisos bloqueados" : "Activar avisos", bellIcon(), enableNotifications, "notification-icon", notificationState === "denied"), button("⋯", () => window.location.assign(`${BASE}/chat?profile=${encodeURIComponent(bot.name)}`), "icon ghost"))), h("main", { className: "hb-chat-main" }, h("div", { className: "hb-chat-context" }, h("span", { className: "hb-kicker" }, "CONVERSACIÓN PRIVADA"), h("p", null, bot.description || "Este chat conserva el perfil y la memoria de este bot."), isDirector && !state.busy ? h(DirectorQuickActions, { onSelect: quickPrompt }) : null), h("div", { className: "hb-messages", "aria-live": "polite" }, state.messages.length ? state.messages.map((m, i) => h(MessageBubble, { message: m, key: `${m.role}-${m.toolId || i}` })) : h("div", { className: "hb-chat-empty" }, h(BotCharacter, { bot, size: "empty", working: state.busy }), h("h2", null, `¿Qué hacemos, ${profileLabel(bot)}?`), h("p", null, "Escribe una instrucción para comenzar. Este chat usa el Gateway y se reanuda después de recargar.")), (state.busy || state.recoverable || localStalled) ? h(WorkingIndicator, { text: state.status || "Pensando…", recoverable: state.recoverable, stalled: localStalled || state.stalled, onContinue: continueRun, continuing }) : null, notices.map((notice) => h(NoticeCard, { notice, key: `notice-${notice.key}` })), approvals.map((frame) => frame.method === "clarify" ? h(ClarifyCard, { frame, profile: bot.name, rpc: rpcRef.current, key: frame.id, onResolved: clearRequest }) : h(ApprovalCard, { frame, key: frame.id, onRespond: respond })), connections.map((operation) => h(ConnectionCard, { operation, profile: bot.name, rpc: rpcRef.current, key: `connection-${operation.op_id}`, onDone: connectionDone })), secureRequests.map((frame) => h(SecureRequestNotice, { frame, key: `secure-${frame.id}` })), null), h("div", { className: "hb-composer-wrap" }, h("textarea", { ref: composerRef, className: "hb-composer", value: draft, rows: 1, placeholder: state.busy ? "Escribí lo que necesites; Hermes ordena el mensaje…" : `Mensaje para ${profileLabel(bot)}…`, "aria-label": "Escribir mensaje", onChange: (e) => setDraft(e.target.value), onKeyDown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } } }), h("div", { className: `hb-composer-bar ${state.busy ? "busy" : ""}` }, h("span", { className: "hb-compose-hint" }, state.busy ? "Hermes decide si ajusta el trabajo o lo deja como siguiente tarea." : "Enter enviar · Shift+Enter nueva línea"), voiceState === "recording" ? iconButton("Detener audio", stopIcon(), recordVoice, "voice-recording") : iconButton(voiceState === "transcribing" ? "Transcribiendo…" : "Grabar audio", microphoneIcon(), recordVoice, "voice-button", !state.connected || voiceState === "transcribing"), !state.connected ? button("Reconectar", reconnect, "ghost") : null, button("Enviar", send, "primary send-button", !draft.trim() || !state.connected)), voiceError ? h("div", { className: "hb-voice-error" }, voiceError) : null, h("div", { className: "hb-chat-note" }, "Perfil explícito: ", bot.name, " · Terminal avanzado disponible desde ⋯"))), screen ? h("div", { className: "hb-screen-overlay" }, h(ScreenPanel, { bot, onClose: () => setScreen(false) })) : null);
  }

  function BotsPage() {
    const [route, setRoute] = useState(routeFromLocation()); const [bots, setBots] = useState([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [sheet, setSheet] = useState(null); const [screenBot, setScreenBot] = useState(null);
    const refresh = useCallback(async () => { setLoading(true); setError(""); try { const result = await api.getProfiles(); setBots(result.profiles || []); } catch (e) { setError(errText(e)); } finally { setLoading(false); } }, []);
    useEffect(() => { const onPop = () => { setRoute(routeFromLocation()); setScreenBot(null); }; window.addEventListener("popstate", onPop); refresh(); return () => window.removeEventListener("popstate", onPop); }, [refresh]);
    useEffect(() => {
      let alive = true; let checking = false;
      const checkForUpdate = async () => {
        if (checking) return;
        checking = true;
        try {
          const response = await window.fetch(`${ASSET}/manifest.json?hb=${Date.now()}`, { cache: "no-store", credentials: "same-origin" });
          if (!response.ok) return;
          const manifest = await response.json();
          const changed = manifest.version !== CURRENT_RELEASE || manifest.entry !== CURRENT_ENTRY || manifest.css !== CURRENT_CSS;
          if (alive && changed) {
            await window.fetch(`${BASE}/api/dashboard/plugins/rescan?hb=${Date.now()}`, { cache: "no-store", credentials: "same-origin" }).catch(() => {});
            if (alive) window.location.reload();
          }
        } catch (_) {
          // A temporary manifest check failure must not interrupt the current chat.
        } finally { checking = false; }
      };
      const timer = window.setInterval(checkForUpdate, 15000);
      window.addEventListener("focus", checkForUpdate);
      return () => { alive = false; window.clearInterval(timer); window.removeEventListener("focus", checkForUpdate); };
    }, []);
    const bot = bots.find((b) => b.name === route.profile) || bots.find((b) => b.is_default) || bots[0];
    const content = route.view === "chat" && bot ? h(ChatView, { bot, storedId: route.session }) : route.view === "groups" ? h(GroupsView, { bots }) : h(RosterView, { bots, loading, error, onRefresh: refresh, onCreate: () => setSheet({ type: "create" }), onSettings: (b) => setSheet({ type: "settings", bot: b }), onScreen: setScreenBot, onEdit: (b) => setSheet({ type: "edit", bot: b }) });
    return h("div", { className: "hb-root" }, content, screenBot && route.view !== "chat" ? h("div", { className: "hb-screen-overlay" }, h(ScreenPanel, { bot: screenBot, onClose: () => setScreenBot(null) })) : null, sheet?.type === "create" ? h(CreateBotSheet, { onClose: () => setSheet(null), onCreated: refresh }) : null, sheet?.type === "settings" ? h(SettingsSheet, { bot: sheet.bot, onClose: () => setSheet(null), onSaved: async () => { await refresh(); setSheet(null); } }) : null, sheet?.type === "edit" ? h(CreateBotSheet, { onClose: () => setSheet(null), onCreated: refresh }) : null);
  }

  window.__HERMES_PLUGINS__.register(PLUGIN, BotsPage);
  if (typeof window.__HERMES_PLUGINS__.registerSlot === "function") window.__HERMES_PLUGINS__.registerSlot(PLUGIN, "chat:top", ({}) => null);
})();
