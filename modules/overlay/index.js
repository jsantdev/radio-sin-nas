const fs = require('node:fs');
const path = require('node:path');

const defaultSettings = {
  tapGoal: 5000,
  coinGoal: 500,
  ctaIntervalSeconds: 25,
  ctaMessages: [
    '¡Dejá tu TAP TAP y llenemos esta radio de corazones! ❤️',
    'Si esta canción te bendice, comenta AMÉN 🙏',
    'Comparte este LIVE con alguien que necesite esperanza 🕊️',
    'Cada TAP TAP nos acerca a la próxima meta ❤️',
    'Tu apoyo voluntario ayuda a mantener la radio en vivo ✨',
    '¿Qué canción de fe te gustaría escuchar? Déjanos tu pedido 🎶',
  ],
};

function createOverlayModule({
  settingsPath = path.join(__dirname, '..', '..', 'data', 'overlay-settings.json'),
  stream,
} = {}) {
  if (!stream || typeof stream.attach !== 'function' || typeof stream.broadcast !== 'function') {
    throw new Error('El módulo de overlay necesita su canal de actualizaciones.');
  }

  let settings = { ...defaultSettings };
  if (fs.existsSync(settingsPath)) {
    const savedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!savedSettings || typeof savedSettings !== 'object' || Array.isArray(savedSettings)) {
      throw new Error('La configuración del overlay guardada no es válida.');
    }
    const migratedSettings = {
      ...savedSettings,
      tapGoal: [1000, 5000, 10000, 20000].includes(savedSettings.tapGoal)
        ? savedSettings.tapGoal : defaultSettings.tapGoal,
      ctaIntervalSeconds: savedSettings.ctaIntervalSeconds ?? defaultSettings.ctaIntervalSeconds,
    };
    if (!isValidSettings(migratedSettings)) {
      throw new Error('La configuración del overlay guardada no es válida.');
    }
    settings = { ...defaultSettings, ...migratedSettings };
  }

  function isValidSettings(value) {
    return value && [1000, 5000, 10000, 20000].includes(value.tapGoal)
      && Number.isInteger(value.coinGoal) && value.coinGoal >= 1
      && [20, 25, 30].includes(value.ctaIntervalSeconds ?? defaultSettings.ctaIntervalSeconds)
      && Array.isArray(value.ctaMessages) && value.ctaMessages.length <= 20
      && value.ctaMessages.every((message) => typeof message === 'string'
        && message.trim().length > 0 && message.length <= 180);
  }

  function saveSettings(nextSettings) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(nextSettings, null, 2));
    settings = nextSettings;
    stream.broadcast('settings', settings);
  }

  function registerRoutes(app) {
    app.get(['/','/index.html'], (request, response) => {
      response.sendFile(path.join(__dirname, 'index.html'));
    });

    app.get('/manifest.webmanifest', (request, response) => {
      response.sendFile(path.join(__dirname, 'manifest.webmanifest'));
    });

    app.get('/service-worker.js', (request, response) => {
      response.set('Cache-Control', 'no-cache');
      response.type('application/javascript');
      response.sendFile(path.join(__dirname, 'service-worker.js'));
    });

    app.get('/icons/:filename', (request, response) => {
      if (!['icon-192.png', 'icon-512.png'].includes(request.params.filename)) {
        response.status(404).end();
        return;
      }
      response.sendFile(path.join(__dirname, 'icons', request.params.filename));
    });

    app.get('/api/overlay/settings', (request, response) => {
      response.json(settings);
    });

    app.put('/api/overlay/settings', (request, response) => {
      const { tapGoal, coinGoal, ctaIntervalSeconds, ctaMessages } = request.body || {};
      const nextSettings = {
        tapGoal,
        coinGoal,
        ctaIntervalSeconds: ctaIntervalSeconds ?? defaultSettings.ctaIntervalSeconds,
        ctaMessages,
      };
      if (!isValidSettings(nextSettings)) {
        response.status(400).json({ ok: false, message: 'Revisa las metas y los mensajes del overlay.' });
        return;
      }
      saveSettings({
        tapGoal,
        coinGoal,
        ctaIntervalSeconds: nextSettings.ctaIntervalSeconds,
        ctaMessages: ctaMessages.map((message) => message.trim()),
      });
      response.json({ ok: true, settings });
    });

    app.get('/api/overlay/stream', (request, response) => {
      stream.attach(response, [['settings', settings]]);
    });

    app.post('/api/overlay/operator', (request, response) => {
      const { action } = request.body || {};
      const actions = new Set(['reset', 'test-like', 'test-follow', 'test-gift', 'test-epic-gift', 'test-song-goal']);
      if (!actions.has(action)) {
        response.status(400).json({ ok: false, message: 'La acción del operador no es válida.' });
        return;
      }
      stream.broadcast('command', { action });
      response.json({ ok: true });
    });
  }

  return { registerRoutes };
}

module.exports = { createOverlayModule };
