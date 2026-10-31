# Estructura de Radio TikTok Live

El repositorio contiene dos dominios Node.js: Radio integra TikTok Live y el overlay; Biblioteca conserva el catálogo musical y controla la reproducción. El despliegue recomendado los ejecuta en el mismo proceso/contenedor con un solo volumen persistente; Biblioteca también conserva un arranque HTTP independiente para despliegues separados.

## Mapa de carpetas

```text
repo/
  server.js                    # Composición e inicio de la aplicación
  modules/
    radio/                     # Estado, rutas y cliente HTTP de Biblioteca
    tiktok/                    # Conector, configuración y eventos normalizados
    overlay/                   # Overlay público y ajustes visuales
    realtime/sseHub.js         # Clientes SSE y difusión de eventos
    library/                   # Adaptador HTTP para la Biblioteca integrada
    biblioteca/
      server.js                # API y composición del dominio Biblioteca
      catalog/                 # Repositorio de discos y metadatos
      playback/                # Playlist, persistencia y programación
  public/
    backend/                   # Portada y paneles por dominio
    biblioteca/               # Panel de administración de Biblioteca
  test/
    radio/
    biblioteca/
  data/                        # Persistencia local, excluida de Git
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
| `modules/biblioteca/catalog` | Persistir el catálogo de discos, archivos y metadatos SHA-256. |
| `modules/biblioteca/playback` | Administrar estado, playlist, programación y restauración del reproductor. |

El flujo actual es:

```text
TikTok Live -> módulo tiktok -> registro de eventos -> página TikTok
                                     |
                                     +-> overlay (estado de conexión)
panel de Biblioteca -> Radio (/biblioteca) -> proxy HTTP local -> API Biblioteca
Biblioteca -> playlist y audio -> módulo radio -> reproductor del overlay
Radio -> API y SSE -> páginas Radio y Overlay
Biblioteca -> migración autenticada -> otra instancia de Biblioteca
```

## Contratos

Cada módulo dueño de rutas expone `registerRoutes(app)`. Los eventos TikTok normalizados pueden incluir `type`, `username`, `time`, `content`, `activityCount` y `diamondCount`; el conector es el único módulo que importa el SDK de TikTok. La conexión continúa aunque el módulo de radio aún no procese eventos.

`realtime/sseHub` es un contrato de transporte: `attach(response, mensajesIniciales)`, `broadcast(nombre, datos)` y `close()`. El significado de cada mensaje lo define el módulo que lo publica. En el despliegue integrado, la API de Biblioteca conserva sus rutas y se reenvía al servidor de loopback `127.0.0.1:3101`; ese puerto no se expone a Internet.

- TikTok: `GET /api/status`, `GET/PUT /api/config`, `POST /api/reconnect` y SSE `GET /api/events`.
- Overlay: `GET/PUT /api/overlay/settings`, SSE `GET /api/overlay/stream` y `POST /api/overlay/operator`.
- Radio: `GET /api/radio-state`, SSE `GET /api/radio-state/stream`, `GET/PUT /api/radio/storage`, `POST /api/radio/next`, `/previous` y `/playback`, y audio `GET /audio/current`. El panel de administración tiene páginas separadas en `/backend/radio`, `/backend/tiktok`, `/backend/overlay` y `/biblioteca`.
- Biblioteca: la API independiente administra discos, archivos, playlist, programación y migraciones. Radio lee el catálogo y estado, transmite el tema actual y controla la reproducción con llamadas servidor-a-servidor.

La configuración persistente de Radio se guarda bajo `radio/`; el audio y el estado de Biblioteca bajo `biblioteca/`. `BIBLIOTECA_ADMIN_TOKEN` protege las operaciones de escritura y administración; Radio reutiliza ese secreto en el modo integrado sin exponerlo en el panel. Las migraciones entre instancias de Biblioteca verifican SHA-256, combinan playlist y programación y requieren destinos autorizados por `BIBLIOTECA_MIGRATION_ALLOWED_HOSTS`. Los flujos SSE envían heartbeat cada 25 segundos. El reproductor del overlay puede requerir una interacción del usuario si el navegador bloquea la reproducción automática.

`APP_DATA_DIR=/app/data` agrupa persistencia: Radio escribe bajo `radio/` y Biblioteca bajo `biblioteca/`. Monta un solo volumen en `/app/data` en Easypanel. Las especificaciones formales están en [contratos de integración](docs/contratos/README.md), [OpenAPI de Radio](docs/contratos/radio.openapi.yaml) y [OpenAPI de Biblioteca](docs/contratos/biblioteca.openapi.yaml).
