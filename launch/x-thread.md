# X launch draft

Status: draft only. Do not publish until the repository URL, release URL and authorized X account are verified.

## English thread

1/ Hermes Bot Command adds a Bots workspace to the Hermes Dashboard: profile roster, bot chat, native groups and profile-scoped Turbo policy.

2/ The plugin keeps mutable state outside the installed bundle. Groups, policy metadata and temporary attachment descriptors live in Hermes profile storage; credentials and chat payloads are not stored there.

3/ The portable console works with Hermes on Linux, macOS and Windows after validation. The isolated desktop viewer is currently a Linux-gateway capability. Windows and macOS clients can use a remote Linux gateway.

4/ Turbo has Planning, Simulation and Autonomous modes. Login, MFA/CAPTCHA, payments, irreversible changes, legal actions and security changes still require a human decision.

5/ Release candidate: 0.5.0-rc.1. Code: [REPOSITORY_URL]. Notes: [RELEASE_URL].

## Borrador en español

1/ Hermes Bot Command suma un espacio Bots al Dashboard de Hermes: roster de perfiles, chat por bot, grupos nativos y política Turbo aislada por perfil.

2/ El plugin guarda el estado mutable fuera del bundle instalado. Los grupos, la política y los descriptores temporales usan almacenamiento del perfil; no se guardan credenciales ni payloads de chat.

3/ La consola está preparada para Linux, macOS y Windows después de validar cada combinación. El visor de escritorio aislado requiere por ahora un gateway Linux. Un cliente Windows o macOS puede usar un gateway Linux remoto.

4/ Turbo ofrece Planificación, Simulación y Autónomo. Login, MFA/CAPTCHA, pagos, cambios irreversibles, acciones legales y cambios de seguridad siguen requiriendo una decisión humana.

5/ Release candidate: 0.5.0-rc.1. Código: [REPOSITORY_URL]. Notas: [RELEASE_URL].

## Publishing gate

- [ ] Confirm the X account and OAuth app through the approved connector/browser flow.
- [ ] Replace both placeholders with URLs that were read back from the real release.
- [ ] Review the wording against the actual CI and platform matrix.
- [ ] Publish only after explicit authorization for this destination.
- [ ] Read back the resulting post/thread ID and URL; never store access tokens here.
