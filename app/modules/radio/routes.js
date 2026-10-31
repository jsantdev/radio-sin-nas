const { pipeline } = require('node:stream');
const { Readable } = require('node:stream');

function sendResult(response, result) {
  if (!result.ok) {
    response.status(result.status).json({ ok: false, message: result.message });
    return;
  }
  response.status(result.status || 200).json(result);
}

function registerRadioRoutes(app, {
  getSnapshot,
  getStorageConfiguration,
  playerAction,
  refreshState,
  saveStorageConfiguration,
  stream,
  externalLibrary,
}) {
  app.get('/api/radio-state', async (request, response, next) => {
    try {
      await refreshState();
      response.json(getSnapshot());
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/radio-state/stream', (request, response) => {
    stream.attach(response, [['snapshot', getSnapshot()]]);
  });

  app.get('/audio/current', async (request, response, next) => {
    try {
      const audioResponse = await externalLibrary.fetchCurrentTrack(request.get('range'));
      for (const header of ['accept-ranges', 'content-length', 'content-range', 'content-type']) {
        const value = audioResponse.headers.get(header);
        if (value) response.set(header, value);
      }
      response.status(audioResponse.status);
      if (!audioResponse.body) {
        response.end();
        return;
      }
      pipeline(Readable.fromWeb(audioResponse.body), response, (error) => {
        if (error) next(error);
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/radio/storage', (request, response) => {
    response.json(getStorageConfiguration());
  });

  app.put('/api/radio/storage', async (request, response) => {
    const result = await saveStorageConfiguration(request.body?.serverUrl);
    if (!result.ok) {
      response.status(result.status).json({ ok: false, message: result.message, configuration: result.configuration });
      return;
    }
    response.json(result.configuration);
  });

  for (const action of ['next', 'previous', 'playback']) {
    app.post(`/api/radio/${action}`, async (request, response) => {
      sendResult(response, await playerAction(action, request.body || {}));
    });
  }
}

module.exports = { registerRadioRoutes };
