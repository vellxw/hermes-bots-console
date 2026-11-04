import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../dashboard/', import.meta.url);
const source = await readFile(new URL('index.js', root), 'utf8');
const css = await readFile(new URL('style.css', root), 'utf8');
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));

test('pixel surface exposes fixed Chief roster and responsive split-view contracts', () => {
  assert.match(source, /hb-roster-screen/);
  assert.match(source, /hb-pin-strip/);
  assert.match(source, /Chief of Staff/);
  assert.match(source, /data-hb-reorder-key/);
  assert.match(source, /hb-split-view/);
  assert.match(source, /hb-chat-bubble/);
  assert.match(css, /\.hb-roster-screen/);
  assert.match(css, /\.hb-pin-strip/);
  assert.match(css, /\.hb-split-view/);
  assert.match(css, /@media \(min-width: 768px\)/);
  assert.match(css, /@media \(max-width: 767px\)/);
  assert.equal(manifest.entry, 'index-v055.js');
  assert.equal(manifest.css, 'style-v054.css');
});

test('desktop workspace gets a bot rail, chat surface and inspector without replacing mobile', () => {
  assert.match(source, /function DesktopWorkspace/);
  assert.match(source, /hb-desktop-sidebar/);
  assert.match(source, /hb-desktop-inspector/);
  assert.match(source, /hb-marketplace/);
  assert.match(source, /matchMedia\("\(min-width: 1180px\)"\)/);
  assert.match(source, /hb-mobile-surface/);
  assert.match(css, /\.hb-desktop-workspace/);
  assert.match(css, /\.hb-desktop-sidebar/);
  assert.match(css, /\.hb-desktop-inspector/);
  assert.match(css, /@media \(min-width: 1180px\)/);
  assert.match(css, /@media \(max-width: 1179px\)/);
});

