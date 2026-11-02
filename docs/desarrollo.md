# Guía de desarrollo

Esta guía describe cómo se organiza el código, dónde se guarda el estado y cómo
ejecutar las pruebas. Para instalar y desplegar el servicio, consulta el
[README](../README.md); los contratos HTTP están en
[docs/contratos](contratos/README.md).

## Requisitos y comandos

Se necesita Node.js 22 o posterior, según `package.json`. Instala las
dependencias con `npm ci` y usa estos comandos desde la raíz:

| Comando | Uso |
|---|---|
| `npm start` | Inicia Radio y Biblioteca integrada. |
| `npm run start:biblioteca` | Inicia Biblioteca como servicio independiente. |
| `npm test` | Ejecuta todas las pruebas con `node:test`. |
| `npm run test:coverage` | Ejecuta las pruebas e imprime cobertura de líneas, ramas y funciones. |

La cobertura usa el informe integrado de Node.js; actualmente no hay un umbral
mínimo que haga fallar el comando.

## Módulos

| Ruta | Responsabilidad |
|---|---|
| `server.js` | Compone Express, Radio, TikTok, Overlay y, cuando corresponde, Biblioteca. Configura rutas globales, errores y cierre de recursos. |
| `modules/radio/index.js` | Mantiene el snapshot del reproductor, refresca la biblioteca externa y publica cambios por SSE. |
| `modules/radio/routes.js` | Expone el estado, el flujo SSE, el audio actual y la configuración/controles de reproducción. |
| `modules/radio/externalLibraryClient.js` | Valida y persiste la URL de Biblioteca; consulta su catálogo/estado y reenvía controles y solicitudes de audio. |
| `modules/tiktok/index.js` | Coordina configuración, filtros, historial de eventos y estado del conector. |
| `modules/tiktok/tiktokMonitorService.js` | Administra la conexión TikTok Live, normaliza eventos, deduplica mensajes y reintenta conexiones. |
| `modules/tiktok/eventConfig.js` | Define los nombres y etiquetas de eventos del proveedor. |
| `modules/tiktok/eventFeedService.js` | Ordena y conserva la lista de eventos recientes. |
| `modules/tiktok/giftTranslationService.js` | Traduce nombres de regalos conocidos para mostrarlos en el panel y el overlay. |
| `modules/tiktok/routes.js` | Expone estado, configuración, reconexión y eventos TikTok mediante SSE. |
| `modules/overlay/index.js` | Sirve el overlay, persiste sus ajustes y publica ajustes/comandos por SSE. |
| `modules/realtime/sseHub.js` | Implementa el transporte SSE compartido, snapshots, heartbeat y limpieza de clientes. |
| `modules/biblioteca/server.js` | Crea la API HTTP de Biblioteca, valida acceso administrativo y coordina catálogo, reproducción y migraciones. |
| `modules/biblioteca/catalog/repository.js` | Persiste discos, archivos de audio y metadatos del catálogo. |
| `modules/biblioteca/playback/service.js` | Gestiona playlist, reproducción, programación y combinación de estado importado. |
| `modules/library/integratedRoutes.js` | Publica el panel/PWA de Biblioteca bajo `/biblioteca` y reenvía sus APIs al servidor local de loopback. |
| `public/`, `modules/overlay/` | Contienen páginas administrativas, paneles, overlay, manifiestos PWA y service workers. |

Cada módulo de dominio recibe sus dependencias al crearse y registra sus rutas
en la aplicación anfitriona. `server.js` es el punto de composición; la
Biblioteca integrada escucha solo en `127.0.0.1`.

## Configuración y persistencia

Las variables también aparecen en [`.env.example`](../.env.example). La
aplicación no carga archivos `.env` automáticamente: el entorno debe
proporcionarlas.

