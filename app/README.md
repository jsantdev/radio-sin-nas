# Radio TikTok Live

Servidor Node.js modular para una radio vinculada a TikTok Live. Conserva el conector, su configuración y el registro de eventos; permite administrar una playlist persistente y reproducir audio desde la biblioteca local o desde un servidor externo de temas.

## Instalación y ejecución

Se requiere Node.js 18 o posterior. En Windows, ejecuta [`iniciar-servidores.bat`](iniciar-servidores.bat): inicia el servidor de radio en el puerto 80 por defecto, espera a que responda y abre la radio y el panel de playlist en Chrome. Para iniciarlo manualmente, ejecuta `npm start` desde esta carpeta. Define `PORT` para cambiar el puerto del servidor.

El lanzador abre `http://localhost:80/` para la radio y `http://localhost:80/playlist` para administrar el playlist y todos los ajustes del servidor. `/backend` redirige a la sección de ajustes de esa misma página. Si se configura una biblioteca externa, las cargas, lecturas y eliminaciones de audio se realizan allí; la playlist y su URL siguen guardándose en el disco de la aplicación.

### Easypanel con Nixpacks

Selecciona **Nixpacks** como proveedor de construcción. El proyecto no requiere compilación: Nixpacks instala las dependencias desde `package-lock.json` y ejecuta `npm start` (`node server.js`). El servidor escucha en `0.0.0.0` en el puerto de `PORT`, con `3000` como valor local predeterminado; configura el puerto interno del servicio como `3000`. Monta un volumen persistente en `/app/data` para conservar la playlist y la configuración entre despliegues. Si se usa la biblioteca local, ese volumen también conserva los audios. El usuario predeterminado de TikTok es `hnaevalopez`; `TIKTOK_USERNAME` puede fijarlo en el entorno y tiene prioridad sobre la configuración guardada.

### Servidor externo de temas

`biblioteca-musical` es un servicio Node.js independiente y no requiere paquetes adicionales. Despliégalo usando `biblioteca-musical` como raíz del proyecto y `npm start` como comando. Escucha en `0.0.0.0` usando `PORT` (localmente, `3001`). Monta un volumen persistente para sus datos y define `BIBLIOTECA_DATA_DIR` con esa ruta; por ejemplo, `/app/data/discs`. En `/playlist`, abre **Ajustes del servidor → Biblioteca externa de temas**, pega la URL base pública del servicio y pulsa **Guardar y conectar**. La radio guarda la URL en `app/data/external-library-config.json` y vuelve a conectarse al iniciar; conserva el volumen `/app/data` de la radio y el volumen `BIBLIOTECA_DATA_DIR` del servicio para sobrevivir despliegues/versiones.

La biblioteca del panel lista todos los discos y temas. Desde la carga de música se puede elegir un disco existente o crear uno vacío y seleccionarlo antes de subir. La vista previa del audio y el cambio de nombre del tema se conservan. `biblioteca-musical` permite listar/crear discos y crear, leer o borrar temas; transmite los audios a la radio y no permite modificar archivos existentes.

## Instalar en Android

El overlay incluye un manifiesto, iconos y un service worker para instalarse como aplicación desde Chrome. Para habilitar la instalación, abre la radio en `https://` con un certificado válido y confiable para el teléfono; el HTTP local (`http://localhost`) solo es seguro en el mismo dispositivo y no habilita la instalación desde otro teléfono de la red. En Chrome Android, abre `/`, toca el menú ⋮ y elige **Instalar aplicación** / **Agregar a pantalla principal**. La aplicación instalada abre el overlay; la conexión y la reproducción necesitan que el servidor esté en línea.

## Estructura

