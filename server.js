const { createServer } = require('node:http');
const express = require('express');
const path = require('node:path');
const { createOverlayModule } = require('./modules/overlay');
const { createSseHub } = require('./modules/realtime/sseHub');
const { createRadioModule } = require('./modules/radio');
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
  configurationPath = process.env.WEBSERVER_CONFIG_PATH || path.join(__dirname, 'data', 'monitor-config.json'),
  overlaySettingsPath = path.join(__dirname, 'data', 'overlay-settings.json'),
  audioDirectory = path.join(__dirname, 'data', 'music'),
  playlistPath = path.join(__dirname, 'data', 'radio-playlist.json'),
  monitorService = createTikTokMonitorService(),
} = {}) {
  const app = express();
  const server = createServer(app);
  const radioStream = createSseHub();
  const activityStream = createSseHub();
  const overlayStream = createSseHub();
  const radioModule = createRadioModule({ stream: radioStream, audioDirectory, playlistPath });
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
    response.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
  app.get(['/playlist', '/playlist/', '/playlist/index.html'], (request, response) => {
    response.sendFile(path.join(__dirname, 'public', 'playlist.html'));
  });
  app.get(['/panel', '/panel/', '/panel/index.html'], (request, response) => {
    response.redirect(308, '/backend');
  });
  app.use('/api', (request, response) => {
    response.status(404).json({ ok: false, message: 'Ruta API no encontrada.' });
  });

  app.use(createErrorHandler());

  server.on('close', () => {
    tiktokModule.close();
    radioModule.close();
    radioStream.close();
    activityStream.close();
    overlayStream.close();
  });

  return { server, monitorService };
}

function startServer({
  port = Number(process.env.PORT || 3000),
  host = process.env.HOST || '0.0.0.0',
  createWebserver: createServerInstance = createWebserver,
  logger = console,
} = {}) {
  const { server } = createServerInstance();
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
