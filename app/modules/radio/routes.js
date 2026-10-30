const express = require('express');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream');

function sendResult(response, result) {
  if (!result.ok) {
    response.status(result.status).json({ ok: false, message: result.message });
    return;
  }
  response.status(result.status || 200).json(result);
}

function registerRadioRoutes(app, {
  addAudioFile,
  deleteAudioFile,
  getAvailableTracks,
  getAvailableDiscs,
  createExternalDisc,
  getSnapshot,
  moveTrack,
  setCurrentTrack,
  setPlaybackState,
  setPlaylist,
  stream,
  resolveAudioFile,
  externalLibrary,
  getStorageConfiguration,
  saveStorageConfiguration,
  maxAudioFileSize,
}) {
  app.get('/api/radio-state', (request, response) => {
    response.json(getSnapshot());
  });

  app.get('/api/radio-state/stream', (request, response) => {
    stream.attach(response, [['snapshot', getSnapshot()]]);
  });

  app.get('/api/radio/tracks', async (request, response) => {
    response.json({ tracks: await getAvailableTracks(), discs: getAvailableDiscs() });
  });

  app.post('/api/radio/discs', async (request, response) => {
    const result = await createExternalDisc(request.body?.name);
    if (!result.ok) {
      response.status(result.status).json({ ok: false, message: result.message });
      return;
    }
    response.status(result.created ? 201 : 200).json(result);
  });

  app.post('/api/radio/tracks', express.raw({
    type: '*/*',
    limit: maxAudioFileSize,
  }), async (request, response) => {
    let filename;
    let discName;
    try {
      filename = decodeURIComponent(request.get('x-file-name') || '');
      discName = decodeURIComponent(request.get('x-disc-name') || '');
    } catch {
      response.status(400).json({ ok: false, message: 'El nombre del archivo o disco no es válido.' });
      return;
    }
    const result = await addAudioFile(filename, request.body, discName);
    if (result.ok) result.status = 201;
    sendResult(response, result);
  });

  app.delete('/api/radio/tracks/:filename', async (request, response) => {
    sendResult(response, await deleteAudioFile(request.params.filename));
  });

  app.get('/audio/:filename', async (request, response, next) => {
    if (externalLibrary?.getServerUrl()) {
      try {
        const externalResponse = await externalLibrary.fetchTrack(request.params.filename, request.get('range'));
        const headers = ['accept-ranges', 'content-length', 'content-range', 'content-type'];
        for (const header of headers) {
          const value = externalResponse.headers.get(header);
          if (value) response.set(header, value);
        }
        response.status(externalResponse.status);
        if (!externalResponse.body) {
          response.end();
          return;
        }
        pipeline(Readable.fromWeb(externalResponse.body), response, (error) => {
          if (error) next(error);
        });
      } catch (error) {
        if (error.status === 404) {
          response.status(404).json({ ok: false, message: error.message });
          return;
        }
        next(error);
      }
      return;
    }
    const filePath = resolveAudioFile(request.params.filename);
    if (!filePath) {
      response.status(404).json({ ok: false, message: 'No se encontró el archivo de audio.' });
      return;
    }
    response.sendFile(filePath);
  });

  app.get('/api/radio/playlist', (request, response) => {
    response.json(getSnapshot());
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

  app.put('/api/radio/playlist', async (request, response) => {
    sendResult(response, await setPlaylist(request.body?.tracks));
  });

  app.post('/api/radio/current', (request, response) => {
    sendResult(response, setCurrentTrack(request.body?.index));
  });

  app.post('/api/radio/next', (request, response) => {
    sendResult(response, moveTrack(1));
  });

  app.post('/api/radio/previous', (request, response) => {
    sendResult(response, moveTrack(-1));
  });

  app.post('/api/radio/playback', (request, response) => {
    sendResult(response, setPlaybackState(request.body?.isPlaying));
  });
}

module.exports = { registerRadioRoutes };