```text
server.js                    # Composición e inicio del servidor
modules/
  radio/                     # Biblioteca local/externa, playlist, reproducción y rutas
  tiktok/                    # Conector, normalización, configuración y eventos
  overlay/                   # Overlay público para TikTok Live
  realtime/                  # Transporte SSE compartido
public/
  index.html                 # Página anterior del panel (la ruta /backend redirige)
  playlist.html              # Playlist y ajustes unificados del servidor
data/
  monitor-config.json        # Configuración local persistente de TikTok
  music/                     # Archivos de audio locales
  radio-playlist.json        # Orden persistente de reproducción
  external-library-config.json # URL persistente de la biblioteca externa
test/                        # Pruebas automáticas
../biblioteca-musical/       # Servicio externo independiente de temas
```

El conector de TikTok es independiente de la radio: normaliza y filtra eventos, mantiene la conexión y los publica en el registro. La ruta `/playlist` permite cargar archivos, agruparlos por disco, agregarlos o quitarlos de la cola y reordenarlos. La ruta `/` reproduce la canción actual y avanza automáticamente al terminar. Formatos admitidos: MP3, WAV, OGG, OPUS, M4A y AAC; límite de 100 MB por archivo. El navegador puede requerir pulsar reproducir para autorizar el audio.

## Rutas

- `GET /`: overlay de la radio y estado del conector.
- `GET /manifest.webmanifest`, `/service-worker.js` y `/icons/icon-192.png`, `/icons/icon-512.png`: recursos de instalación PWA.
- `GET /playlist`: panel para cargar archivos, administrar la playlist y configurar TikTok y el overlay.
- `GET /backend`: redirige a la sección de ajustes dentro de `/playlist`.
- `GET /api/status`: estado del conector.
- `GET/PUT /api/config`: consulta o cambia la cuenta de TikTok y los eventos ignorados.
- `GET /api/events`: flujo SSE de estado y eventos de TikTok.
- `GET /api/overlay/stream`: flujo SSE de ajustes y comandos para el overlay; los ajustes incluyen metas y frecuencia de CTA.
- `GET/PUT /api/overlay/settings`: lee y guarda metas de Tap Tap (`1000`, `5000`, `10000` o `20000`), meta de monedas, mensajes y frecuencia automática (`20`, `25` o `30` segundos).
- `POST /api/overlay/operator`: comandos administrativos y vistas previas que no alteran las métricas reales.
- `GET /api/radio/tracks`: archivos de audio disponibles.
- `POST /api/radio/discs`: crea o selecciona un disco en la biblioteca externa.
- `POST/DELETE /api/radio/tracks`: carga o borra archivos locales o externos.
- `GET/PUT /api/radio/storage`: consulta y guarda la URL de la biblioteca externa.
- `GET/PUT /api/radio/playlist`: consulta o guarda el orden de reproducción.
- `POST /api/radio/current`, `/next`, `/previous` y `/playback`: controla la reproducción.
- `GET /audio/:filename`: sirve o transmite un archivo de audio local/externo.
- `GET /api/radio-state` y `/api/radio-state/stream`: estado y actualizaciones SSE de la radio.

El servicio externo ofrece `GET/POST /api/discs`, `POST/DELETE /api/tracks` y `GET /api/audio`. No expone operaciones para modificar archivos existentes.

El conector escucha los eventos que declara `tiktok-live-connector`: `like`, `gift`, `member`, `follow`, `share`, `chat` y `subNotify` (suscripciones). Se publican por `GET /api/events` como `update` con `entry.id`, `activityCount` y `diamondCount`; el ID del mensaje del proveedor se usa para deduplicar y las rachas de regalos contabilizan solo el incremento. `member` y `subNotify` dependen de que TikTok/proveedor los envíe para ese directo. El overlay reconoce dedicatorias escritas en el chat como `Dedico a María` o `Dedico esta canción a María`.

## Pruebas

Ejecuta `npm test` para las pruebas o `npm run test:coverage` para generar el resumen de cobertura de Node.js.

## Servicios de programación

¿Necesitas desarrollar o mejorar un proyecto? Contacta a **jsantdev**:

- Correo: [jsantdev.automation@gmail.com](mailto:jsantdev.automation@gmail.com)
- Teléfono: [+595 998 113 3313](tel:+5959981133313)
