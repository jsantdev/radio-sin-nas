# Radio TikTok Live

Servidor Node.js modular para una radio vinculada a TikTok Live. Conserva el conector, su configuración y el registro de eventos; permite cargar archivos de audio locales, guardarlos en una playlist persistente y reproducirlos desde el overlay.

## Instalación y ejecución

Se requiere Node.js 18 o posterior. En Windows, ejecuta [`iniciar-servidores.bat`](iniciar-servidores.bat): inicia el servidor en el puerto 80 por defecto, espera a que responda y abre la radio y el panel de playlist en Chrome. Para iniciarlo manualmente, ejecuta `npm start` desde la raíz. Define `PORT` para cambiar el puerto del servidor.

El lanzador abre `http://localhost:80/` para la radio y `http://localhost:80/playlist` para administrar el playlist. El panel del conector TikTok permanece disponible en `http://localhost:80/backend`.

### Easypanel con Nixpacks

Selecciona **Nixpacks** como proveedor de construcción. El proyecto no requiere compilación: Nixpacks instala las dependencias desde `package-lock.json` y ejecuta `npm start` (`node server.js`). El servidor escucha en `0.0.0.0` en el puerto de `PORT`, con `3000` como valor local predeterminado; configura el puerto interno del servicio como `3000`. Monta un volumen persistente en `/app/data` para conservar los audios subidos, la playlist y la configuración entre despliegues.

## Instalar en Android

El overlay incluye un manifiesto, iconos y un service worker para instalarse como aplicación desde Chrome. Para habilitar la instalación, abre el panel en `https://` con un certificado válido y confiable para el teléfono; el HTTP local (`http://localhost`) solo es seguro en el mismo dispositivo y no habilita la instalación desde otro teléfono de la red. En Chrome Android, abre `/backend` y pulsa **Instalar aplicación**, o abre `/`, toca el menú ⋮ y elige **Instalar aplicación** / **Agregar a pantalla principal**. La aplicación instalada abre el overlay; la conexión y la reproducción necesitan que el servidor esté en línea.

## Estructura

```text
server.js                    # Composición e inicio del servidor
modules/
  radio/                     # Biblioteca local, playlist, reproducción y rutas
  tiktok/                    # Conector, normalización, configuración y eventos
  overlay/                   # Overlay público para TikTok Live
  realtime/                  # Transporte SSE compartido
public/
  index.html                 # Panel del conector TikTok en /backend
  playlist.html              # Gestión de audio y playlist en /playlist
data/
  monitor-config.json        # Configuración local persistente de TikTok
  music/                     # Archivos de audio locales
  radio-playlist.json        # Orden persistente de reproducción
test/                        # Pruebas automáticas
```

El conector de TikTok es independiente de la radio: normaliza y filtra eventos, mantiene la conexión y los publica en el registro. La ruta `/playlist` permite cargar archivos, agregarlos o quitarlos de la cola y reordenarlos. La ruta `/` reproduce la canción actual y avanza automáticamente al terminar. Formatos admitidos: MP3, WAV, OGG, OPUS, M4A y AAC; límite de 100 MB por archivo. El navegador puede requerir pulsar reproducir para autorizar el audio.

## Rutas

- `GET /`: overlay de la radio y estado del conector.
- `GET /manifest.webmanifest`, `/service-worker.js` y `/icons/icon-192.png`, `/icons/icon-512.png`: recursos de instalación PWA.
- `GET /playlist`: panel para cargar archivos y administrar el orden de reproducción.
- `GET /backend`: panel de configuración y registro de eventos.
- `GET /api/status`: estado del conector.
- `GET/PUT /api/config`: consulta o cambia la cuenta de TikTok y los eventos ignorados.
- `GET /api/events`: flujo SSE de estado y eventos de TikTok.
- `GET /api/radio/tracks`: archivos de audio disponibles.
- `POST/DELETE /api/radio/tracks`: carga o borra archivos locales.
- `GET/PUT /api/radio/playlist`: consulta o guarda el orden de reproducción.
- `POST /api/radio/current`, `/next`, `/previous` y `/playback`: controla la reproducción.
- `GET /audio/:filename`: sirve un archivo de audio local.
- `GET /api/radio-state` y `/api/radio-state/stream`: estado y actualizaciones SSE de la radio.

## Pruebas

Ejecuta `npm test` para las pruebas o `npm run test:coverage` para generar el resumen de cobertura de Node.js.

## Servicios de programación

¿Necesitas desarrollar o mejorar un proyecto? Contacta a **jsantdev**:

- Correo: [jsantdev.automation@gmail.com](mailto:jsantdev.automation@gmail.com)
- Teléfono: [+595 998 113 3313](tel:+5959981133313)
