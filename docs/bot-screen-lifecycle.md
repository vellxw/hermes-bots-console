# Bot Screen contextual: lifecycle y RAM

## Política aplicada

- En PC, `view=chat` monta un único `ScreenPanel` profile-scoped dentro de `DesktopInspector`. El panel se inicia solo cuando el inspector es visible (`IntersectionObserver`) y muestra el estado real `idle`, `starting`, `connecting`, `live`, `stopped`, `blocked_low_memory`, `error` o `human_owned`.
- El monitor inline de PC es exclusivamente de observación: su canvas queda `viewOnly`. Abrir la vista por clic mantiene solo lectura; pulsar `Tomar control` expande el mismo panel y solicita automáticamente el lease cuando la vista grande termina de conectar, sin exigir un segundo clic. La superficie grande queda a pantalla completa con solo controles flotantes compactos; no se manipula el escritorio desde el preview chico.
- Roster, Marketplace, grupos y otras rutas desktop conservan un preview estático y no montan RFB/noVNC. La superficie expandida del chat reutiliza un único `ScreenPanel`, sin duplicar viewers, tickets o displays. La vista móvil conserva su acción explícita de viewer fullscreen/touch separado.
- `display.status` se consulta antes de arrancar. El guard acepta el contrato público del Gateway (`blocker`, `memory_available_mb`, `resource_gate` y presión de memoria), no baja `min_free_memory_mb` y no inicia cuando el estado indica memoria insuficiente. La interfaz muestra el motivo sin revelar tickets, cookies, rutas o credenciales.
- `display.observe` se ejecuta por intento de conexión para obtener un ticket fresco. AbortController, timeout y cierre del RPC/WebSocket cancelan un arranque colgado antes de reintentar.
- Un display ya activo no se duplica. Un lease humano nunca se adquiere ni se revoca automáticamente; si `lease.holder=human`, la vista queda en solo lectura. Solo se intenta `display.stop` si esta consola inició el display y la lectura inmediatamente anterior confirma que no hay lease humano.
- El viewer se desmonta al cambiar de bot, salir del chat o cerrar la ruta. Un panel inline que pierde visibilidad libera el viewer de inmediato y programa el idle-stop configurable del display auto-iniciado; el valor por defecto visible en el cliente es 30 minutos. La ruta móvil también libera viewer, timers y RPC al cerrar.

## Presupuesto de esta máquina

La máquina objetivo tiene aproximadamente 8 GiB de RAM. La política operativa es una pantalla viva como máximo; Chromium/Xvnc/Xfce se mantienen on-demand porque son el costo dominante observado. El umbral frontend de respaldo es 768 MiB, pero el `blocker` y la memoria calculados por el Gateway son autoritativos cuando están presentes. No se modificaron los defaults de Hermes ni la configuración de otros perfiles durante esta entrega.

La evidencia inicial de esta goal registró aproximadamente 7.5 GiB totales, 2.5 GiB disponibles y 1.4 GiB de swap usada. El perfil `xmanager` en `DISPLAY :20` pertenece a una sesión humana: no se detiene, no se toma su lease y no se usa como perfil de validación destructiva.

## Medición reproducible

El script stdlib `scripts/measure-bot-screen.py` omite PIDs, command lines, entornos, tickets y cookies. Solo agrega RSS/PSS por familia de proceso, memoria host/cgroup y marcadores booleanos del display.

Ejemplos, siempre desde la raíz del plugin:

```text
python scripts/measure-bot-screen.py --phase baseline --profile default --out "$TMPDIR/bot-screen-baseline.json"
python scripts/measure-bot-screen.py --phase starting --profile default
python scripts/measure-bot-screen.py --phase viewer_live --profile default
python scripts/measure-bot-screen.py --phase chat_exit --profile default
python scripts/measure-bot-screen.py --phase idle_recovery --profile default
```

Fases recomendadas: `baseline`, `starting`, `viewer_live`, `switch_profile`, `chat_exit`, `idle_recovery` y `error_recovery`. Comparar `process_families.chromium`, `process_families.xvnc`, `host_memory_mb.available`, `host_memory_mb.swap_used` y `cgroup_memory.current_mb`; la recuperación es válida solo si el viewer desaparece y los agregados vuelven cerca del baseline. No matar procesos para fabricar una muestra.

Una corrida controlada reproducida durante esta entrega sobre `default` no tocó el perfil humano `xmanager`:

1. Baseline con `default` detenido: 7,679.1 MB totales, 3,167.9 MB disponibles, 2,449.1 MB de swap usada; Xvnc agregado 20.9/2.5 MB RSS/PSS y sesión desktop 151.6/14.6 MB.
2. `hermes computer-use screen start` en `default`: RFB profile-scoped activo en `:22`; 2,863.0 MB disponibles; Xvnc agregado 108.1/41.0 MB y sesión desktop 557.2/142.0 MB. El delta atribuible al display nuevo fue aproximadamente +87.2/+38.5 MB RSS/PSS para Xvnc y +405.6/+127.4 MB RSS/PSS para la sesión desktop. No apareció Chromium adicional en esta corrida.
3. El smoke RFB profile-scoped pasó: RFB 003.008, `1440x900`, identidad `hermes:default`, 23 rectángulos y 259,200 bytes de píxeles. Esto prueba el framebuffer/socket del perfil, no el viewer noVNC del Dashboard.
4. `hermes computer-use screen stop` dejó `default` detenido; 2,990.5 MB disponibles, Xvnc 20.9/2.5 MB y sesión desktop 151.6/14.6 MB. Los marcadores `rfb.sock`, `launcher.pid` y `env` del perfil quedaron ausentes. La recuperación de memoria disponible no volvió exactamente al baseline por la presión fluctuante del host, pero los procesos del display auto-iniciado sí desaparecieron.

El perfil humano `xmanager` permaneció activo con su lease humano durante toda la corrida. No se midió un estado `viewer_live` noVNC autenticado porque el Bot Screen propio no estaba disponible para una validación visual sostenida; no se presenta el smoke RFB como sustituto.

## Rollback

Esta entrega no cambió `config.yaml`, `auto_start`, `idle_stop_minutes` ni `min_free_memory_mb`; por eso el rollback no requiere restaurar configuración. La ruta segura es:

1. detener el Dashboard de forma normal;
2. reinstalar el bundle previo del plugin, conservando la data profile-scoped;
3. validar manifest/SRI y abrir un chat con un único perfil;
4. confirmar que el display humano `xmanager` sigue activo antes de cualquier prueba posterior.

Si una operación futura cambia defaults, primero debe guardar el estado legible de la configuración por perfil, aplicar un solo cambio, leerlo de vuelta y registrar el comando inverso. Nunca usar `force:true` para un display con lease humano. La data de perfiles no debe borrarse como parte del rollback.

## Límites conocidos

El cliente no inventa un RPC para medir PSS ni para detener displays: consume los métodos públicos `display.status`, `display.start`, `display.observe`, `display.stop` y `display.lease.*`. La certificación visual autenticada y una medición `viewer_live` real dependen de que el Gateway del perfil tenga Bot Desktop instalado y de que el Bot Screen propio esté disponible; una captura estática o una respuesta HTTP no cuenta como monitor vivo.
