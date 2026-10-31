# Contratos entre aplicaciones

Este repositorio contiene dos servicios Node.js independientes:

| Aplicación | Responsabilidad | Puerto local |
|---|---|---:|
| Radio | Overlay, conector TikTok y puente de reproducción | `3000` |
| Biblioteca | Discos, archivos de audio, playlist, programación y migraciones | `3001` |

Las especificaciones OpenAPI describen las APIs HTTP implementadas:

- [API de Radio](radio.openapi.yaml)
- [API de Biblioteca](biblioteca.openapi.yaml)

## Integración Radio → Biblioteca

La Radio usa la URL base configurada en **Ajustes del servidor → Biblioteca externa**.
El contrato de interoperabilidad se limita a estas operaciones de Biblioteca:

| Operación | Uso |
|---|---|
| `GET /api/discs` | Cargar discos y metadatos de temas |
| `GET /api/player/state` | Obtener cola, tema actual y estado del reproductor |
| `POST /api/player/next`, `/previous`, `/playback` | Controlar el reproductor |
| `GET /api/player/audio` | Leer el tema actual, incluidos rangos HTTP |

Las lecturas de Biblioteca son públicas. Los `POST` de control requieren el token
administrativo. Configura el mismo secreto de al menos 32 bytes en
`BIBLIOTECA_ADMIN_TOKEN` (Biblioteca) y `RADIO_LIBRARY_ADMIN_TOKEN` (Radio).
La Radio no acepta ni devuelve el secreto en el panel: lo envía entre servidores
como `Authorization: Bearer <token>` al realizar operaciones de escritura.

La URL de Biblioteca se configura con `PUT /api/radio/storage` y se persiste en
`app/data/external-library-config.json`. Quitar la URL desconecta el servicio.
La Biblioteca guarda el audio bajo `BIBLIOTECA_DATA_DIR`; su estado del reproductor,
programación e historial de migraciones se conserva en el directorio padre de esa
ruta. Ambos servicios necesitan volúmenes persistentes independientes.

## Integración Biblioteca → Biblioteca (migraciones)

Una migración transfiere datos desde una instancia de Biblioteca a otra. El destino
debe tener una versión compatible (`GET /api/health`, `apiVersion: 1`), un token
administrativo compartido y espacio para los archivos que faltan. El servidor de
origen solo contacta hosts enumerados en `BIBLIOTECA_MIGRATION_ALLOWED_HOSTS`;
requiere HTTPS salvo que `BIBLIOTECA_MIGRATION_ALLOW_HTTP=true` en una red privada
confiable. La URL destino no puede incluir credenciales, parámetros ni fragmentos.

La transferencia no reemplaza archivos existentes. Verifica tamaño y SHA-256,
combina playlist y programación y puede reanudarse después de interrupciones.

## Convenciones y seguridad

- Los cuerpos y las respuestas de las APIs son JSON UTF-8 salvo las rutas de audio.
- Los errores JSON usan `{ "ok": false, "message": "..." }`.
- Las APIs de control, escritura y administración de Biblioteca necesitan bearer
  token. Sin token configurado responden `503`; con token ausente o inválido,
  `401`.
- Las rutas de lectura de disco, estado y audio son públicas para permitir la
  reproducción. Publica el servicio detrás de HTTPS y controles de red adecuados.
- El audio admite solicitudes `Range`; `206` incluye `Content-Range` y `416`
  indica un rango no válido. El máximo de subida es 100 MiB.
- Los flujos de eventos usan Server-Sent Events (`text/event-stream`), envían un
  snapshot inicial cuando corresponde y un heartbeat cada 25 segundos. El cliente
  debe reconectarse si se interrumpe el flujo.
- `GET /api/health` anuncia `apiVersion: 1`; los cambios incompatibles de la API de
  Biblioteca requieren incrementar esa versión y coordinar el despliegue de ambos
  servicios.

## Mantener los contratos

Al cambiar una ruta, un campo, un evento SSE, un encabezado o la autenticación:

1. Actualiza el OpenAPI del servicio dueño y esta sección si cambia la integración.
2. Conserva compatibilidad con los consumidores desplegados o coordina el cambio
   de ambos servicios.
3. Añade o actualiza pruebas de contrato junto a las pruebas del servicio afectado.
