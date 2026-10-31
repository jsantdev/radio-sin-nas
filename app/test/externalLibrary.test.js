const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLibraryServer } = require('../../biblioteca-musical/server');
const { createWebserver } = require('../server');

function createMonitorService() {
  const service = {
    state: { username: '', status: 'idle', isConnected: false, error: '' },
    getAvailableEventsPayload: () => ({
      events: ['chat', 'gift', 'like', 'follow', 'share', 'member', 'subNotify'],
      labels: {},
      enabled: ['chat', 'gift', 'like', 'follow', 'share', 'member', 'subNotify'],
    }),
    getStatusPayload: () => ({ ...service.state }),
    setEnabledEvents() {},
    subscribeToEvents: () => () => {},
    subscribeToStatus: () => () => {},
    connectUser(username) {
      Object.assign(service.state, { username, status: 'connected', isConnected: true });
    },
    disconnectUser() {
      Object.assign(service.state, { username: '', status: 'disconnected', isConnected: false });
    },
  };
  return service;
}

async function listen(server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  const closed = once(server, 'close');
  server.close();
  await closed;
}

test('radio saves an unreachable manually configured library URL and exposes its error', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), `external-radio-${randomUUID()}-`));
  const settingsPath = path.join(storage, 'external-library-config.json');
  const server = createWebserver({
    monitorService: createMonitorService(),
    configurationPath: path.join(storage, 'monitor-config.json'),
    overlaySettingsPath: path.join(storage, 'overlay-settings.json'),
    audioDirectory: path.join(storage, 'local-music'),
    playlistPath: path.join(storage, 'radio-playlist.json'),
    externalLibraryConfigurationPath: settingsPath,
  }).server;
  const radioUrl = await listen(server);

  try {
    const response = await fetch(`${radioUrl}/api/radio/storage`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl: 'http://127.0.0.1:1' }),
    });
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.match(result.message, /La URL quedó guardada, pero no se pudo conectar/);
    assert.equal(result.configuration.serverUrl, 'http://127.0.0.1:1');
    assert.equal(result.configuration.connected, false);
    assert.ok(result.configuration.error);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {
      serverUrl: 'http://127.0.0.1:1',
    });

    const currentStatus = await fetch(`${radioUrl}/api/radio/storage`).then((item) => item.json());
    assert.equal(currentStatus.connected, false);
    assert.ok(currentStatus.error);
  } finally {
    await close(server);
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('library manages tracks directly and radio plays them after restart', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), `external-radio-${randomUUID()}-`));
  const dataDirectory = path.join(storage, 'discs');
  const settingsPath = path.join(storage, 'external-library-config.json');
  const configPath = path.join(storage, 'monitor-config.json');
  const overlaySettingsPath = path.join(storage, 'overlay-settings.json');
  let libraryServer = createLibraryServer({ dataDirectory });
  let libraryUrl = await listen(libraryServer);
  const appOptions = {
    monitorService: createMonitorService(),
    configurationPath: configPath,
    overlaySettingsPath,
    audioDirectory: path.join(storage, 'local-music'),
    externalLibraryConfigurationPath: settingsPath,
  };
  let appServer = createWebserver(appOptions).server;
  let radioUrl = await listen(appServer);
  const audio = Buffer.from('external audio bytes');
  const trackId = 'clasicos-latinos/Tema uno.mp3';

  try {
    const savedConfiguration = await fetch(`${radioUrl}/api/radio/storage`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl: libraryUrl }),
    });
    assert.equal(savedConfiguration.status, 200);
    assert.equal((await savedConfiguration.json()).connected, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { serverUrl: libraryUrl });
    const backendPage = await fetch(`${radioUrl}/backend`).then((response) => response.text());
    assert.match(backendPage, /id="libraryLink"/);
    assert.doesNotMatch(backendPage, /id="uploadForm"|id="discSelect"|id="trackTitle"/);
    assert.equal((await fetch(`${radioUrl}/playlist`)).status, 404);

    const createdDisc = await fetch(`${libraryUrl}/api/discs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Clásicos Latinos' }),
    });
    assert.equal(createdDisc.status, 201);
    assert.equal((await createdDisc.json()).disc.name, 'Clásicos Latinos');
    const createdLibrary = await fetch(`${libraryUrl}/api/discs`).then((response) => response.json());
    assert.deepEqual(createdLibrary.discs[0], {
      id: 'clasicos-latinos',
      name: 'Clásicos Latinos',
      tracks: [],
    });

    const uploaded = await fetch(`${libraryUrl}/api/tracks?disc=${encodeURIComponent('Clásicos Latinos')}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/mpeg',
        'X-File-Name': encodeURIComponent('Tema uno.mp3'),
      },
      body: audio,
    });
    assert.equal(uploaded.status, 201);

    const tracks = await fetch(`${libraryUrl}/api/discs`).then((response) => response.json());
    assert.equal(tracks.discs[0].tracks[0].id, trackId);
    assert.equal(tracks.discs[0].tracks[0].discName, 'Clásicos Latinos');
    const playlist = await fetch(`${libraryUrl}/api/player/playlist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: [trackId], repeat: false }),
    });
    assert.equal(playlist.status, 200);
    assert.equal((await playlist.json()).state.currentTrack.title, 'Tema uno');
    const playback = await fetch(`${radioUrl}/api/radio/playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPlaying: true }),
    });
    assert.equal(playback.status, 200);
    assert.equal((await fetch(`${libraryUrl}/api/player/state`).then((response) => response.json())).isPlaying, true);

    const audioResponse = await fetch(`${radioUrl}/audio/current`);
    assert.equal(audioResponse.status, 200);
    assert.deepEqual(Buffer.from(await audioResponse.arrayBuffer()), audio);

    await close(appServer);
    appServer = createWebserver(appOptions).server;
    radioUrl = await listen(appServer);
    const reloadedTracks = await fetch(`${libraryUrl}/api/discs`).then((response) => response.json());
    assert.equal(reloadedTracks.discs[0].tracks[0].id, trackId);
    assert.equal(reloadedTracks.discs[0].tracks[0].discName, 'Clásicos Latinos');
    const reloadedPlaylist = await fetch(`${radioUrl}/api/radio-state`).then((response) => response.json());
    assert.equal(reloadedPlaylist.currentTrack.name, trackId);
    assert.equal(reloadedPlaylist.repeat, false);
    assert.equal(reloadedPlaylist.isPlaying, true);
    assert.equal((await fetch(`${radioUrl}/api/radio/storage`).then((response) => response.json())).connected, true);

    const deleted = await fetch(`${libraryUrl}/api/tracks?id=${encodeURIComponent(trackId)}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.deepEqual((await fetch(`${libraryUrl}/api/discs`).then((response) => response.json())).discs[0].tracks, []);
  } finally {
    await close(appServer);
    await close(libraryServer);
    fs.rmSync(storage, { recursive: true, force: true });
  }
});
