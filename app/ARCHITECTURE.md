# Estructura de Radio TikTok Live

La radio es un servidor Node.js modular; `biblioteca-musical` es un servicio independiente para conservar la biblioteca entre versiones de la radio.

## Mapa de carpetas

```text
.
  server.js                    # Arranque y composición de módulos
  modules/
    radio/
      index.js                 # Estado y ciclo de vida de la radio
      routes.js                # API y flujo SSE de la radio
      externalLibraryClient.js # Cliente de biblioteca externa y URL persistente
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
    index.html                 # Página anterior del panel (redireccionada)
    playlist.html              # Playlist y ajustes unificados
  test/
  data/
../biblioteca-musical/
  server.js                    # Servicio externo de archivos agrupados por disco
```

## Responsabilidades

| Unidad | Es responsable de |
|---|---|
| `radio` | Biblioteca local o externa, playlist persistente, selección de canción y estado de reproducción. |
| `biblioteca-musical` | Servicio de archivos con operaciones de creación, lectura y eliminación; agrupa los temas por disco y conserva sus datos en un volumen propio. |
| `tiktok` | Conectar/desconectar la cuenta, normalizar y filtrar eventos, guardar su configuración y exponer el registro. No depende del módulo de radio. |
| `overlay` | Servir el overlay público de TikTok Live. |
| `realtime` | Mantener conexiones SSE y emitir mensajes; no interpreta eventos de negocio. |
| `server.js` | Crear y conectar los módulos, montar rutas y cerrar recursos. |

El flujo actual es:

```text
TikTok Live -> módulo tiktok -> registro de eventos -> panel
                                     |
                                     +-> overlay (estado de conexión)
Biblioteca local o biblioteca-musical -> playlist persistente en radio -> reproductor del overlay
Módulo radio -> API y SSE -> reproductor y panel de playlist
```

## Contratos

Cada módulo dueño de rutas expone `registerRoutes(app)`. Los eventos TikTok normalizados pueden incluir `type`, `username`, `time`, `content`, `activityCount` y `diamondCount`; el conector es el único módulo que importa el SDK de TikTok. La conexión continúa aunque el módulo de radio aún no procese eventos.

`realtime/sseHub` es un contrato de transporte: `attach(response, mensajesIniciales)`, `broadcast(nombre, datos)` y `close()`. El significado de cada mensaje lo define el módulo que lo publica.

- `GET /api/radio-state` devuelve el estado actual y el orden de la playlist.
- `GET /api/radio-state/stream` publica un snapshot inicial y actualizaciones de reproducción.
- `GET /api/radio/tracks` lista los archivos locales o externos; `POST` los carga y `DELETE` los elimina.
- `POST /api/radio/discs` crea o selecciona un disco en la biblioteca externa.
- `GET/PUT /api/radio/storage` consulta y persiste la URL del servicio externo en `data/external-library-config.json`.
- `GET/PUT /api/radio/playlist` lee o guarda el orden persistente de las canciones.
- `POST /api/radio/current`, `/next`, `/previous` y `/playback` actualizan la reproducción.
- `GET /audio/:filename` sirve o transmite canciones desde `data/music` o desde la biblioteca externa.
- `GET /api/events` publica `status`, `snapshot` y `update` para el registro TikTok.
- `GET/PUT /api/config` lee o cambia la cuenta de TikTok y los eventos ignorados.
- `GET /api/status` devuelve el estado del monitor y del conector.

La radio usa `data/music` para archivos locales y `data/radio-playlist.json` para guardar el orden. `biblioteca-musical` mantiene sus archivos bajo `BIBLIOTECA_DATA_DIR`; su API permite crear, leer y borrar temas, agrupados en discos. El reproductor del overlay solicita una interacción del usuario si el navegador bloquea la reproducción automática. Las funciones de audio pertenecen a `modules/radio`; no deben acoplarse al SDK del conector.
