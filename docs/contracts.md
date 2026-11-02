# Contratos compartidos de Hermes Bot Command

Versión: 1
Fuentes:

- `contracts/bot-console-contracts.json`: catálogo canónico de campos, límites y fixtures.
- `dashboard/contracts.mjs`: validadores y builders para Dashboard/ChatView/Bot Screen.
- `dashboard/contracts.py`: espejo puro de Python para routers y tests; no importa FastAPI ni Hermes core.
- `dashboard/contracts-v001.mjs`: copia versionada para consumidores que cargan assets cache-busted.

Regla de compatibilidad: los módulos nuevos deben consumir estos builders o respetar exactamente los campos del JSON. No se debe crear otro formato para el mismo concepto. Cambios incompatibles requieren incrementar `contract_version` y publicar un nuevo módulo versionado.

## 1. Estado durable por perfil

`profile_state` siempre tiene `contract_version`, `profile`, `updated_at`, `session`, `turbo` y `ui`.

- `profile`: identificador minúsculo `^[a-z0-9][a-z0-9_-]{0,63}$`.
- `session.stored_id` y `session.runtime_id`: identificadores Hermes, nunca credenciales.
- `turbo.mode`: `planning`, `simulation` o `autonomous`.
- `ui.route`: `roster`, `chat`, `groups` o `group`.
- La clave local es `hermes-bots-console.profile-state.<profile>`.
- Usar `createProfileStateStore(storage).get/update/remove`; el store no cruza perfiles.

No persistir en este contrato cookies, tokens, passwords, códigos, blobs, data URLs ni texto secreto.

## 2. Aislamiento Bot Screen

`isolation_binding` liga todos los recursos a un único `profile`:

```json
{
  "profile": "researcher",
  "browser_profile": "/.../profiles/researcher/bot-desktop/browser-profile",
  "desktop_name": "hermes:researcher",
  "display": {"number": 22, "socket": "/run/.../researcher/display.sock"},
  "gateway_socket": "/run/.../researcher/gateway.sock",
  "lease": {"profile": "researcher", "holder": "agent", "viewer_id": "viewer-researcher", "status": "held", "expires_at": null}
}
```

`holder` es `agent`, `human` o `none`; `status` es `held` o `released`. El número de display por sí solo no identifica al bot: la identidad comprobable es `profile`, `desktop_name` y las rutas profile-scoped. Un monitor puede usar RFB y el transporte WebSocket existente, pero no debe reutilizar browser-profile, socket o lease de otro perfil.

Usar `createIsolationBinding` al construir un binding y `validateIsolationBinding` antes de iniciar RFB, adquirir lease o abrir una sesión de navegador.

## 3. Ledger de autorizaciones

Cada grant contiene `grant_id`, `profile`, `service`, `account`, `capabilities`, `persistent`, `scope`, `owner`, `status`, `granted_at` y `expires_at`.

- `persistent=true` implica `scope="profile"`; de lo contrario el alcance es `once`.
- `owner` siempre es `{ "type": "profile", "profile": "..." }` en este plugin.
- Revocar conserva el registro con `status="revoked"` y vacía `capabilities`.
- Nunca enviar ni guardar password, token, secret, cookie, authorization, `data_url`, `base64` o bytes inline.
- `account` es una etiqueta/identificador permitido, no una credencial.

Usar `createAuthorizationLedger`, `grantAuthorization`, `revokeAuthorization` e `isAuthorizationActive`.

## 4. Auditoría

`audit_event` registra solamente metadatos operativos: `event_id`, `at`, `profile`, `type`, `actor`, `outcome` y `metadata`. Los tipos de la versión 1 están en el JSON; incluyen cambios de estado, binding/lease, autorizaciones, mensajes, respuestas y voz.

No registrar texto de conversación, Markdown, transcript, audio, payload completo, body, HTML ni datos sensibles. El fallo es cerrado: `createAuditEvent` rechaza metadata que pueda contenerlos.

## 5. Respuestas multimodales

`multimodal_response` tiene `response_id`, `profile`, `role`, `text`, `markdown`, `attachments`, `voice` y `created_at`.

Los adjuntos son descriptores (`id`, `profile`, `name`, `type`, `size`, `kind`, `source`, `storage_key`, `status`); el archivo se mantiene fuera del mensaje y `storage_key` es opcional pero, si aparece, debe coincidir exactamente con `hermes-bots-console://<profile>/<id>` (perfil idéntico, id opaco seguro). La voz es un descriptor con `voice_id`, `profile`, `mime_type`, `duration_ms`, `source`, `transcript`, `storage_key` y `status`; nunca contiene `data_url`, base64, Blob o bytes.

