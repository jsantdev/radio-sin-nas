const express = require('express');

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
  getSnapshot,
  moveTrack,
  setCurrentTrack,
  setPlaybackState,
  setPlaylist,
  stream,
  resolveAudioFile,
  maxAudioFileSize,
}) {
  app.get('/api/radio-state', (request, response) => {
    response.json(getSnapshot());
  });

  app.get('/api/radio-state/stream', (request, response) => {
    stream.attach(response, [['snapshot', getSnapshot()]]);
  });

  app.get('/api/radio/tracks', (request, response) => {
    response.json({ tracks: getAvailableTracks() });
  });

  app.post('/api/radio/tracks', express.raw({
    type: '*/*',
    limit: maxAudioFileSize,
  }), (request, response) => {
    let filename;
    try {
      filename = decodeURIComponent(request.get('x-file-name') || '');
    } catch {
      response.status(400).json({ ok: false, message: 'El nombre del archivo no es válido.' });
      return;
    }
    const result = addAudioFile(filename, request.body);
    if (result.ok) result.status = 201;
    sendResult(response, result);
  });

  app.delete('/api/radio/tracks/:filename', (request, response) => {
    sendResult(response, deleteAudioFile(request.params.filename));
  });

  app.get('/audio/:filename', (request, response) => {
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

  app.put('/api/radio/playlist', (request, response) => {
    sendResult(response, setPlaylist(request.body?.tracks));
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
