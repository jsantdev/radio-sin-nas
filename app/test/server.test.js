const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWebserver } = require('../server');

function createMonitorService() {
  let eventListener;
  let statusListener;
  const service = {
    state: { username: '', status: 'idle', isConnected: false, error: '' },
    getAvailableEventsPayload: () => ({
      events: ['chat', 'gift', 'like', 'follow', 'share', 'member', 'subNotify'],
      labels: { chat: 'Comentario', gift: 'Regalo', like: 'Me gusta' },
      enabled: ['chat', 'gift', 'like', 'follow', 'share', 'member', 'subNotify'],
    }),
    getStatusPayload: () => ({ ...service.state }),
    setEnabledEvents(events) {
      service.enabledEvents = [...events];
    },
    subscribeToEvents(listener) {
      eventListener = listener;
      return () => { eventListener = null; };
    },
    subscribeToStatus(listener) {
      statusListener = listener;
      return () => { statusListener = null; };
    },
    connectUser(username) {
      Object.assign(service.state, { username, status: 'connected', isConnected: true, error: '' });
      statusListener?.({ ...service.state });
    },
    disconnectUser() {
      Object.assign(service.state, { username: '', status: 'disconnected', isConnected: false });
      statusListener?.({ ...service.state });
    },
    emit(entry) {
      eventListener(entry);
    },
  };
  return service;
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

test('radio server keeps TikTok configuration, event monitoring, and radio state separate', async () => {
  const monitorService = createMonitorService();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), `radio-config-${randomUUID()}-`));
  const configurationPath = path.join(storagePath, 'monitor-config.json');
  const overlaySettingsPath = path.join(storagePath, 'overlay-settings.json');
  const { server } = createWebserver({
    monitorService,
    configurationPath,
    overlaySettingsPath,
  });
  const baseUrl = await listen(server);
  let radioReader;
  let eventReader;
  let operatorReader;

  async function sendJson(route, method, body) {
    return fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  try {
    const overlayPage = await fetch(`${baseUrl}/`);
    assert.equal(overlayPage.status, 200);
    const overlayHtml = await overlayPage.text();
    assert.match(overlayHtml, /FE Y ESPERANZA/);
    assert.match(overlayHtml, /id="radioPlayer" preload="metadata" aria-hidden="true" class="hidden"/);
    assert.doesNotMatch(overlayHtml, /id="radioPlayer" controls/);
    assert.match(overlayHtml, /new EventSource\('\/api\/events'\)/);
    assert.match(overlayHtml, /new EventSource\('\/api\/radio-state\/stream'\)/);
    assert.match(overlayHtml, /clamp\(120px, 23vh, 210px\)/);
    assert.match(overlayHtml, /id="tapProgressBar"/);
    assert.match(overlayHtml, /Faltan .* likes para la pr/);
    assert.match(overlayHtml, /topContributors/);
    assert.doesNotMatch(overlayHtml, /href="\/playlist"/);
    assert.match(overlayHtml, /rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(overlayHtml, /serviceWorker\.register\('\/service-worker\.js'\)/);
    assert.doesNotMatch(overlayHtml, /toggleOperatorPanelBtn|operatorPanel/);
    assert.match(overlayHtml, /initOperatorStream\(\);/);
    assert.doesNotMatch(overlayHtml, /window\.onTikTokMember\(user\)/);
    assert.match(overlayHtml, /window\.onTikTokChat\(user, entry\.content/);
    assert.match(overlayHtml, /avatar: entry\.avatar/);
    assert.doesNotMatch(overlayHtml, /renderOperatorMessagesList/);

    const backendPage = await fetch(`${baseUrl}/backend`);
    assert.equal(backendPage.status, 200);
    const backendHtml = await backendPage.text();
    assert.match(backendHtml, /Panel técnico/);
    assert.match(backendHtml, /id="tiktokConfigForm"/);
    assert.match(backendHtml, /id="externalStorageForm"/);
    assert.doesNotMatch(backendHtml, /playlistTracks|scheduleForm|togglePlayback/);
    assert.equal((await fetch(`${baseUrl}/playlist`)).status, 404);

    const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    assert.match(manifestResponse.headers.get('content-type'), /application\/manifest\+json|application\/json/);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');
    assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512']);
    for (const size of [192, 512]) {
      const iconResponse = await fetch(`${baseUrl}/icons/icon-${size}.png`);
      assert.equal(iconResponse.status, 200);
      const icon = Buffer.from(await iconResponse.arrayBuffer());
      assert.equal(icon.toString('hex', 0, 8), '89504e470d0a1a0a');
      assert.equal(icon.readUInt32BE(16), size);
      assert.equal(icon.readUInt32BE(20), size);
    }

    const serviceWorkerResponse = await fetch(`${baseUrl}/service-worker.js`);
    assert.equal(serviceWorkerResponse.status, 200);
    assert.match(await serviceWorkerResponse.text(), /addEventListener\('fetch'/);

    const initialOverlaySettings = await fetch(`${baseUrl}/api/overlay/settings`).then((response) => response.json());
    assert.equal(initialOverlaySettings.tapGoal, 5000);
    assert.equal(initialOverlaySettings.coinGoal, 500);
    assert.equal(initialOverlaySettings.ctaIntervalSeconds, 25);
    assert.ok(initialOverlaySettings.ctaMessages.length > 0);

    const updatedOverlaySettings = await sendJson('/api/overlay/settings', 'PUT', {
      tapGoal: 10000,
      coinGoal: 750,
      ctaIntervalSeconds: 30,
      ctaMessages: ['Mensaje del backend'],
    });
    assert.equal(updatedOverlaySettings.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(overlaySettingsPath, 'utf8')), {
      tapGoal: 10000,
      coinGoal: 750,
      ctaIntervalSeconds: 30,
      ctaMessages: ['Mensaje del backend'],
    });

    const invalidOverlaySettings = await sendJson('/api/overlay/settings', 'PUT', {
      tapGoal: 0,
      coinGoal: 750,
      ctaIntervalSeconds: 30,
      ctaMessages: ['Mensaje'],
    });
    assert.equal(invalidOverlaySettings.status, 400);

    const operatorStream = await fetch(`${baseUrl}/api/overlay/stream`);
    operatorReader = operatorStream.body.getReader();
    assert.match(new TextDecoder().decode((await operatorReader.read()).value), /event: settings/);
    assert.equal((await sendJson('/api/overlay/operator', 'POST', { action: 'test-like' })).status, 200);
    const operatorCommand = new TextDecoder().decode((await operatorReader.read()).value);
    assert.match(operatorCommand, /event: command/);
    assert.match(operatorCommand, /test-like/);
    assert.equal((await sendJson('/api/overlay/operator', 'POST', { action: 'invalid' })).status, 400);

    assert.match(backendHtml, /Conexión al canal de TikTok/);
    assert.match(backendHtml, /NO CONECTADO/);
    assert.match(backendHtml, /Reconectar canal/);
    assert.match(backendHtml, /\/api\/reconnect/);
    assert.match(backendHtml, /hasta 3 intentos/);
    assert.match(backendHtml, /id="serverSettings"/);
    assert.match(backendHtml, /id="overlaySettingsForm"/);
    assert.match(backendHtml, /option value="20000"/);
    assert.match(backendHtml, /id="ctaIntervalSeconds"/);
    assert.match(backendHtml, /data-overlay-action="test-like"/);
    assert.match(backendHtml, /loadTikTokConfiguration\(\)/);

    const radioState = await fetch(`${baseUrl}/api/radio-state`).then((response) => response.json());
    assert.deepEqual(radioState, {
      status: 'empty',
      audioSource: 'external-library',
      isPlaying: false,
      repeat: true,
      currentIndex: null,
      currentTrack: null,
      queue: [],
    });

    const radioStream = await fetch(`${baseUrl}/api/radio-state/stream`);
    radioReader = radioStream.body.getReader();
    assert.match(new TextDecoder().decode((await radioReader.read()).value), /event: snapshot/);

    const eventStream = await fetch(`${baseUrl}/api/events`);
    eventReader = eventStream.body.getReader();
    const initialEvents = new TextDecoder().decode((await eventReader.read()).value);
    assert.match(initialEvents, /event: status/);
    assert.match(initialEvents, /event: snapshot/);

    const config = await fetch(`${baseUrl}/api/config`).then((response) => response.json());
    assert.equal(config.username, 'hnaevalopez');
    assert.equal(config.events.find((event) => event.name === 'gift').enabled, true);
    assert.equal(config.events.find((event) => event.name === 'subNotify').enabled, true);

    const reconnectWithoutUser = await sendJson('/api/reconnect', 'POST', {});
    assert.equal(reconnectWithoutUser.status, 409);

    const connect = await sendJson('/api/config', 'PUT', {
      username: '@hnaevalopez',
      ignoredEvents: ['follow'],
    }).then((response) => response.json());
    assert.equal(connect.username, 'hnaevalopez');
    assert.equal(JSON.parse(fs.readFileSync(configurationPath, 'utf8')).usernameConfigured, true);
    const configuredEvents = await fetch(`${baseUrl}/api/config`).then((response) => response.json());
    assert.equal(configuredEvents.events.find((event) => event.name === 'chat').enabled, true);
    assert.equal(configuredEvents.events.find((event) => event.name === 'follow').enabled, false);
    const reconnectWhileConnected = await sendJson('/api/reconnect', 'POST', {});
    assert.equal(reconnectWhileConnected.status, 409);
    monitorService.disconnectUser();
    const reconnect = await sendJson('/api/reconnect', 'POST', {});
    assert.equal(reconnect.status, 200);
    assert.equal((await reconnect.json()).username, 'hnaevalopez');

    monitorService.emit({
      type: 'gift',
      username: 'music-fan',
      time: new Date().toISOString(),
      content: 'Envió Rosa',
      activityCount: 1,
      diamondCount: 1,
    });

    let update = '';
    while (!update.includes('"type":"gift"')) {
      const next = await eventReader.read();
      assert.equal(next.done, false);
      update += new TextDecoder().decode(next.value);
    }
    assert.match(update, /music-fan/);

    monitorService.emit({
      type: 'chat',
      username: 'live-viewer',
      time: new Date().toISOString(),
      content: '¡Hola!',
    });
    let chatUpdate = '';
    while (!chatUpdate.includes('"type":"chat"')) {
      const next = await eventReader.read();
      assert.equal(next.done, false);
      chatUpdate += new TextDecoder().decode(next.value);
    }
    assert.match(chatUpdate, /live-viewer/);

    monitorService.emit({
      type: 'subNotify',
      username: 'new-subscriber',
      time: new Date().toISOString(),
      content: 'Se suscribió',
    });
    let subscriberUpdate = '';
    while (!subscriberUpdate.includes('"type":"subNotify"')) {
      const next = await eventReader.read();
      assert.equal(next.done, false);
      subscriberUpdate += new TextDecoder().decode(next.value);
    }
    assert.match(subscriberUpdate, /new-subscriber/);

    const status = await fetch(`${baseUrl}/api/status`).then((response) => response.json());
    assert.equal(status.connected, true);
    assert.equal(status.connector.username, 'hnaevalopez');

    const invalidConfig = await sendJson('/api/config', 'PUT', { username: '', ignoredEvents: [] });
    assert.equal(invalidConfig.status, 400);
    assert.equal((await invalidConfig.json()).ok, false);

    assert.equal((await fetch(`${baseUrl}/api/radio/playlist`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/radio/tracks`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/audio/current`)).status, 409);

    const oldGameApi = await fetch(`${baseUrl}/api/game-state`);
    assert.equal(oldGameApi.status, 404);
    const unknownApi = await fetch(`${baseUrl}/api/not-a-route`);
    assert.equal(unknownApi.status, 404);
  } finally {
    await radioReader?.cancel();
    await eventReader?.cancel();
    await operatorReader?.cancel();
    await close(server);
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test('server reports malformed saved TikTok configuration', () => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), `radio-config-${randomUUID()}-`));
  const configurationPath = path.join(storagePath, 'monitor-config.json');
  fs.writeFileSync(configurationPath, JSON.stringify({ username: 42, ignoredEvents: [] }));

  try {
    assert.throws(() => createWebserver({
      monitorService: createMonitorService(),
      configurationPath,
      audioDirectory: path.join(storagePath, 'music'),
      playlistPath: path.join(storagePath, 'playlist.json'),
    }), /configuración guardada.*no es válida/);
  } finally {
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test('server migrates legacy TikTok settings to the default channel and preserves event filters', () => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), `radio-config-${randomUUID()}-`));
  const configurationPath = path.join(storagePath, 'monitor-config.json');
  fs.writeFileSync(configurationPath, JSON.stringify({
    username: 'old-channel',
    ignoredEvents: ['gift'],
  }));
  const monitorService = createMonitorService();

  try {
    createWebserver({
      monitorService,
      configurationPath,
      overlaySettingsPath: path.join(storagePath, 'overlay-settings.json'),
      audioDirectory: path.join(storagePath, 'music'),
      playlistPath: path.join(storagePath, 'playlist.json'),
    });
    assert.equal(monitorService.state.username, 'hnaevalopez');
    assert.deepEqual(JSON.parse(fs.readFileSync(configurationPath, 'utf8')), {
      username: 'hnaevalopez',
      ignoredEvents: ['gift'],
      usernameConfigured: false,
    });
    assert.deepEqual(monitorService.enabledEvents, ['chat', 'like', 'follow', 'share', 'member', 'subNotify']);
  } finally {
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});
