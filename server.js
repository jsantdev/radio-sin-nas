const { createServer } = require('node:http');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { createLibraryServer } = require('./modules/biblioteca/server');
const { registerIntegratedLibrary } = require('./modules/library/integratedRoutes');
const { createOverlayModule } = require('./modules/overlay');
const { createSseHub } = require('./modules/realtime/sseHub');
const { createRadioModule } = require('./modules/radio');
const { createExternalLibraryClient } = require('./modules/radio/externalLibraryClient');
const { createTikTokModule, createTikTokMonitorService } = require('./modules/tiktok');

function createErrorHandler() {
  return (error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const statusCode = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 400;
    response.status(statusCode).json({ ok: false, message: error.message || String(error) });
  };
}

function createWebserver({
  integratedLibrary = false,
  libraryPort = Number(process.env.BIBLIOTECA_INTERNAL_PORT || 3101),
  dataDirectory = process.env.APP_DATA_DIR || path.join(__dirname, 'data'),
  libraryDataDirectory = process.env.BIBLIOTECA_DATA_DIR
    || path.join(dataDirectory, 'biblioteca', 'discs'),
  libraryAdminToken = process.env.BIBLIOTECA_ADMIN_TOKEN
    || process.env.RADIO_LIBRARY_ADMIN_TOKEN || '',
  configurationPath = process.env.WEBSERVER_CONFIG_PATH
    || path.join(dataDirectory, 'radio', 'monitor-config.json'),
  overlaySettingsPath = process.env.RADIO_OVERLAY_SETTINGS_PATH
    || path.join(dataDirectory, 'radio', 'overlay-settings.json'),
  externalLibraryConfigurationPath = process.env.RADIO_LIBRARY_CONFIG_PATH
    || path.join(dataDirectory, 'radio', 'external-library-config.json'),
  externalLibrary,
  monitorService = createTikTokMonitorService(),
} = {}) {
  const app = express();
  const server = createServer(app);
  const libraryServer = integratedLibrary
    ? createLibraryServer({
      dataDirectory: libraryDataDirectory,
      adminToken: libraryAdminToken,
    })
    : null;
  if (libraryServer) {
    libraryServer.listen(libraryPort, '127.0.0.1');
    registerIntegratedLibrary(app, libraryServer, libraryPort);
  }
  externalLibrary = externalLibrary || createExternalLibraryClient({
    configurationPath: externalLibraryConfigurationPath,
    adminToken: libraryAdminToken,
    defaultServerUrl: integratedLibrary ? `http://127.0.0.1:${libraryPort}` : '',
  });
  const radioStream = createSseHub();
  const activityStream = createSseHub();
  const overlayStream = createSseHub();
  const radioModule = createRadioModule({ stream: radioStream, externalLibrary });
  const overlayModule = createOverlayModule({ stream: overlayStream, settingsPath: overlaySettingsPath });
  const tiktokModule = createTikTokModule({
    stream: activityStream,
    monitorService,
    configurationPath,
  });

  app.use(express.json({ limit: '1mb' }));
  overlayModule.registerRoutes(app);
  tiktokModule.registerRoutes(app);
  radioModule.registerRoutes(app);

  app.get(['/backend', '/backend/', '/backend/index.html'], (request, response) => {
    response.sendFile(path.join(__dirname, 'public', 'backend', 'index.html'));
  });
  app.get('/backend/radio', (request, response) => {
    response.sendFile(path.join(__dirname, 'public', 'backend', 'radio.html'));
  });
  for (const domain of ['tiktok', 'overlay']) {
    app.get(`/backend/${domain}`, (request, response, next) => {
      fs.readFile(path.join(__dirname, 'public', 'backend', 'domains.html'), 'utf8', (error, html) => {
        if (error) {
          next(error);
          return;
        }
        const sectionId = domain === 'tiktok' ? 'tiktokSettingsSection' : 'overlaySettingsSection';
        const pageTitle = domain === 'tiktok' ? 'TikTok Live' : 'Overlay';
        const page = html
          .replace('<body>', `<body data-domain="${domain}">`)
          .replace('<h1 id="domainHeading">Administración</h1>', `<h1 id="domainHeading">${pageTitle}</h1>`)
          .replace(`<a href="/backend/${domain}" data-domain-link="${domain}">`, `<a href="/backend/${domain}" data-domain-link="${domain}" aria-current="page">`)
          .replace(`id="${sectionId}">`, `id="${sectionId}" open>`);
        response.type('html').send(page);
      });
    });
  }
  app.get('/dashboard.css', (request, response) => {
    response.sendFile(path.join(__dirname, 'public', 'dashboard.css'));
  });
  app.get(['/panel', '/panel/', '/panel/index.html'], (request, response) => {
    response.redirect(308, '/backend');
  });
  app.use('/api', (request, response) => {
    response.status(404).json({ ok: false, message: 'Ruta API no encontrada.' });
  });

  app.use(createErrorHandler());

  server.on('close', () => {
    if (libraryServer?.listening) libraryServer.close();
    tiktokModule.close();
    radioModule.close();
    radioStream.close();
    activityStream.close();
    overlayStream.close();
  });

  return { server, monitorService, libraryServer };
}

function startServer({
  port = Number(process.env.PORT || 3000),
  host = process.env.HOST || '0.0.0.0',
  createWebserver: createServerInstance = createWebserver,
  logger = console,
} = {}) {
  const { server, libraryServer } = createServerInstance({ integratedLibrary: true });
  libraryServer?.on('error', (error) => {
    logger.error(`No se pudo iniciar Biblioteca: ${error.message}`);
    process.exitCode = 1;
    server.close();
  });
  server.listen(port, host, () => {
    const address = server.address();
    const listeningPort = address && typeof address === 'object' ? address.port : port;
    logger.log(`Radio TikTok Live y conector disponibles en http://localhost:${listeningPort}`);
  });
  server.on('error', (error) => {
    logger.error(`No se pudo iniciar el servidor de radio: ${error.message}`);
    process.exitCode = 1;
  });
  return server;
}

if (require.main === module) startServer();

module.exports = { createErrorHandler, createWebserver, startServer };
