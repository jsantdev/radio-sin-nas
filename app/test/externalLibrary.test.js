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

test('radio uploads and plays tracks from the persistent external library after restart', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), `external-radio-${randomUUID()}-`));
  const dataDirectory = path.join(storage, 'discs');
  const settingsPath = path.join(storage, 'external-library-config.json');
  const playlistPath = path.join(storage, 'radio-playlist.json');
  const configPath = path.join(storage, 'monitor-config.json');
  const overlaySettingsPath = path.join(storage, 'overlay-settings.json');
  let libraryServer = createLibraryServer({ dataDirectory });
  let libraryUrl = await listen(libraryServer);
  const appOptions = {
    monitorService: createMonitorService(),
    configurationPath: configPath,
    overlaySettingsPath,
    audioDirectory: path.join(storage, 'local-music'),
    playlistPath,
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
    const playlistPage = await fetch(`${radioUrl}/playlist`).then((response) => response.text());
    assert.match(playlistPage, /id="discSelect"/);
    assert.match(playlistPage, /id="createDiscButton"/);
    assert.match(playlistPage, /id="selectedAudioPlayer" controls/);
    assert.match(playlistPage, /id="trackTitle"/);

    const createdDisc = await fetch(`${radioUrl}/api/radio/discs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Clásicos Latinos' }),
    });
    assert.equal(createdDisc.status, 201);
    assert.equal((await createdDisc.json()).disc.name, 'Clásicos Latinos');
    const createdLibrary = await fetch(`${radioUrl}/api/radio/tracks`).then((response) => response.json());
    assert.deepEqual(createdLibrary.discs[0], {
      id: 'clasicos-latinos',
      name: 'Clásicos Latinos',
      trackCount: 0,
    });

    const uploaded = await fetch(`${radioUrl}/api/radio/tracks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/mpeg',
        'X-File-Name': encodeURIComponent('Tema uno.mp3'),
        'X-Disc-Name': encodeURIComponent('Clásicos Latinos'),
      },
      body: audio,
    });
    assert.equal(uploaded.status, 201);

    const tracks = await fetch(`${radioUrl}/api/radio/tracks`).then((response) => response.json());
    assert.equal(tracks.tracks[0].name, trackId);
    assert.equal(tracks.tracks[0].discName, 'Clásicos Latinos');
    const playlist = await fetch(`${radioUrl}/api/radio/playlist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: [trackId] }),
    });
    assert.equal(playlist.status, 200);
    assert.equal((await playlist.json()).state.currentTrack.title, 'Tema uno');

    const audioResponse = await fetch(`${radioUrl}/audio/${encodeURIComponent(trackId)}`);
    assert.equal(audioResponse.status, 200);
    assert.deepEqual(Buffer.from(await audioResponse.arrayBuffer()), audio);

    const libraryPort = Number(new URL(libraryUrl).port);
    await close(libraryServer);
    libraryServer = createLibraryServer({ dataDirectory });
    libraryUrl = await listen(libraryServer, libraryPort);
    await close(appServer);
    appServer = createWebserver(appOptions).server;
    radioUrl = await listen(appServer);
    const reloadedTracks = await fetch(`${radioUrl}/api/radio/tracks`).then((response) => response.json());
    assert.equal(reloadedTracks.tracks[0].name, trackId);
    assert.equal(reloadedTracks.tracks[0].discName, 'Clásicos Latinos');
    const reloadedPlaylist = await fetch(`${radioUrl}/api/radio/playlist`).then((response) => response.json());
    assert.equal(reloadedPlaylist.currentTrack.name, trackId);
    assert.equal((await fetch(`${radioUrl}/api/radio/storage`).then((response) => response.json())).connected, true);

    const deleted = await fetch(`${radioUrl}/api/radio/tracks/${encodeURIComponent(trackId)}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.deepEqual((await fetch(`${radioUrl}/api/radio/tracks`).then((response) => response.json())).tracks, []);
  } finally {
    await close(appServer);
    await close(libraryServer);
    fs.rmSync(storage, { recursive: true, force: true });
  }
});
