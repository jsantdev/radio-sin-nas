# Estructura de Radio TikTok Live

La aplicación es un único servidor Node.js modular. Las carpetas separan responsabilidades; no son servidores independientes ni microservicios.

## Mapa de carpetas

```text
.
  server.js                    # Arranque y composición de módulos
  modules/
    radio/
      index.js                 # Estado y ciclo de vida de la radio
      routes.js                # API y flujo SSE de la radio
    tiktok/
      index.js                 # Conecta el monitor y publica eventos normalizados
      routes.js                # /api/config, /api/events y /api/status
      tiktokMonitorService.js  # Conexión con tiktok-live-connector
      eventConfig.js           # Tipos y nombres de eventos
      giftTranslationService.js # Normaliza nombres de regalos
      eventFeedService.js      # Ordena eventos para el monitor
    overlay/
      index.js                 # Sirve la página de visualización
      index.html
    realtime/
      sseHub.js                # Clientes SSE y difusión de eventos
  public/
    index.html                 # Panel del conector en /backend
    playlist.html              # Gestión de playlist en /playlist
  test/
  data/
```

## Responsabilidades

| Unidad | Es responsable de |
|---|---|
| `radio` | Biblioteca de audio local, playlist persistente, selección de canción y estado de reproducción. |
| `tiktok` | Conectar/desconectar la cuenta, normalizar y filtrar eventos, guardar su configuración y exponer el registro. No depende del módulo de radio. |
| `overlay` | Servir el overlay público de TikTok Live. |
| `realtime` | Mantener conexiones SSE y emitir mensajes; no interpreta eventos de negocio. |
| `server.js` | Crear y conectar los módulos, montar rutas y cerrar recursos. |

El flujo actual es:

```text
TikTok Live -> módulo tiktok -> registro de eventos -> panel
                                     |
                                     +-> overlay (estado de conexión)
Archivos locales -> playlist -> reproductor del overlay
Módulo radio -> API y SSE -> reproductor y panel de playlist
```

## Contratos

Cada módulo dueño de rutas expone `registerRoutes(app)`. Los eventos TikTok normalizados pueden incluir `type`, `username`, `time`, `content`, `activityCount` y `diamondCount`; el conector es el único módulo que importa el SDK de TikTok. La conexión continúa aunque el módulo de radio aún no procese eventos.

`realtime/sseHub` es un contrato de transporte: `attach(response, mensajesIniciales)`, `broadcast(nombre, datos)` y `close()`. El significado de cada mensaje lo define el módulo que lo publica.

- `GET /api/radio-state` devuelve el estado actual y el orden de la playlist.
- `GET /api/radio-state/stream` publica un snapshot inicial y actualizaciones de reproducción.
- `GET /api/radio/tracks` lista los archivos locales admitidos; `POST` los carga y `DELETE` los elimina.
- `GET/PUT /api/radio/playlist` lee o guarda el orden persistente de las canciones.
- `POST /api/radio/current`, `/next`, `/previous` y `/playback` actualizan la reproducción.
- `GET /audio/:filename` sirve canciones desde `data/music`.
- `GET /api/events` publica `status`, `snapshot` y `update` para el registro TikTok.
- `GET/PUT /api/config` lee o cambia la cuenta de TikTok y los eventos ignorados.
- `GET /api/status` devuelve el estado del monitor y del conector.

La radio usa `data/music` para los archivos y `data/radio-playlist.json` para guardar el orden. El reproductor del overlay solicita una interacción del usuario si el navegador bloquea la reproducción automática. Las funciones de audio pertenecen a `modules/radio`; no deben acoplarse al SDK del conector.
