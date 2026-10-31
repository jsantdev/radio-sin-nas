const assert = require('node:assert/strict');
const fs = require('node:fs');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLibraryServer } = require('../../modules/biblioteca/server');

const testAdminToken = 'test-library-admin-token-that-is-at-least-32-bytes-long';
const fetch = (url, options = {}) => globalThis.fetch(url, {
  ...options,
  headers: {
    ...options.headers,
    Authorization: `Bearer ${testAdminToken}`,
  },
});

function createTestLibraryServer(options) {
  return createLibraryServer({
    adminToken: testAdminToken,
    migrationAllowedHosts: ['127.0.0.1'],
    allowInsecureMigrationHttp: true,
    ...options,
  });
}

test('external library creates named empty discs and reuses them when uploading tracks', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-library-'));
  const server = createTestLibraryServer({ dataDirectory: path.join(storage, 'discs') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(baseUrl).then((response) => response.text());
    assert.match(page, /Subir temas por disco/);
    assert.match(page, /Borrar disco/);
    assert.match(page, /Borrar tema/);
    assert.match(page, /Repetir playlist al llegar al final/);
    assert.match(page, /Programar canciones/);
    assert.match(page, /Migrar biblioteca a otra API/);
    assert.match(page, /migrationProgress/);
    assert.match(page, /rel="manifest" href="\/manifest.webmanifest"/);
    assert.match(page, /serviceWorker\.register\('\/service-worker\.js'\)/);
    const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
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

    const created = await fetch(`${baseUrl}/api/discs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Álbum Favorito' }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), {
      disc: { id: 'album-favorito', name: 'Álbum Favorito' },
      created: true,
    });
    assert.deepEqual((await fetch(`${baseUrl}/api/discs`).then((response) => response.json())).discs[0].tracks, []);

    const existing = await fetch(`${baseUrl}/api/discs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Álbum Favorito' }),
    });
    assert.equal(existing.status, 200);
    assert.equal((await existing.json()).created, false);

    const uploaded = await fetch(`${baseUrl}/api/tracks?disc=${encodeURIComponent('Álbum Favorito')}`, {
      method: 'POST',
      headers: { 'X-File-Name': encodeURIComponent('Canción.mp3'), 'Content-Type': 'audio/mpeg' },
      body: Buffer.from('audio'),
    });
    assert.equal(uploaded.status, 201);
    const library = await fetch(`${baseUrl}/api/discs`).then((response) => response.json());
    assert.equal(library.discs[0].name, 'Álbum Favorito');
    assert.equal(library.discs[0].tracks.length, 1);
    assert.equal(library.discs[0].tracks[0].sizeBytes, Buffer.byteLength('audio'));
    assert.match(library.discs[0].tracks[0].sha256, /^[a-f0-9]{64}$/);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('library protects mutations with an administrative token', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-library-auth-'));
  const server = createTestLibraryServer({ dataDirectory: path.join(storage, 'discs') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const publicState = await globalThis.fetch(`${baseUrl}/api/discs`);
    assert.equal(publicState.status, 200);
    const unauthorized = await globalThis.fetch(`${baseUrl}/api/discs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No autorizado' }),
    });
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`${baseUrl}/api/admin/session`, { method: 'POST' });
    assert.equal(authorized.status, 200);

    const unconfigured = createLibraryServer({
      adminToken: '',
      dataDirectory: path.join(storage, 'unconfigured'),
    });
    unconfigured.listen(0, '127.0.0.1');
    await once(unconfigured, 'listening');
    const unconfiguredUrl = `http://127.0.0.1:${unconfigured.address().port}`;
    try {
      const mutation = await globalThis.fetch(`${unconfiguredUrl}/api/discs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Deshabilitado' }),
      });
      assert.equal(mutation.status, 503);
    } finally {
      const closed = once(unconfigured, 'close');
      unconfigured.close();
      await closed;
    }
    assert.throws(() => createLibraryServer({
      adminToken: 'short',
      dataDirectory: path.join(storage, 'invalid-token'),
    }), /al menos 32 bytes/);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('library migration copies missing tracks to another API and reports progress', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-library-migration-'));
  const source = createTestLibraryServer({ dataDirectory: path.join(storage, 'source', 'discs') });
  const destination = createTestLibraryServer({ dataDirectory: path.join(storage, 'destination', 'discs') });
  source.listen(0, '127.0.0.1');
  destination.listen(0, '127.0.0.1');
  await Promise.all([once(source, 'listening'), once(destination, 'listening')]);
  const sourceUrl = `http://127.0.0.1:${source.address().port}`;
  const destinationUrl = `http://127.0.0.1:${destination.address().port}`;
  const existingAudio = Buffer.from('destination audio');
  const copiedAudio = Buffer.from('source audio to migrate');

  async function upload(baseUrl, filename, contents) {
    const response = await fetch(`${baseUrl}/api/tracks?disc=${encodeURIComponent('Migración de prueba')}`, {
      method: 'POST',
      headers: { 'X-File-Name': encodeURIComponent(filename), 'Content-Type': 'audio/mpeg' },
      body: contents,
    });
    assert.equal(response.status, 201);
  }

  async function waitForMigration(id) {
    let migration;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${sourceUrl}/api/migrations/${id}`);
      assert.equal(response.status, 200);
      migration = (await response.json()).migration;
      if (migration.status !== 'running') return migration;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Migration did not finish in time.');
  }

  try {
    await upload(sourceUrl, 'Ya existe.mp3', Buffer.from('source duplicate'));
    await upload(sourceUrl, 'Por copiar.mp3', copiedAudio);
    await upload(destinationUrl, 'Ya existe.mp3', existingAudio);
    const existingId = 'migracion-de-prueba/Ya existe.mp3';
    const copiedId = 'migracion-de-prueba/Por copiar.mp3';
    for (const [baseUrl, tracks, repeat] of [
      [sourceUrl, [existingId, copiedId], false],
      [destinationUrl, [existingId], true],
    ]) {
      const playlist = await fetch(`${baseUrl}/api/player/playlist`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks, repeat }),
      });
      assert.equal(playlist.status, 200);
    }
    const sourceSchedules = [
      { id: 'shared-schedule', trackId: copiedId, scheduledAt: '2030-01-01T10:00:00.000Z', recurrence: 'once' },
      { id: 'source-schedule', trackId: copiedId, scheduledAt: '2030-01-02T10:00:00.000Z', recurrence: 'daily' },
    ];
    const destinationSchedules = [
      { id: 'shared-schedule', trackId: existingId, scheduledAt: '2030-02-01T10:00:00.000Z', recurrence: 'once' },
      { id: 'destination-schedule', trackId: existingId, scheduledAt: '2030-02-02T10:00:00.000Z', recurrence: 'weekly' },
    ];
    for (const [baseUrl, entries] of [
      [sourceUrl, sourceSchedules],
      [destinationUrl, destinationSchedules],
    ]) {
      const scheduled = await fetch(`${baseUrl}/api/schedules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedules: entries }),
      });
      assert.equal(scheduled.status, 200);
    }

    const invalid = await fetch(`${sourceUrl}/api/migrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationUrl: 'file:///tmp/library' }),
    });
    assert.equal(invalid.status, 400);
    const blockedHost = await fetch(`${sourceUrl}/api/migrations/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationUrl: 'http://localhost:3001' }),
    });
    assert.equal(blockedHost.status, 403);

    const previewResponse = await fetch(`${sourceUrl}/api/migrations/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationUrl }),
    });
    assert.equal(previewResponse.status, 200);
    const { preview } = await previewResponse.json();
    assert.equal(preview.sourceTrackCount, 2);
    assert.equal(preview.existingTracks, 1);
    assert.equal(preview.checksumConflicts, 1);
    assert.equal(preview.requiredBytes, copiedAudio.length);
    assert.equal(preview.sourcePlaylistCount, 2);
    assert.equal(preview.destinationPlaylistCount, 1);
    assert.equal(preview.sourceScheduleCount, 2);
    assert.equal(preview.destinationScheduleCount, 2);
    assert.equal(preview.mergedScheduleCount, 3);
    assert.equal(preview.mergedPlaylistCount, 2);
    assert.equal(preview.stateFits, true);
    assert.notEqual(preview.enoughSpace, false);

    const started = await fetch(`${sourceUrl}/api/migrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationUrl }),
    });
    assert.equal(started.status, 202);
    const migration = await waitForMigration((await started.json()).migration.id);
    assert.equal(migration.status, 'completed');
    assert.equal(migration.percent, 100);
    assert.equal(migration.transferredTracks, 1);
    assert.equal(migration.skippedTracks, 1);
    assert.equal(migration.conflictTracks, 1);

    const copied = await fetch(`${destinationUrl}/api/audio?id=${encodeURIComponent('migracion-de-prueba/Por copiar.mp3')}`);
    assert.equal(copied.status, 200);
    assert.deepEqual(Buffer.from(await copied.arrayBuffer()), copiedAudio);
    const preserved = await fetch(`${destinationUrl}/api/audio?id=${encodeURIComponent('migracion-de-prueba/Ya existe.mp3')}`);
    assert.deepEqual(Buffer.from(await preserved.arrayBuffer()), existingAudio);
    assert.equal((await fetch(`${sourceUrl}/api/discs`).then((response) => response.json())).discs[0].tracks.length, 2);
    const mergedPlayer = await fetch(`${destinationUrl}/api/player/state`).then((response) => response.json());
    assert.deepEqual(mergedPlayer.queue.map((track) => track.id), [existingId, copiedId]);
    assert.equal(mergedPlayer.repeat, true);
    const mergedSchedules = await fetch(`${destinationUrl}/api/schedules`).then((response) => response.json());
    assert.deepEqual(mergedSchedules.schedules.map((schedule) => schedule.id).sort(), [
      'destination-schedule',
      'shared-schedule',
      'source-schedule',
    ]);
    assert.equal(
      mergedSchedules.schedules.find((schedule) => schedule.id === 'shared-schedule').trackId,
      existingId,
    );

    const repeated = await fetch(`${sourceUrl}/api/migrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationUrl }),
    });
    assert.equal(repeated.status, 202);
    const repeatedMigration = await waitForMigration((await repeated.json()).migration.id);
    assert.equal(repeatedMigration.transferredTracks, 0);
    assert.equal(repeatedMigration.skippedTracks, 2);
    assert.equal(repeatedMigration.conflictTracks, 1);
  } finally {
    const closed = [once(source, 'close'), once(destination, 'close')];
    source.close();
    destination.close();
    await Promise.all(closed);
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('library migration resumes persisted progress after a server restart', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-library-resume-'));
  const sourceDataDirectory = path.join(storage, 'source', 'discs');
  const destination = createTestLibraryServer({ dataDirectory: path.join(storage, 'destination', 'discs') });
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  const destinationUrl = `http://127.0.0.1:${destination.address().port}`;
  let source = createTestLibraryServer({
    dataDirectory: sourceDataDirectory,
    fetchImpl: () => new Promise(() => {}),
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  let sourceUrl = `http://127.0.0.1:${source.address().port}`;

  try {
    const uploaded = await fetch(`${sourceUrl}/api/tracks?disc=Reanudar`, {
      method: 'POST',
      headers: { 'X-File-Name': encodeURIComponent('Tema.mp3') },
      body: Buffer.from('audio to resume'),
    });
    assert.equal(uploaded.status, 201);

    const started = await fetch(`${sourceUrl}/api/migrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationUrl }),
    });
    assert.equal(started.status, 202);
    const migrationId = (await started.json()).migration.id;
    const active = await fetch(`${sourceUrl}/api/migrations/${migrationId}`).then((response) => response.json());
    assert.equal(active.migration.status, 'running');

    const firstClosed = once(source, 'close');
    source.close();
    await firstClosed;
    source = createTestLibraryServer({ dataDirectory: sourceDataDirectory });
    source.listen(0, '127.0.0.1');
    await once(source, 'listening');
    sourceUrl = `http://127.0.0.1:${source.address().port}`;

    const restored = await fetch(`${sourceUrl}/api/migrations`).then((response) => response.json());
    assert.equal(restored.migrations[0].status, 'paused');
    const resumed = await fetch(`${sourceUrl}/api/migrations/${migrationId}/resume`, { method: 'POST' });
    assert.equal(resumed.status, 202);
    const completed = await waitForMigration(sourceUrl, migrationId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.transferredTracks, 1);
    assert.equal(
      await fetch(`${destinationUrl}/api/audio?id=${encodeURIComponent('reanudar/Tema.mp3')}`).then((response) => response.text()),
      'audio to resume',
    );
  } finally {
    const closed = [once(source, 'close'), once(destination, 'close')];
    source.close();
    destination.close();
    await Promise.all(closed);
    fs.rmSync(storage, { recursive: true, force: true });
  }

  async function waitForMigration(baseUrl, id) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/migrations/${id}`);
      const migration = (await response.json()).migration;
      if (migration.status !== 'running') return migration;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Migration did not finish in time.');
  }
});

test('library persists the player queue and current playback across restarts', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-player-state-'));
  const dataDirectory = path.join(storage, 'discs');
  let server = createTestLibraryServer({ dataDirectory });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const created = await fetch(`${baseUrl}/api/discs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Temas de prueba' }),
    });
    assert.equal(created.status, 201);
    for (const filename of ['Primera.mp3', 'Segunda.mp3']) {
      const uploaded = await fetch(`${baseUrl}/api/tracks?disc=${encodeURIComponent('Temas de prueba')}`, {
        method: 'POST',
        headers: { 'X-File-Name': encodeURIComponent(filename) },
        body: Buffer.from(filename),
      });
      assert.equal(uploaded.status, 201);
    }

    const queue = ['temas-de-prueba/Primera.mp3', 'temas-de-prueba/Segunda.mp3'];
    const updated = await fetch(`${baseUrl}/api/player/playlist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: queue, repeat: false }),
    });
    assert.equal(updated.status, 200);
    const selected = await fetch(`${baseUrl}/api/player/current`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: 1 }),
    });
    assert.equal(selected.status, 200);
    const playing = await fetch(`${baseUrl}/api/player/playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPlaying: true }),
    });
    assert.equal(playing.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(storage, 'player-state.json'), 'utf8')), {
      queue,
      currentIndex: 1,
      isPlaying: true,
      repeat: false,
    });

    const closed = once(server, 'close');
    server.close();
    await closed;
    server = createTestLibraryServer({ dataDirectory });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const restored = await fetch(`${baseUrl}/api/player/state`).then((response) => response.json());
    assert.deepEqual(restored.queue.map((track) => track.id), queue);
    assert.equal(restored.currentIndex, 1);
    assert.equal(restored.currentTrack.title, 'Segunda');
    assert.equal(restored.isPlaying, true);
    assert.equal(restored.repeat, false);
    assert.equal(await fetch(`${baseUrl}/api/player/audio`).then((response) => response.text()), 'Segunda.mp3');
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('external library creates, lists, reads, and deletes audio grouped by disc', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-library-'));
  const server = createTestLibraryServer({ dataDirectory: path.join(storage, 'discs') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const audio = Buffer.from('audio bytes');

  try {
    const upload = await fetch(`${baseUrl}/api/tracks?disc=${encodeURIComponent('Mi Álbum')}`, {
      method: 'POST',
      headers: { 'X-File-Name': encodeURIComponent('Canción.mp3'), 'Content-Type': 'audio/mpeg' },
      body: audio,
    });
    assert.equal(upload.status, 201);
    const { track } = await upload.json();
    assert.equal(track.id, 'mi-album/Canción.mp3');

    const discs = await fetch(`${baseUrl}/api/discs`).then((response) => response.json());
    assert.equal(discs.discs[0].id, 'mi-album');
    assert.equal(discs.discs[0].name, 'Mi Álbum');
    assert.equal(discs.discs[0].tracks[0].title, 'Canción');

    const read = await fetch(`${baseUrl}/api/audio?id=${encodeURIComponent(track.id)}`);
    assert.equal(read.status, 200);
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), audio);
    const partial = await fetch(`${baseUrl}/api/audio?id=${encodeURIComponent(track.id)}`, {
      headers: { Range: 'bytes=0-4' },
    });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), 'audio');

    const deleted = await fetch(`${baseUrl}/api/tracks?id=${encodeURIComponent(track.id)}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    const remainingDisc = (await fetch(`${baseUrl}/api/discs`).then((response) => response.json())).discs[0];
    assert.equal(remainingDisc.name, 'Mi Álbum');
    assert.deepEqual(remainingDisc.tracks, []);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('deleting a disc removes its tracks from the library, playlist, and schedules', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-delete-disc-'));
  const server = createTestLibraryServer({ dataDirectory: path.join(storage, 'discs') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function upload(disc, filename) {
    const response = await fetch(`${baseUrl}/api/tracks?disc=${encodeURIComponent(disc)}`, {
      method: 'POST',
      headers: { 'X-File-Name': encodeURIComponent(filename), 'Content-Type': 'audio/mpeg' },
      body: Buffer.from(filename),
    });
    assert.equal(response.status, 201);
    return (await response.json()).track;
  }

  try {
    const first = await upload('Disco para borrar', 'Primera.mp3');
    const second = await upload('Disco para borrar', 'Segunda.mp3');
    const keep = await upload('Disco conservado', 'Conservar.mp3');
    const playlist = await fetch(`${baseUrl}/api/player/playlist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: [first.id, keep.id, second.id] }),
    });
    assert.equal(playlist.status, 200);
    const schedule = await fetch(`${baseUrl}/api/schedules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schedules: [{
          id: 'delete-disc-schedule',
          trackId: second.id,
          scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          recurrence: 'once',
        }],
      }),
    });
    assert.equal(schedule.status, 200);

    const deleted = await fetch(`${baseUrl}/api/discs?id=${encodeURIComponent(first.discId)}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    const library = await fetch(`${baseUrl}/api/discs`).then((response) => response.json());
    assert.deepEqual(library.discs.map((disc) => disc.id), [keep.discId]);
    const player = await fetch(`${baseUrl}/api/player/state`).then((response) => response.json());
    assert.deepEqual(player.queue.map((track) => track.id), [keep.id]);
    assert.equal(player.currentTrack.id, keep.id);
    const schedules = await fetch(`${baseUrl}/api/schedules`).then((response) => response.json());
    assert.deepEqual(schedules.schedules, []);
    assert.equal((await fetch(`${baseUrl}/api/audio?id=${encodeURIComponent(first.id)}`)).status, 404);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('external library rejects invalid names and duplicate tracks', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-library-'));
  const server = createTestLibraryServer({ dataDirectory: path.join(storage, 'discs') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const options = {
    method: 'POST',
    headers: { 'X-File-Name': encodeURIComponent('Tema.mp3'), 'Content-Type': 'audio/mpeg' },
    body: Buffer.from('audio'),
  };
  try {
    const checksumMismatch = await fetch(`${baseUrl}/api/tracks?disc=Rock`, {
      method: 'POST',
      headers: {
        'X-File-Name': encodeURIComponent('Checksum.mp3'),
        'X-Content-SHA256': '0'.repeat(64),
      },
      body: Buffer.from('audio'),
    });
    assert.equal(checksumMismatch.status, 422);
    assert.equal((await fetch(`${baseUrl}/api/tracks?disc=Rock`, options)).status, 201);
    assert.equal((await fetch(`${baseUrl}/api/tracks?disc=Rock`, options)).status, 409);
    assert.equal((await fetch(`${baseUrl}/api/tracks?disc=Rock`, {
      ...options,
      headers: { ...options.headers, 'X-File-Name': encodeURIComponent('..\\outside.mp3') },
    })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/audio?id=${encodeURIComponent('../outside.mp3')}`)).status, 404);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    fs.rmSync(storage, { recursive: true, force: true });
  }
});
