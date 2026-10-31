# Radio TikTok Live

Servidor Node.js modular para una radio vinculada a TikTok Live. Sirve el overlay público, una portada de administración por dominios y puede integrar la Biblioteca musical en el mismo despliegue.

## Instalación y ejecución

Se requiere Node.js 22 o posterior. En Windows, ejecuta [`iniciar-servidores.bat`](iniciar-servidores.bat): inicia el servidor integrado en el puerto 80 y abre la radio y la administración en Chrome. Para iniciarlo manualmente, ejecuta `npm start` desde esta carpeta. Define `PORT` para cambiar el puerto del servidor (predeterminado: `3000`).

Las variables están documentadas en [`.env.example`](.env.example). No copies secretos reales al repositorio ni uses valores de ejemplo en producción.

La radio pública está en `/`; el inicio de administración está en `/backend` (`/panel` redirige allí). Desde allí se accede a las páginas de Radio (`/backend/radio`), TikTok (`/backend/tiktok`), Overlay (`/backend/overlay`) y Biblioteca (`/biblioteca`). Biblioteca también puede ejecutarse como servicio independiente.

### Easypanel con Nixpacks

Selecciona **Nixpacks** como proveedor y deja la raíz del proyecto en el repositorio. El `nixpacks.toml` instala dependencias desde el `package-lock.json` raíz y arranca Radio junto con Biblioteca en una sola app. Configura el puerto interno como `3000` y monta **un volumen persistente con ruta de montaje `/app/data`**. Añade estas variables en Easypanel:

| Variable | Valor |
|---|---|
| `APP_DATA_DIR` | `/app/data` |
| `BIBLIOTECA_DATA_DIR` | `/app/data/biblioteca/discs` |
| `BIBLIOTECA_ADMIN_TOKEN` | Un secreto aleatorio de al menos 32 caracteres |
| `PORT` | `3000` |
| `HOST` | `0.0.0.0` |

`BIBLIOTECA_INTERNAL_PORT` usa `3101` por defecto y solo escucha dentro del contenedor: no lo publiques en Easypanel. El volumen `/app/data` conserva tanto los archivos, la playlist y la programación de Biblioteca como la configuración de Radio. Configura `TIKTOK_USERNAME` o la cuenta desde `/backend`; si no hay usuario, Radio no se conecta. Las operaciones administrativas de Biblioteca necesitan `BIBLIOTECA_ADMIN_TOKEN`; Radio reutiliza ese secreto para el reproductor. No hace falta configurar una URL de Biblioteca externa en este modo.

### Biblioteca externa y migración

Para conservar Biblioteca como servicio HTTP independiente dentro del mismo proyecto, inicia `npm run start:biblioteca`; en producción normalmente se usa el arranque integrado. Si conectas otra instancia externa, configúrala desde **Radio → Biblioteca de reproducción**. Los datos de otros volúmenes no se copian automáticamente: consérvalos o migra la biblioteca antes de retirarlos.

En modo integrado, administra la biblioteca en `/biblioteca`; configura una fuente externa desde **Radio → Biblioteca de reproducción**. Para migrar, autoriza el panel con el token, configura `BIBLIOTECA_MIGRATION_ALLOWED_HOSTS` en el servidor de origen y revisa el destino antes de iniciar. Los destinos requieren HTTPS por defecto; habilita `BIBLIOTECA_MIGRATION_ALLOW_HTTP=true` solo para una red privada confiable. La vista previa indica espacio, archivos repetidos, diferencias de checksum y el resultado de unir playlist/programación. El proceso se puede reanudar después de un reinicio.

La migración copia archivos, playlists y programación sin borrar el origen. Los archivos existentes en destino nunca se sobrescriben; playlist y programación se unen sin duplicados. Protege el volumen y conserva backups independientes. Más detalles: [`docs/biblioteca.md`](docs/biblioteca.md).

## Instalar en Android

