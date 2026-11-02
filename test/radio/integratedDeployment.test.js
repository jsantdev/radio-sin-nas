const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWebserver } = require('../../server');

const adminPassword = 'integrated-library-password-123';

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

function createIntegratedServer(storageDirectory, libraryPort, password = adminPassword) {
  return createWebserver({
    integratedLibrary: true,
    libraryPort,
    dataDirectory: storageDirectory,
    libraryDataDirectory: path.join(storageDirectory, 'biblioteca', 'discs'),
    libraryAdminPassword: password,
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
    const page = await fetch(`${baseUrl}/biblioteca`);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /biblioteca\/manifest\.webmanifest/);
    assert.match(pageHtml, /href="\/biblioteca\/dashboard\.css"/);
    const dashboardStyles = await fetch(`${baseUrl}/biblioteca/dashboard.css`);
    assert.equal(dashboardStyles.status, 200);
    assert.match(await dashboardStyles.text(), /--accent:\s*#00b37e/);
    const dataPageResponse = await fetch(`${baseUrl}/biblioteca/datos`);
    assert.equal(dataPageResponse.status, 200);
    const dataPageHtml = await dataPageResponse.text();
    assert.match(dataPageHtml, /Exportar a otra Biblioteca/);
    assert.match(dataPageHtml, /href="\/biblioteca\/datos"/);
    assert.match(dataPageHtml, /href="\/biblioteca\/"/);

    const manifest = await fetch(`${baseUrl}/biblioteca/manifest.webmanifest`).then((response) => response.json());
    assert.equal(manifest.start_url, '/biblioteca/');
    assert.equal(manifest.scope, '/biblioteca/');
    const serviceWorker = await fetch(`${baseUrl}/biblioteca/service-worker.js`).then((response) => response.text());
    assert.match(serviceWorker, /'\/biblioteca\/dashboard\.css'/);
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);

    const login = await fetch(`${baseUrl}/api/admin/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: adminPassword }),
    });

    test('integrated library allows password-free mutations only for local development', async () => {
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
    assert.equal(login.status, 200);
    const sessionCookie = (login.headers.get('set-cookie') || '').split(';', 1)[0];
    const session = { Cookie: sessionCookie };
    const createdDisc = await fetch(`${baseUrl}/api/discs`, {
      method: 'POST',
      headers: { ...session, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Disco de prueba' }),
    });
    assert.equal(createdDisc.status, 201);

    const upload = await fetch(`${baseUrl}/api/tracks?disc=${encodeURIComponent('Disco de prueba')}`, {
      method: 'POST',
      headers: {
        ...session,
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

    const reLogin = await fetch(`${baseUrl}/api/admin/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: adminPassword }),
    });
    const reSession = { Cookie: (reLogin.headers.get('set-cookie') || '').split(';', 1)[0] };
    const playlist = await fetch(`${baseUrl}/api/player/playlist`, {
      method: 'PUT',
      headers: { ...reSession, 'Content-Type': 'application/json' },
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