test('desktop chat inspector owns one contextual live monitor and other desktop views keep a preview', () => {
  assert.match(source, /function RosterView\(\{ bots, loading, error, onRefresh, onCreate, onEdit, onGroup, onScreen, profile \}\)/);
  assert.match(source, /function BotCard\(\{ bot, onChat, onScreen,/);
  assert.match(source, /onScreen\?\.\(bot\)/);
  assert.match(source, /className: route\.view === "chat" && bot \? "hb-mobile-surface is-chat" : "hb-mobile-surface"/);
  assert.match(source, /onOpenMonitor \? iconButton\("Abrir monitor", monitorIcon\(\), \(\) => onOpenMonitor\(bot\), "hb-monitor-button"\)/);
  assert.match(source, /if \(inline\) return undefined;\n      viewerRef\.current = "";/);
  assert.match(source, /const inChat = route\?\.view === "chat"/);
  assert.match(source, /hb-desktop-inline-monitor/);
  assert.match(source, /h\(ScreenPanel, \{ key: bot\.name, bot, inline: !expanded, onExpand: requestExpand, autoAcquire: pendingControl, onControlComplete: \(\) => setPendingControl\(false\), onClose: \(\) => \{/);
  assert.match(source, /h\(ChatView, \{ bot, storedId: route\.session, onEdit: \(item\) => setSheet\(\{ type: "edit", bot: item \}\), onOpenMonitor: setScreenBot \}\)/);
  assert.match(source, /h\("div", \{ className: "hb-screen-overlay mobile-screen" \}, h\(ScreenPanel, \{ key: screenBot\.name, bot: screenBot/);
  assert.match(source, /data-contextual-monitor/);
  assert.match(source, /data-screen-state/);
  assert.match(source, /function ScreenPanel\(\{ bot, onClose, inline = false, onExpand, autoAcquire = false, onControlComplete \}\)/);
  assert.match(source, /const openExpanded = useCallback\(\(takeControl = false\)/);
  assert.match(source, /onClickCapture: inline && !fullscreen \? \(\) => openExpanded\(false\) : undefined/);
  assert.match(source, /inline \? button\("Tomar control", \(\) => openExpanded\(true\)/);
  assert.match(source, /if \(!autoAcquire \|\| inline \|\| connection !== "live" \|\| human\)/);
  assert.match(source, /autoAcquire: pendingControl/);
  assert.match(source, /inline \? null : iconButton\("Cerrar monitor", closeIcon\(\), closePanel/);
  assert.match(css, /\.hb-desktop-expanded-monitor \.hb-screen-state-row \{[^}]*display:none/);
  assert.match(css, /\.hb-desktop-expanded-monitor \.hb-screen-frame \{[^}]*position:absolute;[^}]*inset:0/);
  assert.match(css, /\.hb-desktop-expanded-monitor \{[^}]*z-index:2147483000/);
  assert.match(css, /\.hb-desktop-expanded-monitor \.hb-screen-panel > \.hb-btn \{[^}]*z-index:2147483001/);
  assert.doesNotMatch(source, /screenBot && route\.view !== "chat"/);
  assert.match(css, /\.hb-desktop-inline-monitor/);
  assert.match(css, /\.hb-desktop-inline-monitor \.hb-screen-state-live/);
});

test('screen lifecycle exposes a conservative memory gate, idle stop and ownership hand-back', () => {
  assert.match(source, /SCREEN_MIN_FREE_MEMORY_MB = 768/);
  assert.match(source, /resource_gate === "blocked_low_memory"/);
  assert.match(source, /display\.stop/);
  assert.match(source, /screenIdleMinutes/);
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /display\.lease\.release/);
  assert.match(source, /current\?\.lease\?\.holder === "human"/);
});

test('mobile composer reserves its own height so message text cannot sit behind it', () => {
  assert.match(css, /--hb-composer-reserve/);
  assert.match(css, /padding-bottom:calc\(var\(--hb-composer-reserve\)/);
  assert.match(css, /\.hb-mobile-surface(?:\.is-chat)? \.hb-composer-wrap/);
  assert.match(css, /\.hb-mobile-surface(?:\.is-chat)? \.hb-messages \{[^}]*overflow-y:auto/);
  assert.match(css, /\.hb-mobile-surface(?:\.is-chat)? \.hb-composer-wrap \{[^}]*position:relative/);
  assert.match(css, /\.hb-desktop-main > \.hb-chat-layout \{[^}]*display:flex/);
  assert.match(css, /\.hb-desktop-main \.hb-messages \{[^}]*overflow-y:auto/);
  assert.match(css, /\.hb-desktop-main \.hb-composer-wrap \{[^}]*position:relative/);
  assert.match(css, /\.hb-root \{[^}]*box-sizing:border-box[^}]*padding:0/);
  assert.match(css, /\.hb-desktop-surface \{[^}]*height:100%/);
  assert.match(css, /\.hb-desktop-workspace \{[^}]*height:100%;[^}]*min-height:0;[^}]*overflow:hidden/);
  assert.match(css, /\.hb-desktop-main \{[^}]*height:100%;[^}]*min-height:0/);
  assert.match(css, /\.hb-desktop-main > \.hb-chat-layout \{[^}]*min-height:0;[^}]*height:100%/);
  assert.match(css, /\.hb-desktop-main \.hb-chat-header \{[^}]*position:relative;[^}]*top:auto/);
  assert.match(css, /\.hb-desktop-main \.hb-composer-bar > \.hb-attachment-actions button \{[^}]*display:inline-flex/);
  assert.match(css, /\.hb-desktop-main \.hb-composer-bar \.voice-button \{[^}]*display:inline-grid/);
  assert.match(css, /\.hb-desktop-main \.hb-composer-wrap \{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(css, /\.hb-desktop-main \.hb-composer \{[^}]*width:auto/);
});

test('first-run onboarding exposes required checks, optional viewer status, copyable commands and recheck', () => {
  assert.match(source, /function OnboardingCard/);
  assert.match(source, /\/diagnostics\?profile=/);
  assert.match(source, /Copiar acción/);
  assert.match(source, /Volver a comprobar/);
  assert.match(source, /hermes plugins validate/);
  assert.match(source, /hermes-bots-console\.onboarding/);
});

test('visual contract keeps technical metadata out of the default roster and chat surface', () => {
  assert.match(source, /Editar bot/);
  assert.match(source, /Abrir monitor/);
  assert.match(source, /hb-compose-plus/);
  assert.match(source, /hb-compose-mic/);
  assert.match(source, /hb-editor-sheet/);
  assert.match(source, /hb-chat-name/);
  assert.doesNotMatch(source, /className: "hb-chat-identity", type: "button"/);
  assert.match(css, /safe-area-inset-bottom/);
});

test('roster uses app-like long press semantics instead of avatar editing', () => {
  assert.match(source, /useLongPressReorder/);
  assert.match(source, /onPointerDown/);
  assert.match(source, /onPointerMove/);
  assert.match(source, /onPointerUp/);
  assert.match(source, /onHoldRelease/);
  assert.match(source, /clone_from: "default"/);
  assert.match(source, /DISPLAY_NAME_RE/);
  assert.match(source, /profileIdFromDisplayName/);
  assert.match(source, /saveProfileDisplayName/);
  assert.match(source, /api\.deleteProfile/);
  assert.doesNotMatch(source, /name\.trim\(\)\.toLowerCase\(\)/);
  assert.match(source, /Confirmar eliminación/);
  assert.match(source, /is_default.*No se puede mover ni eliminar/);
  assert.match(source, /onHoldRelease: bot\.is_default \? undefined/);
  assert.match(source, /document\.addEventListener\("touchmove"/);
  assert.match(source, /getBoundingClientRect\(\)/);
  assert.match(source, /translate3d/);
  assert.match(source, /shifts/);
  assert.match(source, /onDragStart\?\.\(\{ \.\.\.event, clientX: gesture\.x, clientY: gesture\.y \}\)/);
  assert.match(css, /transition:transform 160ms ease/);
  assert.doesNotMatch(source, /dataTransfer\?\.setData\("text\/plain", key\)/);
  assert.doesNotMatch(source, /disabled: Boolean\(bot\.is_default\)/);
  assert.doesNotMatch(css, /grid-template-columns:62px minmax\(0,1fr\) auto 22px/);
  assert.doesNotMatch(source, /hb-bot-row-avatar[\\s\\S]{0,240}onEdit\\(bot\\)/);
});
