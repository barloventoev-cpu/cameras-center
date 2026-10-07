# Cameras Center

Monorepo para ver cámaras IP de la red local en vivo desde el navegador, exponer ese
stream y sus metadatos vía API para que otras aplicaciones lo consuman.

```
[Cámaras RTSP/ONVIF] ──► AGENT (LAN) ──┬──► web local    (baja latencia)
                                       │
                                       └──► SERVER (Render) ◄── web remoto (Vercel)
                                                 │
                                                 └──► API pública (REST + WS)
```

## Estructura

```
apps/
  agent/     Daemon edge. Corre en una máquina de la LAN: descubre cámaras,
             lee RTSP, transcodifica y hace push al server. (Node + FFmpeg)
  server/    API REST + WebSocket. Registro, auth, relay de streams. (Render)
  web/       UI. Grid de cámaras en vivo y panel de administración. (Vercel)
packages/
  protocol/  Tipos + esquemas Zod compartidos (contrato de mensajes).
  core/      Utilidades: cifrado de credenciales, parsing RTSP, API keys.
  ui/        Componentes React reutilizables (grid, tarjeta, badges).
```

## Requisitos

- Node.js >= 20
- npm >= 9 (workspaces)
- FFmpeg en el PATH (solo para el agent, a partir de F1): `ffmpeg -version`

## Puesta en marcha

```bash
cp .env.example .env      # completa los valores
npm install
npm run typecheck         # valida todo el monorepo
npm run dev               # server :4000 · agent :4100 · web :5173
```

O con el lanzador, que comprueba Node/FFmpeg, crea el `.env` si falta (generando
los secretos), instala dependencias y valida los puertos antes de arrancar:

```bash
./start.sh                # arranca los tres servicios
./start.sh --check        # sólo comprueba requisitos y puertos
./start.sh --install      # npm install + arranque
./stop.sh                 # los detiene (da igual cómo se hayan arrancado)
```

### Arranque automático al encender la PC

Unidades **systemd de usuario** (sin sudo): arrancan al arrancar la máquina,
aunque nadie haya iniciado sesión, y se relanzan solas si alguna se cae.

```bash
./autostart.sh on         # instala + habilita las unidades y las arranca
./autostart.sh status     # estado de las unidades y health de cada servicio
./autostart.sh logs       # journalctl en vivo de server/agent/web
./autostart.sh off        # desinstala el autoarranque y los para
```

- `on` activa `loginctl enable-linger $USER`; si polkit no lo permite sin
  contraseña, lo indica con el comando exacto a ejecutar con `sudo`.
- Los servicios viven en `~/.config/systemd/user/cameras-{server,agent,web}.service`.
- `./stop.sh` los **para ahora** pero deja el autoarranque puesto; para que no
  arranquen al próximo encendido usa `./autostart.sh off`.
- Logs: `journalctl --user -u cameras-server -u cameras-agent -u cameras-web`.

> 📄 **PC con Ubuntu 24.04 + cámaras EZVIZ:** ver la guía completa en
> [`docs/UBUNTU.md`](docs/UBUNTU.md) (instalación, red, URLs RTSP, systemd).
>
> 📷 **Cámara ya comprobada (O-KAM/EZVIZ, RTSP :10554 `/tcp/av0_0`):**
> [`docs/CAMARAS-COMPROBADAS.md`](docs/CAMARAS-COMPROBADAS.md).
>
> 🗄 **Supabase (auth + persistencia):** [`docs/SUPABASE.md`](docs/SUPABASE.md).

| Servicio | URL |
|---|---|
| Web (Vite) | http://localhost:5173 |
| API server | http://localhost:4000/api/health |
| API cámaras | http://localhost:4000/api/v1/cameras |
| Stream MJPEG (agent) | http://localhost:4100/stream/{id}.mjpg |

## Autenticación (F2)

```bash
# primer usuario (queda como owner)
curl -X POST http://localhost:4000/api/auth/register \
  -H 'content-type: application/json' -d '{"email":"yo@local","password":"<tu-password>"}'
# → {"token":"eyJ..."}

# crear cámara (exige token)
curl -X POST http://localhost:4000/api/v1/cameras \
  -H 'content-type: application/json' -H 'authorization: Bearer $TOKEN' \
  -d '{"name":"Entrada","sourceType":"rtsp","connection":"rtsp://admin:pass@192.168.1.10:554/..."}'
```

`GET /api/v1/cameras` es público y **no incluye** la URL de conexión; la recibe
sólo el agent (`/api/agent/cameras`, cabecera `x-agent-token`).