El overlay incluye un manifiesto, iconos y un service worker para instalarse como aplicación desde Chrome. Para habilitar la instalación, abre la radio en `https://` con un certificado válido y confiable para el teléfono; el HTTP local (`http://localhost`) solo es seguro en el mismo dispositivo y no habilita la instalación desde otro teléfono de la red. En Chrome Android, abre `/`, toca el menú ⋮ y elige **Instalar aplicación** / **Agregar a pantalla principal**. La aplicación instalada abre el overlay; la conexión y la reproducción necesitan que el servidor esté en línea.

## Estructura

```text
server.js                    # Composición de la aplicación integrada
modules/
  radio/                     # Reproductor y cliente de Biblioteca
  tiktok/                    # Conector, configuración y eventos
  overlay/                   # Overlay y ajustes visuales
  biblioteca/                # API, catálogo, playlist y programación
  library/                   # Rutas de Biblioteca integradas en Radio
  realtime/                  # Transporte SSE compartido
public/
  backend/                   # Portada y páginas de administración por dominio
  biblioteca/                # Panel y PWA de Biblioteca
test/
  radio/                     # Pruebas de Radio e integración
  biblioteca/                # Pruebas de API, reproducción y almacenamiento
data/                        # Persistencia local (no se versiona)
docs/                        # Contratos, OpenAPI y guías
```

El conector de TikTok normaliza y filtra eventos antes de publicarlos por SSE. La Biblioteca administra audio en MP3, WAV, OGG, OPUS, M4A y AAC, con un límite de 100 MiB por carga. El navegador puede requerir una interacción para autorizar la reproducción automática.

## Rutas

- `GET /`: overlay de la radio y estado del conector.
- `GET /biblioteca`: administración de discos, archivos de audio, playlist, programación y migraciones.
- `GET /manifest.webmanifest`, `/service-worker.js` y `/icons/icon-192.png`, `/icons/icon-512.png`: recursos de instalación PWA.
- `GET /backend`: inicio de administración con acceso separado a cada dominio.
- `GET /backend/radio`, `/backend/tiktok`, `/backend/overlay`: páginas de administración por dominio.
- `GET /panel`: redirección permanente a `/backend`.
- `GET /api/status`: estado del conector.
- `GET/PUT /api/config`: consulta o cambia la cuenta de TikTok y los eventos ignorados.
- `POST /api/reconnect`: intenta reconectar la cuenta configurada.
- `GET /api/events`: flujo SSE de estado y eventos de TikTok.
- `GET /api/overlay/stream`: flujo SSE de ajustes y comandos para el overlay; los ajustes incluyen metas y frecuencia de CTA.
- `GET/PUT /api/overlay/settings`: lee y guarda metas de Tap Tap (`1000`, `5000`, `10000` o `20000`), meta de monedas, mensajes y frecuencia automática (`20`, `25` o `30` segundos).
- `POST /api/overlay/operator`: publica comandos de operador y vistas previas.
- `GET/PUT /api/radio/storage`: consulta o configura la URL de Biblioteca.
- `GET /api/radio-state` y `/api/radio-state/stream`: snapshot y actualizaciones SSE del reproductor.
- `POST /api/radio/next`, `/previous` y `/playback`: controla la reproducción.
- `GET /audio/current`: transmite el audio actual y admite encabezado `Range`.

El contrato HTTP completo y los detalles de autenticación entre servicios están en la [guía de contratos](docs/contratos/README.md), con especificaciones [OpenAPI de Radio](docs/contratos/radio.openapi.yaml) y [OpenAPI de Biblioteca](docs/contratos/biblioteca.openapi.yaml).

El conector escucha los eventos que declara `tiktok-live-connector`: `like`, `gift`, `member`, `follow`, `share`, `chat` y `subNotify` (suscripciones). Se publican por `GET /api/events` como `update` con `entry.id`, `activityCount` y `diamondCount`; el ID del mensaje del proveedor se usa para deduplicar y las rachas de regalos contabilizan solo el incremento. `member` y `subNotify` dependen de que TikTok/proveedor los envíe para ese directo. El overlay reconoce dedicatorias escritas en el chat como `Dedico a María` o `Dedico esta canción a María`.

## Pruebas

Ejecuta `npm test` para las pruebas o `npm run test:coverage` para generar el resumen de cobertura de Node.js.
