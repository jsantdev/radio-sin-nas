const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLibraryServer } = require('../../modules/biblioteca/server');
const { createWebserver } = require('../../server');
const { createExternalLibraryClient } = require('../../modules/radio/externalLibraryClient');

const libraryAdminToken = 'test-library-admin-token-0123456789';
async function libraryFetch(url, options = {}) {
  const parsedUrl = new URL(url);
  const method = (options.method || 'GET').toUpperCase();
  const needsSession = method !== 'GET' || parsedUrl.pathname.startsWith('/api/admin/');
  const headers = new Headers(options.headers || {});
  if (needsSession) headers.set('Authorization', 'Bearer ' + libraryAdminToken);
  return fetch(url, { ...options, headers });
}

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

test('integrated radio restores the saved external library and falls back to its local library', () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), `external-radio-${randomUUID()}-`));
  const settingsPath = path.join(storage, 'external-library-config.json');
  const externalUrl = 'https://nas.example.com';
  fs.writeFileSync(settingsPath, JSON.stringify({ serverUrl: externalUrl }));

  try {
    const client = createExternalLibraryClient({
      configurationPath: settingsPath,
      defaultServerUrl: 'http://127.0.0.1:3101',
    });
    assert.equal(client.getServerUrl(), externalUrl);
    assert.equal(client.isLocalServer(), false);

    const configuration = client.setServerUrl('');
    assert.equal(configuration.serverUrl, 'http://127.0.0.1:3101');
    assert.equal(client.getServerUrl(), 'http://127.0.0.1:3101');
    assert.equal(client.isLocalServer(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { serverUrl: '' });
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('external library client can use the configured NAS URL as its default', () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), `external-radio-${randomUUID()}-`));
  const settingsPath = path.join(storage, 'external-library-config.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ serverUrl: 'http://127.0.0.1:3101' }));

  try {
    const client = createExternalLibraryClient({
      configurationPath: settingsPath,
      defaultServerUrl: 'http://127.0.0.1:3101',
      initialServerUrl: 'https://nas.example.com',
    });
    assert.equal(client.getServerUrl(), 'https://nas.example.com');
    assert.equal(client.isLocalServer(), false);
    assert.equal(client.setServerUrl('').serverUrl, 'https://nas.example.com');
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

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
  let libraryServer = createLibraryServer({ dataDirectory, adminToken: libraryAdminToken });
  let libraryUrl = await listen(libraryServer);
  const appOptions = {
    monitorService: createMonitorService(),
    configurationPath: configPath,
    overlaySettingsPath,
    audioDirectory: path.join(storage, 'local-music'),
    externalLibraryConfigurationPath: settingsPath,
    externalLibrary: createExternalLibraryClient({
      configurationPath: settingsPath,
      adminToken: libraryAdminToken,
    }),
  };
  let appServer = createWebserver(appOptions).server;
  let radioUrl = await listen(appServer);
  const audio = Buffer.from('external audio bytes');
  const nextAudio = Buffer.from('next external audio bytes');
  const trackId = 'clasicos-latinos/Tema uno.mp3';
  const nextTrackId = 'clasicos-latinos/Tema dos.mp3';

  try {
    const savedConfiguration = await fetch(`${radioUrl}/api/radio/storage`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl: libraryUrl }),
    });
    assert.equal(savedConfiguration.status, 200);
    const saved = await savedConfiguration.json();
    assert.equal(saved.connected, true);
    assert.equal(saved.adminTokenConfigured, true);
    assert.equal(Object.hasOwn(saved, 'adminToken'), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {
      serverUrl: libraryUrl,
    });
    const backendPage = await fetch(`${radioUrl}/backend`).then((response) => response.text());
    assert.match(backendPage, /id="libraryLink"/);
    assert.doesNotMatch(backendPage, /id="uploadForm"|id="discSelect"|id="trackTitle"/);
    const radioAdminPage = await fetch(`${radioUrl}/backend/radio`).then((response) => response.text());
    assert.match(radioAdminPage, /id="libraryStorageForm"/);
    assert.match(radioAdminPage, /\/api\/radio\/storage/);
    assert.equal((await fetch(`${radioUrl}/playlist`)).status, 404);

    const createdDisc = await libraryFetch(`${libraryUrl}/api/discs`, {
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

    const uploaded = await libraryFetch(`${libraryUrl}/api/tracks?disc=${encodeURIComponent('Clásicos Latinos')}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/mpeg',
        'X-File-Name': encodeURIComponent('Tema uno.mp3'),
      },
      body: audio,
    });
    assert.equal(uploaded.status, 201);
    assert.equal((await uploaded.json()).queued, true);

    const uploadedNext = await libraryFetch(`${libraryUrl}/api/tracks?disc=${encodeURIComponent('Clásicos Latinos')}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/mpeg',
        'X-File-Name': encodeURIComponent('Tema dos.mp3'),
      },
      body: nextAudio,
    });
    assert.equal(uploadedNext.status, 201);

    const tracks = await fetch(`${libraryUrl}/api/discs`).then((response) => response.json());
    assert.deepEqual(new Set(tracks.discs[0].tracks.map((track) => track.id)), new Set([trackId, nextTrackId]));
    const playlist = await libraryFetch(`${libraryUrl}/api/player/playlist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: [trackId, nextTrackId], repeat: false }),
    });
    assert.equal(playlist.status, 200);
    const selectFirstTrack = await libraryFetch(`${libraryUrl}/api/player/current`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: 0 }),
    });
    assert.equal(selectFirstTrack.status, 200);
    assert.equal((await selectFirstTrack.json()).state.currentTrack.title, 'Tema uno');
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
    const firstRadioState = await fetch(`${radioUrl}/api/radio-state`).then((response) => response.json());
    assert.match(firstRadioState.currentTrack.url, /track=clasicos-latinos%2FTema%20uno\.mp3/);
    const nextTrack = await fetch(`${radioUrl}/api/radio/next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(nextTrack.status, 200);
    const nextRadioState = await nextTrack.json();
    assert.equal(nextRadioState.state.currentTrack.name, nextTrackId);
    assert.match(nextRadioState.state.currentTrack.url, /track=clasicos-latinos%2FTema%20dos\.mp3/);
    const nextAudioResponse = await fetch(`${radioUrl}${nextRadioState.state.currentTrack.url}`);
    assert.equal(nextAudioResponse.status, 200);
    assert.equal(nextAudioResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await nextAudioResponse.arrayBuffer()), nextAudio);
    const partialAudioResponse = await fetch(`${radioUrl}/audio/current`, {
      headers: { Range: 'bytes=0-7' },
    });
    assert.equal(partialAudioResponse.status, 206);
    assert.equal(partialAudioResponse.headers.get('content-range'), `bytes 0-7/${nextAudio.length}`);
    assert.deepEqual(Buffer.from(await partialAudioResponse.arrayBuffer()), nextAudio.subarray(0, 8));

    await close(appServer);
    appServer = createWebserver(appOptions).server;
    radioUrl = await listen(appServer);
    const reloadedTracks = await fetch(`${libraryUrl}/api/discs`).then((response) => response.json());
    assert.deepEqual(new Set(reloadedTracks.discs[0].tracks.map((track) => track.id)), new Set([trackId, nextTrackId]));
    const reloadedPlaylist = await fetch(`${radioUrl}/api/radio-state`).then((response) => response.json());
    assert.equal(reloadedPlaylist.currentTrack.name, nextTrackId);
    assert.equal(reloadedPlaylist.repeat, false);
    assert.equal(reloadedPlaylist.isPlaying, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(storage, 'player-state.json'), 'utf8')), {
      queue: [trackId, nextTrackId],
      currentIndex: 1,
      isPlaying: true,
      repeat: false,
    });
    assert.equal((await fetch(`${radioUrl}/api/radio/storage`).then((response) => response.json())).connected, true);

    const deleted = await libraryFetch(`${libraryUrl}/api/tracks?id=${encodeURIComponent(trackId)}`, {
      method: 'DELETE',
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual((await fetch(`${libraryUrl}/api/discs`).then((response) => response.json()))
      .discs[0].tracks.map((track) => track.id), [nextTrackId]);
  } finally {
    await close(appServer);
    await close(libraryServer);
    fs.rmSync(storage, { recursive: true, force: true });
  }
});