- Sin `SUPABASE_SERVICE_KEY`, el server arranca en **modo memoria** (todo funciona,
  pero nada persiste). Setup completo: [`docs/SUPABASE.md`](docs/SUPABASE.md).
- SQL inicial: [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).

## Cómo llega la imagen al navegador (F3)

Hay dos caminos y la app elige el primero que funcione:

```
(1) LAN (rápido)      navegador ──HTTP MJPEG──► agent :4100 ──► FFmpeg ──► cámara
(2) Relay (remoto)    navegador ──WS──► server ──WS──► agent ──► FFmpeg ──► cámara
                       (JWT)           (JWT)            (AGENT_TOKEN)
```

1. **Directo**: el `<img>` apunta a `VITE_AGENT_URL` (sólo funciona en la LAN).
2. Si esa imagen falla, la tarjeta **cambia sola a `🌐 Servidor`**: se suscribe
   por WebSocket al server, éste le pide al agent que arranque FFmpeg y reenvía
   cada JPEG por `stream:frame` (binario). También se cambia a mano con el
   botón de cada tarjeta.

Detalles que importan:

- **Sólo hay relay si alguien mira.** Al suscribirse llega `server:startStream`
  al agent; al dejar de mirar, `server:stopStream` → el agent se desprende y
  FFmpeg se apaga a los `AGENT_NO_VIEWER_STOP_MS` sin espectadores.
- **Backpressure**: el server manda los frames con *ack*; si un cliente va lento
  (más de 4 sin confirmar) se le **saltan** frames en vez de encolarlos. El agent
  además emite con `socket.volatile`: si la subida se satura, se descarta.
- **Rate**: `RELAY_FPS` (por defecto 6) limita lo que sube por la WAN.
- **Auth**: el WS valida en el handshake (`auth.token` = AGENT_TOKEN para el
  agent, JWT para los espectadores) y rechaza todo lo demás.
- **`GET /api/v1/cameras/:id/frame.jpg`** (JWT o API key) devuelve el último
  JPEG: fallback para quien no pueda abrir WebSocket y base de F5/F6. Con el
  agent apagado devuelve **404** en cuanto la foto cumple `FRAME_MAX_AGE_MS`
  (60 s por defecto) en lugar de una imagen fantasma, y siempre manda
  `X-Frame-Age-Ms`.
- Al suscribirse llega primero el último frame cacheado con `seq: -1`
  ("puesta al día") para no dejar pantalla negra.

```bash
npm run test:relay     # 26 comprobaciones; necesita server + agent levantados
```

## Miniaturas en Cloudinary (F4)

El server no habla con la cámara: **aprovecha los frames que ya recibe por el
relay** y cada `THUMB_INTERVAL_MS` (5 min por defecto) sube uno a Cloudinary con
`public_id` fijo por cámara → se sobrescribe y nunca se acumulan assets.

```
frame (WS) ──► frameCache ──► uploadJpeg() ──► Cloudinary ──► URL pública
                                (firma SHA-1)       │
                                                    ▼
                                    events (type='thumbnail')  ← última URL
```

- La URL se guarda en `events` (**sin migración**: la tabla ya tenía
  `thumbnail_url`), manteniendo **una sola fila por cámara**.
- **`GET /api/v1/cameras/thumbnails`** (JWT) → `{cameraId: url}`: es el póster
  de cada tarjeta cuando aún no hay vídeo.
- **`POST /api/v1/cameras/:id/thumbnail`** (JWT) → captura *ahora* y devuelve
  la URL. Botón **📸 Capturar** de la UI; si falla, la app cae al snapshot
  directo del agent (sólo LAN).
- Las credenciales van en `CLOUDINARY_URL` (`.env`, gitignored); la firma es
  SHA-1 de los parámetros ordenados + `api_secret`, y la key nunca se loguea.

```bash
npm run cloud:ping -- --clean   # sube y baja un JPEG de prueba con tu cuenta
npm run test:f4                 # 23 comprobaciones end-to-end
```

## Descubrimiento ONVIF (F4)

```bash
npm run discover:onvif                    # WS-Discovery por UDP (239.255.255.250:3702)
npm run discover:onvif -- --timeout 8000   # más paciencia
npm run discover:onvif -- --user admin --pass ****
npm run discover:onvif -- --xaddr http://192.168.1.10:8000/onvif/device_service
```

