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
  const CURRENT_RELEASE = "0.5.0-rc.1";
  const CURRENT_ENTRY = "index-v054.js";
  const CURRENT_CSS = "style-v054.css";
  const INTERACTION_CORE = "interaction-core-v001.mjs";
  const BROWSER_FLOW_CORE = "browser-flow-v001.mjs";
  const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
  const TURBO_MODES = ["planning", "simulation", "autonomous"];
  const TURBO_LABELS = { planning: "Planificación Turbo", simulation: "Simulación Turbo", autonomous: "Turbo Autónomo" };
  const TURBO_CAPABILITIES = { planning: ["read", "plan", "explain"], simulation: ["read", "plan", "explain", "prepare"], autonomous: ["read", "plan", "explain", "prepare", "confirm", "write"] };
  const turboModeAllows = (mode, capability) => Boolean(TURBO_CAPABILITIES[mode]?.includes(capability));
  const redactedAccount = (value) => String(value || "").replace(/(password|passwd|passphrase|token|secret|credential|authorization|api[_-]?key|private[_-]?key|connection[_-]?string|verification[_-]?code|mfa|otp|cvc|code|cookie)=?[^\s,;]+/gi, "$1=[REDACTED]").slice(0, 160);
  const attachmentKind = (type) => type.startsWith("image/") ? "image" : type.startsWith("audio/") ? "audio" : type.startsWith("video/") ? "video" : "document";
  function normalizeBrowserAttachment(file, source = "file") {
    const name = String(file?.name || "captura").trim(); const type = String(file?.type || "application/octet-stream").toLowerCase().split(";")[0]; const size = Number(file?.size || 0);
    if (!name || name.includes("/") || name.includes("\\") || /[\\u0000-\\u001f]/.test(name)) throw new Error("Nombre de archivo inválido.");
    if (!Number.isFinite(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) throw new Error("El adjunto supera el límite de 25 MB.");
    const extension = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    const expected = { pdf: "application/pdf", md: "text/markdown", markdown: "text/markdown", txt: "text/plain", csv: "text/csv", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav" }[extension];
    if (expected && type !== expected && type !== "application/octet-stream") throw new Error("El tipo MIME no coincide con la extensión.");
    if (!(type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/") || ["application/pdf", "text/plain", "text/markdown", "text/csv", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream"].includes(type))) throw new Error("Tipo MIME no permitido.");
    const id = `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return { id, name: name.slice(0, 240), type, size, kind: attachmentKind(type), source, file, preview: type.startsWith("image/") && typeof URL !== "undefined" ? URL.createObjectURL(file) : "", status: "ready" };
  }
  const attachmentPayload = (items) => (Array.isArray(items) ? items : []).map((item) => ({ id: item.id, profile: item.profile, name: item.name, type: item.type, size: item.size, kind: item.kind, source: item.source, status: item.status || "ready", ...(item.storage_key ? { storage_key: item.storage_key } : {}) })).filter((item) => item.id && item.name);
  const TURBO_SECRET_KEY_RE = /(?:password|passwd|passphrase|token|secret|cookie|credential|authorization|api[_-]?key|private[_-]?key|connection[_-]?string|verification[_-]?code|mfa|otp|cvc|data[_-]?url|base64|file[_-]?bytes|(?:^|[_-])code$)/i;
  const TURBO_SECRET_VALUE_RE = /(?:data:[^,;\s]+;base64,|(?:password|passwd|passphrase|token|secret|cookie|api[_-]?key|connection[_-]?string|verification[_-]?code|mfa|otp|cvc|code)\s*[:=])/i;
  const redactTurbo = (value) => { if (Array.isArray(value)) return value.map(redactTurbo); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, TURBO_SECRET_KEY_RE.test(key) || (typeof child === "string" && TURBO_SECRET_VALUE_RE.test(child)) ? "[REDACTED]" : redactTurbo(child)])); if (typeof value === "string" && TURBO_SECRET_VALUE_RE.test(value)) return "[REDACTED]"; return value; };
  const persistTurboState = (profile, state) => { try { localStorage.setItem(`hermes-bots-console.turbo.${profile}`, JSON.stringify(redactTurbo({ profile, mode: state.mode, grants: state.grants || [], audit: state.audit || [], updatedAt: Date.now() }))); } catch (_) {} };
  const loadTurboState = (profile) => { try { const value = JSON.parse(localStorage.getItem(`hermes-bots-console.turbo.${profile}`) || "null"); if (value?.profile === profile && TURBO_MODES.includes(value.mode)) return value; } catch (_) {} return { profile, mode: "planning", grants: [], updatedAt: 0 }; };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errText = (error) => String(error && error.message ? error.message : error);
  function screenRequest(rpc, method, params, timeout = 12000, signal) {
    return new Promise((resolve, reject) => {
      let expired = false;
      const abort = () => {
        if (expired) return;
        expired = true;
        try { rpc.close(); } catch (_) {}
        reject(screenLifecycleError("La operación del monitor fue cancelada.", "idle"));
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      const timer = window.setTimeout(() => {
        expired = true;
        signal?.removeEventListener("abort", abort);
        // A timed-out RPC remains in the Gateway's request queue unless its transport is
        // closed. Reusing that socket makes a slow display.start hold every later observe.
        try { rpc.close(); } catch (_) {}
        reject(new Error("El Gateway tardó demasiado en responder. Pulsá Reconectar."));
      }, timeout);
      rpc.request(method, params).then((value) => {
        if (expired) return;
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(value);
      }).catch((error) => {
        if (expired) return;
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
    });
  }
  function importWithTimeout(loader, timeout = 15000, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => { if (!settled) { settled = true; reject(screenLifecycleError("La carga del visor fue cancelada.", "idle")); } };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        reject(new Error("noVNC tardó demasiado en cargar. Pulsá Reconectar."));
      }, timeout);
      loader().then((value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(value);
      }).catch((error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
    });
  }
  const SCREEN_MIN_FREE_MEMORY_MB = 768;
  const SCREEN_DEFAULT_IDLE_STOP_MINUTES = 30;
  const SCREEN_STATES = new Set(["idle", "starting", "connecting", "live", "stopped", "blocked_low_memory", "error", "human_owned"]);
  const screenMemoryAvailable = (status) => {
    const value = status?.memory_available_mb ?? status?.memory?.available_mb ?? status?.resources?.memory_available_mb ?? status?.resources?.memory?.available_mb;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const screenMinimumMemory = (status) => {
    const value = status?.min_free_memory_mb ?? status?.memory?.min_free_memory_mb ?? status?.resources?.min_free_memory_mb;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : SCREEN_MIN_FREE_MEMORY_MB;
  };
  function screenResourceGate(status) {
    if (status?.lease?.holder === "human") return { allowed: true, state: "human_owned", reason: "Otra persona controla este escritorio; se mantiene la vista de solo lectura." };
    const blocker = String(status?.blocker || "");
    const available = screenMemoryAvailable(status);
    const minimum = screenMinimumMemory(status);
    const pressure = String(status?.memory_pressure ?? status?.resources?.memory_pressure ?? "").toLowerCase();
    const blocked = status?.resource_gate === "blocked_low_memory" || /low.?memory|not enough free memory|memoria insuficiente/i.test(blocker) || (available != null && available < minimum) || ["critical", "high", "danger"].includes(pressure);
    if (blocked) return { allowed: false, state: "blocked_low_memory", available, minimum, reason: blocker || `Memoria disponible insuficiente (${available ?? "desconocida"} MB; mínimo ${minimum} MB).` };
    return { allowed: true, state: status?.running ? "connecting" : "starting", available, minimum, reason: "" };
  }
  const screenIdleMinutes = (status) => {
    const value = Number(status?.idle_stop_minutes ?? status?.bot_desktop?.idle_stop_minutes);
    return Number.isFinite(value) && value > 0 ? value : SCREEN_DEFAULT_IDLE_STOP_MINUTES;
  };
  const screenStateLabel = (state) => ({ idle: "En espera", starting: "Iniciando", connecting: "Conectando", live: "En vivo", stopped: "Detenido", blocked_low_memory: "Memoria insuficiente", error: "Error", human_owned: "Control humano · solo lectura" }[state] || "Monitor");
  const screenLifecycleError = (message, state = "error") => { const error = new Error(message); error.screenState = state; return error; };
  const button = (label, onClick, cls, disabled) => h("button", { className: `hb-btn ${cls || ""}`, onClick, disabled, type: "button" }, label);
  const iconButton = (label, icon, onClick, cls, disabled) => h("button", { className: `hb-btn icon hb-icon-button ${cls || ""}`, onClick, disabled, type: "button", title: label, "aria-label": label }, icon);
  const monitorIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("rect", { x: "3", y: "4", width: "18", height: "12", rx: "1.8" }), h("path", { d: "M8 20h8M12 16v4" }));
  const microphoneIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("rect", { x: "8", y: "3", width: "8", height: "12", rx: "4" }), h("path", { d: "M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" }));
  const stopIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("rect", { x: "6", y: "6", width: "12", height: "12", rx: "2" }));
  const bellIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("path", { d: "M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" }));
  const closeIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("path", { d: "M6 6l12 12M18 6L6 18" }));
  const refreshIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("path", { d: "M20 11a8 8 0 1 0 1 5M20 5v6h-6" }));
  const fullscreenIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("path", { d: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" }));
  const arrowLeftIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("path", { d: "M14 5l-7 7 7 7" }));
  const arrowRightIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("path", { d: "M10 5l7 7-7 7" }));
  const keyboardIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("rect", { x: "3", y: "6", width: "18", height: "12", rx: "2" }), h("path", { d: "M6 10h1M9 10h1M12 10h1M15 10h1M6 14h8" }));
  const copyIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("rect", { x: "8", y: "8", width: "11", height: "12", rx: "2" }), h("path", { d: "M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" }));
  const clipboardIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("rect", { x: "6", y: "5", width: "12", height: "16", rx: "2" }), h("path", { d: "M9 5V3h6v2M9 10h6M9 14h6" }));
  const plusIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("path", { d: "M12 5v14M5 12h14" }));
  const searchIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("circle", { cx: "10.8", cy: "10.8", r: "6.5" }), h("path", { d: "m16 16 5 5" }));
  const editIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("path", { d: "m4 16 10.8-10.8a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3L8 20H4zM13 7l4 4" }));
  const dragIcon = () => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, h("path", { d: "M8 5h.01M8 12h.01M8 19h.01M16 5h.01M16 12h.01M16 19h.01" }));
  const profileLabel = (bot) => bot.display_name || bot.bot_title || bot.name;
  const DISPLAY_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,63}$/u;
  const profileIdFromDisplayName = (value) => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
  const saveProfileDisplayName = (profile, displayName) => fetchJSON(`${BASE}/api/plugins/${PLUGIN}/profiles/${encodeURIComponent(profile)}/display-name`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ display_name: displayName }) });
  const profileInitial = (bot) => profileLabel(bot).trim().slice(0, 1).toUpperCase() || "B";
  const avatarTone = (name) => {
    let n = 0;
    for (const ch of String(name || "bot")) n = (n * 31 + ch.charCodeAt(0)) % 360;
    return { background: `linear-gradient(135deg, hsl(${n} 72% 52%), hsl(${(n + 48) % 360} 72% 42%))` };
  };
  const VISUAL_META_KEY = "hermes-bots-console.visual-meta";
  const readVisualMeta = () => { try { const parsed = JSON.parse(localStorage.getItem(VISUAL_META_KEY) || "{}"); return parsed && typeof parsed === "object" ? parsed : {}; } catch (_) { return {}; } };
  const writeVisualMeta = (value) => { try { localStorage.setItem(VISUAL_META_KEY, JSON.stringify(value)); window.dispatchEvent(new CustomEvent("hermes-bots-visual-meta")); } catch (_) {} };
  const botMeta = (bot, meta = readVisualMeta()) => ({ ...(meta[bot.name] || {}), ...(bot || {}) });
  const visualAvatar = (bot, meta) => {
    const current = botMeta(bot, meta);
    if (current.avatar) return h("span", { className: "hb-avatar-image", style: { backgroundImage: `url(${current.avatar})` }, role: "img", "aria-label": profileLabel(bot) });
    return h(BotCharacter, { bot: current, size: "normal" });
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
  const LONG_PRESS_MS = 520;
  const MOVE_THRESHOLD_PX = 10;
  const botOrderKey = (name) => `bot:${name}`;
  const groupOrderKey = (id) => `group:${id}`;
  const normalizeOrderKeys = (saved, valid) => {
    const allowed = new Set(valid); const result = [];
    for (const raw of Array.isArray(saved) ? saved : []) {
      const value = String(raw || ""); const key = allowed.has(value) ? value : allowed.has(botOrderKey(value)) ? botOrderKey(value) : "";
      if (key && !result.includes(key)) result.push(key);
    }
    for (const key of valid) if (!result.includes(key)) result.push(key);
    return result;
  };
  const moveOrderKey = (saved, valid, from, to, after = false) => {
    if (!from || !to || from === to || !valid.includes(from) || !valid.includes(to)) return normalizeOrderKeys(saved, valid);
    const order = normalizeOrderKeys(saved, valid); const fromIndex = order.indexOf(from); const toIndex = order.indexOf(to);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return order;
    const next = [...order]; const [value] = next.splice(fromIndex, 1); const insertion = next.indexOf(to) + (after ? 1 : 0); next.splice(Math.max(0, insertion), 0, value); return next;
  };
  function useLongPressReorder({ disabled = false, onTap, onHoldStart, onHoldEnd, onHoldRelease, onDragStart, onDragMove, onDragEnd }) {
    const timerRef = useRef(null); const gestureRef = useRef(null); const touchCleanupRef = useRef(null);
    const clearTimer = useCallback(() => { if (timerRef.current) window.clearTimeout(timerRef.current); timerRef.current = null; }, []);
    const releaseTouchLock = useCallback(() => { touchCleanupRef.current?.(); touchCleanupRef.current = null; document.documentElement.classList.remove("hb-pointer-dragging"); }, []);
    const lockTouch = useCallback((pointerType) => {
      if (!(["touch", "pen"].includes(pointerType)) || touchCleanupRef.current) return;
      const preventScroll = (event) => { if (gestureRef.current?.holding) event.preventDefault(); };
      document.addEventListener("touchmove", preventScroll, { passive: false }); document.documentElement.classList.add("hb-pointer-dragging");
      touchCleanupRef.current = () => document.removeEventListener("touchmove", preventScroll);
    }, []);
    useEffect(() => () => { clearTimer(); releaseTouchLock(); gestureRef.current = null; }, [clearTimer, releaseTouchLock]);
    const finish = useCallback((event, cancelled = false) => {
      const gesture = gestureRef.current; if (!gesture || gesture.pointerId !== event.pointerId) return;
      clearTimer(); releaseTouchLock(); gestureRef.current = null;
      try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch (_) {}
      if (gesture.holding) onHoldEnd?.(event);
      if (cancelled) return;
      if (gesture.dragging) onDragEnd?.(event);
      else if (gesture.holding && !gesture.moved) onHoldRelease?.(event);
      else if (!gesture.moved) onTap?.(event);
    }, [clearTimer, onDragEnd, onHoldEnd, onHoldRelease, onTap, releaseTouchLock]);
    const onPointerDown = useCallback((event) => {
      if (disabled || (event.pointerType === "mouse" && event.button !== 0) || event.isPrimary === false) return;
      clearTimer(); releaseTouchLock();
      gestureRef.current = { pointerId: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY, holding: false, moved: false, dragging: false };
      try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch (_) {}
      timerRef.current = window.setTimeout(() => {
        const gesture = gestureRef.current;
        if (gesture?.pointerId === event.pointerId) { gesture.holding = true; lockTouch(gesture.pointerType); onHoldStart?.(event); }
      }, LONG_PRESS_MS);
    }, [clearTimer, disabled, lockTouch, onHoldStart, releaseTouchLock]);
    const onPointerMove = useCallback((event) => {
      const gesture = gestureRef.current; if (!gesture || gesture.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y);
      if (!gesture.holding && distance > MOVE_THRESHOLD_PX) { gesture.moved = true; clearTimer(); return; }
      if (gesture.holding) {
        event.preventDefault();
        if (distance > MOVE_THRESHOLD_PX) {
          if (!gesture.dragging) { gesture.dragging = true; onDragStart?.({ ...event, clientX: gesture.x, clientY: gesture.y }); }
          onDragMove?.(event);
        }
      }
    }, [clearTimer, onDragMove, onDragStart]);
    const onPointerUp = useCallback((event) => finish(event), [finish]);
    const onPointerCancel = useCallback((event) => finish(event, true), [finish]);
    return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
  }
  const SECURE_REQUEST_METHODS = new Set(["secret", "sudo", "vault.code", "vault.save_login", "vault.unlock_prompt"]);
  const routeFromLocation = () => {
    const q = new URLSearchParams(window.location.search);
    return { view: q.get("view") === "chat" ? "chat" : q.get("view") === "groups" ? "groups" : q.get("view") === "group" ? "group" : "roster", profile: q.get("profile") || "", session: q.get("session") || "", group: q.get("group") || "" };
  };
  const navigate = (route, replace = false) => {
    const q = new URLSearchParams();
    if (route.view && route.view !== "roster") q.set("view", route.view);
    if (route.profile) q.set("profile", route.profile);
    if (route.session) q.set("session", route.session);
    if (route.group) q.set("group", route.group);
    const next = `${BASE}/bots${q.toString() ? `?${q}` : ""}`;
    if (replace) window.history.replaceState({}, "", next);
    else window.history.pushState({}, "", next);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  class RpcClient {
    constructor(profile = "") { this.profile = profile; this.ws = null; this.connectPromise = null; this.connectReject = null; this.nextId = 1; this.pending = new Map(); this.listeners = new Map(); this.capabilitiesSent = false; }
    on(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(fn);
      return () => this.listeners.get(name)?.delete(fn);
    }
    emit(name, value) { for (const fn of this.listeners.get(name) || []) { try { fn(value); } catch (_) {} } }
    async connect() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      if (this.connectPromise) return this.connectPromise;
      const promise = (async () => {
        const url = await buildWsUrl("/api/ws", this.profile ? { profile: this.profile } : undefined);
        await new Promise((resolve, reject) => {
          const ws = new WebSocket(url);
          let settled = false;
          const fail = (error) => { if (settled) return; settled = true; if (this.connectReject === reject) this.connectReject = null; reject(error); };
          const succeed = () => { if (settled) return; settled = true; if (this.connectReject === reject) this.connectReject = null; resolve(); };
          this.connectReject = reject;
          this.ws = ws;
          this.capabilitiesSent = false;
          ws.onopen = () => { succeed(); this.emit("open"); };
          ws.onerror = () => fail(new Error("No se pudo abrir el Gateway WebSocket"));
          ws.onclose = () => {
            if (!settled) fail(new Error("Gateway WebSocket cerrado"));
            for (const item of this.pending.values()) item.reject(new Error("Gateway WebSocket cerrado"));
            this.pending.clear();
            if (this.ws === ws) this.ws = null;
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
      })();
      this.connectPromise = promise;
      try { return await promise; }
      finally { if (this.connectPromise === promise) this.connectPromise = null; this.connectReject = null; }
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
    close() {
      const error = new Error("Gateway WebSocket cerrado");
      this.connectReject?.(error);
      this.connectReject = null;
      for (const item of this.pending.values()) item.reject(error);
      this.pending.clear();
      this.capabilitiesSent = false;
      if (this.ws) this.ws.close();
      this.ws = null;
    }
  }

  async function transcribeAudioBlob(profile, blob, filename = "voice.webm") {
    const form = new FormData();
    form.append("file", blob, filename);
    // The visible plugin route is also documented as api/audio/transcribe for legacy Gateway clients.
    return fetchJSON(`${BASE}/api/plugins/${PLUGIN}/audio/transcribe?profile=${encodeURIComponent(profile)}`, { method: "POST", body: form, credentials: "same-origin" });
  }
  function blobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      if (!blob || typeof FileReader === "undefined") { reject(new Error("El navegador no puede preparar este adjunto.")); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("No se pudo leer el adjunto."));
      reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("El adjunto no tiene contenido válido."));
      reader.readAsDataURL(blob);
    });
  }
  async function attachBlobToGateway(rpc, profile, sessionId, descriptor, blob) {
    if (!sessionId || !blob) throw new Error(`No se pudo preparar ${descriptor?.name || "el adjunto"}.`);
    const dataUrl = await blobAsDataUrl(blob);
    const base64 = dataUrl.split(",", 2)[1] || "";
    if (!base64) throw new Error("El adjunto no tiene datos utilizables.");
    if (descriptor?.kind === "image" || String(descriptor?.type || "").startsWith("image/")) {
      return rpc.request("image.attach_bytes", { session_id: sessionId, profile, content_base64: base64, filename: descriptor.name });
    }
    // file.attach is the Gateway's declared generic path for PDFs and other
    // documents. Its ref is consumed internally by ChatSession; it is never
    // rendered as a local filesystem path in the conversation UI.
    return rpc.request("file.attach", { session_id: sessionId, profile, data_url: dataUrl, name: descriptor.name });
  }
  function safeMessageText(message) {
    if (message == null) return "";
    if (typeof message === "string") return message;
    if (Array.isArray(message)) return message.map(safeMessageText).join("\n");
    if (typeof message === "object") return String(message.text || message.content || message.display_content || "");
    return String(message);
  }
  function safeMarkdownUrl(value) {
    const url = String(value || "").trim();
    return /^(?:https?:|mailto:)/i.test(url) ? url : "";
  }
  function inlineMarkdown(text, prefix = "inline") {
    const source = String(text || "").replace(/<[^>]*>/g, "");
    const children = []; let rest = source; let index = 0;
    while (rest) {
      const match = rest.match(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*]+)\*|_([^_]+)_/);
      if (!match) { children.push(rest); break; }
      if (match.index > 0) { children.push(rest.slice(0, match.index)); rest = rest.slice(match.index); continue; }
      if (match[1] !== undefined) { const url = safeMarkdownUrl(match[2]); children.push(url ? h("img", { key: `${prefix}-${index++}`, src: url, alt: match[1], loading: "lazy" }) : match[1]); }
      else if (match[3] !== undefined) { const url = safeMarkdownUrl(match[4]); children.push(url ? h("a", { key: `${prefix}-${index++}`, href: url, target: "_blank", rel: "noopener noreferrer" }, match[3]) : match[3]); }
      else if (match[5] !== undefined || match[6] !== undefined) children.push(h("strong", { key: `${prefix}-${index++}` }, inlineMarkdown(match[5] || match[6], `${prefix}-strong`)));
      else if (match[7] !== undefined) children.push(h("code", { key: `${prefix}-${index++}` }, match[7]));
      else children.push(h("em", { key: `${prefix}-${index++}` }, match[8] || match[9]));
      rest = rest.slice(match[0].length);
    }
    return children;
  }
  function renderMarkdown(text) {
    const source = safeMessageText(text).replace(/\r\n?/g, "\n").replace(/<[^>]*>/g, "");
    const lines = source.split("\n"); const blocks = []; let index = 0; let blockId = 0;
    while (index < lines.length) {
      if (!lines[index].trim()) { index += 1; continue; }
      const fence = lines[index].match(/^\s*```\s*([\w-]*)\s*$/);
      if (fence) { const code = []; index += 1; while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) code.push(lines[index++]); if (index < lines.length) index += 1; blocks.push(h("details", { className: "hb-code", key: `code-${blockId++}` }, h("summary", null, fence[1] ? `Código · ${fence[1]}` : "Código"), h("pre", null, code.join("\n")))); continue; }
      const heading = lines[index].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) { const level = heading[1].length; blocks.push(h(`h${level}`, { key: `heading-${blockId++}` }, inlineMarkdown(heading[2]))); index += 1; continue; }
      if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[index])) {
        const ordered = /^\s*\d+[.)]\s+/.test(lines[index]); const items = []; while (index < lines.length && /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[index])) { items.push(h("li", { key: `item-${blockId}-${items.length}` }, inlineMarkdown(lines[index].replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "")))); index += 1; } blocks.push(h(ordered ? "ol" : "ul", { key: `list-${blockId++}` }, items)); continue;
      }
      if (/^\s*>/.test(lines[index])) { const quote = []; while (index < lines.length && /^\s*>/.test(lines[index])) { quote.push(lines[index].replace(/^\s*>\s?/, "")); index += 1; } blocks.push(h("blockquote", { key: `quote-${blockId++}` }, inlineMarkdown(quote.join("\n")))); continue; }
      if (lines[index].includes("|") && lines[index + 1]?.includes("---")) { const cells = (line) => line.split("|").map((value) => value.trim()).filter(Boolean); const headers = cells(lines[index]); const rows = []; index += 2; while (index < lines.length && lines[index].includes("|") && lines[index].trim()) { rows.push(cells(lines[index++])); } blocks.push(h("table", { className: "hb-markdown-table", key: `table-${blockId++}` }, h("thead", null, h("tr", null, headers.map((cell, cellIndex) => h("th", { key: `th-${cellIndex}` }, inlineMarkdown(cell))))), h("tbody", null, rows.map((row, rowIndex) => h("tr", { key: `tr-${rowIndex}` }, row.map((cell, cellIndex) => h("td", { key: `td-${rowIndex}-${cellIndex}` }, inlineMarkdown(cell)))))))); continue; }
      const paragraph = [lines[index++]]; while (index < lines.length && lines[index].trim() && !/^\s*(?:#{1,6}\s|```|[-*+]\s+|\d+[.)]\s+|>)/.test(lines[index])) paragraph.push(lines[index++]); blocks.push(h("p", { key: `p-${blockId++}` }, paragraph.map((line, lineIndex) => h(React.Fragment, { key: `${blockId}-${lineIndex}` }, lineIndex ? h("br") : null, inlineMarkdown(line, `p-${blockId}-${lineIndex}`)))));
    }
    return blocks;
  }
  function WorkingIndicator({ text, recoverable, stalled, onContinue, continuing }) {
    const interrupted = Boolean(recoverable || stalled);
    const label = interrupted ? (stalled ? 'Parece detenido.' : 'El trabajo se detuvo.') : 'Hermes decide automáticamente el orden de cada mensaje.';
    return h("div", { className: `hb-working ${interrupted ? "hb-working-recovery" : ""}`, role: "status", "aria-live": "polite" }, interrupted ? h("span", { className: "hb-recovery-dot", "aria-hidden": "true" }, "!") : h("span", { className: "hb-working-spinner", "aria-hidden": "true" }), h("span", { className: "hb-working-copy" }, h("span", null, interrupted ? "Necesita continuar" : text || "Pensando…"), h("small", null, label)), interrupted ? button(continuing ? "Reanudando…" : "Continuar", onContinue, "hb-continue-button", continuing) : null);
  }
  function MessageBubble({ message, profile }) {
    if (message.role === "tool") return h("div", { className: "hb-tool" }, h("span", { className: "hb-tool-dot" }, "•"), h("span", null, "Trabajando…"));
    if (message.role !== "user" && !message.text?.trim() && !message.streaming && !message.voice) return null;
    const attachmentView = Array.isArray(message.attachments) && message.attachments.length ? h("div", { className: "hb-message-attachments" }, message.attachments.map((attachment) => h("span", { className: "hb-message-attachment", key: attachment.id || attachment.name }, `${attachment.kind || "archivo"} · ${attachment.name}${attachment.status && attachment.status !== "ready" ? ` · ${attachment.status}` : ""}`))) : null;
    const voice = message.voice?.voice_id ? h("div", { className: "hb-message-voice" }, h("span", null, "Respuesta de voz"), h("audio", { controls: true, preload: "metadata", src: `${BASE}/api/plugins/${PLUGIN}/audio/${encodeURIComponent(message.voice.voice_id)}?profile=${encodeURIComponent(profile || "")}`, "aria-label": "Reproducir respuesta de voz" })) : null;
    return h("div", { className: `hb-message hb-chat-bubble ${message.role === "user" ? "user" : "assistant"}` }, h("div", { className: "hb-message-label" }, message.role === "user" ? "Tú" : "Hermes"), h("div", { className: "hb-message-body" }, renderMarkdown(message.text), attachmentView, voice), message.streaming ? h("span", { className: "hb-cursor", "aria-label": "respondiendo" }, "▋") : null);
  }

  async function waitForScreenReady(rpc, profile, timeout = 15000, signal) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const status = await screenRequest(rpc, "display.status", { profile }, 5000, signal);
        if (status?.running) return status;
      } catch (error) {
        lastError = error;
      }
      await sleep(350);
    }
    throw new Error(lastError ? `Bot Screen no respondió: ${errText(lastError)}` : "Bot Screen no inició a tiempo. Pulsá Reconectar.");
  }

  function ScreenPanel({ bot, onClose, inline = false, onExpand, autoAcquire = false, onControlComplete }) {
    const hostRef = useRef(null); const frameRef = useRef(null); const panelRef = useRef(null); const rpcRef = useRef(null); const rfbRef = useRef(null); const wsRef = useRef(null); const viewerRef = useRef(""); const reconnectTimerRef = useRef(null); const keyboardRef = useRef(null); const clipboardListenerRef = useRef(null); const tapTimerRef = useRef(null); const keyboardLockRef = useRef(null); const visualViewportCleanupRef = useRef(null); const modifierKeysRef = useRef(new Set()); const remoteRecorderRef = useRef(null); const remoteAudioChunksRef = useRef([]); const mobileModeRef = useRef(typeof window !== "undefined" && window.matchMedia?.("(max-width: 700px)").matches);
    const pointersRef = useRef(new Map()); const gestureRef = useRef({ mode: "none", moved: false, startX: 0, startY: 0, lastX: 0, lastY: 0, centerX: 0, centerY: 0, pinchDistance: 0, pinchZoom: 1, longPress: false, longPressTimer: null }); const zoomRef = useRef(1); const panRef = useRef({ x: 0, y: 0 }); const humanRef = useRef(false); const remoteMouseRef = useRef({ down: false, button: 0 }); const releaseInFlightRef = useRef(null); const startAbortRef = useRef(null); const startPromiseRef = useRef(null); const startedByConsoleRef = useRef(false); const idleTimerRef = useRef(null); const statusRef = useRef(null);
    const [status, setStatus] = useState(null); const [connection, setConnection] = useState("idle"); const [screenState, setScreenState] = useState("idle"); const [human, setHuman] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [zoom, setZoom] = useState(1); const [pan, setPan] = useState({ x: 0, y: 0 }); const [remoteClipboard, setRemoteClipboard] = useState(""); const [keyboardOpen, setKeyboardOpen] = useState(false); const [remoteVoiceState, setRemoteVoiceState] = useState("idle"); const [mobileMode, setMobileMode] = useState(() => mobileModeRef.current); const [fullscreen, setFullscreen] = useState(false); const [screenVisible, setScreenVisible] = useState(!inline);
    statusRef.current = status;
    const getRpc = useCallback(() => { if (!rpcRef.current) rpcRef.current = new RpcClient(bot.name); return rpcRef.current; }, [bot.name]);
    const setHumanLease = useCallback((value) => { humanRef.current = value; setHuman(value); }, []);
    useEffect(() => {
      const media = window.matchMedia?.("(max-width: 700px)"); if (!media) return undefined;
      const update = () => { const isMobile = media.matches; mobileModeRef.current = isMobile; setMobileMode(isMobile); if (rfbRef.current) { rfbRef.current.focusOnClick = !isMobile; rfbRef.current.hideCursor = isMobile; } };
      update(); media.addEventListener?.("change", update); return () => media.removeEventListener?.("change", update);
    }, []);
    useEffect(() => { const update = () => setFullscreen(document.fullscreenElement === panelRef.current); document.addEventListener("fullscreenchange", update); return () => document.removeEventListener("fullscreenchange", update); }, []);
    useEffect(() => {
      if (!inline) return undefined;
      const node = panelRef.current;
      if (!node || typeof IntersectionObserver === "undefined") { setScreenVisible(true); return undefined; }
      const observer = new IntersectionObserver((entries) => setScreenVisible(Boolean(entries[0]?.isIntersecting)), { threshold: 0.15 });
      observer.observe(node);
      return () => observer.disconnect();
    }, [inline]);
    const toggleFullscreen = useCallback(async () => { try { if (document.fullscreenElement) { await document.exitFullscreen?.(); return; } const panel = panelRef.current; if (!panel?.requestFullscreen) throw new Error("fullscreen-unavailable"); await panel.requestFullscreen(); } catch (e) { setError("El navegador no permite pantalla completa en este momento."); } }, []);
    const openExpanded = useCallback((takeControl = false) => { if (onExpand) { onExpand({ takeControl }); return; } void toggleFullscreen(); }, [onExpand, toggleFullscreen]);
    const clampPan = useCallback((value, nextZoom) => {
      const frame = frameRef.current; const canvas = hostRef.current?.querySelector("canvas"); if (!frame) return value;
      const currentZoom = zoomRef.current; const rect = canvas?.getBoundingClientRect(); const baseWidth = canvas?.offsetWidth || (rect?.width ? rect.width / currentZoom : frame.clientWidth); const baseHeight = canvas?.offsetHeight || (rect?.height ? rect.height / currentZoom : frame.clientHeight);
      const maxX = Math.max(0, (baseWidth * nextZoom - frame.clientWidth) / 2); const maxY = Math.max(0, (baseHeight * nextZoom - frame.clientHeight) / 2);
      return { x: Math.max(-maxX, Math.min(maxX, value.x)), y: Math.max(-maxY, Math.min(maxY, value.y)) };
    }, []);
    const resetViewport = useCallback(() => { zoomRef.current = 1; panRef.current = { x: 0, y: 0 }; setZoom(1); setPan({ x: 0, y: 0 }); }, []);
    const setViewportZoom = useCallback((requested, clientX, clientY, extraPan = { x: 0, y: 0 }) => {
      const frame = frameRef.current; const previous = zoomRef.current; const next = Math.max(1, Math.min(4, requested));
      if (!frame) return;
      const rect = frame.getBoundingClientRect(); const originX = rect.width / 2; const originY = rect.height / 2;
      const pointerX = Number.isFinite(clientX) ? clientX - rect.left - originX : 0; const pointerY = Number.isFinite(clientY) ? clientY - rect.top - originY : 0;
      const current = panRef.current; const nextPan = clampPan({ x: pointerX - (pointerX - current.x) * next / previous + extraPan.x, y: pointerY - (pointerY - current.y) * next / previous + extraPan.y }, next);
      zoomRef.current = next; panRef.current = nextPan; setZoom(next); setPan(nextPan);
    }, [clampPan]);
    const canvasClientPoint = useCallback((clientX, clientY) => {
      const canvas = hostRef.current?.querySelector("canvas"); if (!canvas) return null;
      const currentZoom = zoomRef.current; const transformed = canvas.getBoundingClientRect();
      if (clientX < transformed.left || clientX > transformed.right || clientY < transformed.top || clientY > transformed.bottom) return null;
      return { clientX: transformed.left + (clientX - transformed.left) / currentZoom, clientY: transformed.top + (clientY - transformed.top) / currentZoom };
    }, []);
    const dispatchRemoteMouse = useCallback((type, clientX, clientY, buttons = 0, button = 0) => {
      const canvas = hostRef.current?.querySelector("canvas"); const point = canvasClientPoint(clientX, clientY); if (!canvas || !point || !humanRef.current) return false;
      canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: point.clientX, clientY: point.clientY, buttons, button })); return true;
    }, [canvasClientPoint]);
    const remoteMouseDown = useCallback((clientX, clientY, button = 0) => { const buttons = button === 2 ? 2 : 1; if (dispatchRemoteMouse("mousedown", clientX, clientY, buttons, button)) { remoteMouseRef.current = { down: true, button }; } }, [dispatchRemoteMouse]);
    const remoteMouseUp = useCallback((clientX, clientY) => { if (!remoteMouseRef.current.down) return; dispatchRemoteMouse("mouseup", clientX, clientY, 0, remoteMouseRef.current.button); remoteMouseRef.current = { down: false, button: 0 }; }, [dispatchRemoteMouse]);
    const remoteMouseMove = useCallback((clientX, clientY) => { dispatchRemoteMouse("mousemove", clientX, clientY, remoteMouseRef.current.down ? 1 : 0, remoteMouseRef.current.button); }, [dispatchRemoteMouse]);
    const acquireLease = useCallback(async () => {
      if (!viewerRef.current || humanRef.current) return humanRef.current;
      try { const r = await screenRequest(getRpc(), "display.lease.acquire", { profile: bot.name, viewer_id: viewerRef.current, reason: "mobile-console" }); setHumanLease(true); setStatus((s) => ({ ...(s || {}), lease: r.lease })); if (rfbRef.current) rfbRef.current.viewOnly = false; return true; }
      catch (e) { setError(errText(e)); return false; }
    }, [bot.name, getRpc, setHumanLease]);
    const releaseLease = useCallback(async () => {
      if (!humanRef.current || !viewerRef.current) return null;
      if (releaseInFlightRef.current) return releaseInFlightRef.current;
      const run = (async () => {
        const result = await screenRequest(getRpc(), "display.lease.release", { profile: bot.name, viewer_id: viewerRef.current });
        setHumanLease(false); setStatus((s) => ({ ...(s || {}), lease: result.lease })); if (rfbRef.current) rfbRef.current.viewOnly = true;
        return result;
      })();
      releaseInFlightRef.current = run;
      try { return await run; } finally { if (releaseInFlightRef.current === run) releaseInFlightRef.current = null; }
    }, [bot.name, getRpc, setHumanLease]);
    const cleanup = useCallback(() => {
      if (idleTimerRef.current) { window.clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
      try { if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current); } catch (_) {}
      try { if (tapTimerRef.current) window.clearTimeout(tapTimerRef.current); } catch (_) {}
      try { if (gestureRef.current.longPressTimer) window.clearTimeout(gestureRef.current.longPressTimer); } catch (_) {}
      try { if (remoteRecorderRef.current && remoteRecorderRef.current.state === "recording") remoteRecorderRef.current.stop(); } catch (_) {}
      remoteRecorderRef.current = null; remoteAudioChunksRef.current = []; setRemoteVoiceState("idle");
      remoteMouseRef.current = { down: false, button: 0 };
      visualViewportCleanupRef.current?.(); visualViewportCleanupRef.current = null;
      const lock = keyboardLockRef.current; if (lock) { const body = document.body; const root = document.documentElement; body.style.position = lock.body.position; body.style.top = lock.body.top; body.style.width = lock.body.width; body.style.overflow = lock.body.overflow; root.style.overscrollBehavior = lock.rootOverscroll; window.scrollTo(0, lock.scrollY); keyboardLockRef.current = null; }
      setKeyboardOpen(false);
      try { if (rfbRef.current && clipboardListenerRef.current) rfbRef.current.removeEventListener("clipboard", clipboardListenerRef.current); } catch (_) {}
      try { rfbRef.current?.disconnect(); } catch (_) {} try { wsRef.current?.close(); } catch (_) {}
      rfbRef.current = null; wsRef.current = null; clipboardListenerRef.current = null; pointersRef.current.clear(); setHumanLease(false); setConnection("idle"); setScreenState("idle"); resetViewport();
      if (hostRef.current) hostRef.current.replaceChildren();
    }, [resetViewport, setHumanLease]);
    const refresh = useCallback(async () => { try { setStatus(await getRpc().request("display.status", { profile: bot.name })); setError(""); } catch (e) { setError(errText(e)); } }, [bot.name, getRpc]);
    const dispatchTap = useCallback((clientX, clientY) => { remoteMouseDown(clientX, clientY, 0); remoteMouseUp(clientX, clientY); }, [remoteMouseDown, remoteMouseUp]);
    const cancelTap = useCallback(() => { if (tapTimerRef.current) { window.clearTimeout(tapTimerRef.current); tapTimerRef.current = null; } }, []);
    const scheduleTap = useCallback((clientX, clientY) => { cancelTap(); tapTimerRef.current = window.setTimeout(() => { tapTimerRef.current = null; dispatchTap(clientX, clientY); }, 320); }, [cancelTap, dispatchTap]);
    const beginTwoFingerCamera = useCallback(() => {
      const points = [...pointersRef.current.values()]; if (points.length < 2) return;
      cancelTap(); if (gestureRef.current.longPressTimer) window.clearTimeout(gestureRef.current.longPressTimer); if (remoteMouseRef.current.down) remoteMouseUp(points[0].x, points[0].y);
      const centerX = (points[0].x + points[1].x) / 2; const centerY = (points[0].y + points[1].y) / 2;
      gestureRef.current.mode = "twoFingerPan"; gestureRef.current.moved = true; gestureRef.current.centerX = centerX; gestureRef.current.centerY = centerY; gestureRef.current.pinchDistance = Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)); gestureRef.current.pinchZoom = zoomRef.current;
    }, [cancelTap, remoteMouseUp]);
    const handlePointerDown = useCallback((event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointersRef.current.size === 1) {
        gestureRef.current = { mode: "remoteMouse", moved: false, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, centerX: event.clientX, centerY: event.clientY, pinchDistance: 0, pinchZoom: zoomRef.current, longPress: false, longPressTimer: window.setTimeout(() => { gestureRef.current.longPress = true; }, 650) };
      } else if (pointersRef.current.size === 2) beginTwoFingerCamera();
    }, [beginTwoFingerCamera]);
    const handlePointerMove = useCallback((event) => {
      if (!pointersRef.current.has(event.pointerId)) return; event.preventDefault(); pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); const points = [...pointersRef.current.values()];
      if (points.length >= 2) {
        if (gestureRef.current.mode !== "twoFingerPan") beginTwoFingerCamera();
        const centerX = (points[0].x + points[1].x) / 2; const centerY = (points[0].y + points[1].y) / 2; const distance = Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y));
        const deltaX = centerX - gestureRef.current.centerX; const deltaY = centerY - gestureRef.current.centerY; const pinch = gestureRef.current.pinchZoom * distance / gestureRef.current.pinchDistance;
        setViewportZoom(pinch, centerX, centerY, { x: deltaX, y: deltaY }); gestureRef.current.centerX = centerX; gestureRef.current.centerY = centerY; return;
      }
      if (points.length !== 1 || gestureRef.current.mode !== "remoteMouse") return;
      const distance = Math.hypot(event.clientX - gestureRef.current.startX, event.clientY - gestureRef.current.startY);
      if (distance > 8) { gestureRef.current.moved = true; if (gestureRef.current.longPressTimer) window.clearTimeout(gestureRef.current.longPressTimer); }
      if (gestureRef.current.longPress && distance > 8 && !remoteMouseRef.current.down) remoteMouseDown(event.clientX, event.clientY, 0);
      remoteMouseMove(event.clientX, event.clientY);
    }, [beginTwoFingerCamera, remoteMouseDown, remoteMouseMove, setViewportZoom]);
    const handlePointerUp = useCallback((event) => {
      if (!pointersRef.current.has(event.pointerId)) return; event.preventDefault(); const wasSingle = pointersRef.current.size === 1; const gesture = gestureRef.current; pointersRef.current.delete(event.pointerId);
      if (gesture.longPressTimer) window.clearTimeout(gesture.longPressTimer);
      if (!wasSingle || gesture.mode === "twoFingerPan") { if (!pointersRef.current.size) gestureRef.current.mode = "none"; return; }
      if (remoteMouseRef.current.down) remoteMouseUp(event.clientX, event.clientY);
      if (!gesture.moved) { if (gesture.longPress) { remoteMouseDown(event.clientX, event.clientY, 2); remoteMouseUp(event.clientX, event.clientY); } else if (tapTimerRef.current) { cancelTap(); setViewportZoom(zoomRef.current > 1 ? 1 : 2, event.clientX, event.clientY); } else scheduleTap(event.clientX, event.clientY); }
      gestureRef.current.mode = "none";
    }, [cancelTap, dispatchTap, remoteMouseUp, scheduleTap, setViewportZoom]);
    const sendBrowserKey = useCallback((keysym, code) => { if (!rfbRef.current || !humanRef.current) return; rfbRef.current.sendKey(0xffe9, "AltLeft", true); rfbRef.current.sendKey(keysym, code, true); rfbRef.current.sendKey(keysym, code, false); rfbRef.current.sendKey(0xffe9, "AltLeft", false); }, []);
    const copyRemote = useCallback(async () => { if (!remoteClipboard) return; try { await navigator.clipboard.writeText(remoteClipboard); } catch (e) { setError(errText(e)); } }, [remoteClipboard]);
    const pasteLocal = useCallback(async () => { if (!rfbRef.current || !humanRef.current) return; try { rfbRef.current.clipboardPasteFrom(await navigator.clipboard.readText()); } catch (e) { setError(errText(e)); } }, []);
    const openKeyboard = useCallback(() => {
      if (!humanRef.current) return;
      const scrollY = window.scrollY || document.documentElement.scrollTop || 0; const body = document.body; const root = document.documentElement;
      keyboardLockRef.current = { scrollY, body: { position: body.style.position, top: body.style.top, width: body.style.width, overflow: body.style.overflow }, rootOverscroll: root.style.overscrollBehavior };
      body.style.position = "fixed"; body.style.top = `-${scrollY}px`; body.style.width = "100%"; body.style.overflow = "hidden"; root.style.overscrollBehavior = "none";
      const input = keyboardRef.current;
      if (input) { input.tabIndex = 0; try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); } }
      const keepViewport = () => window.scrollTo(0, scrollY); window.visualViewport?.addEventListener("resize", keepViewport); window.visualViewport?.addEventListener("scroll", keepViewport); visualViewportCleanupRef.current = () => { window.visualViewport?.removeEventListener("resize", keepViewport); window.visualViewport?.removeEventListener("scroll", keepViewport); };
      setKeyboardOpen(true); window.setTimeout(() => { if (keyboardRef.current && document.activeElement !== keyboardRef.current) { keyboardRef.current.tabIndex = 0; try { keyboardRef.current.focus({ preventScroll: true }); } catch (_) { keyboardRef.current.focus(); } } }, 80);
    }, []);
    const closeKeyboard = useCallback(() => {
      try { keyboardRef.current?.blur(); } catch (_) {}
      visualViewportCleanupRef.current?.(); visualViewportCleanupRef.current = null;
      const lock = keyboardLockRef.current; if (lock) { const body = document.body; const root = document.documentElement; body.style.position = lock.body.position; body.style.top = lock.body.top; body.style.width = lock.body.width; body.style.overflow = lock.body.overflow; root.style.overscrollBehavior = lock.rootOverscroll; window.scrollTo(0, lock.scrollY); keyboardLockRef.current = null; }
      setKeyboardOpen(false);
    }, []);
    const toggleKeyboard = useCallback(() => { if (keyboardOpen) closeKeyboard(); else openKeyboard(); }, [closeKeyboard, keyboardOpen, openKeyboard]);
    const sendKeyboardText = useCallback((text) => { if (!rfbRef.current || !humanRef.current) return; for (const character of [...text]) rfbRef.current.sendKey(character.codePointAt(0)); }, []);
    const handleKeyboardInput = useCallback((event) => { const text = event.currentTarget.value; if (text) sendKeyboardText(text); event.currentTarget.value = ""; }, [sendKeyboardText]);
    const keyboardSpecials = { Backspace: [0xff08, "Backspace"], Enter: [0xff0d, "Enter"], Tab: [0xff09, "Tab"], Escape: [0xff1b, "Escape"], ArrowUp: [0xff52, "ArrowUp"], ArrowDown: [0xff54, "ArrowDown"], ArrowLeft: [0xff51, "ArrowLeft"], ArrowRight: [0xff53, "ArrowRight"], Shift: [0xffe1, "ShiftLeft"], Control: [0xffe3, "ControlLeft"], Alt: [0xffe9, "AltLeft"], Meta: [0xffeb, "MetaLeft"] };
    const handleKeyboardKey = useCallback((event) => { const entry = keyboardSpecials[event.key]; if (entry && rfbRef.current && humanRef.current) { event.preventDefault(); if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) { modifierKeysRef.current.add(event.key); rfbRef.current.sendKey(entry[0], entry[1], true); } else rfbRef.current.sendKey(entry[0], entry[1]); } }, []);
    const handleKeyboardKeyUp = useCallback((event) => { const entry = keyboardSpecials[event.key]; if (!entry || !modifierKeysRef.current.has(event.key)) return; event.preventDefault(); modifierKeysRef.current.delete(event.key); if (rfbRef.current && humanRef.current) rfbRef.current.sendKey(entry[0], entry[1], false); }, []);
    const stopRemoteVoice = useCallback(() => { const recorder = remoteRecorderRef.current; if (recorder && recorder.state === "recording") recorder.stop(); }, []);
    const recordRemoteVoice = useCallback(async () => {
      if (remoteVoiceState === "recording") { stopRemoteVoice(); return; }
      if (!humanRef.current || !rfbRef.current || remoteVoiceState === "transcribing") return;
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setError("Este navegador no permite grabar audio aquí."); return; }
      setError("");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
        const mime = candidates.find((value) => typeof MediaRecorder.isTypeSupported !== "function" || MediaRecorder.isTypeSupported(value)) || "";
        const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        remoteAudioChunksRef.current = []; remoteRecorderRef.current = recorder;
        recorder.ondataavailable = (event) => { if (event.data?.size) remoteAudioChunksRef.current.push(event.data); };
        recorder.onerror = () => { stream.getTracks().forEach((track) => track.stop()); remoteRecorderRef.current = null; setRemoteVoiceState("idle"); setError("La grabación de audio remoto falló."); };
        recorder.onstop = async () => {
          stream.getTracks().forEach((track) => track.stop()); remoteRecorderRef.current = null; setRemoteVoiceState("transcribing");
          try {
            const blob = new Blob(remoteAudioChunksRef.current, { type: recorder.mimeType || mime || "audio/webm" });
            remoteAudioChunksRef.current = [];
            const result = await transcribeAudioBlob(bot.name, blob, "remote-voice.webm");
            const transcript = String(result?.transcript || "").trim(); if (!transcript) throw new Error("No se detectó voz en la grabación.");
            sendKeyboardText(transcript); setRemoteVoiceState("idle");
          } catch (error) { setRemoteVoiceState("idle"); setError(errText(error)); }
        };
        recorder.start(); setRemoteVoiceState("recording");
      } catch (error) { setRemoteVoiceState("idle"); setError(error?.name === "NotAllowedError" ? "Permiso de micrófono denegado. Habilítalo para este sitio." : errText(error)); }
    }, [bot.name, remoteVoiceState, sendKeyboardText, stopRemoteVoice]);
    const start = useCallback(async () => {
      if (startPromiseRef.current) return startPromiseRef.current;
      const controller = new AbortController(); startAbortRef.current = controller;
      const run = (async () => {
        setBusy(true); setError(""); setScreenState("connecting"); setConnection("connecting");
        const rpc = getRpc(); const request = (method, params, timeout = 12000) => screenRequest(rpc, method, params, timeout, controller.signal);
        try {
          if (humanRef.current && viewerRef.current) await releaseLease();
          const current = await request("display.status", { profile: bot.name }); setStatus(current);
          const gate = screenResourceGate(current);
          if (!current?.running) {
            if (!gate.allowed) throw screenLifecycleError(gate.reason, gate.state);
            setScreenState("starting"); await request("display.start", { profile: bot.name }, 30000); startedByConsoleRef.current = true; setStatus(await waitForScreenReady(rpc, bot.name, 15000, controller.signal));
          } else setScreenState(gate.state === "human_owned" ? "human_owned" : "connecting");
          const RFB = (await importWithTimeout(() => import(`${ASSET}/novnc/rfb.bundle.js`), 15000, controller.signal)).default; let lastError = null;
          for (let attempt = 0; attempt < 4; attempt++) {
            cleanup(); setConnection("connecting"); setScreenState("connecting");
            try {
              const observed = await request("display.observe", { profile: bot.name, viewer_id: viewerRef.current || undefined }); viewerRef.current = observed.viewer_id || viewerRef.current; setStatus(observed); if (!hostRef.current) throw screenLifecycleError("El panel del escritorio ya no está montado.", "idle");
              const observedHuman = observed?.lease?.holder === "human"; if (observedHuman) setScreenState("human_owned");
              const scheme = window.location.protocol === "https:" ? "wss:" : "ws:"; const wsUrl = new URL(`${scheme}//${window.location.host}${BASE}/api/display/ws`); wsUrl.searchParams.set("display_ticket", observed.ticket);
              await new Promise((resolve, reject) => { let settled = false; let rfb = null; const socket = new WebSocket(wsUrl); socket.binaryType = "arraybuffer"; wsRef.current = socket; const fail = (error) => { if (settled) return; settled = true; window.clearTimeout(timer); controller.signal.removeEventListener("abort", abort); try { rfb?.disconnect(); } catch (_) {} try { socket.close(); } catch (_) {} reject(error); }; const abort = () => fail(screenLifecycleError("La conexión del monitor fue cancelada.", "idle")); const timer = window.setTimeout(() => fail(new Error("El escritorio tardó demasiado en responder")), 12000); controller.signal.addEventListener("abort", abort, { once: true }); const connected = () => { if (settled) return; settled = true; window.clearTimeout(timer); controller.signal.removeEventListener("abort", abort); setConnection("live"); setScreenState(observedHuman ? "human_owned" : "live"); resolve(); }; socket.onerror = () => fail(new Error("No se pudo abrir el canal seguro del Bot Screen")); socket.onclose = (event) => { if (!settled) fail(new Error(`El canal del escritorio se cerró (${event.code}${event.reason ? `: ${event.reason}` : ""}) antes de mostrar la pantalla`)); else { setConnection("idle"); setScreenState("error"); } }; try { rfb = new RFB(hostRef.current, socket, { shared: true }); rfb.scaleViewport = true; rfb.resizeSession = false; rfb.focusOnClick = !mobileModeRef.current; rfb.showDotCursor = false; rfb.hideCursor = mobileModeRef.current; rfb.viewOnly = true; rfb.background = "transparent"; const clipboardListener = (event) => setRemoteClipboard(String(event.detail?.text || "")); clipboardListenerRef.current = clipboardListener; rfb.addEventListener("clipboard", clipboardListener); rfb.addEventListener("connect", connected); rfb.addEventListener("disconnect", () => { if (!settled) fail(new Error("noVNC desconectó el escritorio antes del primer frame")); }); rfbRef.current = rfb; } catch (error) { fail(error); } });
              return;
            } catch (error) { lastError = error; cleanup(); if (attempt < 3) await sleep(500 + attempt * 350); }
          }
          throw lastError || new Error("No se pudo conectar al Bot Screen");
        } catch (e) {
          if (e?.screenState === "blocked_low_memory") { setScreenState("blocked_low_memory"); setConnection("idle"); }
          else if (e?.screenState === "idle") { setScreenState("idle"); setConnection("idle"); }
          else { setScreenState("error"); setConnection("error"); }
          if (e?.screenState !== "idle") setError(errText(e));
          // A failed start/observe must not leave an idle Gateway socket behind. A
          // later retry creates a fresh profile-scoped RPC transport.
          if (e?.screenState !== "human_owned" && connection !== "live") { try { rpc.close(); } catch (_) {} }
        }
        finally { setBusy(false); }
      })();
      startPromiseRef.current = run;
      try { return await run; } finally { if (startPromiseRef.current === run) startPromiseRef.current = null; if (startAbortRef.current === controller) startAbortRef.current = null; }
    }, [bot.name, cleanup, getRpc, releaseLease]);
    useEffect(() => {
      if (!autoAcquire || inline || connection !== "live" || human) return undefined;
      let alive = true;
      void acquireLease().finally(() => { if (alive) onControlComplete?.(); });
      return () => { alive = false; };
    }, [acquireLease, autoAcquire, connection, human, inline, onControlComplete]);
    const takeOver = acquireLease;
    const handBack = useCallback(async () => { if (!viewerRef.current) return; setBusy(true); try { await releaseLease(); } catch (e) { setError(errText(e)); } finally { setBusy(false); } }, [releaseLease]);
    const stopOwnedDisplay = useCallback(async () => {
      if (!startedByConsoleRef.current || humanRef.current) return;
      try {
        const rpc = getRpc(); const current = await screenRequest(rpc, "display.status", { profile: bot.name });
        if (current?.lease?.holder === "human") { setScreenState("human_owned"); return; }
        if (current?.running) { const result = await screenRequest(rpc, "display.stop", { profile: bot.name, force: false }, 12000); setStatus(result); }
        startedByConsoleRef.current = false; setScreenState("stopped"); setConnection("idle");
      } catch (e) { if (/human|viewer_mismatch|control humano/i.test(errText(e))) setScreenState("human_owned"); else setError(errText(e)); }
    }, [bot.name, getRpc]);
    useEffect(() => {
      if (!inline) return undefined;
      if (screenVisible) {
        if (idleTimerRef.current) { window.clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
        viewerRef.current = ""; void start();
      } else {
        startAbortRef.current?.abort(); cleanup();
        const delay = screenIdleMinutes(statusRef.current) * 60 * 1000;
        idleTimerRef.current = window.setTimeout(() => { idleTimerRef.current = null; void stopOwnedDisplay(); }, delay);
      }
      return () => { if (screenVisible) { startAbortRef.current?.abort(); const release = humanRef.current && viewerRef.current ? releaseLease() : Promise.resolve(); void release.catch(() => {}).finally(() => cleanup()); } };
    }, [cleanup, inline, releaseLease, screenVisible, start, stopOwnedDisplay]);
    useEffect(() => {
      if (inline) return undefined;
      viewerRef.current = "";
      void start();
      return undefined;
    }, [inline, start]);
    useEffect(() => () => {
      startAbortRef.current?.abort();
      const release = humanRef.current && viewerRef.current ? releaseLease() : Promise.resolve();
      void release.catch(() => {}).finally(async () => { cleanup(); await stopOwnedDisplay(); rpcRef.current?.close(); });
    }, [bot.name, cleanup, releaseLease, stopOwnedDisplay]);
    const leaseControl = human ? button("Devolver control", handBack, "ghost", busy) : inline ? button("Tomar control", () => openExpanded(true), "primary", busy || connection !== "live" || screenState === "human_owned") : button("Tomar control", takeOver, "primary", busy || connection !== "live" || screenState === "human_owned");
    const retryControl = ["error", "blocked_low_memory", "stopped", "idle"].includes(screenState) ? button(screenState === "blocked_low_memory" ? "Reintentar cuando haya memoria" : "Reintentar monitor", start, "ghost", busy) : null;
    const stopControl = startedByConsoleRef.current && status?.running && screenState !== "human_owned" ? button("Detener pantalla", stopOwnedDisplay, "ghost", busy) : null;
    const screenIdentity = status?.desktop_name || status?.desktop || `hermes:${bot.name}`;
    const memoryAvailable = screenMemoryAvailable(status);
    const screenDetails = memoryAvailable == null ? `Identidad: ${screenIdentity}` : `Identidad: ${screenIdentity} · ${memoryAvailable} MB disponibles`;
    const closePanel = useCallback(async () => { try { await releaseLease(); } catch (_) {} onClose(); }, [onClose, releaseLease]);
    const transform = { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` };
    const mobileToolbar = h("div", { className: "hb-screen-mobile-toolbar" }, iconButton("Cerrar escritorio", closeIcon(), closePanel, "hb-screen-mobile-button"), h("div", { className: "hb-screen-mobile-title" }, monitorIcon(), h("span", null, `Ordenador de ${profileLabel(bot)}`)), iconButton(fullscreen ? "Salir de pantalla completa" : "Pantalla completa", fullscreenIcon(), toggleFullscreen, "hb-screen-mobile-button"), iconButton("Reconectar", refreshIcon(), start, "hb-screen-mobile-button", busy));
    const mobileControls = h("div", { className: "hb-screen-mobile-controls" }, h("div", { className: "hb-screen-control-group" }, iconButton("Atrás", arrowLeftIcon(), () => sendBrowserKey(0xff51, "ArrowLeft"), "hb-screen-mobile-button", !human || busy), iconButton("Adelante", arrowRightIcon(), () => sendBrowserKey(0xff53, "ArrowRight"), "hb-screen-mobile-button", !human || busy)), h("div", { className: "hb-screen-control-group" }, iconButton(keyboardOpen ? "Cerrar teclado" : "Teclado", keyboardIcon(), toggleKeyboard, "hb-screen-mobile-button", !human), iconButton(remoteVoiceState === "recording" ? "Detener audio remoto" : remoteVoiceState === "transcribing" ? "Transcribiendo audio remoto…" : "Grabar audio remoto", remoteVoiceState === "recording" ? stopIcon() : microphoneIcon(), recordRemoteVoice, `hb-screen-mobile-button ${remoteVoiceState === "recording" ? "voice-recording" : ""}`, !human || remoteVoiceState === "transcribing"), iconButton("Copiar", copyIcon(), copyRemote, "hb-screen-mobile-button", !remoteClipboard), iconButton("Pegar", clipboardIcon(), pasteLocal, "hb-screen-mobile-button", !human)));
    const placeholder = connection !== "live" ? h("div", { className: "hb-screen-placeholder" }, h("strong", null, screenStateLabel(screenState)), screenState === "blocked_low_memory" ? `No se inicia para proteger la máquina: ${error || "el Gateway indicó presión de memoria"}.` : screenState === "human_owned" ? "El escritorio sigue activo bajo control humano; esta vista no toma el lease." : screenState === "starting" || screenState === "connecting" || busy ? "Esperando respuesta del monitor…" : screenState === "stopped" || screenState === "idle" ? "La pantalla está detenida. Podés reintentar sin bloquear el chat." : error || "Revisa el estado y reintenta.", retryControl) : null;
    const frame = h("div", { className: "hb-screen-frame", ref: frameRef, onClickCapture: inline && !fullscreen ? () => openExpanded(false) : undefined, onKeyDown: inline && !fullscreen ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openExpanded(); } } : undefined, role: inline && !fullscreen ? "button" : undefined, tabIndex: inline && !fullscreen ? 0 : undefined, title: inline && !fullscreen ? "Abrir Bot Screen en pantalla completa" : undefined }, h("div", { className: "hb-screen-viewport", style: transform }, h("div", { className: "hb-screen-host", ref: hostRef, "aria-label": `Escritorio ${screenIdentity} de ${profileLabel(bot)}` })), placeholder, mobileMode && connection === "live" ? h("div", { className: "hb-screen-touch-layer", onPointerDown: handlePointerDown, onPointerMove: handlePointerMove, onPointerUp: handlePointerUp, onPointerCancel: handlePointerUp, onWheel: (event) => { if (event.ctrlKey) { event.preventDefault(); setViewportZoom(zoomRef.current + (event.deltaY < 0 ? .25 : -.25), event.clientX, event.clientY); } } }) : null, h("textarea", { ref: keyboardRef, className: "hb-screen-keyboard-input", "aria-label": "Teclado del escritorio remoto", onInput: handleKeyboardInput, onKeyDown: handleKeyboardKey, onKeyUp: handleKeyboardKeyUp, onBlur: () => window.setTimeout(() => { if (document.activeElement !== keyboardRef.current) closeKeyboard(); }, 80), inputMode: "text", autoCapitalize: "sentences", autoCorrect: "off", spellCheck: false }), mobileControls, h("div", { className: "hb-screen-desktop-bar" }, h("span", null, human ? "Control humano" : screenState === "human_owned" ? "Control humano · solo lectura" : "Solo lectura · bot en control"), h("span", null, `Zoom ${Math.round(zoom * 100)}%`), stopControl, button("Restablecer vista", resetViewport, "ghost")));
    return h("section", { className: `hb-card hb-screen-panel ${inline ? "is-inline" : ""}`, ref: panelRef, "data-screen-state": screenState, "data-profile": bot.name, "data-contextual-monitor": inline ? "true" : "false" }, mobileToolbar, h("div", { className: "hb-screen-state-row", role: "status", "aria-live": "polite" }, h("span", { className: `hb-screen-state hb-screen-state-${screenState}` }, screenStateLabel(screenState)), h("small", null, screenDetails)), leaseControl, h("div", { className: "hb-panel-heading hb-screen-desktop-heading" }, h(BotCharacter, { bot, size: "small" }), h("div", { className: "hb-bot-name" }, h("strong", null, profileLabel(bot)), h("span", null, screenDetails)), iconButton(fullscreen ? "Salir de pantalla completa" : "Pantalla completa", fullscreenIcon(), toggleFullscreen), inline ? null : iconButton("Cerrar monitor", closeIcon(), closePanel, "hb-screen-close-button")), error ? h("div", { className: "hb-error" }, error) : null, frame);
  }

  function SettingsSheet({ bot, onClose, onSaved, groups = [] }) {
    const meta = readVisualMeta(); const existing = meta[bot.name] || {};
    const [options, setOptions] = useState(null); const [skills, setSkills] = useState([]); const [tools, setTools] = useState([]); const [choice, setChoice] = useState("");
    const [displayName, setDisplayName] = useState(bot.display_name || bot.bot_title || profileLabel(bot)); const [description, setDescription] = useState(bot.description || ""); const [avatar, setAvatar] = useState(existing.avatar || "");
    const [pinned, setPinned] = useState(existing.pinned !== false && Boolean(existing.pinned)); const [groupId, setGroupId] = useState(existing.group_id || ""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
    const isChief = Boolean(bot.is_default);
    useEffect(() => { Promise.all([api.getModelOptions(bot.name), api.getSkills(bot.name), api.getToolsets(bot.name)]).then(([models, skillRows, toolRows]) => { setOptions(models); setSkills(skillRows || []); setTools(toolRows || []); if (models?.provider && models?.model) setChoice(`${models.provider}\0${models.model}`); }).catch((e) => setError(errText(e))); }, [bot.name]);
    const save = async () => {
      setBusy(true); setError("");
      try {
        const nextDisplayName = displayName.trim();
        if (!DISPLAY_NAME_RE.test(nextDisplayName)) throw new Error("El nombre visible debe tener hasta 64 caracteres, sin saltos de línea.");
        await saveProfileDisplayName(bot.name, nextDisplayName);
        if (description !== (bot.description || "") && api.updateProfileDescription) await api.updateProfileDescription(bot.name, description.trim());
        if (choice) { const [provider, model] = choice.split("\0"); await api.setProfileModel(bot.name, provider, model); }
        const nextMeta = { ...readVisualMeta(), [bot.name]: { ...(readVisualMeta()[bot.name] || {}), display_name: nextDisplayName, avatar: avatar.trim(), pinned, group_id: groupId || "" } };
        writeVisualMeta(nextMeta); await onSaved(nextMeta);
      } catch (e) { setError(errText(e)); } finally { setBusy(false); }
    };
    const toggleSkill = async (skill) => { setBusy(true); try { await api.toggleSkill(skill.name, !skill.enabled, bot.name); setSkills((rows) => rows.map((r) => r.name === skill.name ? { ...r, enabled: !r.enabled } : r)); } catch (e) { setError(errText(e)); } finally { setBusy(false); } };
    const toggleTool = async (tool) => { setBusy(true); try { await api.toggleToolset(tool.name, !tool.enabled, bot.name); setTools((rows) => rows.map((r) => r.name === tool.name ? { ...r, enabled: !r.enabled } : r)); } catch (e) { setError(errText(e)); } finally { setBusy(false); } };
    const providers = Array.isArray(options?.providers) ? options.providers : [];
    return h("div", { className: "hb-sheet-backdrop" }, h("section", { className: "hb-sheet hb-editor-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Editar bot", onClick: (e) => e.stopPropagation() },
      h("div", { className: "hb-panel-heading hb-editor-heading" }, h("div", null, h("span", { className: "hb-kicker" }, "PERFIL DEL BOT"), h("h2", null, "Editar bot"), h("p", { className: "hb-subtitle" }, profileLabel(bot))), button("Cerrar", onClose, "ghost")),
      h("div", { className: "hb-editor-identity" }, h("div", { className: "hb-editor-avatar" }, avatar ? h("span", { className: "hb-avatar-image", style: { backgroundImage: `url(${avatar})` } }) : h(BotCharacter, { bot, size: "large" })), h("div", null, h("strong", null, profileLabel(bot)), h("small", null, isChief ? "Chief of Staff · fijo en la primera posición" : "Perfil aislado de los demás bots"))),
      error ? h("div", { className: "hb-error" }, error) : null,
      h("div", { className: "hb-editor-grid" },
        h("label", { className: "hb-field" }, "Nombre visible", h("input", { className: "hb-input", value: displayName, onChange: (e) => setDisplayName(e.target.value), maxLength: 80 })),
        h("label", { className: "hb-field" }, "Avatar · URL de imagen", h("input", { className: "hb-input", value: avatar, onChange: (e) => setAvatar(e.target.value), placeholder: "https://…", inputMode: "url" })),
        h("label", { className: "hb-field hb-editor-wide" }, "Descripción", h("textarea", { className: "hb-textarea", value: description, rows: 3, onChange: (e) => setDescription(e.target.value), placeholder: "Qué función cumple este bot…" })),
        h("label", { className: "hb-field" }, "Grupo fijado", h("select", { className: "hb-select", value: groupId, onChange: (e) => setGroupId(e.target.value) }, h("option", { value: "" }, "Sin grupo"), groups.map((group) => h("option", { key: group.id, value: group.id }, group.name)))),
        h("label", { className: "hb-editor-toggle" }, h("input", { type: "checkbox", checked: pinned, onChange: (e) => setPinned(e.target.checked), disabled: isChief }), h("span", null, isChief ? "Chief fijado y bloqueado" : "Mostrar en la franja fijada")),
        h("div", { className: "hb-editor-wide hb-editor-actions" }, button(busy ? "Guardando…" : "Guardar cambios", save, "primary", busy), isChief ? h("small", null, "El Chief se puede editar, pero no se puede mover ni eliminar.") : null)
      ),
      h("details", { className: "hb-editor-advanced" }, h("summary", null, "Modelo, skills, herramientas y grants"), h("label", { className: "hb-field" }, "Modelo y proveedor", h("select", { className: "hb-select", value: choice, onChange: (e) => setChoice(e.target.value) }, h("option", { value: "" }, "Usar configuración del perfil"), providers.map((p) => h("optgroup", { key: p.slug, label: p.name || p.slug }, (p.models || []).map((m) => h("option", { key: `${p.slug}-${m}`, value: `${p.slug}\0${m}` }, m))))), h("div", { className: "hb-editor-columns" }, h("div", { className: "hb-field" }, h("label", null, "Skills (solo este perfil)"), h("div", { className: "hb-checklist" }, skills.map((s) => h("label", { className: "hb-check", key: s.name }, h("input", { type: "checkbox", checked: !!s.enabled, onChange: () => toggleSkill(s), disabled: busy }), h("span", null, s.name))))), h("div", { className: "hb-field" }, h("label", null, "Herramientas / toolsets"), h("div", { className: "hb-checklist" }, tools.map((t) => h("label", { className: "hb-check", key: t.name }, h("input", { type: "checkbox", checked: !!t.enabled, onChange: () => toggleTool(t), disabled: busy }), h("span", null, t.name))))))),
      )));
  }

  function CreateBotSheet({ onClose, onCreated }) {
    const [displayName, setDisplayName] = useState("");
    const [description, setDescription] = useState("");
    const [provider, setProvider] = useState("");
    const [model, setModel] = useState("");
    const [options, setOptions] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [confirming, setConfirming] = useState(false);
    useEffect(() => { api.getModelOptions().then(setOptions).catch(() => {}); }, []);
    const validate = () => {
      const cleanDisplayName = displayName.trim();
      if (!DISPLAY_NAME_RE.test(cleanDisplayName)) { setError("Usa un nombre visible de hasta 64 caracteres, con mayúsculas y espacios permitidos."); return null; }
      const profileId = profileIdFromDisplayName(cleanDisplayName);
      if (!profileId || profileId === "default") { setError("El nombre debe producir un identificador interno válido y no reservado."); return null; }
      setError(""); return { displayName: cleanDisplayName, profileId };
    };
    const review = () => { if (validate()) setConfirming(true); };
    const create = async () => {
      const identity = validate(); if (!identity) return;
      setBusy(true);
      try {
        await api.createProfile({ name: identity.profileId, clone_from: "default", description: description.trim(), provider: provider || undefined, model: model || undefined });
        try {
          await saveProfileDisplayName(identity.profileId, identity.displayName);
        } catch (displayError) {
          await onCreated();
          setError(`El bot ${identity.profileId} fue creado, pero no se pudo guardar el nombre visible: ${errText(displayError)}`);
          return;
        }
        await onCreated(); onClose();
      } catch (e) { setError(errText(e)); }
      finally { setBusy(false); }
    };
    const providers = Array.isArray(options?.providers) ? options.providers : [];
    const header = h("div", { className: "hb-panel-heading" }, h("div", null, h("h2", null, "Nuevo bot"), h("p", { className: "hb-subtitle" }, "Cada bot nace con la configuración operativa del Chief, pero conserva su perfil aislado.")), button("Cerrar", onClose, "ghost"));
    const providerField = h("label", { className: "hb-field" }, "Proveedor", h("select", { className: "hb-select", value: provider, onChange: (e) => { setProvider(e.target.value); setModel(""); setConfirming(false); } }, h("option", { value: "" }, "Configuración del Chief"), providers.map((p) => h("option", { key: p.slug, value: p.slug }, p.name || p.slug))));
    const modelField = provider ? h("label", { className: "hb-field" }, "Modelo", h("select", { className: "hb-select", value: model, onChange: (e) => { setModel(e.target.value); setConfirming(false); } }, h("option", { value: "" }, "Elegir modelo"), (providers.find((p) => p.slug === provider)?.models || []).map((m) => h("option", { key: m, value: m }, m)))) : null;
    const identityPreview = displayName.trim() ? profileIdFromDisplayName(displayName.trim()) || "—" : "Se genera al confirmar";
    const form = h("div", null,
      h("label", { className: "hb-field" }, "Nombre visible", h("input", { className: "hb-input", value: displayName, placeholder: "X Manager", onChange: (e) => { setDisplayName(e.target.value); setConfirming(false); }, autoFocus: true, maxLength: 64 })),
      h("small", { className: "hb-field-hint" }, `ID interno: ${identityPreview}`),
      h("label", { className: "hb-field" }, "Descripción", h("textarea", { className: "hb-textarea", value: description, rows: 3, placeholder: "Qué función cumple este bot…", onChange: (e) => { setDescription(e.target.value); setConfirming(false); } })),
      providerField,
      modelField,
      button("Revisar y confirmar", review, "primary", !displayName.trim())
    );
    const confirmation = h("div", { className: "hb-confirmation" }, h("strong", null, "Revisa antes de crear"), h("p", null, `Nombre visible: ${displayName.trim()}`), h("p", null, `ID interno: ${profileIdFromDisplayName(displayName.trim()) || "—"}`), h("p", null, description.trim() || "Sin descripción adicional"), h("p", null, `${provider || "Configuración del Chief"}${model ? ` · ${model}` : ""}`), h("div", { className: "hb-row-actions" }, button(busy ? "Creando…" : "Confirmar creación", create, "primary", busy), button("Volver a editar", () => setConfirming(false), "ghost", busy)));
    return h("div", { className: "hb-sheet-backdrop", role: "presentation" }, h("section", { className: "hb-sheet", role: "dialog", "aria-modal": "true", onClick: (e) => e.stopPropagation() }, header, error ? h("div", { className: "hb-error" }, error) : null, confirming ? confirmation : form));
  }

  function DeleteBotPrompt({ bot, busy, error, onClose, onConfirm }) {
    return h("div", { className: "hb-context-backdrop", role: "presentation", onClick: onClose },
      h("section", { className: "hb-context-menu", role: "dialog", "aria-modal": "true", "aria-label": `Eliminar ${profileLabel(bot)}`, onClick: (event) => event.stopPropagation() },
        h("strong", null, "Eliminar bot"),
        h("p", null, `¿Querés eliminar ${profileLabel(bot)}? Esta acción elimina su perfil y sus datos.`),
        error ? h("div", { className: "hb-error" }, error) : null,
        h("div", { className: "hb-row-actions" }, button("Cancelar", onClose, "ghost", busy), button(busy ? "Eliminando…" : "Confirmar eliminación", onConfirm, "danger", busy))
      )
    );
  }

  function BotCard({ bot, onChat, onScreen, onRequestDelete, onHoldStart, onHoldEnd, onReorderStart, onReorderMove, onReorderEnd, draggingKey, holdingKey, dragStyleFor, meta }) {
    const item = botMeta(bot, meta); const key = botOrderKey(bot.name);
    const gesture = useLongPressReorder({
      disabled: false,
      onTap: () => onChat(bot),
      onHoldStart: () => onHoldStart(key),
      onHoldEnd: () => onHoldEnd(key),
      onHoldRelease: bot.is_default ? undefined : () => onRequestDelete(bot),
      onDragStart: bot.is_default ? undefined : (event) => onReorderStart(key, event, "feed"),
      onDragMove: bot.is_default ? undefined : (event) => onReorderMove(key, event, "feed"),
      onDragEnd: () => onReorderEnd(),
    });
    return h("article", { className: `hb-bot-row ${bot.is_default ? "is-chief" : ""} ${holdingKey === key ? "is-pressing" : ""} ${draggingKey === key ? "is-dragging" : ""}`, style: draggingKey === key ? dragStyleFor?.(key, "feed") : undefined, role: "button", tabIndex: 0, "data-hb-reorder-key": key, "data-hb-reorder-zone": "feed", ...gesture, onKeyDown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onChat(bot); } } },
      h("div", { className: "hb-bot-row-avatar", "aria-hidden": "true" }, visualAvatar(item, meta)),
      h("div", { className: "hb-bot-row-copy" }, h("strong", null, profileLabel(item)), h("span", null, item.preview || item.description || (bot.is_default ? "Coordina la flota de Hermes." : "Listo para trabajar."))),
      onScreen ? h("button", { className: "hb-bot-row-screen", type: "button", title: `Abrir monitor de ${profileLabel(bot)}`, "aria-label": `Abrir monitor de ${profileLabel(bot)}`, onPointerDown: (event) => event.stopPropagation(), onClick: (event) => { event.stopPropagation(); onScreen?.(bot); } }, monitorIcon()) : null,
      h("time", null, item.last_activity || item.last_active_label || ""),
      bot.is_default ? h("span", { className: "hb-lock", title: "No se puede mover ni eliminar", "aria-label": "Chief fijo" }, "•") : null
    );
  }

  const nativeGroupRoomId = (profile, groupId) => `hermes-bots-${String(profile || "default").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 24)}-${String(groupId || "group").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 64)}`;
  const nativeGroupHandle = (profile) => String(profile || "bot").toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").slice(0, 64) || "bot";
  const nativeGroupCoordinator = (bots, profile, names = []) =>
    bots.find(bot => bot.name === profile) || bots.find(bot => bot.is_default) ||
    bots.find(bot => names.includes(bot.name)) || bots[0];
  const nativeGroupEventText = (event) => {
    const payload = event?.payload || {}; const actor = event?.actor?.display_name || event?.actor?.profile || event?.actor?.id || "El grupo";
    if (event?.kind === "message.user" || event?.kind === "message.member") return String(payload.text || "").trim();
    if (event?.kind === "turn.started") return `${actor} está trabajando…`;
    if (event?.kind === "turn.settled") return `${actor} terminó su ronda.`;
    if (event?.kind === "turn.failed") return `${actor} no pudo completar esta ronda.`;
    if (event?.kind === "turn.cancelled") return `${actor} canceló su ronda.`;
    if (event?.kind === "member.unavailable") return `${actor} no está disponible en este momento.`;
    if (event?.kind === "room.activity") return `Estado del grupo: ${String(payload.status || "actualizando")}.`;
    return "";
  };
  const nativeGroupActor = (event) => event?.actor?.display_name || event?.actor?.profile || event?.actor?.id || (event?.kind === "message.user" ? "Tú" : "Hermes");
  function GroupRoomEvent({ event }) {
    const text = nativeGroupEventText(event); if (!text) return null;
    const user = event.kind === "message.user"; const activity = !user && event.kind !== "message.member";
    const stamp = event.created_at ? new Date(Number(event.created_at) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    return h("article", { className: `hb-group-message ${user ? "user" : activity ? "activity" : "member"}` }, h("div", { className: "hb-group-message-meta" }, h("strong", null, nativeGroupActor(event)), stamp ? h("time", null, stamp) : null), h("p", null, text));
  }
  function GroupRoomView({ bots, groupId, profile }) {
    const [group, setGroup] = useState(null); const [room, setRoom] = useState(null); const [events, setEvents] = useState([]); const [driver, setDriver] = useState(null); const [capabilities, setCapabilities] = useState(null); const [draft, setDraft] = useState(""); const [phase, setPhase] = useState("loading"); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [coordinatorName, setCoordinatorName] = useState("");
    const rpcRef = useRef(null); const aliveRef = useRef(true); const cursorRef = useRef(0); const syncLockRef = useRef(false); const syncRoomRef = useRef(null); const threadRef = useRef("");
    const appendEvents = useCallback((incoming) => { if (!incoming?.length) return; setEvents((current) => { const map = new Map(current.map((event) => [event.event_id, event])); incoming.forEach((event) => { if (event?.event_id) map.set(event.event_id, event); }); return [...map.values()].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0)); }); }, []);
    useEffect(() => {
      aliveRef.current = true; let timer = null;
      const setup = async () => {
        try {
          if (!bots.length) { setPhase("loading"); return; }
          const config = await fetchJSON(`/api/plugins/${PLUGIN}/groups?profile=${encodeURIComponent(profile)}`); const row = (config.groups || []).find((item) => item.id === groupId);
          if (!row) throw new Error("No se encontró la configuración de este grupo.");
          const names = [...new Set((row.members || []).map((name) => String(name).trim().toLowerCase()).filter(Boolean))];
          if (names.length < 2 || names.length > 6) throw new Error("La sala nativa necesita entre 2 y 6 bots miembros.");
          const coordinator = nativeGroupCoordinator(bots, profile, names);
          if (!coordinator) throw new Error("No hay un perfil coordinador disponible.");
          const known = new Map(bots.map((bot) => [bot.name, bot])); const memberInputs = names.map((name) => ({ member_id: name, profile: name, handle: nativeGroupHandle(name), display_name: profileLabel(known.get(name) || { name }) }));
          const roomId = nativeGroupRoomId(profile, row.id); const threadId = `thread-${roomId}`;
          setGroup({ ...row, members: names }); setCoordinatorName(coordinator.name); threadRef.current = threadId; setPhase("connecting");
          const rpc = new RpcClient(coordinator.name); rpcRef.current = rpc;
          const caps = await screenRequest(rpc, "groups.capabilities", { profile: coordinator.name }, 8000); if (!caps?.driver || !Array.isArray(caps.methods) || !caps.methods.includes("groups.send")) throw new Error("El Gateway no tiene habilitado el driver nativo de grupos.");
          setCapabilities(caps);
          const { findNativeRoom, assertNativeRoomMembers } = await import(`${ASSET}/group-membership.mjs`);
          let nativeRoom = await findNativeRoom(roomId, ({limit, offset}) =>
            screenRequest(rpc, "groups.list", {profile: coordinator.name, limit, offset}, 8000));
          if (!nativeRoom) nativeRoom = (await screenRequest(rpc, "groups.create", { profile: coordinator.name, room_id: roomId, name: row.name, members: memberInputs }, 12000)).room;
          assertNativeRoomMembers(names, nativeRoom);
          setRoom(nativeRoom); setPhase("live");
          const sync = async () => {
            if (!aliveRef.current || syncLockRef.current || !rpcRef.current) return; syncLockRef.current = true;
            try {
              let since = cursorRef.current || null; let page;
              do { page = await screenRequest(rpc, "groups.log", { profile: coordinator.name, room_id: roomId, since_seq: since, limit: Math.min(200, caps.max_log_limit || 200) }, 8000); appendEvents(page.events || []); const next = Number(page.latest_seq || since || 0); if (next <= Number(since || 0) && !(page.events || []).length) break; since = next; } while (page?.has_more);
              cursorRef.current = Number(since || 0); const state = await screenRequest(rpc, "groups.state", { profile: coordinator.name, room_id: roomId }, 8000); if (state.room) setRoom(state.room); setDriver(state.driver_status || null); setError("");
            } catch (err) { if (aliveRef.current) setError(errText(err)); } finally { syncLockRef.current = false; }
          };
          syncRoomRef.current = sync; await sync(); timer = window.setInterval(sync, 1800);
        } catch (err) { if (aliveRef.current) { setPhase("error"); setError(errText(err)); } }
      };
      setup();
      return () => { aliveRef.current = false; if (timer) window.clearInterval(timer); syncRoomRef.current = null; try { rpcRef.current?.close(); } catch (_) {} rpcRef.current = null; };
    }, [appendEvents, bots, groupId, profile]);
    const send = useCallback(async () => {
      const text = draft.trim(); const currentRoom = room; const profile = coordinatorName; if (!text || !currentRoom || !profile || !rpcRef.current || busy) return; setDraft(""); setBusy(true); setError("");
      try { const eventId = `mobile-${Date.now()}-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`; const result = await screenRequest(rpcRef.current, "groups.send", { profile, room_id: currentRoom.room_id, event_id: eventId, payload: { thread_id: threadRef.current, text } }, 12000); if (result?.accepted === false) throw new Error("El grupo no aceptó el mensaje."); await syncRoomRef.current?.(); } catch (err) { setDraft((current) => current.trim() ? current : text); setError(errText(err)); } finally { setBusy(false); }
    }, [busy, coordinatorName, draft, room]);
    const stop = useCallback(async () => { if (!room || !coordinatorName || !rpcRef.current) return; setBusy(true); try { await screenRequest(rpcRef.current, "groups.stop", { profile: coordinatorName, room_id: room.room_id }, 12000); await syncRoomRef.current?.(); } catch (err) { setError(errText(err)); } finally { setBusy(false); } }, [coordinatorName, room]);
    const members = room?.members || group?.members || []; const working = Boolean(driver?.working); const pending = Array.isArray(driver?.pending_actions) && driver.pending_actions.length > 0;
    if (phase === "loading") return h("div", { className: "hb-group-room hb-card hb-info" }, "Cargando sala del grupo…");
    return h("div", { className: "hb-group-room" }, h("header", { className: "hb-group-room-header" }, button("‹", () => navigate({ view: "groups", profile }), "icon ghost"), h("div", { className: "hb-group-room-identity" }, h("div", { className: "hb-avatar", style: avatarTone(room?.name || group?.name || "Grupo") }, "G"), h("div", null, h("strong", null, room?.name || group?.name || "Grupo"), h("span", null, `${members.length} bots · ${working ? "trabajando…" : capabilities?.driver ? "driver nativo activo" : "sala nativa"}`))), h("div", { className: "hb-group-room-actions" }, pending ? h("span", { className: "hb-group-attention", role: "status" }, "Necesita tu decisión") : null, working ? button(busy ? "Deteniendo…" : "Detener", stop, "ghost", busy) : null)), error ? h("div", { className: "hb-error" }, error) : null, h("div", { className: "hb-group-member-strip", "aria-label": "Miembros del grupo" }, members.map((member) => h("span", { className: "hb-member", key: member.member_id || member.profile || member }, member.display_name || member.profile || member))), h("main", { className: "hb-group-messages", "aria-live": "polite" }, events.length ? events.map((event) => h(GroupRoomEvent, { event, key: event.event_id })) : h("div", { className: "hb-group-empty" }, h("strong", null, "Sala lista"), h("p", null, "Escribí una tarea. Los bots decidirán quién responde y podrán convocarse entre ellos."))), h("div", { className: "hb-group-composer-wrap" }, h("textarea", { className: "hb-group-composer", value: draft, placeholder: "Escribí una tarea para el grupo…", "aria-label": "Mensaje para el grupo", onChange: (event) => setDraft(event.target.value), onKeyDown: (event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent?.isComposing) { event.preventDefault(); send(); } } }), h("div", { className: "hb-group-composer-bar" }, h("span", { className: "hb-compose-hint" }, "Enter envía · Shift+Enter agrega una línea"), button(busy ? "Enviando…" : "Enviar al grupo", send, "primary", busy || !draft.trim() || phase !== "live"))));
  }

  function GroupsView({ bots, profile }) {
    const [groups, setGroups] = useState([]); const [selected, setSelected] = useState(null); const [draft, setDraft] = useState(""); const [members, setMembers] = useState([]); const [skills, setSkills] = useState([]); const [availableSkills, setAvailableSkills] = useState([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
    const load = useCallback(async () => { try { const r = await fetchJSON(`/api/plugins/${PLUGIN}/groups?profile=${encodeURIComponent(profile)}`); setGroups(r.groups || []); } catch (e) { setError(errText(e)); } }, [profile]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => { if (!selected) return; setMembers(selected.members || []); setSkills(selected.skills || []); Promise.all((selected.members || []).map((n) => api.getSkills(n).catch(() => []))).then((lists) => { const map = new Map(); lists.flat().forEach((s) => s?.name && map.set(s.name, s)); setAvailableSkills([...map.values()].sort((a, b) => a.name.localeCompare(b.name))); }); }, [selected]);
    const toggle = (list, value) => list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
    const create = async () => { if (!draft.trim()) return; try { const row = await fetchJSON(`/api/plugins/${PLUGIN}/groups?profile=${encodeURIComponent(profile)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: draft.trim(), members: [], skills: [] }) }); setDraft(""); await load(); setSelected(row); } catch (e) { setError(errText(e)); } };
    const save = async () => {
      if (!selected) return;
      setBusy(true); setError("");
      try {
        const { isMembershipChanged, findNativeRoom, assertNativeMembershipEditable } = await import(`${ASSET}/group-membership.mjs`);
        if (isMembershipChanged(selected.members || [], members)) {
          const coordinator = nativeGroupCoordinator(bots, profile, selected.members || []);
          if (!coordinator) throw new Error("No hay un perfil de Hermes disponible para verificar este grupo.");
          const rpc = new RpcClient(coordinator.name);
          let existingRoom;
          try {
            existingRoom = await findNativeRoom(nativeGroupRoomId(profile, selected.id), ({limit,offset}) =>
              screenRequest(rpc, "groups.list", {profile: coordinator.name, limit, offset}, 8000));
          } finally { try { rpc.close(); } catch (_) {} }
          assertNativeMembershipEditable(selected.members || [], members, existingRoom);
        }
        const row = await fetchJSON(`/api/plugins/${PLUGIN}/groups/${encodeURIComponent(selected.id)}?profile=${encodeURIComponent(profile)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: selected.name, members, skills }) });
        await Promise.all(bots.filter((b) => members.includes(b.name)).flatMap((b) => availableSkills.filter((s) => skills.includes(s.name)).map((s) => api.toggleSkill(s.name, true, b.name))));
        setSelected(row); await load();
      } catch (e) { setError(errText(e)); } finally { setBusy(false); }
    };
    return h("div", { className: "hb-groups-view" }, error ? h("div", { className: "hb-error" }, error) : null, h("section", { className: "hb-card group-create" }, h("div", null, h("strong", null, "Grupos de trabajo"), h("p", { className: "hb-subtitle" }, "Administración de miembros y skills; la sala nativa de Hermes sigue siendo la fuente del chat grupal.")), h("div", { className: "hb-row-actions" }, h("input", { className: "hb-input", value: draft, placeholder: "Ej. Investigación", onChange: (e) => setDraft(e.target.value) }), button("Crear grupo", create, "primary", !draft.trim()))), h("div", { className: "hb-group-grid" }, groups.map((g) => h("article", { className: `hb-card hb-group-card ${selected?.id === g.id ? "selected" : ""}`, key: g.id }, h("h3", null, g.name), h("p", null, `${(g.members || []).length} bots · ${(g.skills || []).length} skills aplicadas`), h("div", { className: "hb-member-list" }, (g.members || []).map((m) => h("span", { className: "hb-member", key: m }, m))), h("div", { className: "hb-row-actions" }, button("Abrir sala", () => navigate({ view: "group", group: g.id, profile }), "primary", (g.members || []).length < 2 || (g.members || []).length > 6), button("Administrar", () => setSelected(g), "ghost"))))), selected ? h("section", { className: "hb-card hb-group-editor" }, h("div", { className: "hb-panel-heading" }, h("h3", null, `Editar ${selected.name}`), button("Cerrar", () => setSelected(null), "ghost")), h("div", { className: "hb-field" }, h("label", null, "Miembros"), h("div", { className: "hb-checklist" }, bots.map((b) => h("label", { className: "hb-check", key: b.name }, h("input", { type: "checkbox", checked: members.includes(b.name), onChange: () => setMembers(toggle(members, b.name)) }), h("span", null, profileLabel(b))))), h("div", { className: "hb-field" }, h("label", null, "Skills del grupo · se aplican por perfil"), h("div", { className: "hb-checklist" }, availableSkills.map((s) => h("label", { className: "hb-check", key: s.name }, h("input", { type: "checkbox", checked: skills.includes(s.name), onChange: () => setSkills(toggle(skills, s.name)) }), h("span", null, s.name)))), h("p", { className: "hb-subtitle" }, "No se habilitan skills globales: la sala mobile usa el driver nativo de Hermes y conserva su historial como fuente de verdad."), button(busy ? "Aplicando…" : "Guardar y aplicar", save, "primary", busy)))) : null);
  }

  function RecentActivity({ bots }) {
    const [rows, setRows] = useState([]);
    useEffect(() => { let alive = true; Promise.all(bots.slice(0, 8).map(async (bot) => { try { const r = await fetchJSON(`/api/sessions?limit=3&order=recent&profile=${encodeURIComponent(bot.name)}`); return (r.sessions || []).map((s) => ({ ...s, profile: bot.name, label: profileLabel(bot) })); } catch (_) { return []; } })).then((lists) => alive && setRows(lists.flat().sort((a, b) => (b.last_active || b.started_at || 0) - (a.last_active || a.started_at || 0)).slice(0, 8))); return () => { alive = false; }; }, [bots]);
    if (!rows.length) return h("div", { className: "hb-empty-activity" }, "Cuando un bot tenga conversaciones, aparecerán aquí.");
    return h("div", { className: "hb-activity-list" }, rows.map((row) => h("button", { className: "hb-activity-row", type: "button", key: `${row.profile}-${row.id}`, onClick: () => navigate({ view: "chat", profile: row.profile, session: row.id }) }, h(BotCharacter, { bot: { name: row.profile, display_name: row.label }, size: "small" }), h("span", { className: "hb-activity-copy" }, h("strong", null, row.title || row.preview || "Conversación"), h("small", null, `${row.label} · ${row.message_count || 0} mensajes`)), h("span", { className: "hb-chevron" }, "›"))));
  }

  function PinBotItem({ bot, meta, onChat, onRequestDelete, onHoldStart, onHoldEnd, onReorderStart, onReorderMove, onReorderEnd, draggingKey, holdingKey, dragStyleFor }) {
    const key = botOrderKey(bot.name);
    const gesture = useLongPressReorder({
      disabled: false,
      onTap: () => onChat(bot),
      onHoldStart: () => onHoldStart(key),
      onHoldEnd: () => onHoldEnd(key),
      onHoldRelease: bot.is_default ? undefined : () => onRequestDelete(bot),
      onDragStart: bot.is_default ? undefined : (event) => onReorderStart(key, event, "pins"),
      onDragMove: bot.is_default ? undefined : (event) => onReorderMove(key, event, "pins"),
      onDragEnd: () => onReorderEnd(),
    });
    return h("div", { className: `hb-pin-item ${bot.is_default ? "is-chief" : ""} ${holdingKey === key ? "is-pressing" : ""} ${draggingKey === key ? "is-dragging" : ""}`, style: draggingKey === key ? dragStyleFor?.(key, "pins") : undefined, role: "button", tabIndex: 0, "data-hb-reorder-key": key, "data-hb-reorder-zone": "pins", ...gesture, onKeyDown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onChat(bot); } } },
      h("div", { className: "hb-pin-avatar", "aria-hidden": "true" }, visualAvatar(bot, meta)),
      h("span", null, profileLabel(bot)), bot.is_default ? h("small", null, "fijo") : h("span", { className: "hb-pin-drag", "aria-hidden": "true" }, dragIcon())
    );
  }

  function PinGroupItem({ group, onGroup, onHoldStart, onHoldEnd, onReorderStart, onReorderMove, onReorderEnd, draggingKey, holdingKey, dragStyleFor }) {
    const key = groupOrderKey(group.id);
    const gesture = useLongPressReorder({
      onTap: () => onGroup(group),
      onHoldStart: () => onHoldStart(key),
      onHoldEnd: () => onHoldEnd(key),
      onDragStart: (event) => onReorderStart(key, event, "pins"),
      onDragMove: (event) => onReorderMove(key, event, "pins"),
      onDragEnd: () => onReorderEnd(),
    });
    return h("div", { className: `hb-pin-item hb-pin-group ${holdingKey === key ? "is-pressing" : ""} ${draggingKey === key ? "is-dragging" : ""}`, style: draggingKey === key ? dragStyleFor?.(key, "pins") : undefined, role: "button", tabIndex: 0, "data-hb-reorder-key": key, "data-hb-reorder-zone": "pins", ...gesture, onKeyDown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onGroup(group); } } }, h("span", { className: "hb-pin-group-avatar", "aria-hidden": "true" }, "G"), h("span", null, group.name));
  }

  function PinStrip({ bots, groups, meta, onChat, onRequestDelete, onHoldStart, onHoldEnd, onGroup, onReorderStart, onReorderMove, onReorderEnd, draggingKey, holdingKey, dragStyleFor }) {
    const chief = bots.find((bot) => bot.is_default);
    const pinnedBots = bots.filter((bot) => !bot.is_default && meta[bot.name]?.pinned);
    const pinnedGroups = (groups || []).filter((group) => meta.__groups?.[group.id]?.pinned);
    const valid = [...pinnedBots.map((bot) => botOrderKey(bot.name)), ...pinnedGroups.map((group) => groupOrderKey(group.id))];
    const order = normalizeOrderKeys(meta.__order, valid);
    const rank = (key) => order.indexOf(key);
    const orderedBots = [...pinnedBots].sort((a, b) => rank(botOrderKey(a.name)) - rank(botOrderKey(b.name)));
    const orderedGroups = [...pinnedGroups].sort((a, b) => rank(groupOrderKey(a.id)) - rank(groupOrderKey(b.id)));
    return h("div", { className: "hb-pin-strip", "aria-label": "Bots y grupos fijados" },
      h("div", { className: "hb-pin-scroll", "data-hb-reorder-zone": "pins" },
        chief ? h(PinBotItem, { bot: chief, meta, onChat, onRequestDelete, onHoldStart, onHoldEnd, onReorderStart, onReorderMove, onReorderEnd, draggingKey, holdingKey, dragStyleFor }) : null,
        orderedBots.map((bot) => h(PinBotItem, { bot, meta, onChat, onRequestDelete, onHoldStart, onHoldEnd, onReorderStart, onReorderMove, onReorderEnd, draggingKey, holdingKey, dragStyleFor, key: bot.name })),
        orderedGroups.map((group) => h(PinGroupItem, { group, onGroup, onHoldStart, onHoldEnd, onReorderStart, onReorderMove, onReorderEnd, draggingKey, holdingKey, dragStyleFor, key: group.id }))
      )
    );
  }

  function RosterView({ bots, loading, error, onRefresh, onCreate, onEdit, onGroup, onScreen, profile }) {
    const [search, setSearch] = useState(""); const [searchOpen, setSearchOpen] = useState(false); const [meta, setMeta] = useState(readVisualMeta()); const [groups, setGroups] = useState([]); const [activity, setActivity] = useState({}); const [deleteTarget, setDeleteTarget] = useState(null); const [deleteBusy, setDeleteBusy] = useState(false); const [deleteError, setDeleteError] = useState(""); const [dragState, setDragState] = useState({ key: "", zone: "", offsetX: 0, offsetY: 0, shifts: {} }); const [holdingKey, setHoldingKey] = useState("");
    const dragRef = useRef({ key: "", zone: "", startX: 0, startY: 0 });
    useEffect(() => { const sync = () => setMeta(readVisualMeta()); window.addEventListener("hermes-bots-visual-meta", sync); return () => window.removeEventListener("hermes-bots-visual-meta", sync); }, []);
    useEffect(() => { let alive = true; fetchJSON(`/api/plugins/${PLUGIN}/groups?profile=${encodeURIComponent(profile)}`).then((result) => alive && setGroups(result.groups || [])).catch(() => {}); return () => { alive = false; }; }, [profile]);
    useEffect(() => { let alive = true; Promise.all(bots.map(async (bot) => { try { const result = await fetchJSON(`/api/sessions?limit=1&order=recent&min_messages=1&profile=${encodeURIComponent(bot.name)}`); const row = result.sessions?.[0]; return [bot.name, row ? { preview: row.preview || row.title || "Conversación reciente", last_activity: row.last_active ? new Date(Number(row.last_active) * 1000).toLocaleDateString([], { month: "short", day: "numeric" }) : "" } : {}]; } catch (_) { return [bot.name, {}]; } })).then((rows) => alive && setActivity(Object.fromEntries(rows))); return () => { alive = false; }; }, [bots]);
    const director = bots.find((bot) => bot.is_default); const pinned = new Set(bots.filter((bot) => !bot.is_default && meta[bot.name]?.pinned).map((bot) => bot.name));
    const filtered = bots.filter((bot) => !search || `${profileLabel(bot)} ${bot.description || ""}`.toLowerCase().includes(search.toLowerCase()));
    const baseRows = filtered.filter((bot) => !bot.is_default && !pinned.has(bot.name)).map((bot) => ({ ...bot, ...(activity[bot.name] || {}) }));
    const feedKeys = baseRows.map((bot) => botOrderKey(bot.name));
    const feedOrder = normalizeOrderKeys(meta.__order, feedKeys); const feedRank = (key) => feedOrder.indexOf(key);
    const rows = [...baseRows].sort((a, b) => feedRank(botOrderKey(a.name)) - feedRank(botOrderKey(b.name)));
    const pinKeys = [...bots.filter((bot) => !bot.is_default && meta[bot.name]?.pinned).map((bot) => botOrderKey(bot.name)), ...groups.filter((group) => meta.__groups?.[group.id]?.pinned).map((group) => groupOrderKey(group.id))];
    const allOrderKeys = [...feedKeys, ...pinKeys];
    const handleHoldStart = (key) => setHoldingKey(key);
    const handleHoldEnd = (key) => setHoldingKey((current) => current === key ? "" : current);
    const handleReorderStart = (key, event, zone) => { const x = Number(event?.clientX || 0); const y = Number(event?.clientY || 0); dragRef.current = { key, zone, startX: x, startY: y, offsetX: 0, offsetY: 0, targetKey: "", after: false, shifts: {} }; setHoldingKey(""); setDragState({ key, zone, offsetX: 0, offsetY: 0, shifts: {} }); };
    const handleReorderMove = (sourceKey, event, zone) => {
      const session = dragRef.current; const fromKey = sourceKey || session.key; if (!fromKey) return;
      const x = Number(event?.clientX || session.startX); const y = Number(event?.clientY || session.startY); const offsetX = x - session.startX; const offsetY = y - session.startY;
      const valid = zone === "pins" ? pinKeys : feedKeys; if (!valid.includes(fromKey)) return;
      const candidates = [...document.querySelectorAll("[data-hb-reorder-key]")].filter((node) => node.dataset.hbReorderZone === zone && node.dataset.hbReorderKey !== fromKey);
      if (!candidates.length) { setDragState({ key: fromKey, zone, offsetX, offsetY, shifts: {} }); return; }
      const coordinate = zone === "pins" ? x : y; let targetKey = ""; let after = false;
      for (const node of candidates) {
        const rect = node.getBoundingClientRect(); const midpoint = zone === "pins" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
        if (coordinate < midpoint) { targetKey = node.dataset.hbReorderKey; after = false; break; }
        targetKey = node.dataset.hbReorderKey; after = true;
      }
      const order = normalizeOrderKeys(meta.__order, allOrderKeys); const zoneSet = new Set(valid); const zoneOrder = order.filter((key) => zoneSet.has(key)); const moved = targetKey && targetKey !== fromKey ? moveOrderKey(zoneOrder, valid, fromKey, targetKey, after) : zoneOrder; const fromIndex = zoneOrder.indexOf(fromKey); const targetIndex = moved.indexOf(fromKey); const positions = new Map();
      for (const key of zoneOrder) { const node = [...document.querySelectorAll("[data-hb-reorder-key]")].find((candidate) => candidate.dataset.hbReorderKey === key && candidate.dataset.hbReorderZone === zone); if (node) { const rect = node.getBoundingClientRect(); const visualShift = key === fromKey ? (zone === "pins" ? session.offsetX : session.offsetY) : Number(session.shifts?.[key] || 0); positions.set(key, (zone === "pins" ? rect.left : rect.top) - visualShift); } }
      const shifts = {};
      if (fromIndex >= 0 && targetIndex >= 0 && fromIndex !== targetIndex) {
        for (let index = 0; index < zoneOrder.length; index += 1) {
          if (index === fromIndex || !positions.has(zoneOrder[index])) continue;
          if (fromIndex < targetIndex && index > fromIndex && index <= targetIndex) shifts[zoneOrder[index]] = positions.get(zoneOrder[index - 1]) - positions.get(zoneOrder[index]);
          if (targetIndex < fromIndex && index >= targetIndex && index < fromIndex) shifts[zoneOrder[index]] = positions.get(zoneOrder[index + 1]) - positions.get(zoneOrder[index]);
        }
      }
      dragRef.current = { ...session, key: fromKey, zone, offsetX, offsetY, targetKey, after, shifts }; setDragState({ key: fromKey, zone, offsetX, offsetY, shifts });
    };
    const handleReorderEnd = () => {
      const session = dragRef.current;
      if (session.key && session.targetKey) {
        const valid = session.zone === "pins" ? pinKeys : feedKeys; const order = normalizeOrderKeys(meta.__order, allOrderKeys); const zoneSet = new Set(valid); const zoneOrder = order.filter((key) => zoneSet.has(key)); const moved = moveOrderKey(zoneOrder, valid, session.key, session.targetKey, session.after); let index = 0; const next = order.map((key) => zoneSet.has(key) ? moved[index++] : key);
        if (!next.every((key, position) => key === order[position])) { const nextMeta = { ...readVisualMeta(), __order: next }; writeVisualMeta(nextMeta); setMeta(nextMeta); }
      }
      dragRef.current = { key: "", zone: "", startX: 0, startY: 0, offsetX: 0, offsetY: 0, targetKey: "", after: false, shifts: {} }; setHoldingKey(""); setDragState({ key: "", zone: "", offsetX: 0, offsetY: 0, shifts: {} });
    };
    const requestDelete = (bot) => { if (!bot || bot.is_default) return; setDeleteError(""); setDeleteTarget(bot); };
    const closeDelete = () => { if (!deleteBusy) { setDeleteTarget(null); setDeleteError(""); } };
    const confirmDelete = async () => {
      if (!deleteTarget || deleteTarget.is_default || deleteBusy) return;
      setDeleteBusy(true); setDeleteError("");
      try {
        if (typeof api.deleteProfile !== "function") throw new Error("Hermes no expone la eliminación de perfiles en esta sesión.");
        await api.deleteProfile(deleteTarget.name);
        const nextMeta = { ...readVisualMeta(), __order: (Array.isArray(readVisualMeta().__order) ? readVisualMeta().__order : []).filter((key) => key !== deleteTarget.name && key !== botOrderKey(deleteTarget.name)) }; delete nextMeta[deleteTarget.name];
        writeVisualMeta(nextMeta); setMeta(nextMeta); setDeleteTarget(null); await onRefresh();
      } catch (e) { setDeleteError(errText(e)); } finally { setDeleteBusy(false); }
    };
    const dragStyleFor = (key, zone) => {
      if (!dragState.key || dragState.zone !== zone) return undefined;
      if (dragState.key === key) return { transform: `translate3d(${zone === "pins" ? dragState.offsetX : 0}px, ${zone === "feed" ? dragState.offsetY : 0}px, 0)`, zIndex: 20, transition: "none" };
      const shift = Number(dragState.shifts?.[key] || 0); if (!shift) return undefined;
      return { transform: `translate3d(${zone === "pins" ? shift : 0}px, ${zone === "feed" ? shift : 0}px, 0)`, transition: "transform 160ms ease" };
    };
    const headerSearch = searchOpen ? h("label", { className: "hb-roster-search" }, searchIcon(), h("input", { autoFocus: true, value: search, placeholder: "Buscar", "aria-label": "Buscar bots", onChange: (event) => setSearch(event.target.value) })) : iconButton("Buscar bots", searchIcon(), () => setSearchOpen(true), "hb-round-action");
    return h("div", { className: "hb-roster-screen" },
      h("header", { className: "hb-roster-header" }, h("div", { className: "hb-user-mark", "aria-label": "Perfil de Franco" }, "F"), h("div", { className: "hb-roster-actions" }, headerSearch, iconButton("Crear bot", plusIcon(), onCreate, "hb-round-action"))),
      h(PinStrip, { bots, groups, meta, onChat: (bot) => navigate({ view: "chat", profile: bot.name }), onRequestDelete: requestDelete, onHoldStart: handleHoldStart, onHoldEnd: handleHoldEnd, onGroup: (group) => onGroup?.(group), onReorderStart: handleReorderStart, onReorderMove: handleReorderMove, onReorderEnd: handleReorderEnd, draggingKey: dragState.key, holdingKey, dragStyleFor }),
      error ? h("div", { className: "hb-roster-error" }, error) : null,
      loading ? h("div", { className: "hb-roster-loading" }, "Cargando…") : null,
      !loading && !rows.length && !director ? h("div", { className: "hb-roster-empty" }, "Todavía no hay bots para mostrar.") : null,
      h("main", { className: "hb-bot-feed", "aria-label": "Roster de bots" }, rows.map((bot) => h(BotCard, { bot, key: bot.name, meta, onChat: (item) => navigate({ view: "chat", profile: item.name }), onScreen, onRequestDelete: requestDelete, onHoldStart: handleHoldStart, onHoldEnd: handleHoldEnd, onReorderStart: handleReorderStart, onReorderMove: handleReorderMove, onReorderEnd: handleReorderEnd, draggingKey: dragState.key, holdingKey, dragStyleFor, onEdit }))),
      director && !pinned.has(director.name) ? h("div", { className: "hb-roster-note" }, "Chief of Staff está siempre primero en la franja fijada.") : null,
      deleteTarget ? h(DeleteBotPrompt, { bot: deleteTarget, busy: deleteBusy, error: deleteError, onClose: closeDelete, onConfirm: confirmDelete }) : null
    );
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

  function TurboAuditPanel({ audit, grants, onRevoke }) {
    const events = Array.isArray(audit) ? audit.slice(-6).reverse() : [];
    const rows = Array.isArray(grants) ? grants : [];
    const auditDetail = (event) => [event.profile, event.metadata?.account, event.metadata?.tool, event.metadata?.evidence, event.metadata?.expected_result].filter(Boolean).join(" · ");
    return h("div", { className: "hb-turbo-audit", "aria-label": "Auditoría y revocación Turbo" },
      h("div", { className: "hb-turbo-audit-heading" }, h("strong", null, "Auditoría y revocación"), h("small", null, "Cuenta, perfil, herramienta, evidencia y resultado esperado; sin secretos.")),
      rows.length ? h("div", { className: "hb-turbo-grants" }, rows.map((grant) => h("div", { className: "hb-grant-row", key: grant.grant_id || `${grant.service}-${grant.account}` }, h("span", null, `${grant.service || "servicio"} · ${grant.account || "cuenta"}`), h("small", null, `${grant.status || "pending"} · ${(grant.capabilities || []).join(", ") || "sin capabilities"}`), grant.status === "active" ? button("Revocar", () => onRevoke(grant), "danger") : null))) : h("small", null, "Sin grants registrados para este bot."),
      events.length ? h("ul", { className: "hb-turbo-audit-list" }, events.map((event) => h("li", { key: event.event_id || `${event.type}-${event.at}` }, `${event.type || "evento"} · ${event.outcome || "ok"}${auditDetail(event) ? ` · ${auditDetail(event)}` : ""}`))) : null);
  }

  function TurboControls({ profile, accountInfo }) {
    const [turbo, setTurbo] = useState(() => loadTurboState(profile)); const [grantLedger, setGrantLedger] = useState(() => loadTurboState(profile).grants || []); const [grantOpen, setGrantOpen] = useState(false); const [saveError, setSaveError] = useState("");
    useEffect(() => { const local = loadTurboState(profile); setTurbo(local); setGrantLedger(local.grants || []); fetchJSON(`/api/plugins/${PLUGIN}/turbo/${encodeURIComponent(profile)}`).then((remote) => { if (remote?.mode && TURBO_MODES.includes(remote.mode)) { const merged = { ...local, ...remote, profile }; setTurbo(merged); setGrantLedger(merged.grants || []); persistTurboState(profile, merged); } }).catch(() => {}); }, [profile]);
    const save = (next) => { const durable = (next.grants || []).filter((grant) => grant.persistent || grant.status === "revoked"); setTurbo(next); setGrantLedger(next.grants || []); persistTurboState(profile, { ...next, grants: durable }); fetchJSON(`/api/plugins/${PLUGIN}/turbo/${encodeURIComponent(profile)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: next.mode, grants: durable }) }).catch((error) => setSaveError(errText(error))); };
    const setMode = (mode) => { if (!TURBO_MODES.includes(mode)) return; const at = Date.now(); save({ ...turbo, mode, updatedAt: at, audit: [...(turbo.audit || []), { event: "turbo.mode.changed", type: "turbo.mode.changed", mode, at, profile, tool: "TurboControls", evidence: "selector", expected_result: "política aplicada" }] }); };
    const addGrant = (persistent) => { const rawAccount = accountInfo?.account?.account_id || accountInfo?.selected_account?.account_id || (typeof accountInfo?.account === "string" ? accountInfo.account : ""); const account = String(rawAccount || "").trim(); if (!account || accountInfo?.account_active !== true) { setSaveError("No hay una cuenta activa verificada en el navegador propio de este perfil."); return; } if (redactedAccount(account) !== account) { setSaveError("La cuenta contiene un dato protegido; no se registra en el ledger."); return; } const service = String(accountInfo?.service || "navegador").trim(); const grant = { grant_id: `grant-${profile}-${Date.now()}`, service, account, capabilities: ["read", "prepare", ...(persistent ? ["write"] : [])], persistent, status: "active", grantedAt: Date.now() }; const grants = [...grantLedger.filter((item) => !(item.service === service && item.account === account)), grant]; save({ ...turbo, grants }); setGrantOpen(false); };
    const revoke = (grant) => { const grants = grantLedger.map((item) => item === grant ? { ...item, status: "revoked", capabilities: [] } : item); save({ ...turbo, grants }); };
    const modeHelp = turbo.mode === "planning" ? "Descompone la tarea y no escribe fuera de Hermes." : turbo.mode === "simulation" ? "Lee y prepara borradores en el escritorio propio; no confirma." : "Usa grants persistentes y pide solo excepciones de alto riesgo.";
    const providerState = accountInfo?.provider_consent ? "Activo" : "No verificado"; const hermesState = accountInfo?.hermes_enabled ? "Activo" : "No verificado"; const browserState = accountInfo?.browser_open ? "Abierto" : "No verificado"; const accountState = accountInfo?.account_active ? "Activa" : "No verificado";
    return h("section", { className: "hb-turbo-controls", "aria-label": "Modos y autorizaciones Turbo" }, h("div", { className: "hb-turbo-header" }, h("div", null, h("span", { className: "hb-kicker" }, "POLÍTICA DEL BOT"), h("strong", null, "Turbo")), h("span", { className: `hb-mode-badge hb-mode-${turbo.mode}` }, TURBO_LABELS[turbo.mode])), h("label", { className: "hb-field hb-mode-field" }, "Modo actual", h("select", { className: "hb-select", value: turbo.mode, onChange: (event) => setMode(event.target.value) }, h("option", { value: "planning" }, "Planificación Turbo"), h("option", { value: "simulation" }, "Simulación Turbo"), h("option", { value: "autonomous" }, "Turbo Autónomo"))), h("p", { className: "hb-turbo-help" }, modeHelp), h("div", { className: "hb-account-status" }, h("strong", null, "Cuenta y navegador del perfil"), [["Navegador propio", browserState], ["Consentimiento del proveedor", providerState], ["Hermes habilitado", hermesState], ["Cuenta activa", accountState], ["Acción ejecutada", "No verificado"]].map(([label, value]) => h("span", { key: label }, h("small", null, label), h("b", null, value)))), h(TurboAuditPanel, { audit: turbo.audit, grants: grantLedger, onRevoke: revoke }), h("div", { className: "hb-grant-summary" }, h("div", null, h("strong", null, "Autorizaciones persistentes"), h("small", null, grantLedger.filter((item) => item.status === "active").length ? "Se reutilizan para tareas rutinarias de este bot." : "Todavía no hay grants para este bot.")), h("button", { className: "hb-btn ghost", type: "button", onClick: () => setGrantOpen((value) => !value) }, grantOpen ? "Cerrar" : "Autorizar")), grantOpen ? h("div", { className: "hb-grant-card" }, h("strong", null, "¿Qué querés autorizar?"), h("p", null, "La cuenta queda ligada a este perfil. No se guardan contraseñas, tokens ni códigos en el chat."), h("div", { className: "hb-row-actions" }, button("Permitir una vez", () => addGrant(false), "ghost"), button("Habilitar siempre para este bot", () => addGrant(true), "primary"), button("Cancelar", () => setGrantOpen(false), "ghost"))) : null, grantLedger.filter((item) => item.status === "active").map((grant) => h("div", { className: "hb-grant-row", key: `${grant.service}-${grant.account}` }, h("span", null, `${grant.service} · ${grant.account}`), h("small", null, grant.persistent ? "Siempre para este bot" : "Una vez"), button("Revocar", () => revoke(grant), "ghost"))), saveError ? h("small", { className: "hb-voice-error" }, saveError) : null);
  }

  function BrowserFlowCard({ profile, accountInfo }) {
    const source = accountInfo?.browser_flow || accountInfo?.browser_context || accountInfo?.account_flow || accountInfo || {};
    const operation = source.operation || source.browser_operation || accountInfo?.operation || null;
    const selected = source.selected_account?.account_id || source.account?.account_id || (typeof source.account === "string" ? source.account : "");
    const stages = source.stages || {};
    const stage = (name, fallback) => stages[name] === "verified" || source[name] === true ? "Verificado" : stages[name] === "pending" ? "Pendiente" : fallback || "No verificado";
    const browserStatus = stage("browser_open", "No verificado");
    const providerStatus = stage("provider_consent", "No verificado");
    const hermesStatus = stage("hermes_enabled", "No verificado");
    const accountStatus = stage("account_active", "No verificado");
    const evidence = Array.isArray(operation?.evidence) ? operation.evidence : [];
    const steps = Array.isArray(operation?.steps) ? operation.steps : [];
    const blocked = operation?.status === "blocked" || operation?.stop === true;
    return h("section", { className: "hb-browser-flow", "aria-label": "Flujo seguro de navegador y cuentas" },
      h("div", { className: "hb-browser-flow-header" }, h("div", null, h("span", { className: "hb-kicker" }, "NAVEGADOR DEL PERFIL"), h("strong", null, "Cuenta y operación segura")), h("span", { className: "hb-chip" }, "local · headed · visible")),
      h("p", { className: "hb-browser-flow-help" }, "Las acciones web se vinculan únicamente al Bot Desktop propio; no se comparten cookies, sesiones, displays ni credenciales."),
      h("div", { className: "hb-account-status hb-browser-stages" }, h("strong", null, "Evidencia leída del flujo"), [["Navegador propio", browserStatus], ["Consentimiento del proveedor", providerStatus], ["Hermes habilitado", hermesStatus], ["Cuenta activa", accountStatus], ["Cuenta seleccionada", selected ? redactedAccount(selected) : "Ninguna"]].map(([label, value]) => h("span", { key: label }, h("small", null, label), h("b", null, value)))),
      operation ? h("div", { className: `hb-browser-operation ${blocked ? "is-blocked" : ""}` },
        h("strong", null, blocked ? "Operación detenida" : "Operación preparada"),
        h("div", { className: "hb-browser-operation-meta" }, h("span", null, `Perfil: ${operation.profile || profile}`), h("span", null, `Cuenta: ${redactedAccount(operation.account?.account_id || operation.account) || "No seleccionada"}`), h("span", null, `Herramienta: ${operation.tool || "local-browser"}`), h("span", null, `Modo: ${TURBO_LABELS[operation.mode] || operation.mode || "Planificación Turbo"}`)),
        blocked ? h("p", { className: "hb-browser-stop" }, `Detenido antes de ejecutar: ${operation.stop_reason || "requiere confirmación explícita"}.`) : null,
        steps.length ? h("div", { className: "hb-browser-list" }, h("small", null, "Pasos"), h("ol", null, steps.map((item, index) => h("li", { key: `${index}-${item}` }, item)))) : null,
        evidence.length ? h("div", { className: "hb-browser-list" }, h("small", null, "Evidencia"), h("ul", null, evidence.map((item, index) => h("li", { key: `${index}-${item.kind || item}` }, typeof item === "string" ? item : `${item.kind || "readback"} · ${item.status || "esperado"}`)))) : null,
        operation.expected_result ? h("p", { className: "hb-browser-expected" }, h("small", null, "Resultado esperado"), operation.expected_result) : null,
      ) : h("p", { className: "hb-browser-flow-empty" }, "El Gateway todavía no entregó un readback de cuenta u operación. No se afirma que la cuenta esté activa."));
  }

  function AttachmentTray({ attachments, onRemove }) {
    if (!attachments.length) return null;
    return h("div", { className: "hb-attachment-tray", "aria-label": "Adjuntos preparados" }, attachments.map((attachment) => h("div", { className: `hb-attachment ${attachment.status === "error" ? "is-error" : ""}`, key: attachment.id }, attachment.preview ? h("img", { src: attachment.preview, alt: "", loading: "lazy" }) : h("span", { className: `hb-attachment-kind ${attachment.kind}` }, attachment.kind === "document" ? "DOC" : attachment.kind.toUpperCase()), h("span", { className: "hb-attachment-copy" }, h("strong", null, attachment.name), h("small", null, `${Math.ceil(attachment.size / 1024)} KB · ${attachment.status === "uploading" ? `Subiendo ${attachment.progress || 0}%` : attachment.status === "error" ? attachment.error || "Error" : "Listo"}`), attachment.status === "uploading" ? h("progress", { value: attachment.progress || 0, max: 100, "aria-label": `Progreso de ${attachment.name}` }) : null), button("Quitar", () => onRemove(attachment.id), "ghost"))));
  }

  function ChatView({ bot, storedId, onEdit, onOpenMonitor }) {
    const draftStorageKey = `hermes-bots-console.draft.${bot.name}`;
    const [core, setCore] = useState(null); const [state, setState] = useState({ messages: [], connected: false, busy: false, error: "", status: "" }); const [approvals, setApprovals] = useState([]); const [secureRequests, setSecureRequests] = useState([]); const [notices, setNotices] = useState([]); const [connections, setConnections] = useState([]); const rpcRef = useRef(null); const composerRef = useRef(null); const recorderRef = useRef(null); const audioChunksRef = useRef([]); const [draft, setDraft] = useState(() => { try { return window.sessionStorage.getItem(draftStorageKey) || ""; } catch (_) { return ""; } }); const [attachments, setAttachments] = useState([]); const [attachmentError, setAttachmentError] = useState(""); const fileInputRef = useRef(null); const cameraInputRef = useRef(null); const [voiceState, setVoiceState] = useState("idle"); const [voiceError, setVoiceError] = useState(""); const [notificationState, setNotificationState] = useState(() => typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported"); const [localStalled, setLocalStalled] = useState(false); const [continuing, setContinuing] = useState(false); const isDirector = Boolean(bot.is_default || /arquitect|architect|chief|director/i.test(`${bot.name || ""} ${profileLabel(bot)}`));
    useEffect(() => {
      let alive = true; const rpc = new RpcClient(bot.name); rpcRef.current = rpc;
      let chat;
      const start = async () => {
        try {
          const [{ ChatSession }, interaction, browserFlow] = await Promise.all([import(`${ASSET}/chat-core-v023.mjs`), import(`${ASSET}/${INTERACTION_CORE}`), import(`${ASSET}/${BROWSER_FLOW_CORE}`)]); if (!interaction?.normalizeAttachment || !browserFlow?.createBrowserContext) throw new Error("Política de navegador seguro no disponible");
          if (!alive) return;
          chat = new ChatSession({ rpc, fetchJSON, profile: bot.name, attachAttachment: (descriptor, blob, sessionId, profile) => attachBlobToGateway(rpc, profile, sessionId, descriptor, blob), routeMessage: (context) => fetchJSON(`/api/plugins/${PLUGIN}/route`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: bot.name, ...context }) }), onChange: (next) => { if (alive) { setState(next); if (Array.isArray(next.openRequests)) { const requests = next.openRequests.map((request) => ({ id: request.id, method: request.method, params: request.params || {} })); setApprovals(requests.filter((request) => request.method === "approval" || request.method === "clarify")); setSecureRequests(requests.filter((request) => SECURE_REQUEST_METHODS.has(request.method))); } if (next.pendingConnection) setConnections((old) => [...old.filter((item) => item.op_id !== next.pendingConnection.op_id), { ...next.pendingConnection, session_id: next.runtimeId, owner: { type: "session", session_id: next.runtimeId } }]); if (next.storedId) { try { localStorage.setItem(`hermes-bots-console.session.${bot.name}`, next.storedId); } catch (_) {} } if (next.storedId && !new URLSearchParams(window.location.search).get("session")) navigate({ view: "chat", profile: bot.name, session: next.storedId }, true); } } });
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
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") new Notification("Autorización requerida", { body: "El bot necesita tu decisión en la conversación.", tag: `hermes-connection-${operation.op_id}` });
        } else {
          if (payload.settled) setConnections((old) => old.filter((item) => item.op_id !== payload.op_id));
          else setConnections((old) => { const current = old.find((item) => item.op_id === payload.op_id); if (current && Number(current.seq || 0) >= Number(payload.seq || 0)) return old; return [...old.filter((item) => item.op_id !== payload.op_id), { ...payload, session_id: event.session_id || chat?.state?.runtimeId, owner }]; });
        }
      });
      const offRequest = rpc.on("server-request", (frame) => {
        if (frame.method === "approval" || frame.method === "clarify") {
          setApprovals((old) => [...old.filter((x) => x.id !== frame.id), frame]);
          if (frame.method === "approval" && typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") new Notification("Hermes necesita tu aprobación", { body: "Hay una aprobación pendiente en la conversación.", tag: `hermes-approval-${frame.id}` });
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
    const addFiles = useCallback((fileList, source = "file") => {
      const files = [...(fileList || [])]; if (!files.length) return;
      const next = []; let error = "";
      for (const file of files) { try { next.push(normalizeBrowserAttachment(file, source)); } catch (problem) { error = errText(problem); } }
      if (next.length) setAttachments((current) => [...current, ...next].slice(-12));
      setAttachmentError(error);
    }, []);
    const removeAttachment = useCallback((id) => setAttachments((current) => { const item = current.find((attachment) => attachment.id === id); if (item?.preview) URL.revokeObjectURL(item.preview); return current.filter((attachment) => attachment.id !== id); }), []);
    const handleDrop = useCallback((event) => { event.preventDefault(); event.stopPropagation(); addFiles(event.dataTransfer?.files, "drop"); }, [addFiles]);
    const handlePaste = useCallback((event) => { const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); addFiles(files, "paste"); } }, [addFiles]);
    const openAttachmentPicker = useCallback(async () => {
      try {
        if (navigator.clipboard?.read) { const items = await navigator.clipboard.read(); const pasted = []; for (const item of items) for (const type of item.types || []) if (type.startsWith("image/")) pasted.push(await item.getType(type)); if (pasted.length) { addFiles(pasted, "clipboard"); return; } }
      } catch (_) {}
      fileInputRef.current?.click();
    }, [addFiles]);
    const handleComposerKeyDown = useCallback((event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") { event.preventDefault(); openAttachmentPicker(); } }, [openAttachmentPicker]);
    const uploadAttachments = useCallback(async () => Promise.all(attachments.map(async (attachment) => {
      if (!attachment.file) return attachment;
      setAttachments((current) => current.map((item) => item.id === attachment.id ? { ...item, status: "uploading", progress: 15 } : item));
      try {
        const form = new FormData(); form.append("file", attachment.file, attachment.name);
        const response = await window.fetch(`${BASE}/api/plugins/${PLUGIN}/attachments?profile=${encodeURIComponent(bot.name)}`, { method: "POST", body: form, credentials: "same-origin" });
        if (!response.ok) throw new Error(`No se pudo adjuntar (${response.status}).`);
        const uploaded = await response.json();
        const result = { ...attachment, ...uploaded, status: "ready", progress: 100 };
        setAttachments((current) => current.map((item) => item.id === attachment.id ? result : item));
        return result;
      } catch (error) {
        setAttachments((current) => current.map((item) => item.id === attachment.id ? { ...item, status: "error", progress: 0, error: errText(error) } : item));
        throw error;
      }
    })), [attachments, bot.name]);
    const send = useCallback(async () => { const text = draft.trim() || (attachments.length ? "Revisá los adjuntos que te envío." : ""); if (!text || !core || !state.connected) return; setAttachmentError(""); try { const uploaded = await uploadAttachments(); const payload = attachmentPayload(uploaded); setDraft(""); await core.submit(text, payload, { files: uploaded }); attachments.forEach((attachment) => { if (attachment.preview) URL.revokeObjectURL(attachment.preview); }); setAttachments([]); } catch (error) { setAttachmentError(errText(error)); } }, [attachments, core, draft, state.connected, uploadAttachments]);
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
            audioChunksRef.current = [];
            const result = await transcribeAudioBlob(bot.name, blob, "voice.webm");
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
    return h("div", { className: "hb-chat-layout" }, h("header", { className: "hb-chat-header" }, button("‹", () => navigate({ view: "roster" }), "icon ghost"), h("div", { className: "hb-chat-identity" }, h(BotCharacter, { bot, size: "small", working: state.busy }), h("div", null, h("button", { className: "hb-chat-name", type: "button", onClick: () => onEdit?.(bot), "aria-label": `Editar ${profileLabel(bot)}` }, h("strong", null, profileLabel(bot))), h("span", null, state.connected ? (state.busy ? state.status || "Trabajando…" : "En línea") : "Desconectado"))), h("div", { className: "hb-chat-actions" }, onOpenMonitor ? iconButton("Abrir monitor", monitorIcon(), () => onOpenMonitor(bot), "hb-monitor-button") : null, notificationState === "granted" ? iconButton("Avisos activos", bellIcon(), () => {}, "notification-icon") : notificationState === "unsupported" ? null : iconButton(notificationState === "denied" ? "Avisos bloqueados" : "Activar avisos", bellIcon(), enableNotifications, "notification-icon", notificationState === "denied"), button("⋯", () => window.location.assign(`${BASE}/chat?profile=${encodeURIComponent(bot.name)}`), "icon ghost"))), h("main", { className: "hb-chat-main" }, h("div", { className: "hb-chat-context" }, h("span", { className: "hb-kicker" }, "CONVERSACIÓN PRIVADA"), h("p", null, bot.description || "Este chat conserva el perfil y la memoria de este bot."), h(TurboControls, { profile: bot.name, accountInfo: state.info }), h(BrowserFlowCard, { profile: bot.name, accountInfo: state.info }), isDirector && !state.busy ? h(DirectorQuickActions, { onSelect: quickPrompt }) : null), h("div", { className: "hb-messages", "aria-live": "polite" }, state.messages.length ? state.messages.map((m, i) => h(MessageBubble, { message: m, profile: bot.name, key: `${m.role}-${m.toolId || i}` })) : h("div", { className: "hb-chat-empty" }, h(BotCharacter, { bot, size: "empty", working: state.busy }), h("h2", null, `¿Qué hacemos, ${profileLabel(bot)}?`), h("p", null, "Escribe una instrucción para comenzar. Este chat usa el Gateway y se reanuda después de recargar.")), (state.busy || state.recoverable || localStalled) ? h(WorkingIndicator, { text: state.status || "Pensando…", recoverable: state.recoverable, stalled: localStalled || state.stalled, onContinue: continueRun, continuing }) : null, notices.map((notice) => h(NoticeCard, { notice, key: `notice-${notice.key}` })), approvals.map((frame) => frame.method === "clarify" ? h(ClarifyCard, { frame, profile: bot.name, rpc: rpcRef.current, key: frame.id, onResolved: clearRequest }) : h(ApprovalCard, { frame, key: frame.id, onRespond: respond })), connections.map((operation) => h(ConnectionCard, { operation, profile: bot.name, rpc: rpcRef.current, key: `connection-${operation.op_id}`, onDone: connectionDone })), secureRequests.map((frame) => h(SecureRequestNotice, { frame, key: `secure-${frame.id}` })), null), h("div", { className: "hb-composer-wrap", onDrop: handleDrop, onDragOver: (event) => event.preventDefault(), onPaste: handlePaste }, h("input", { ref: fileInputRef, type: "file", accept: "image/*,audio/*,video/*,.md,.markdown,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt", multiple: true, hidden: true, onChange: (event) => { addFiles(event.target.files, "file"); event.target.value = ""; } }), h("input", { ref: cameraInputRef, type: "file", accept: "image/*", capture: "environment", hidden: true, onChange: (event) => { addFiles(event.target.files, "camera"); event.target.value = ""; } }), h(AttachmentTray, { attachments, onRemove: removeAttachment }), h("textarea", { ref: composerRef, className: "hb-composer", value: draft, rows: 1, placeholder: state.busy ? "Escribí lo que necesites; Hermes ordena el mensaje…" : `Mensaje para ${profileLabel(bot)}…`, "aria-label": "Escribir mensaje", onChange: (e) => setDraft(e.target.value), onPaste: handlePaste, onKeyDown: (e) => { handleComposerKeyDown(e); if (!e.defaultPrevented && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } } }), h("div", { className: `hb-composer-bar ${state.busy ? "busy" : ""}` }, h("div", { className: "hb-attachment-actions" }, button("+ Adjuntar", openAttachmentPicker, "ghost hb-compose-plus"), button("Cámara", () => cameraInputRef.current?.click(), "ghost")), h("span", { className: "hb-compose-hint" }, state.busy ? "Hermes decide si ajusta el trabajo o lo deja como siguiente tarea." : "Enter enviar · Shift+Enter nueva línea"), voiceState === "recording" ? iconButton("Detener audio", stopIcon(), recordVoice, "voice-recording") : iconButton(voiceState === "transcribing" ? "Transcribiendo…" : "Grabar audio", microphoneIcon(), recordVoice, "voice-button hb-compose-mic", !state.connected || voiceState === "transcribing"), !state.connected ? button("Reconectar", reconnect, "ghost") : null, button("Enviar", send, "primary send-button", (!draft.trim() && !attachments.length) || !state.connected)), attachmentError ? h("div", { className: "hb-voice-error" }, attachmentError) : null, voiceError ? h("div", { className: "hb-voice-error" }, voiceError) : null, h("div", { className: "hb-chat-note" }, "Perfil explícito: ", bot.name, " · Terminal avanzado disponible desde ⋯"))));
  }

  function DesktopBotRail({ bots, selectedBot, search, onSearch, onSelect, onCreate, onMarketplace }) {
    const query = String(search || "").trim().toLowerCase();
    const visible = (bots || []).filter((bot) => !query || `${profileLabel(bot)} ${bot.description || ""}`.toLowerCase().includes(query));
    return h("aside", { className: "hb-desktop-sidebar", "aria-label": "Navegación de Bots" },
      h("div", { className: "hb-desktop-brand" }, h("span", { className: "hb-desktop-brand-mark" }, "H"), h("strong", null, "Hermes"), h("small", null, "BOT COMMAND")),
      h("label", { className: "hb-desktop-search" }, searchIcon(), h("input", { value: search, onChange: (event) => onSearch(event.target.value), placeholder: "Buscar bots", "aria-label": "Buscar bots" })),
      h("nav", { className: "hb-desktop-nav", "aria-label": "Secciones" },
        h("button", { className: "is-active", type: "button", onClick: () => selectedBot && onSelect(selectedBot) }, h("span", null, "⌂"), "Chat"),
        h("button", { type: "button", onClick: onMarketplace }, h("span", null, "⌘"), "Marketplace"),
        h("button", { type: "button", onClick: onCreate }, h("span", null, "+"), "Nuevo bot")
      ),
      h("div", { className: "hb-desktop-bot-heading" }, h("span", null, "Tus bots"), iconButton("Crear bot", plusIcon(), onCreate, "hb-desktop-add")),
      h("div", { className: "hb-desktop-bot-list" }, visible.length ? visible.map((bot) => h("button", { className: `hb-desktop-bot-item ${selectedBot?.name === bot.name ? "is-selected" : ""}`, type: "button", key: bot.name, onClick: () => onSelect(bot) }, h("span", { className: "hb-desktop-bot-avatar" }, h(BotCharacter, { bot, size: "small" })), h("span", { className: "hb-desktop-bot-copy" }, h("strong", null, profileLabel(bot)), h("small", null, bot.is_default ? "Chief of Staff" : bot.description || "Perfil de Hermes")), bot.is_default ? h("span", { className: "hb-desktop-bot-dot", title: "Bot principal" }, "•") : null)) : h("p", { className: "hb-desktop-empty" }, "No hay bots que coincidan.")),
      h("div", { className: "hb-desktop-sidebar-footer" }, h("div", { className: "hb-desktop-user-avatar" }, "F"), h("div", null, h("strong", null, "Franco"), h("small", null, "Perfil default")))
    );
  }

  function DesktopInspector({ bot, route, onEdit, onMarketplace }) {
    const [expanded, setExpanded] = useState(false);
    const [pendingControl, setPendingControl] = useState(false);
    useEffect(() => { setExpanded(false); setPendingControl(false); }, [bot?.name, route?.view]);
    if (!bot) return h("aside", { className: "hb-desktop-inspector" }, h("div", { className: "hb-desktop-inspector-empty" }, "Seleccioná un bot para ver sus detalles."));
    const inChat = route?.view === "chat";
    const requestExpand = (options = {}) => { setPendingControl(Boolean(options.takeControl)); setExpanded(true); };
    const monitor = inChat ? h("section", { className: expanded ? "hb-desktop-expanded-monitor" : "hb-desktop-inline-monitor", "aria-label": expanded ? `Monitor ampliado de ${profileLabel(bot)}` : `Monitor vivo de ${profileLabel(bot)}` }, h(ScreenPanel, { key: bot.name, bot, inline: !expanded, onExpand: requestExpand, autoAcquire: pendingControl, onControlComplete: () => setPendingControl(false), onClose: () => { setPendingControl(false); setExpanded(false); } })) : h("section", { className: "hb-desktop-preview-card" }, h("div", { className: "hb-desktop-preview-window" }, h("div", { className: "hb-desktop-preview-toolbar" }, h("span", null), h("span", null), h("span", null)), h("div", { className: "hb-desktop-preview-content" }, h(BotCharacter, { bot, size: "large" }), h("strong", null, "Monitor contextual"), h("small", null, "Abrí el chat de este bot para iniciar su pantalla bajo demanda."))), h("p", { className: "hb-desktop-preview-note" }, "Fuera del chat no se monta ni se inicia ningún Bot Screen."));
    return h("aside", { className: "hb-desktop-inspector", "aria-label": `Inspector de ${profileLabel(bot)}` },
      h("div", { className: "hb-desktop-inspector-heading" }, h("div", null, h("span", { className: "hb-kicker" }, "BOT SCREEN"), h("h2", null, `${profileLabel(bot)}'s screen`)), iconButton("Editar bot", editIcon(), onEdit, "hb-desktop-inspector-edit")),
      monitor,
      h("section", { className: "hb-desktop-detail-card" }, h("span", { className: "hb-kicker" }, "PERFIL"), h("strong", null, profileLabel(bot)), h("p", null, bot.description || "Este bot conserva su perfil, memoria y configuración dentro de Hermes."), h("small", null, `ID: ${bot.name}`)),
      h("section", { className: "hb-desktop-inspector-actions" }, h("h3", null, "Acciones"), button("Editar configuración", onEdit, "ghost"), button("Explorar Marketplace", onMarketplace, "ghost"))
    );
  }

  function DesktopMarketplace({ bots, onClose, onSelect }) {
    const [query, setQuery] = useState(""); const [filter, setFilter] = useState("Todos");
    const matches = (bots || []).filter((bot) => { const text = `${profileLabel(bot)} ${bot.description || ""}`.toLowerCase(); if (query && !text.includes(query.toLowerCase())) return false; if (filter === "Chief" && !bot.is_default) return false; if (filter === "Especialistas" && bot.is_default) return false; return true; });
    const featured = matches.slice(0, 4); const rest = matches.slice(4);
    const select = (bot) => { onSelect(bot); onClose(); };
    return h("div", { className: "hb-marketplace-backdrop", onClick: onClose }, h("section", { className: "hb-marketplace", onClick: (event) => event.stopPropagation(), role: "dialog", "aria-modal": "true", "aria-labelledby": "hb-marketplace-title" },
      h("header", { className: "hb-marketplace-header" }, h("div", null, h("h2", { id: "hb-marketplace-title" }, "Marketplace"), h("p", null, "Explorá los bots disponibles en tu espacio de Hermes.")), h("div", { className: "hb-marketplace-header-actions" }, h("span", { className: "hb-marketplace-switch is-active" }, "Bots"), h("span", { className: "hb-marketplace-switch" }, "Plugins"), iconButton("Cerrar Marketplace", closeIcon(), onClose, "hb-marketplace-close"))),
      h("section", { className: "hb-marketplace-section" }, h("div", { className: "hb-marketplace-section-title" }, h("h3", null, "Destacados"), h("span", null, `${matches.length} bots`)), h("div", { className: "hb-marketplace-featured" }, featured.length ? featured.map((bot) => h("button", { className: "hb-marketplace-feature-card", type: "button", key: bot.name, onClick: () => select(bot) }, h(BotCharacter, { bot, size: "featured" }), h("strong", null, profileLabel(bot)), h("small", null, bot.is_default ? "Chief de tu espacio" : "Bot especialista"))) : h("p", { className: "hb-desktop-empty" }, "No hay resultados."))),
      h("label", { className: "hb-marketplace-search" }, searchIcon(), h("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: "Buscar por nombre o descripción", "aria-label": "Buscar bots en Marketplace" })),
      h("div", { className: "hb-marketplace-filters" }, ["Todos", "Chief", "Especialistas"].map((item) => h("button", { className: filter === item ? "is-active" : "", type: "button", key: item, onClick: () => setFilter(item) }, item))),
      h("section", { className: "hb-marketplace-results" }, h("h3", null, "En tu espacio"), (rest.length ? rest : featured).map((bot) => h("button", { className: "hb-marketplace-result", type: "button", key: `result-${bot.name}`, onClick: () => select(bot) }, h(BotCharacter, { bot, size: "small" }), h("span", null, h("strong", null, profileLabel(bot)), h("small", null, bot.description || "Perfil de Hermes")), h("span", { className: "hb-marketplace-open" }, "›"))))
    ));
  }

  function DesktopWorkspace({ bots, groups, route, bot, search, onSearch, onSelect, onCreate, onEdit, onMarketplace, marketplaceOpen, onCloseMarketplace }) {
    const main = route.view === "group" ? h(GroupRoomView, { key: `${bot?.name || route.profile || "default"}:${route.group}`, bots, groupId: route.group, profile: bot?.name || route.profile || "default" }) : route.view === "groups" ? h(GroupsView, { bots, profile: bot?.name || route.profile || "default" }) : bot ? h(ChatView, { bot, storedId: route.session, onEdit }) : h("div", { className: "hb-desktop-empty-state" }, "Creá o seleccioná un bot para comenzar.");
    return h("div", { className: "hb-desktop-workspace" }, h(DesktopBotRail, { bots, selectedBot: bot, search, onSearch, onSelect, onCreate, onMarketplace }), h("main", { className: "hb-desktop-main" }, main), h(DesktopInspector, { bot, route, onEdit, onMarketplace }), marketplaceOpen ? h(DesktopMarketplace, { bots, onClose: onCloseMarketplace, onSelect }) : null);
  }

  function OnboardingCard({ profile, onDismiss }) {
    const [checks, setChecks] = useState([]); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [copied, setCopied] = useState("");
    const reload = useCallback(async () => {
      setBusy(true); setError("");
      try { const result = await fetchJSON(`/api/plugins/${PLUGIN}/diagnostics?profile=${encodeURIComponent(profile)}`); setChecks(Array.isArray(result.checks) ? result.checks : []); }
      catch (cause) { setError(errText(cause)); }
      finally { setBusy(false); }
    }, [profile]);
    useEffect(() => { reload(); }, [reload]);
    const copyAction = async (item) => { try { await navigator.clipboard?.writeText(String(item.action || "hermes plugins validate")); setCopied(item.id); window.setTimeout(() => setCopied(""), 1600); } catch (_) { setError("No se pudo copiar la acción; podés seleccionarla manualmente."); } };
    const statusLabel = (status) => status === "ok" ? "Listo" : status === "manual" ? "Opcional" : status === "error" ? "Revisar" : "Comprobando…";
    return h("section", { className: "hb-card hb-onboarding", "aria-labelledby": "hb-onboarding-title" },
      h("div", { className: "hb-onboarding-header" }, h("div", null, h("span", { className: "hb-kicker" }, "PRIMER ARRANQUE"), h("h2", { id: "hb-onboarding-title" }, "Comprobá tu espacio de bots"), h("p", { className: "hb-subtitle" }, "Los requisitos obligatorios y el visor opcional aparecen por separado. No pegues secretos aquí.")), button("Cerrar guía", onDismiss, "ghost")),
      error ? h("div", { className: "hb-error" }, error) : null,
      h("div", { className: "hb-onboarding-checks" }, checks.map((item) => h("article", { className: `hb-onboarding-check status-${item.status}`, key: item.id }, h("div", { className: "hb-onboarding-check-copy" }, h("div", { className: "hb-onboarding-check-title" }, h("strong", null, item.label), h("span", { className: "hb-onboarding-status" }, `${item.required ? "Obligatorio" : "Opcional"} · ${statusLabel(item.status)}`)), h("p", null, item.detail), item.action ? h("code", { className: "hb-onboarding-action" }, item.action) : null), item.action ? iconButton(copied === item.id ? "Acción copiada" : "Copiar acción", copied === item.id ? "✓" : copyIcon(), () => copyAction(item), "onboarding-copy") : null))),
      h("div", { className: "hb-onboarding-footer" }, button(busy ? "Comprobando…" : "Volver a comprobar", reload, "secondary", busy), h("small", null, `Perfil: ${profile}`))
    );
  }

  function BotsPage() {
    const [route, setRoute] = useState(routeFromLocation()); const [bots, setBots] = useState([]); const [groups, setGroups] = useState([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [sheet, setSheet] = useState(null); const [screenBot, setScreenBot] = useState(null); const [showOnboarding, setShowOnboarding] = useState(() => { try { const initialProfile = routeFromLocation().profile || "default"; return localStorage.getItem(`hermes-bots-console.onboarding.${initialProfile}`) !== "dismissed"; } catch (_) { return true; } });
    const [isDesktop, setIsDesktop] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1180px)").matches);
    const [desktopSearch, setDesktopSearch] = useState(""); const [marketplaceOpen, setMarketplaceOpen] = useState(false);
    const refresh = useCallback(async () => { setLoading(true); setError(""); try { const result = await api.getProfiles(); const visual = readVisualMeta(); setBots((result.profiles || []).map((bot) => ({ ...bot, ...(visual[bot.name]?.display_name ? { display_name: visual[bot.name].display_name } : {}), ...(visual[bot.name]?.avatar ? { avatar: visual[bot.name].avatar } : {}) }))); } catch (e) { setError(errText(e)); } finally { setLoading(false); } }, []);
    useEffect(() => { const onPop = () => { setRoute(routeFromLocation()); setScreenBot(null); }; window.addEventListener("popstate", onPop); refresh(); fetchJSON(`/api/plugins/${PLUGIN}/groups?profile=${encodeURIComponent(route.profile || "default")}`).then((result) => setGroups(result.groups || [])).catch(() => {}); return () => window.removeEventListener("popstate", onPop); }, [refresh, route.profile]);
    useEffect(() => { const media = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 1180px)") : null; if (!media) return undefined; const sync = () => setIsDesktop(media.matches); sync(); media.addEventListener?.("change", sync); return () => media.removeEventListener?.("change", sync); }, []);
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
    const dataProfile = route.profile || bot?.name || "default";
    const onboardingProfile = bot?.name || "default";
    const dismissOnboarding = () => { try { localStorage.setItem(`hermes-bots-console.onboarding.${onboardingProfile}`, "dismissed"); } catch (_) {} setShowOnboarding(false); };
    const onboarding = showOnboarding && !loading && bot ? h(OnboardingCard, { profile: onboardingProfile, onDismiss: dismissOnboarding }) : null;
    const roster = h(RosterView, { bots, groups, profile: dataProfile, loading, error, onRefresh: refresh, onCreate: () => setSheet({ type: "create" }), onScreen: setScreenBot, onEdit: (b) => setSheet({ type: "edit", bot: b }), onGroup: (group) => navigate({ view: "group", group: group.id, profile: dataProfile }) });
    const content = route.view === "chat" && bot ? h("div", { className: "hb-split-view is-chat" }, h("aside", { className: "hb-roster-pane" }, roster), h("section", { className: "hb-chat-pane" }, h(ChatView, { bot, storedId: route.session, onEdit: (item) => setSheet({ type: "edit", bot: item }), onOpenMonitor: setScreenBot }))) : route.view === "group" ? h(GroupRoomView, { key: `${dataProfile}:${route.group}`, bots, groupId: route.group, profile: dataProfile }) : route.view === "groups" ? h(GroupsView, { bots, profile: dataProfile }) : roster;
    const desktop = h(DesktopWorkspace, { bots, groups, route, bot, search: desktopSearch, onSearch: setDesktopSearch, onSelect: (item) => navigate({ view: "chat", profile: item.name }), onCreate: () => setSheet({ type: "create" }), onEdit: () => setSheet({ type: "edit", bot }), onMarketplace: () => setMarketplaceOpen(true), marketplaceOpen, onCloseMarketplace: () => setMarketplaceOpen(false) });
    const mobileSurface = h("div", { className: route.view === "chat" && bot ? "hb-mobile-surface is-chat" : "hb-mobile-surface" }, onboarding, content, screenBot ? h("div", { className: "hb-screen-overlay mobile-screen" }, h(ScreenPanel, { key: screenBot.name, bot: screenBot, onClose: () => setScreenBot(null) })) : null);
    // Desktop owns exactly one contextual ScreenPanel inside DesktopInspector.
    // Do not mirror it in an overlay: that would mint a second viewer/ticket and
    // could start a second display during a remount. Mobile keeps its explicit
    // fullscreen overlay below.
    const desktopSurface = h("div", { className: "hb-desktop-surface" }, desktop);
    return h("div", { className: "hb-root" }, isDesktop ? desktopSurface : mobileSurface, sheet?.type === "create" ? h(CreateBotSheet, { onClose: () => setSheet(null), onCreated: refresh }) : null, sheet?.type === "edit" ? h(SettingsSheet, { bot: sheet.bot, groups, onClose: () => setSheet(null), onSaved: async () => { await refresh(); setSheet(null); } }) : null);
  }

  window.__HERMES_PLUGINS__.register(PLUGIN, BotsPage);
  if (typeof window.__HERMES_PLUGINS__.registerSlot === "function") window.__HERMES_PLUGINS__.registerSlot(PLUGIN, "chat:top", ({}) => null);
})();
