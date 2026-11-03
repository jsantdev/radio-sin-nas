const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWebserver } = require('../../server');
const { createLibraryServer } = require('../../modules/biblioteca/server');

const adminToken = 'integrated-library-admin-token-0123456789';

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

function createIntegratedServer(storageDirectory, libraryPort, token = adminToken, radioToken = token) {
  return createWebserver({
    integratedLibrary: true,
    libraryPort,
    dataDirectory: storageDirectory,
    libraryDataDirectory: path.join(storageDirectory, 'biblioteca', 'discs'),
    libraryAdminToken: token,
    radioLibraryAdminToken: radioToken,
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

test('integrated radio can select, persist, and open an external NAS library', async () => {
  const storageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-external-nas-'));
  const localToken = 'integrated-library-admin-token-0123456789';
  const remoteToken = 'external-library-admin-token-0123456789';
  const remoteServer = createLibraryServer({
    dataDirectory: path.join(storageDirectory, 'remote', 'discs'),
    adminToken: remoteToken,
  });
  let appServer;

  try {
    const remoteUrl = await listen(remoteServer);
    const remoteHeaders = { Authorization: 'Bearer ' + remoteToken };
    const createdDisc = await fetch(`${remoteUrl}/api/discs`, {
      method: 'POST',
      headers: { ...remoteHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Biblioteca NAS' }),
    });
    assert.equal(createdDisc.status, 201);
    const audio = Buffer.from('audio desde NAS');
    const uploaded = await fetch(`${remoteUrl}/api/tracks?disc=Biblioteca%20NAS`, {
      method: 'POST',
      headers: {
        ...remoteHeaders,
        'Content-Type': 'audio/mpeg',
        'X-File-Name': 'tema.mp3',
      },
      body: audio,
    });
    assert.equal(uploaded.status, 201);

    let instance = createIntegratedServer(
      storageDirectory,
      await findFreePort(),
      localToken,
      remoteToken,
    );
    appServer = instance.server;
    let baseUrl = await listen(appServer);
    const connection = await fetch(`${baseUrl}/api/radio/storage`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl: remoteUrl }),
    });
    assert.equal(connection.status, 200);
    const configuration = await connection.json();
    assert.equal(configuration.local, false);
    assert.equal(configuration.connected, true);
    assert.equal(configuration.trackCount, 1);

    const libraryPageResponse = await fetch(`${baseUrl}/biblioteca`);
    assert.equal(libraryPageResponse.status, 200);
    const libraryPage = await libraryPageResponse.text();
    assert.match(libraryPage, /\/biblioteca\/api\/admin\/config/);
    assert.doesNotMatch(libraryPage, new RegExp(remoteToken));
    const adminConfiguration = await fetch(`${baseUrl}/biblioteca/api/admin/config`).then((response) => response.json());
    assert.equal(adminConfiguration.proxyAuthenticated, true);
    const adminSession = await fetch(`${baseUrl}/biblioteca/api/admin/session`).then((response) => response.json());
    assert.equal(adminSession.authenticated, true);
    const proxiedDisc = await fetch(`${baseUrl}/biblioteca/api/discs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Disco desde Radio' }),
    });
    assert.equal(proxiedDisc.status, 201);
    const proxiedUpload = await fetch(
      `${baseUrl}/biblioteca/api/tracks?disc=${encodeURIComponent('Disco desde Radio')}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'audio/mpeg', 'X-File-Name': 'carga.mp3' },
        body: Buffer.from('audio subido desde la interfaz proxy'),
      },
    );
    assert.equal(proxiedUpload.status, 201);

    const audioResponse = await fetch(`${baseUrl}/audio/current`);
    assert.equal(audioResponse.status, 200);
    assert.deepEqual(Buffer.from(await audioResponse.arrayBuffer()), audio);
    const playback = await fetch(`${baseUrl}/api/radio/playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPlaying: true }),
    });
    assert.equal(playback.status, 200);
    assert.equal((await fetch(`${remoteUrl}/api/player/state`).then((response) => response.json())).isPlaying, true);

    const radioPage = await fetch(`${baseUrl}/backend/radio`).then((response) => response.text());
    assert.match(radioPage, /libraryPageLink\.href = '\/biblioteca'/);
    assert.doesNotMatch(radioPage, /libraryStorageForm\.hidden/);

    await close(appServer);
    instance = createIntegratedServer(
      storageDirectory,
      await findFreePort(),
      localToken,
      remoteToken,
    );
    appServer = instance.server;
    baseUrl = await listen(appServer);
    await fetch(`${baseUrl}/api/radio-state`);
    const restoredConfiguration = await fetch(`${baseUrl}/api/radio/storage`).then((response) => response.json());
    assert.equal(restoredConfiguration.serverUrl, remoteUrl);
    assert.equal(restoredConfiguration.local, false);
    assert.equal(restoredConfiguration.connected, true);

    const restoreLocal = await fetch(`${baseUrl}/api/radio/storage`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl: '' }),
    });
    assert.equal(restoreLocal.status, 200);
    const localConfiguration = await restoreLocal.json();
    assert.equal(localConfiguration.local, true);
    assert.equal(localConfiguration.connected, true);
  } finally {
    if (appServer) await close(appServer);
    await close(remoteServer);
    fs.rmSync(storageDirectory, { recursive: true, force: true });
  }
});

test('integrated upload adds audio to the radio playlist and makes it playable', async () => {
  const storageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-integrated-'));
  let appServer;

  try {
    let instance = createIntegratedServer(storageDirectory, await findFreePort());
    appServer = instance.server;
    let baseUrl = await listen(appServer);
    const page = await fetch(`${baseUrl}/biblioteca`);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /biblioteca\/manifest\.webmanifest/);
    assert.match(pageHtml, /href="\/biblioteca\/dashboard\.css"/);
    assert.match(pageHtml, /Token de administrador/);
    const dataPage = await fetch(`${baseUrl}/biblioteca/datos`);
    assert.equal(dataPage.status, 200);
    const dataPageHtml = await dataPage.text();
    assert.match(dataPageHtml, /Token de administrador/);
    assert.match(dataPageHtml, /Authorization', 'Bearer '/);
    assert.doesNotMatch(dataPageHtml, /adminPassword|BIBLIOTECA_ADMIN_PASSWORD/);
    assert.match(await (await fetch(`${baseUrl}/biblioteca/dashboard.css`)).text(), /--accent:\s*#00b37e/);
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);

    const unauthenticatedUpload = await fetch(`${baseUrl}/api/discs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No autorizado' }),
    });
    assert.equal(unauthenticatedUpload.status, 401);

    const headers = { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' };
    const createdDisc = await fetch(`${baseUrl}/api/discs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Disco de prueba' }),
    });
    assert.equal(createdDisc.status, 201);

    const audio = Buffer.from('audio de prueba');
    const upload = await fetch(`${baseUrl}/api/tracks?disc=${encodeURIComponent('Disco de prueba')}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + adminToken,
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent('tema.mp3'),
      },
      body: audio,
    });
    assert.equal(upload.status, 201);
    const { track, queued } = await upload.json();
    assert.equal(queued, true);

    const library = await fetch(`${baseUrl}/api/discs`).then((response) => response.json());
    assert.equal(library.discs[0].tracks[0].id, track.id);
    const playlist = await fetch(`${baseUrl}/api/player/playlist`).then((response) => response.json());
    assert.deepEqual(playlist.queue.map((item) => item.id), [track.id]);
    assert.equal(playlist.currentTrack.id, track.id);
    assert.equal(playlist.isPlaying, false);

    const audioResponse = await fetch(`${baseUrl}/api/player/audio`);
    assert.equal(audioResponse.status, 200);
    assert.deepEqual(Buffer.from(await audioResponse.arrayBuffer()), audio);

    const playback = await fetch(`${baseUrl}/api/radio/playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPlaying: true }),
    });
    assert.equal(playback.status, 200);
    const playing = await fetch(`${baseUrl}/api/player/state`).then((response) => response.json());
    assert.equal(playing.isPlaying, true);
    assert.equal(playing.currentTrack.id, track.id);

    await close(appServer);
    appServer = null;
    instance = createIntegratedServer(storageDirectory, await findFreePort());
    appServer = instance.server;
    baseUrl = await listen(appServer);
    const savedState = await fetch(`${baseUrl}/api/player/state`).then((response) => response.json());
    assert.deepEqual(savedState.queue.map((item) => item.id), [track.id]);
    assert.equal(savedState.isPlaying, true);
  } finally {
    if (appServer) await close(appServer);
    fs.rmSync(storageDirectory, { recursive: true, force: true });
  }
});

test('integrated library permits unauthenticated mutations only for local development', async () => {
  const storageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-integrated-local-'));
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAuthDisabled = process.env.BIBLIOTECA_AUTH_DISABLED;
  process.env.NODE_ENV = 'development';
  process.env.BIBLIOTECA_AUTH_DISABLED = 'true';
  let appServer;

  try {
    const instance = createIntegratedServer(storageDirectory, await findFreePort(), '');
    appServer = instance.server;
    const baseUrl = await listen(appServer);
    const config = await fetch(`${baseUrl}/api/admin/config`).then((response) => response.json());
    assert.deepEqual(config, { configured: false, authRequired: false });
    const createdDisc = await fetch(`${baseUrl}/api/discs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Disco local' }),
    });
    assert.equal(createdDisc.status, 201);
  } finally {
    if (appServer) await close(appServer);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalAuthDisabled === undefined) delete process.env.BIBLIOTECA_AUTH_DISABLED;
    else process.env.BIBLIOTECA_AUTH_DISABLED = originalAuthDisabled;
    fs.rmSync(storageDirectory, { recursive: true, force: true });
  }
});