Por cada dispositivo resuelve `GetDeviceInformation → GetCapabilities →
GetProfiles → GetStreamUri` y devuelve **la URL RTSP lista para pegar en la
app**. Autenticación WS-Security *UsernameToken* (PasswordDigest) + Basic HTTP.

> Las cámaras "RTSP puro" (como la O-KAM de esta red, que sólo abre el 10554)
> **no responden**: no hablan ONVIF. Para saber qué devuelve la sonda contra una
> cámara real sin tenerla a mano: `npm run test:onvif` (mock SOAP local, 18 checks).

## Búsqueda de cámaras desde la web (F8)

La app tiene un panel **📡 Descubrir cámaras en la red** (arriba, junto a
*Añadir cámara*) que barre la LAN y devuelve lo que encuentra con la URL
candidata lista para pegar. El botón **Usar** rellena el formulario de alta
(sólo falta añadir `usuario:contraseña@` detrás de `rtsp://`).

```bash
# desde la API (sólo JWT) — lo mismo que hace el panel:
curl -X POST http://localhost:4000/api/v1/discover \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{}'                          # subred autodetectada
#   -d '{"ip":"192.168.1.20"}'     # búsqueda puntual de una IP
#   -d '{"subnet":"192.168.1.0/24","onvif":false}'
```

La búsqueda **la hace el agent**, que es el único que está en la LAN: el server
(en producción, en Render) sólo correlaciona la petición con la respuesta por
WebSocket (`server:discover` → `agent:discoverResult`, mismo `requestId`). Dos
sondeos en paralelo:

1. **TCP** por los puertos típicos (80, 443, 554, 8554, 8080, 8000, 37777,
   8899, 10554, 34567). En cada host vivo sondea HTTP (`Server`/`Title`) y RTSP
   con `DESCRIBE` probando varias rutas: la O-KAM sólo contesta a `/tcp/av0_0`.
2. **ONVIF** por WS-Discovery (UDP `239.255.255.250:3702`) →
   `GetDeviceInformation → GetCapabilities → GetProfiles → GetStreamUri`
   (marca, modelo y URL RTSP).

Tarda de 5 a 10 s en una LAN doméstica. Respuestas: `200` con los hosts,
`409` si no hay agent conectado, `504` si no contesta, `502` si el agent
devuelve error (p. ej. *«ya hay una búsqueda en curso»*) y `429` a partir de 10
barridos por minuto y usuario.

## API pública para terceros (F5)

La razón de ser del proyecto: que **otras apps** consuman las cámaras sin
compartir el JWT de la UI.

```bash
# 1) crear la clave (se devuelve UNA sola vez: en la BD sólo está su hash)
curl -X POST http://localhost:4000/api/v1/keys \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"label":"mi-app","scopes":["read","stream"],"rate_limit":120}'

# 2) usarla
curl -H "X-API-Key: cc_live_…" http://localhost:4000/api/v1/cameras
curl -o foto.jpg -H "X-API-Key: cc_live_…" http://localhost:4000/api/v1/cameras/$ID/frame.jpg
```

| Qué | Ruta | Auth |
|---|---|---|
| Listar/crear/claves | `GET/POST /api/v1/keys` · `DELETE /api/v1/keys/:id` | JWT (`owner`) |
| Cámaras | `GET /api/v1/cameras[/:id]` | pública |
| Escritura | `POST`/`DELETE /api/v1/cameras` | JWT (nunca API key) |
| Fotograma | `GET /api/v1/cameras/:id/frame.jpg` | JWT o key (`read`) |
| Miniaturas | `GET /api/v1/cameras/thumbnails` | JWT o key (`read`) |
| **Stream MJPEG** | `GET /api/v1/streams/:id.mjpg` | JWT o key (`read`) |
| Documentación | `GET /api/docs` · `GET /api/openapi.json` | pública |

- **Claves**: formato `cc_live_<40 hex>`; en la BD sólo se guarda su **hash
  SHA-256**, por eso la clave se muestra una única vez. Scopes `read` (REST) y
  `stream` (WebSocket). La UI tiene un panel **🔑 API keys** para crearlas y
  revocarlas.
- **MJPEG sin SDK**: `…/streams/:id.mjpg` es `multipart/x-mixed-replace`, sirve
  en un `<img src>`, en VLC o con `ffmpeg -i`. Al abrirlo el server se registra
  como espectador (`gateway.acquire`) → pide el stream al agent; al cerrarlo lo
  suelta y FFmpeg se apaga solo. Si 60 s no llega imagen, cierra la conexión.
