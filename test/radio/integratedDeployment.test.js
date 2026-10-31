const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWebserver } = require('../../server');

const adminToken = 'integrated-library-test-token-with-at-least-32-bytes';

async function findFreePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  const closed = once(server, 'close');
  server.close();
  await closed;
}

function createIntegratedServer(storageDirectory, libraryPort) {
  return createWebserver({
    integratedLibrary: true,
    libraryPort,
    dataDirectory: storageDirectory,
    libraryDataDirectory: path.join(storageDirectory, 'biblioteca', 'discs'),
    libraryAdminToken: adminToken,
    externalLibraryConfigurationPath: path.join(storageDirectory, 'radio', 'library-config.json'),
    monitorService: {
      state: { username: '', status: 'idle', isConnected: false, error: '' },
      getAvailableEventsPayload: () => ({ events: [], labels: {}, enabled: [] }),
      getStatusPayload: () => ({}),
      setEnabledEvents() {},
      subscribeToEvents: () => () => {},
      subscribeToStatus: () => () => {},
      connectUser() {},
      disconnectUser() {},
    },
  });
}

test('one deployment serves the library panel and API and persists its data in the shared volume', async () => {
  const storageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-integrated-'));
  let appServer;

  try {
    let instance = createIntegratedServer(storageDirectory, await findFreePort());
    appServer = instance.server;
    let baseUrl = await listen(appServer);
    const authorization = { Authorization: `Bearer ${adminToken}` };
    const page = await fetch(`${baseUrl}/biblioteca`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /biblioteca\/manifest\.webmanifest/);

    const manifest = await fetch(`${baseUrl}/biblioteca/manifest.webmanifest`).then((response) => response.json());
    assert.equal(manifest.start_url, '/biblioteca/');
    assert.equal(manifest.scope, '/biblioteca/');
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);

    const createdDisc = await fetch(`${baseUrl}/api/discs`, {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Disco de prueba' }),
    });
    assert.equal(createdDisc.status, 201);

    const upload = await fetch(`${baseUrl}/api/tracks?disc=${encodeURIComponent('Disco de prueba')}`, {
      method: 'POST',
      headers: {
        ...authorization,
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent('tema.mp3'),
      },
      body: Buffer.from('audio de prueba'),
    });
    assert.equal(upload.status, 201);
    const { track } = await upload.json();
    assert.equal((await fetch(`${baseUrl}/api/tracks?id=${encodeURIComponent(track.id)}`, {
      method: 'DELETE',
    })).status, 401);

    await close(appServer);
    appServer = null;
    instance = createIntegratedServer(storageDirectory, await findFreePort());
    appServer = instance.server;
    baseUrl = await listen(appServer);
    const savedDiscs = await fetch(`${baseUrl}/api/discs`).then((response) => response.json());
    assert.equal(savedDiscs.discs[0].tracks[0].id, track.id);

    const playlist = await fetch(`${baseUrl}/api/player/playlist`, {
      method: 'PUT',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: [track.id] }),
    });
    assert.equal(playlist.status, 200);
    const playback = await fetch(`${baseUrl}/api/radio/next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(playback.status, 200);
  } finally {
    if (appServer) await close(appServer);
    fs.rmSync(storageDirectory, { recursive: true, force: true });
  }
});
