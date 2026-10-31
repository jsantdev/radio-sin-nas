# Estructura de Radio TikTok Live

El repositorio contiene dos servicios Node.js independientes: Radio integra TikTok Live y el overlay; Biblioteca conserva el catálogo musical y controla la reproducción.

## Mapa de carpetas

```text
repo/
  app/
    server.js                  # Arranque y composición del servicio de Radio
    modules/
      radio/                   # Estado, rutas y cliente HTTP de Biblioteca
      tiktok/                  # Conector, configuración y eventos normalizados
      overlay/                 # Overlay público y ajustes visuales
      realtime/sseHub.js       # Clientes SSE y difusión de eventos
    public/backend.html        # Panel técnico de Radio
    test/
    data/
  biblioteca/
    server.js                  # Catálogo, reproductor y migraciones
    public/                    # Panel de administración de Biblioteca
    test/
  docs/contratos/              # Especificaciones OpenAPI y guía de integración
```

## Responsabilidades

| Unidad | Es responsable de |
|---|---|
| `radio` | Conectar con Biblioteca, exponer estado de reproducción y transmitir el tema actual al overlay. |
| `biblioteca` | Servicio de archivos con operaciones de creación, lectura y eliminación; agrupa temas por disco y conserva archivos, playlist, programación e historial de migraciones en un volumen persistente. |
| `tiktok` | Conectar/desconectar la cuenta, normalizar y filtrar eventos, guardar su configuración y exponer el registro. No depende del módulo de radio. |
| `overlay` | Servir el overlay público de TikTok Live. |
| `realtime` | Mantener conexiones SSE y emitir mensajes; no interpreta eventos de negocio. |
| `server.js` | Crear y conectar los módulos, montar rutas y cerrar recursos. |

El flujo actual es:

```text
TikTok Live -> módulo tiktok -> registro de eventos -> panel
                                     |
                                     +-> overlay (estado de conexión)
Biblioteca -> playlist y audio -> módulo radio -> reproductor del overlay
Radio -> API y SSE -> panel técnico y reproductor
Biblioteca -> migración autenticada -> otra instancia de Biblioteca
```

## Contratos

Cada módulo dueño de rutas expone `registerRoutes(app)`. Los eventos TikTok normalizados pueden incluir `type`, `username`, `time`, `content`, `activityCount` y `diamondCount`; el conector es el único módulo que importa el SDK de TikTok. La conexión continúa aunque el módulo de radio aún no procese eventos.

`realtime/sseHub` es un contrato de transporte: `attach(response, mensajesIniciales)`, `broadcast(nombre, datos)` y `close()`. El significado de cada mensaje lo define el módulo que lo publica.

- TikTok: `GET /api/status`, `GET/PUT /api/config`, `POST /api/reconnect` y SSE `GET /api/events`.
- Overlay: `GET/PUT /api/overlay/settings`, SSE `GET /api/overlay/stream` y `POST /api/overlay/operator`.
- Radio: `GET /api/radio-state`, SSE `GET /api/radio-state/stream`, `GET/PUT /api/radio/storage`, `POST /api/radio/next`, `/previous` y `/playback`, y audio `GET /audio/current`.
- Biblioteca: la API independiente administra discos, archivos, playlist, programación y migraciones. Radio lee el catálogo y estado, transmite el tema actual y controla la reproducción con llamadas servidor-a-servidor.

La configuración persistente de la URL externa se guarda en `data/external-library-config.json`. `BIBLIOTECA_ADMIN_TOKEN` protege las operaciones de escritura y administración de Biblioteca; `RADIO_LIBRARY_ADMIN_TOKEN` permite a Radio controlar la reproducción sin exponer el secreto en el panel. Las migraciones entre instancias de Biblioteca verifican SHA-256, combinan playlist y programación y requieren destinos autorizados por `BIBLIOTECA_MIGRATION_ALLOWED_HOSTS`. Los flujos SSE envían heartbeat cada 25 segundos. El reproductor del overlay puede requerir una interacción del usuario si el navegador bloquea la reproducción automática.

Las especificaciones formales están en [contratos de integración](../docs/contratos/README.md), [OpenAPI de Radio](../docs/contratos/radio.openapi.yaml) y [OpenAPI de Biblioteca](../docs/contratos/biblioteca.openapi.yaml).