- **WebSocket**: `io(url, { auth: { token: <JWT|key> } })` + `viewer:subscribe`
  → binario `stream:frame`. Una key sin scope `stream` recibe
  `connect_error: scope-stream`.
- **Rate limits** en memoria (ventana fija de 60 s), visibles en cada respuesta
  (`X-RateLimit-Limit/Remaining/Reset`):

  | Bucket | Límite | Variable |
  |---|---|---|
  | IP | 300/min | `RATE_LIMIT_RPM` |
  | API key | su `rate_limit` (60/min por defecto) | por clave |
  | login/registro | 10/min por IP | `AUTH_RATE_LIMIT_RPM` |

  Al agotarse: `429` + `Retry-After` + cuerpo con `retryAfterSec`.
- **Docs**: `/api/docs` (HTML autocontenido, sin CDN) y `/api/openapi.json`
  (OpenAPI 3.0, importable en Postman/Insomnia). Ambos enlazados desde la UI.

```bash
npm run test:f5        # 62 comprobaciones end-to-end
```

## Detección de movimiento y webhooks (F6)

El agent lanza **un FFmpeg por cámara** —distinto del de visión— que mide la
puntuación de escena de cada muestra y sólo emite el JPEG cuando supera el
umbral: la foto del aviso es, literalmente, la del instante.

```
FFmpeg (2 fps) ──stderr──► lavfi.scene_score=…   ¿ ≥ MOTION_THRESHOLD?
      └────stdout────► JPEG sólo al superar el umbral
                            │
                            ▼  agent:event (WS + imagen en base64)
server ──► Cloudinary (events/<cámara>/<ms>) ──► fila en events ──► webhooks
```

- **Ajustes** (`.env`, los lee el agent): `MOTION_ENABLED`, `MOTION_FPS`,
  `MOTION_THRESHOLD`, `MOTION_COOLDOWN_MS` (enfriamiento entre avisos de la
  misma cámara) y `MOTION_WIDTH` (ancho de la foto).
- **Umbral**: con la O-KAM de esta red la escena en reposo ronda 0.0001 y el
  ruido máximo medido ha sido 0.0081 (119 muestras), así que `0.03` deja margen
  para no disparar con el ruido. Se afina con
  `npm run probe:motion -- --segundos 60`, que imprime mediana, pico, JPEG
  emitidos y umbral sugerido; en caliente, `GET :4100/api/motion` (`maxScore`,
  `detections`).
- **El detector mantiene su propia sesión RTSP** aunque nadie esté mirando (la
  O-KAM admite varias sesiones concurrentes); se apaga con `MOTION_ENABLED=false`.
- **Server**: sube la foto a Cloudinary, guarda la fila (**sin migración**: la
  tabla `events` ya tenía `thumbnail_url`) y avisa a los webhooks.
- **Webhooks**: `POST`/`GET`/`DELETE /api/v1/webhooks` (JWT de owner; el secreto
  se devuelve **una sola vez**, al crearlo). Cada envío lleva
  `x-cameras-signature: sha256=HMAC-SHA256(secreto, timestamp.cuerpo)` y
  reintenta (`WEBHOOK_ATTEMPTS`, `WEBHOOK_RETRY_MS`, `WEBHOOK_TIMEOUT_MS`);
  éxitos, fallos y último error salen en `/api/health`. Se siembran en `.env`
  con `WEBHOOK_URL` (+ `WEBHOOK_SECRET`).
- **API**: `GET /api/v1/events[?cameraId=&type=&limit=]` (JWT o API key con
  scope `read`), `DELETE /api/v1/events/:id` (JWT) y `event:new` en directo por
  el WebSocket.
- **UI**: panel «Movimiento y webhooks» (avisos con su foto, crear y borrar
  webhooks) y los contadores en la sección **Estado**.

```bash
npm run probe:motion -- --segundos 60   # sonda de umbral contra la cámara real
npm run test:motion                     # 32 checks con fuente sintética
npm run test:f6                         # 75 comprobaciones end-to-end
```

## Grabación de clips por eventos (F7)

Con cada aviso de movimiento el agent arranca **otro FFmpeg propio** que graba
unos segundos de esa cámara en un MP4, lo guarda en disco local y lo sube a
Cloudinary. Por el WebSocket sólo viaja la **URL** (el socket limita cada
mensaje a 2 MB).