## 6. Markdown y voz

`normalizeMarkdownDocument` devuelve `{format: "gfm-safe", source, blocks}`. Los consumidores renderizan `blocks` como AST; no usan `innerHTML`. HTML arbitrario se elimina y las URLs ejecutables (`javascript:`/`vbscript:`) no se convierten en enlaces.

`normalizeVoiceDescriptor` permite solo `audio/mpeg`, `audio/mp4`, `audio/ogg`, `audio/wav` y `audio/webm`, limita la duración a una hora y exige perfil en la clave de almacenamiento.

## 7. Fixtures y dry-run

`createDryRunFixture("researcher", {now})` produce todas las superficies sin escribir archivos, abrir WebSockets, iniciar displays, pedir OAuth ni llamar servicios externos. Incluye `screen` (RFB `003.008`, `1440x900`, `desktop_name` profile-scoped), `group` (room de dos miembros, `thread_id`, `event_id` y capabilities nativas) y `rpc_responses` para `display.*` y `groups.*`. `createDryRunRpc(responses)` registra `{method, params}` en `calls` y devuelve respuestas locales; úselo en pruebas de ChatView/Bot Screen/RFB y grupos nativos.

La prueba ejecutable es:

```text
node --test tests/contracts.test.mjs
python -m unittest discover -s tests -p 'test_contracts.py' -v
```

Los tests de contrato deben seguir siendo deterministas pasando `now` fijo y nunca deben usar credenciales, cookies o servicios de Hermes reales.

## 8. Adjuntos temporales

`POST /api/plugins/hermes-bots-console/attachments?profile=<profile>` recibe `multipart/form-data` y devuelve un descriptor con `storage_key` opaco profile-scoped con forma exacta `hermes-bots-console://<profile>/<id>`. El binario se escribe de forma atómica dentro del directorio persistente del perfil (`$HERMES_HOME/profiles/<profile>/plugin-data/hermes-bots-console/attachments/`); el estado de ChatView solo conserva metadatos y nunca una ruta del sistema, base64 o contenido inline. El servidor valida nombre, extensión/MIME y un máximo de 25 MiB.

`DELETE /attachments/{id}` elimina un descriptor concreto y `POST /attachments/cleanup` ejecuta la limpieza controlada por TTL (24 horas por defecto). La limpieza únicamente usa ids generados por el plugin dentro del directorio del perfil y conserva un `manifest.json` sin datos de conversación.

## 9. Adaptador de voz

`POST /audio/transcribe` usa el contrato inyectable `configure_audio_adapters(transcriber=..., synthesizer=...)`. El transcriber recibe `Path`, `profile` y `mime_type`; los bytes solo existen en un temporal profile-scoped y se borran al finalizar. Sin proveedor, el endpoint responde 503 con `adapter contract pending` en vez de inventar una transcripción.

`POST /audio/synthesize` es opcional: el sintetizador devuelve `Path` o `{path, mime_type, duration_ms}` y el plugin conserva el resultado como descriptor profile-scoped. `GET /audio/{voice_id}` sirve el audio únicamente después de validar el id y el perfil. La UI usa `FormData` para grabaciones, muestra `grabando/transcribiendo/error` y agrega `<audio controls>` solo para respuestas con descriptor; no construye data URLs ni expone secretos.

## 10. Puente Gateway para adjuntos

Cuando el Gateway anuncia sus capacidades nativas, ChatView entrega el Blob temporal al contrato existente: `image.attach_bytes` para imágenes y `file.attach` para PDFs/documentos/archivos. Para `image.attach_bytes` se envía `content_base64`; para `file.attach` el contrato de Hermes core exige `data_url` completo (`path` solo sirve si el archivo ya es visible para el Gateway) y `name` como etiqueta. El `prompt.submit` posterior usa únicamente sus campos declarados; no agrega un campo `attachments` propietario ni registra base64 en el mensaje. Las referencias internas que devuelve `file.attach` se consumen dentro de la sesión y no se muestran en los chips de ChatView. Si el Gateway no ofrece el método, la operación falla de forma visible y no se afirma que el agente recibió el archivo; no se modifica Hermes core ni se envían datos a servicios externos.
