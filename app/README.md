# Radio TikTok Live

Servidor Node.js modular para una radio vinculada a TikTok Live. Sirve el overlay y el panel técnico, administra la conexión y los eventos de TikTok y controla la reproducción de una biblioteca musical externa.

## Instalación y ejecución

Se requiere Node.js 22 o posterior. En Windows, ejecuta [`iniciar-servidores.bat`](iniciar-servidores.bat): inicia el servidor de radio en el puerto 80 y abre la radio y el panel técnico en Chrome. Para iniciarlo manualmente, ejecuta `npm start` desde esta carpeta. Define `PORT` para cambiar el puerto del servidor (predeterminado: `3000`).

Las variables necesarias están documentadas en [`.env.example`](.env.example) para Radio y [`../biblioteca/.env.example`](../biblioteca/.env.example) para Biblioteca. En Easypanel configura los valores en las variables de entorno de cada servicio; no copies secretos reales al repositorio ni uses valores de ejemplo en producción.

La radio está en `/`; el panel técnico está en `/backend` (`/panel` redirige allí). El panel configura TikTok, el overlay y la URL de Biblioteca. La administración de discos, archivos y playlist se hace en el panel de Biblioteca, no en la Radio.

### Easypanel con Nixpacks

Selecciona **Nixpacks** como proveedor de construcción y deja la raíz del proyecto en el repositorio. El `nixpacks.toml` de la raíz fija Node.js 22, instala desde `app/package-lock.json` y arranca con `npm start` dentro de `app/`; no configures una subcarpeta como raíz. El servidor escucha en `0.0.0.0` en el puerto de `PORT`, con `3000` como valor local predeterminado; configura el puerto interno del servicio como `3000`. Monta un volumen persistente en `/app/data` para conservar la configuración de TikTok, del overlay y la URL de Biblioteca. Configura la cuenta con `TIKTOK_USERNAME` o desde el panel; si no hay una configurada, Radio no se conecta a ninguna cuenta.

### Biblioteca externa y migración

`biblioteca` es un servicio Node.js independiente, sin paquetes adicionales. Despliégalo desde esa carpeta con `npm start` y escucha en `0.0.0.0` usando `PORT` (localmente, `3001`). Monta un volumen persistente que incluya `BIBLIOTECA_DATA_DIR` y su carpeta padre (por ejemplo, `/app/data` para `BIBLIOTECA_DATA_DIR=/app/data/discs`) y configura un secreto de al menos 32 bytes en `BIBLIOTECA_ADMIN_TOKEN`. Configura el mismo secreto como `RADIO_LIBRARY_ADMIN_TOKEN` en el servidor de radio. Sin el token de biblioteca, la API deja las lecturas disponibles, pero bloquea cambios y administración. La configuración de radio guarda la URL en `app/data/external-library-config.json`; el token se configura como secreto de entorno y no se envía al navegador.

En `/backend`, abre **Ajustes del servidor → Biblioteca externa de temas**, pega la URL de la API y pulsa **Conectar y guardar**. Para migrar, entra al panel de administración de la biblioteca, autoriza la sesión con el token, configura `BIBLIOTECA_MIGRATION_ALLOWED_HOSTS` en el servidor de origen y revisa el destino antes de iniciar. Los destinos requieren HTTPS por defecto; habilita `BIBLIOTECA_MIGRATION_ALLOW_HTTP=true` solo para una red privada confiable. La vista previa indica espacio, archivos repetidos, diferencias de checksum y el resultado de unir playlist/programación. El proceso se puede reanudar después de un reinicio.

La migración copia archivos, playlists y programación sin borrar el origen. Los archivos existentes en destino nunca se sobrescriben; playlist y programación se unen sin duplicados. Protege los volúmenes y conserva backups independientes. Más detalles y variables de entorno: [`biblioteca/README.md`](../biblioteca/README.md).

## Instalar en Android

El overlay incluye un manifiesto, iconos y un service worker para instalarse como aplicación desde Chrome. Para habilitar la instalación, abre la radio en `https://` con un certificado válido y confiable para el teléfono; el HTTP local (`http://localhost`) solo es seguro en el mismo dispositivo y no habilita la instalación desde otro teléfono de la red. En Chrome Android, abre `/`, toca el menú ⋮ y elige **Instalar aplicación** / **Agregar a pantalla principal**. La aplicación instalada abre el overlay; la conexión y la reproducción necesitan que el servidor esté en línea.

## Estructura

```text
app/
  server.js                  # Composición e inicio del servidor de Radio
  modules/
    radio/                   # Estado, reproducción y cliente de Biblioteca
    tiktok/                  # Conector, configuración y eventos
    overlay/                 # Overlay público y ajustes visuales
    realtime/                # Transporte SSE compartido
  public/backend.html        # Panel técnico de Radio
  data/                      # Configuración persistente de Radio
  test/                      # Pruebas de Radio
biblioteca/
  server.js                  # Servicio independiente de Biblioteca
  public/                    # Panel de administración de Biblioteca
  test/                      # Pruebas de Biblioteca
docs/contratos/              # OpenAPI e integración entre servicios
```

El conector de TikTok normaliza y filtra eventos antes de publicarlos por SSE. La Biblioteca administra audio en MP3, WAV, OGG, OPUS, M4A y AAC, con un límite de 100 MiB por carga. El navegador puede requerir una interacción para autorizar la reproducción automática.

## Rutas

- `GET /`: overlay de la radio y estado del conector.
- `GET /manifest.webmanifest`, `/service-worker.js` y `/icons/icon-192.png`, `/icons/icon-512.png`: recursos de instalación PWA.
- `GET /backend`: panel técnico para TikTok, overlay y conexión de Biblioteca.
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

El contrato HTTP completo y los detalles de autenticación entre servicios están en la [guía de contratos](../docs/contratos/README.md), con especificaciones [OpenAPI de Radio](../docs/contratos/radio.openapi.yaml) y [OpenAPI de Biblioteca](../docs/contratos/biblioteca.openapi.yaml).

El conector escucha los eventos que declara `tiktok-live-connector`: `like`, `gift`, `member`, `follow`, `share`, `chat` y `subNotify` (suscripciones). Se publican por `GET /api/events` como `update` con `entry.id`, `activityCount` y `diamondCount`; el ID del mensaje del proveedor se usa para deduplicar y las rachas de regalos contabilizan solo el incremento. `member` y `subNotify` dependen de que TikTok/proveedor los envíe para ese directo. El overlay reconoce dedicatorias escritas en el chat como `Dedico a María` o `Dedico esta canción a María`.

## Pruebas

Ejecuta `npm test` para las pruebas o `npm run test:coverage` para generar el resumen de cobertura de Node.js.