```
aviso (F6) ──► FFmpeg -t N ──► data/clips/<cámara>/<ms>.mp4 ──► Cloudinary
              (mp4 fragmentado)                                     │
                                                     agent:clipReady (URL)
server ──► ¿aviso de esa cámara ≤ 60 s?  ─sí─► payload.clip del aviso
             └─no─► fila type='clip' ──► webhooks (si se suscribió) + UI
```

- **Codec**: `-c:v copy` sobre RTSP/ONVIF (el H.264 nativo no se recodifica) y
  `libx264` para MJPEG/test, que no traen H.264. La duración va en `-t` para
  que el proceso se muera solo; un temporizador extra lo mata si la sesión
  RTSP se atasca (en F6 ya vimos el coste de los FFmpeg huérfanos).
- **MP4 fragmentado** (`+frag_keyframe+empty_moov+default_base_moof`): es
  reproducible aunque FFmpeg muera a mitad de la grabación.
- **Disparo**: automático con cada aviso (`CLIP_ENABLED=false` lo apaga) o a
  mano con `POST /api/v1/cameras/:id/clip` (JWT, cuerpo opcional
  `{durationMs}` entre 1 s y 60 s → `202 Accepted`). Si no hay ningún agent
  conectado responde `409`; el `202` sólo confirma el pedido.
- **Ajustes** (`.env`, los lee el agent): `CLIP_ENABLED` (true),
  `CLIP_DURATION_MS` (15000), `CLIP_MAX_MS` (60000) y `CLIP_KEEP` (20 clips
  por cámara en disco; los más viejos se borran solos).
- **Server**: `recordAgentClip` pega el clip en el aviso más reciente de esa
  cámara si no tiene más de 60 s (**sin migración**: vive en `payload.clip`);
  si no hay aviso (grabación manual) crea una fila `type='clip'`. Los dos
  casos salen por `event:new` y en `GET /api/v1/events` con su campo `clip`;
  contadores en `GET /api/health` → `clips`.
- **Webhooks**: el evento `type='clip'` se envía sólo a quien se suscribió con
  `events: ["motion","clip"]` (por defecto los webhooks son sólo `["motion"]`).
- **UI**: la tarjeta del aviso reproduce el clip con `<video>` (póster: la foto
  del aviso) y cada cámara tiene el botón **⏺ Clip** para grabar a mano.
- **Mejora futura**: *pre-roll*, es decir, grabar también unos segundos ANTES
  del aviso; exige un búfer continuo por cámara. Hoy la foto de F6 cubre el
  instante exacto y el clip muestra lo que ocurre a partir de ahí.
- **Salud**: `GET /api/health` → `clips` (server) y `GET :4100/api/clips`
  (agent: grabaciones en marcha y estadísticas).

```bash
# Grabar un clip a mano (20 s) — el clip aparece en /api/v1/events
curl -X POST http://localhost:4000/api/v1/cameras/<id>/clip \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"durationMs": 20}'

npm run test:f7                         # 65 comprobaciones end-to-end
```

## Webcam local como cámara IP (F9)

Una webcam conectada al equipo del agent (`/dev/video0`, USB o integrada) se da
de alta como cualquier otra cámara —en el formulario, tipo *Webcam local*— y se
ve, se detecta y se graba igual que las de red.

- **El obstáculo**: V4L2 entrega el dispositivo a **un solo proceso**, y el
  agent tiene dos consumidores independientes por cámara activa: el pipeline de
  visión (F1/F3) y el detector de movimiento (F6). Si cada uno abría
  `/dev/video0`, el segundo recibía `Device or resource busy` y no se llegaba a
  ver nada.
- **La solución**: `apps/agent/src/local/webcam.ts` es el **único dueño** del
  dispositivo: un FFmpeg (`-f v4l2`) captura y reparte los frames por MJPEG en
  loopback a todos los consumidores, haciendo el papel que juega una cámara IP
  ante sus clientes.
- **Ciclo de vida**: el primer cliente arranca la captura y el último la deja en
  marcha 5 s más (sin espectadores la cámara no tiene por qué estar encendida).
  Si otra aplicación tiene la webcam (una videollamada, p. ej.) se reintenta con
  espera y se anota en el log, sin martillear.
- **Privacidad**: `/webcam.mjpg` y `/webcam.jpg` sólo contestan en **loopback**
  (`403` desde la LAN); el resto de la red ve la imagen por la app y por
  `/stream/:id.mjpg`.
- **Clips (F7)**: el MJPEG interno no trae marcas de tiempo y el demuxer
  `mpjpeg` asume 25 fps por índice de fotograma, así que el clip se re-tima con
  `setpts=N/<WEBCAM_FPS>/TB` y se recoge a 640 px. Sin eso salía 2,5×
  acelerado y no llegaba a grabar los 15 s antes del safety-net.
