# Biblioteca musical

Servicio HTTP de archivos y playlists. En el despliegue recomendado, Radio y Biblioteca comparten una app Easypanel: abre el panel musical en `/biblioteca` y monta un volumen persistente en `/app/data`. Biblioteca también se puede desplegar como servicio independiente. Los archivos y el estado se guardan bajo `BIBLIOTECA_DATA_DIR` y su directorio padre.

El contrato HTTP está en [OpenAPI de Biblioteca](contratos/biblioteca.openapi.yaml). La [guía de contratos entre aplicaciones](contratos/README.md) describe la integración con Radio, la autenticación y el versionado. La implementación está organizada por dominio bajo `modules/biblioteca/catalog` y `modules/biblioteca/playback`; `modules/biblioteca/server.js` compone el servicio HTTP.

## Configuración

Para el despliegue integrado, configura `APP_DATA_DIR=/app/data` y `BIBLIOTECA_DATA_DIR=/app/data/biblioteca/discs` en la app. El servicio interno de Biblioteca escucha en `127.0.0.1:3101`; no publiques ese puerto. `BIBLIOTECA_ADMIN_TOKEN` protege las operaciones administrativas y Radio lo reutiliza para el reproductor. Para ejecutarlo en un puerto independiente dentro del proyecto, usa `npm run start:biblioteca`.

- Usa [`.env.example`](../.env.example) como referencia para las variables; configura los secretos en Easypanel y no subas un archivo `.env` real.
- `BIBLIOTECA_DATA_DIR`: carpeta persistente para los temas (predeterminada en `/app/data/biblioteca/discs` en Easypanel).
- `BIBLIOTECA_ADMIN_TOKEN`: token secreto de al menos 32 bytes. Genera uno con `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Sin este valor, la API permite lecturas públicas, pero bloquea subidas, cambios, borrados y operaciones administrativas.
- `RADIO_LIBRARY_ADMIN_TOKEN`: configura el mismo secreto en el servidor de radio que consume esta biblioteca. El panel de radio no recibe ni guarda este token desde el navegador.
- `BIBLIOTECA_MIGRATION_ALLOWED_HOSTS`: lista separada por comas de hosts exactos a los que este servidor puede enviar migraciones. Déjalo vacío si no migras. Por ejemplo: `biblioteca-destino.ejemplo.com,10.0.0.8:3001`. Añade solo destinos confiables; no uses comodines. Para redes públicas usa HTTPS.
- `BIBLIOTECA_MIGRATION_ALLOW_HTTP`: solo pon `true` para una red privada confiable sin TLS. Por defecto las migraciones exigen HTTPS.
- `PORT`: puerto HTTP (por defecto `3001`).

Configura el mismo `BIBLIOTECA_ADMIN_TOKEN` en los dos servidores que participen de la migración y `RADIO_LIBRARY_ADMIN_TOKEN` en el servidor de radio que controla la biblioteca. El panel de biblioteca solicita el token para operaciones administrativas; la radio lo usa solo en llamadas servidor-a-servidor. No publiques los secretos y no expongas el servicio administrativo sin HTTPS y controles de acceso.

## Migraciones

En **Datos** puedes exportar a otra Biblioteca o importar desde su URL. La vista previa muestra temas, espacio libre, archivos existentes y el estado de playlist/programación. Solo se copian archivos faltantes; los existentes nunca se reemplazan. Cada tema se valida con SHA-256 y tamaño. La playlist se une sin duplicados y la programación se combina por ID, conservando la entrada que ya exista. Si se interrumpe el proceso, el historial permite reanudarlo desde el panel.

La copia transfiere discos, temas, playlist y programación; no elimina ni modifica los datos de origen. Mantén backups independientes: la migración entre Bibliotecas no reemplaza un backup de archivos.

Las rutas de lectura de biblioteca y audio son públicas para permitir la reproducción. Protege el servicio con HTTPS y el control de red apropiado; el token protege las operaciones que modifican datos.