| Variable | Uso y valor predeterminado |
|---|---|
| `PORT` | Puerto público de Radio; `3000`. Biblioteca independiente usa `3001` si no se define. |
| `HOST` | Dirección de escucha; `0.0.0.0`. |
| `APP_DATA_DIR` | Raíz de datos; `data/` localmente. Radio guarda su configuración en el subdirectorio `radio/`. |
| `TIKTOK_USERNAME` | Cuenta inicial de TikTok; vacía si no se configura. |
| `WEBSERVER_CONFIG_PATH` | Archivo de configuración TikTok; por defecto `<APP_DATA_DIR>/radio/monitor-config.json`. |
| `RADIO_OVERLAY_SETTINGS_PATH` | Archivo de ajustes del overlay; por defecto `<APP_DATA_DIR>/radio/overlay-settings.json`. |
| `RADIO_LIBRARY_CONFIG_PATH` | Archivo de URL de Biblioteca; por defecto `<APP_DATA_DIR>/radio/external-library-config.json`. |
| `BIBLIOTECA_INTERNAL_PORT` | Puerto local de Biblioteca integrada; `3101`. No publicarlo en Internet. |
| `BIBLIOTECA_DATA_DIR` | Directorio de discos/audio; por defecto `<APP_DATA_DIR>/biblioteca/discs`. El estado del reproductor y las migraciones queda en su directorio padre. |
| `BIBLIOTECA_ADMIN_TOKEN` | Token secreto para las operaciones administrativas de Biblioteca; vacío deshabilita las operaciones protegidas. Debe tener al menos 32 bytes. |
| `BIBLIOTECA_AUTH_DISABLED` | Junto con `NODE_ENV=development`, permite administrar sin token solo por loopback; el servidor rechaza la opción en cualquier otro entorno. |
| `RADIO_LIBRARY_ADMIN_TOKEN` | Token para Radio cuando Biblioteca es externa; si se omite, Radio reutiliza `BIBLIOTECA_ADMIN_TOKEN`. |
| `BIBLIOTECA_MIGRATION_ALLOWED_HOSTS` | Hosts permitidos como destinos de migración, separados por comas. |
| `BIBLIOTECA_MIGRATION_ALLOW_HTTP` | Permite destinos HTTP solo si vale `true`; HTTPS es el valor seguro predeterminado. |

En un despliegue integrado, monta un volumen persistente para todo
`APP_DATA_DIR`. No guardes secretos ni datos reales en el repositorio.

## Pruebas y cobertura

Las pruebas usan el ejecutor nativo `node:test`, solicitudes HTTP locales y
directorios temporales para aislar datos. Se distribuyen así:

| Archivo | Alcance principal |
|---|---|
| `test/radio/server.test.js` | Rutas y páginas de Radio, configuración TikTok, overlay, SSE y errores de API. |
| `test/radio/serverInfrastructure.test.js` | Hub SSE, manejador de errores, arranque y cierre del módulo Radio. |
| `test/radio/tiktokModule.test.js` | Exportaciones, eventos normalizados y traducción de regalos. |
| `test/radio/tiktokMonitorCoverage.test.js` | Formas de eventos TikTok, deduplicación, reintentos, errores y limpieza del conector. |
| `test/radio/externalLibrary.test.js` | Conexión de Radio con Biblioteca, errores y reproducción persistente. |
| `test/radio/integratedDeployment.test.js` | Despliegue integrado y persistencia compartida. |
| `test/biblioteca/server.test.js` | API de Biblioteca, autorización, catálogo, reproducción, programación y migración. |

Resultado actual de `npm run test:coverage`: **31 tests aprobados**;
**86,70 %** de líneas, **77,03 %** de ramas y **89,63 %** de funciones.
La salida completa identifica líneas no cubiertas por archivo. Para comprobar
el estado actual después de un cambio, vuelve a ejecutar el comando; esos
porcentajes pueden variar con el código y la versión de Node.js.

Al añadir una ruta o cambiar un contrato, actualiza el OpenAPI y prueba tanto
respuestas correctas como entradas inválidas y errores relevantes. Para las
migraciones o escrituras, usa directorios temporales y nunca datos reales.