- **Depuración**: `GET :4100/api/webcam` (estado por dispositivo) y
  `GET :4100/webcam.jpg?device=/dev/video0`.

```bash
# crear la cámara desde la web (tipo "Webcam local") o por API:
curl -X POST http://localhost:4000/api/v1/cameras \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Webcam portátil","sourceType":"webcam","connection":"/dev/video0"}'

curl -s http://localhost:4100/api/webcam          # {"webcam":[{"device":"/dev/video0",…}]}
npm run test:webcam                               # auto-prueba F9
```

## Comandos

| Comando | Descripción |
|---|---|
| `npm run dev` | Levanta server + agent + web en paralelo |
| `./start.sh` | Lanzador con comprobaciones (Node, FFmpeg, `.env`, puertos) |
| `./stop.sh` | Detiene los servicios (systemd o en primer plano) |
| `./autostart.sh on\|off\|status\|logs` | Arranque automático al encender la PC (systemd de usuario) |
| `npm run discover` | Barre la red local buscando cámaras (RTSP/HTTP/ONVIF) |
| `npm run typecheck` | `tsc --noEmit` sobre todo el monorepo |
| `npm run build` | Compila todos los workspaces |
| `npm run start` | Arranca el server compilado (producción en Render) |
| `npm run db:ping` | Comprueba credenciales Supabase y tablas |
| `npm run cloud:ping` | Comprueba credenciales Cloudinary (sube y baja un JPEG) |
| `npm run discover -- --ip 192.168.1.0/24` | Descubre cámaras por RTSP/ONVIF en la LAN |
| `npm run discover:onvif` | Descubrimiento ONVIF real por WS-Discovery (UDP) |
| `POST /api/v1/discover` | F8: barre la red desde la web (la hace el agent) |
| `npm run test:relay` | F3: simula un espectador remoto y valida el relay |
| `npm run test:onvif` | F4: auto-test de la sonda ONVIF contra un mock |
| `npm run test:f4` | F4: health + thumbnails en Cloudinary end-to-end |
| `npm run test:f5` | F5: API keys, docs y rate limits end-to-end |
| `npm run probe:motion` | F6: sonda de umbral contra la cámara real (`--test`: fuente sintética) |
| `npm run test:motion` | F6: auto-prueba del detector con `testsrc` |
| `npm run test:f6` | F6: movimiento, snapshots y webhooks end-to-end |
| `npm run test:f7` | F7: grabación de clips (FFmpeg + Cloudinary) end-to-end |
| `npm run test:webcam` | F9: webcam local (V4L2) como cámara IP, auto-prueba |
| `GET :4100/api/webcam` | F9: estado de la captura de la webcam en el agent |
| `npm run test:ui` | Pruebas de interfaz con Chrome headless (capturas en `artifacts/ui`) |

## Roadmap

| Fase | Objetivo | Estado |
|---|---|---|
| **F0** | Monorepo, tipos compartidos, apps mínimas funcionando | ✅ |
| **F1** | Agent lee 1 cámara RTSP y se ve en el navegador | ✅ |
| **F2** | Supabase + auth JWT + agent autenticado contra el server | ✅ |
| **F3** | Relay agent → server → web remoto (multi-cámara) | ✅ |
| **F4** | Descubrimiento ONVIF + health + thumbnails en Cloudinary | ✅ |
| **F5** | API pública con API keys, docs y rate limits | ✅ |
| **F6** | Detección de movimiento + snapshots + webhooks | ✅ |
| **F7** | Grabación local de clips por eventos | ✅ |
| **F8** | Búsqueda de cámaras en la red desde la web (agent + ONVIF) | ✅ |
| **F9** | Webcam local (V4L2) como cámara IP | ✅ |

## Decisiones de diseño

- **Los navegadores no reproducen RTSP**: siempre pasa por el agent (FFmpeg).
- **El server en Render nunca ve las cámaras** (están en una LAN privada); el video
  sólo viaja de salida desde el agent hacia el server.
- **On-demand**: el agent sólo transcodifica una cámara cuando alguien la está mirando
  y la apaga a los 60 s sin espectadores.
- **Cloudinary** sólo para imágenes/clips cortos. El video en vivo nunca pasa por Cloudinary.
- **Supabase** guarda metadata (cámaras, usuarios, API keys, eventos), nunca video.
