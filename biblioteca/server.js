const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { pipeline } = require('node:stream');

const audioExtensions = new Set(['.aac', '.m4a', '.mp3', '.ogg', '.opus', '.wav']);
const maxAudioFileSize = 100 * 1024 * 1024;

function createLibraryServer({
  dataDirectory = process.env.BIBLIOTECA_DATA_DIR || path.join(__dirname, 'data', 'discs'),
  maxFileSize = maxAudioFileSize,
  adminToken = process.env.BIBLIOTECA_ADMIN_TOKEN || '',
  migrationAllowedHosts = (process.env.BIBLIOTECA_MIGRATION_ALLOWED_HOSTS || '')
    .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
  allowInsecureMigrationHttp = process.env.BIBLIOTECA_MIGRATION_ALLOW_HTTP === 'true',
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const rootDirectory = path.resolve(dataDirectory);
  const stateDirectory = path.dirname(rootDirectory);
  const playerStatePath = path.join(stateDirectory, 'player-state.json');
  const schedulesPath = path.join(stateDirectory, 'song-schedules.json');
  const migrationsPath = path.join(stateDirectory, 'migrations.json');
  const migrations = new Map();
  let activeMigrationId = null;
  let recoveredMigration = false;
  if (adminToken && (Buffer.byteLength(adminToken) < 32 || adminToken.trim() !== adminToken)) {
    throw new Error('BIBLIOTECA_ADMIN_TOKEN debe tener al menos 32 bytes y no incluir espacios externos.');
  }
  fs.mkdirSync(rootDirectory, { recursive: true });
  let playerState = { queue: [], currentIndex: null, isPlaying: false, repeat: true };
  let schedules = [];
  if (fs.existsSync(schedulesPath)) {
    const savedSchedules = JSON.parse(fs.readFileSync(schedulesPath, 'utf8'));
    if (!Array.isArray(savedSchedules)) throw new Error('La programación de canciones no es válida.');
    schedules = savedSchedules;
  }
  if (fs.existsSync(migrationsPath)) {
    const savedMigrations = JSON.parse(fs.readFileSync(migrationsPath, 'utf8'));
    if (!Array.isArray(savedMigrations)) throw new Error('El historial de migraciones no es válido.');
    for (const savedMigration of savedMigrations) {
      if (!savedMigration || typeof savedMigration.id !== 'string'
        || !['running', 'paused', 'failed', 'completed'].includes(savedMigration.status)
        || typeof savedMigration.destinationUrl !== 'string'
        || !Array.isArray(savedMigration.completedTrackIds)
        || !Array.isArray(savedMigration.transferredTrackIds)
        || !Array.isArray(savedMigration.skippedTrackIds)) {
        throw new Error('Una migración guardada no es válida.');
      }
      const migration = {
        ...savedMigration,
        status: savedMigration.status === 'running' ? 'paused' : savedMigration.status,
        currentTrack: '',
      };
      if (savedMigration.status === 'running') recoveredMigration = true;
      migrations.set(migration.id, migration);
    }
  }

  function persistMigrations() {
    fs.mkdirSync(path.dirname(migrationsPath), { recursive: true });
    const temporaryPath = `${migrationsPath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify([...migrations.values()], null, 2));
    fs.renameSync(temporaryPath, migrationsPath);
  }
  if (recoveredMigration) persistMigrations();

  function saveSchedules(nextSchedules) {
    fs.mkdirSync(path.dirname(schedulesPath), { recursive: true });
    fs.writeFileSync(schedulesPath, JSON.stringify(nextSchedules, null, 2));
    schedules = nextSchedules;
  }

  function isAdminTokenValid(value) {
    if (!adminToken || typeof value !== 'string') return false;
    const supplied = Buffer.from(value);
    const expected = Buffer.from(adminToken);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  function bearerToken(request) {
    const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || '');
    return match ? match[1] : '';
  }

  function validateSchedules(value) {
    if (!Array.isArray(value) || value.length > 200) {
      const error = new Error('La programación debe incluir hasta 200 canciones.');
      error.status = 400;
      throw error;
    }
    const trackIds = new Set(listDiscs().flatMap((disc) => disc.tracks.map((track) => track.id)));
    const ids = new Set();
    return value.map((schedule) => {
      if (!schedule || typeof schedule.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(schedule.id)
        || ids.has(schedule.id) || typeof schedule.trackId !== 'string' || !trackIds.has(schedule.trackId)
        || typeof schedule.scheduledAt !== 'string' || !Number.isFinite(Date.parse(schedule.scheduledAt))
        || !['once', 'daily', 'weekly'].includes(schedule.recurrence)) {
        const error = new Error('Cada programación debe tener un tema y una fecha válidos.');
        error.status = 400;
        throw error;
      }
      ids.add(schedule.id);
      return {
        id: schedule.id,
        trackId: schedule.trackId,
        scheduledAt: new Date(schedule.scheduledAt).toISOString(),
        recurrence: schedule.recurrence,
      };
    });
  }

  function savePlayerState(nextState) {
    fs.mkdirSync(path.dirname(playerStatePath), { recursive: true });
    fs.writeFileSync(playerStatePath, JSON.stringify(nextState, null, 2));
    playerState = nextState;
    return getPlayerSnapshot();
  }

  function removeTracksFromPlayer(trackIds) {
    const removed = new Set(trackIds);
    if (playerState.queue.some((id) => removed.has(id))) {
      const selectedTrack = playerState.currentIndex === null ? null : playerState.queue[playerState.currentIndex];
      const queue = playerState.queue.filter((id) => !removed.has(id));
      const currentIndex = selectedTrack && queue.includes(selectedTrack)
        ? queue.indexOf(selectedTrack)
        : queue.length ? 0 : null;
      savePlayerState({
        ...playerState,
        queue,
        currentIndex,
        isPlaying: currentIndex === null ? false : playerState.isPlaying,
      });
    }
    const nextSchedules = schedules.filter((schedule) => !removed.has(schedule.trackId));
    if (nextSchedules.length !== schedules.length) saveSchedules(nextSchedules);
  }

  function getPlayerSnapshot() {
    const tracks = new Map(listDiscs().flatMap((disc) => disc.tracks.map((track) => [track.id, track])));
    const queue = playerState.queue.map((id) => {
      const track = tracks.get(id);
      return track && { ...track, url: '/api/player/audio' };
    }).filter(Boolean);
    const currentTrack = playerState.currentIndex === null ? null : queue[playerState.currentIndex] || null;
    return {
      status: queue.length ? 'ready' : 'empty',
      audioSource: 'library',
      queue,
      currentIndex: currentTrack ? playerState.currentIndex : null,
      currentTrack,
      isPlaying: Boolean(currentTrack && playerState.isPlaying),
      repeat: playerState.repeat,
    };
  }

  function validatePlayerPlaylist(value) {
    if (!Array.isArray(value) || value.length > 5000
      || value.some((id) => typeof id !== 'string')
      || new Set(value).size !== value.length) {
      const error = new Error('La playlist debe incluir hasta 5000 temas disponibles y sin duplicados.');
      error.status = 400;
      throw error;
    }
    const availableTracks = new Set(listDiscs().flatMap((disc) => disc.tracks.map((track) => track.id)));
    if (value.some((id) => !availableTracks.has(id))) {
      const error = new Error('La playlist incluye temas que no están en la biblioteca.');
      error.status = 400;
      throw error;
    }
  }

  function updatePlayerPlaylist(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      const error = new Error('La playlist debe enviarse como JSON válido.');
      error.status = 400;
      throw error;
    }
    validatePlayerPlaylist(payload.tracks);
    if (payload.repeat !== undefined && typeof payload.repeat !== 'boolean') {
      const error = new Error('La repetición de playlist debe ser booleana.');
      error.status = 400;
      throw error;
    }
    const selectedTrack = playerState.currentIndex === null ? null : playerState.queue[playerState.currentIndex];
    const queue = payload.tracks;
    const currentIndex = selectedTrack && queue.includes(selectedTrack)
      ? queue.indexOf(selectedTrack)
      : queue.length ? 0 : null;
    return { state: savePlayerState({
      queue,
      currentIndex,
      isPlaying: currentIndex === null ? false : playerState.isPlaying,
      repeat: payload.repeat === undefined ? playerState.repeat : payload.repeat,
    }) };
  }

  function mergeImportedState(payload) {
    if (!payload || !payload.player || !Array.isArray(payload.player.tracks)
      || payload.player.tracks.length > 5000
      || payload.player.tracks.some((id) => typeof id !== 'string')
      || new Set(payload.player.tracks).size !== payload.player.tracks.length
      || !(payload.player.currentTrackId === null
        || typeof payload.player.currentTrackId === 'string')
      || typeof payload.player.repeat !== 'boolean'
      || !Array.isArray(payload.schedules)) {
      const error = new Error('El estado importado no tiene el formato esperado.');
      error.status = 400;
      throw error;
    }
    validatePlayerPlaylist(payload.player.tracks);
    if (payload.player.currentTrackId !== null
      && !payload.player.tracks.includes(payload.player.currentTrackId)) {
      const error = new Error('La canción actual importada no pertenece a la playlist.');
      error.status = 400;
      throw error;
    }
    const importedSchedules = validateSchedules(payload.schedules);
    const queue = [...new Set([...playerState.queue, ...payload.player.tracks])];
    const currentTrackId = playerState.currentIndex === null
      ? null
      : playerState.queue[playerState.currentIndex];
    const nextCurrentTrackId = currentTrackId || payload.player.currentTrackId;
    const currentIndex = nextCurrentTrackId === null ? null : queue.indexOf(nextCurrentTrackId);
    const existingScheduleIds = new Set(schedules.map((schedule) => schedule.id));
    const nextSchedules = [...schedules, ...importedSchedules
      .filter((schedule) => !existingScheduleIds.has(schedule.id))];
    if (nextSchedules.length > 200) {
      const error = new Error('La combinación supera el límite de 200 canciones programadas.');
      error.status = 409;
      throw error;
    }
    if (queue.length > 5000) {
      const error = new Error('La combinación supera el límite de 5000 temas en la playlist.');
      error.status = 409;
      throw error;
    }
    const addedPlaylistTracks = queue.length - playerState.queue.length;
    const addedSchedules = nextSchedules.length - schedules.length;
    const nextPlayerState = {
      queue,
      currentIndex,
      isPlaying: playerState.queue.length ? playerState.isPlaying : false,
      repeat: playerState.queue.length ? playerState.repeat : payload.player.repeat,
    };
    savePlayerState(nextPlayerState);
    saveSchedules(nextSchedules);
    return { addedPlaylistTracks, addedSchedules };
  }

  function setCurrentTrack(index) {
    if (!Number.isInteger(index) || index < 0 || index >= playerState.queue.length) {
      const error = new Error('El índice no corresponde a una canción de la playlist.');
      error.status = 400;
      throw error;
    }
    return { state: savePlayerState({ ...playerState, currentIndex: index }) };
  }

  function movePlayerTrack(direction) {
    const { queue, currentIndex, repeat } = playerState;
    if (!queue.length) {
      const error = new Error('La playlist está vacía.');
      error.status = 409;
      throw error;
    }
    if (currentIndex === null) return { state: savePlayerState({ ...playerState, currentIndex: 0 }) };
    if (direction > 0 && currentIndex === queue.length - 1 && !repeat) {
      return { state: savePlayerState({ ...playerState, isPlaying: false }) };
    }
    const nextIndex = direction < 0 && currentIndex === 0 && !repeat
      ? 0
      : (currentIndex + direction + queue.length) % queue.length;
    return { state: savePlayerState({ ...playerState, currentIndex: nextIndex }) };
  }

  function setPlaybackState(isPlaying) {
    if (typeof isPlaying !== 'boolean') {
      const error = new Error('El estado de reproducción debe ser booleano.');
      error.status = 400;
      throw error;
    }
    return { state: savePlayerState({ ...playerState, isPlaying: isPlaying && playerState.queue.length > 0 }) };
  }

  function playScheduledTrack(trackId) {
    validatePlayerPlaylist({ tracks: [trackId] });
    const queue = playerState.queue.includes(trackId) ? playerState.queue : [...playerState.queue, trackId];
    return savePlayerState({
      ...playerState,
      queue,
      currentIndex: queue.indexOf(trackId),
      isPlaying: true,
    });
  }

  async function processDueSchedules() {
    const now = new Date();
    const due = schedules.filter((schedule) => Date.parse(schedule.scheduledAt) <= now.getTime());
    for (const schedule of due) {
      try {
        playScheduledTrack(schedule.trackId);
        const nextSchedules = schedules.map((entry) => {
          if (entry.id !== schedule.id) return entry;
          if (entry.recurrence === 'once') return null;
          const nextAt = new Date(entry.scheduledAt);
          const interval = entry.recurrence === 'daily' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
          do {
            nextAt.setTime(nextAt.getTime() + interval);
          } while (nextAt.getTime() <= now.getTime());
          return { ...entry, scheduledAt: nextAt.toISOString() };
        }).filter(Boolean);
        saveSchedules(nextSchedules);
      } catch (error) {
        logger.error(`No se pudo reproducir una canción programada: ${error.message}`);
      }
    }
  }

  function getTrackPath(id) {
    if (typeof id !== 'string') return null;
    const [discId, filename, ...extra] = id.split('/');
    if (extra.length || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(discId || '')
      || !filename || filename !== path.basename(filename) || filename.includes('\\')
      || filename.startsWith('.') || /[\u0000-\u001f]/.test(filename)
      || !audioExtensions.has(path.extname(filename).toLowerCase())) {
      return null;
    }

    const discDirectory = path.resolve(rootDirectory, discId);
    const filePath = path.resolve(discDirectory, filename);
    if (path.dirname(discDirectory) !== rootDirectory || path.dirname(filePath) !== discDirectory) return null;
    return filePath;
  }

  function getTrackMetadata(filePath) {
    const metadataPath = path.join(path.dirname(filePath), '.track-metadata.json');
    let metadata = {};
    if (fs.existsSync(metadataPath)) {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('Los metadatos de los temas no son válidos.');
      }
    }
    const filename = path.basename(filePath);
    const sizeBytes = fs.statSync(filePath).size;
    let trackMetadata = metadata[filename];
    if (!trackMetadata || trackMetadata.sizeBytes !== sizeBytes
      || !/^[a-f0-9]{64}$/.test(trackMetadata.sha256 || '')) {
      trackMetadata = {
        sizeBytes,
        sha256: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
      };
      metadata[filename] = trackMetadata;
      const temporaryPath = `${metadataPath}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify(metadata, null, 2));
      fs.renameSync(temporaryPath, metadataPath);
    }
    return trackMetadata;
  }

  function saveTrackMetadata(discId, filename, contents) {
    const metadataPath = path.join(rootDirectory, discId, '.track-metadata.json');
    let metadata = {};
    if (fs.existsSync(metadataPath)) {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('Los metadatos de los temas no son válidos.');
      }
    }
    metadata[filename] = {
      sizeBytes: contents.length,
      sha256: createHash('sha256').update(contents).digest('hex'),
    };
    const temporaryPath = `${metadataPath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(metadata, null, 2));
    fs.renameSync(temporaryPath, metadataPath);
    return metadata[filename];
  }

  function listDiscs() {
    return fs.readdirSync(rootDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name))
      .map((entry) => {
        const discDirectory = path.join(rootDirectory, entry.name);
        const metadataPath = path.join(discDirectory, '.disc-name.json');
        let discName = entry.name.replace(/-/g, ' ');
        if (fs.existsSync(metadataPath)) {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          if (!metadata || typeof metadata.name !== 'string' || !metadata.name.trim()) {
            throw new Error(`El nombre guardado del disco "${entry.name}" no es válido.`);
          }
          discName = metadata.name.trim();
        }
        const tracks = fs.readdirSync(discDirectory, { withFileTypes: true })
          .filter((file) => file.isFile() && audioExtensions.has(path.extname(file.name).toLowerCase()))
          .map((file) => {
            const trackMetadata = getTrackMetadata(path.join(discDirectory, file.name));
            return {
              id: `${entry.name}/${file.name}`,
              name: file.name,
              title: path.parse(file.name).name,
              discId: entry.name,
              discName,
              sizeBytes: trackMetadata.sizeBytes,
              sha256: trackMetadata.sha256,
            };
          })
          .sort((first, second) => first.name.localeCompare(second.name, 'es'));
        return {
          id: entry.name,
          name: discName,
          tracks,
        };
      })
      .sort((first, second) => first.name.localeCompare(second.name, 'es'));
  }

  if (fs.existsSync(playerStatePath)) {
    const savedState = JSON.parse(fs.readFileSync(playerStatePath, 'utf8'));
    if (!savedState || !Array.isArray(savedState.queue)
      || savedState.queue.some((id) => typeof id !== 'string')
      || new Set(savedState.queue).size !== savedState.queue.length
      || typeof savedState.isPlaying !== 'boolean' || typeof savedState.repeat !== 'boolean'
      || !(savedState.currentIndex === null
        || Number.isInteger(savedState.currentIndex) && savedState.currentIndex >= 0
          && savedState.currentIndex < savedState.queue.length)) {
      throw new Error('El estado guardado del reproductor no es válido.');
    }
    const availableTracks = new Set(listDiscs().flatMap((disc) => disc.tracks.map((track) => track.id)));
    const queue = savedState.queue.filter((id) => availableTracks.has(id));
    const currentTrack = savedState.currentIndex === null ? null : savedState.queue[savedState.currentIndex];
    playerState = {
      ...savedState,
      queue,
      currentIndex: currentTrack && queue.includes(currentTrack)
        ? queue.indexOf(currentTrack)
        : queue.length ? 0 : null,
      isPlaying: Boolean(queue.length && savedState.isPlaying),
    };
    if (JSON.stringify(playerState) !== JSON.stringify(savedState)) {
      fs.writeFileSync(playerStatePath, JSON.stringify(playerState, null, 2));
    }
  }

  function getDiscId(name) {
    return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  }

  function createDisc(name) {
    const discName = name.trim();
    const discId = getDiscId(discName);
    if (!discName || discName.length > 100 || !discId) {
      const error = new Error('El nombre del disco debe tener entre 1 y 100 caracteres válidos.');
      error.status = 400;
      throw error;
    }

    const discDirectory = path.join(rootDirectory, discId);
    const existed = fs.existsSync(discDirectory);
    fs.mkdirSync(discDirectory, { recursive: true });
    const metadataPath = path.join(discDirectory, '.disc-name.json');
    let savedName = discName;
    try {
      fs.writeFileSync(metadataPath, JSON.stringify({ name: discName }), { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      if (typeof metadata.name !== 'string' || !metadata.name.trim()) {
        throw new Error(`El nombre guardado del disco "${discId}" no es válido.`);
      }
      savedName = metadata.name.trim();
    }
    return { disc: { id: discId, name: savedName }, created: !existed };
  }

  function sendJson(response, status, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    response.end(body);
  }

  function getFreeBytes() {
    try {
      const { bavail, bsize } = fs.statfsSync(rootDirectory);
      return bavail * bsize;
    } catch {
      return null;
    }
  }

  function validateMigrationDestination(value) {
    if (typeof value !== 'string' || !value.trim()) {
      const error = new Error('Indica la URL de la biblioteca de destino.');
      error.status = 400;
      throw error;
    }
    let destination;
    try {
      destination = new URL(value.trim());
    } catch {
      const error = new Error('Ingresa una URL válida para la biblioteca de destino.');
      error.status = 400;
      throw error;
    }
    if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password
      || destination.search || destination.hash) {
      const error = new Error('La URL de destino debe ser HTTP o HTTPS y no incluir credenciales, parámetros ni fragmentos.');
      error.status = 400;
      throw error;
    }
    if (destination.protocol === 'http:' && !allowInsecureMigrationHttp) {
      const error = new Error('Las migraciones requieren HTTPS; HTTP solo puede habilitarse explícitamente en una red privada confiable.');
      error.status = 400;
      throw error;
    }
    const allowed = migrationAllowedHosts.includes(destination.hostname.toLowerCase())
      || migrationAllowedHosts.includes(destination.host.toLowerCase());
    if (!allowed) {
      const error = new Error('El host de destino no está autorizado. Configúralo en BIBLIOTECA_MIGRATION_ALLOWED_HOSTS.');
      error.status = 403;
      throw error;
    }
    destination.pathname = `${destination.pathname.replace(/\/+$/, '')}/`;
    return destination;
  }

  async function requestMigrationDestination(destination, pathname, options = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('No está disponible el cliente HTTP para migrar la biblioteca.');
    let response;
    try {
      response = await fetchImpl(new URL(pathname.replace(/^\/+/, ''), destination), {
        ...options,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${adminToken}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
    } catch (error) {
      const connectionError = new Error(`No se pudo conectar con la biblioteca de destino: ${error.message}`);
      connectionError.status = 502;
      throw connectionError;
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('La biblioteca de destino no devolvió una respuesta JSON válida.');
    }
    if (!response.ok) {
      const requestError = new Error(payload?.message || `La biblioteca de destino respondió HTTP ${response.status}.`);
      requestError.status = response.status;
      throw requestError;
    }
    return payload;
  }

  async function getMigrationPreview(destination) {
    const sourceDiscs = listDiscs();
    const sourceTracks = sourceDiscs.flatMap((disc) => disc.tracks);
    const totalBytes = sourceTracks.reduce((total, track) => total + track.sizeBytes, 0);
    const [health, destinationLibrary, destinationPlayer, destinationSchedules] = await Promise.all([
      requestMigrationDestination(destination, '/api/health'),
      requestMigrationDestination(destination, '/api/discs'),
      requestMigrationDestination(destination, '/api/player/state'),
      requestMigrationDestination(destination, '/api/schedules'),
    ]);
    if (health.apiVersion !== 1 || health.migrationSupport !== true
      || !Number.isSafeInteger(health.maxFileSize) || health.maxFileSize <= 0
      || !Array.isArray(destinationLibrary.discs) || !Array.isArray(destinationPlayer.queue)
      || !Array.isArray(destinationSchedules.schedules)) {
      const error = new Error('La API destino no es compatible con la migración de biblioteca.');
      error.status = 409;
      throw error;
    }
    const destinationTracks = new Map(destinationLibrary.discs
      .flatMap((disc) => Array.isArray(disc.tracks) ? disc.tracks : [])
      .map((track) => [track.id, track]));
    let existingTracks = 0;
    let checksumConflicts = 0;
    let requiredBytes = 0;
    for (const track of sourceTracks) {
      const existing = destinationTracks.get(track.id);
      if (!existing) {
        requiredBytes += track.sizeBytes;
      } else {
        existingTracks += 1;
        if (existing.sha256 && existing.sha256 !== track.sha256) checksumConflicts += 1;
      }
    }
    const destinationScheduleIds = new Set(destinationSchedules.schedules
      .filter((schedule) => schedule && typeof schedule.id === 'string')
      .map((schedule) => schedule.id));
    const mergedScheduleCount = destinationScheduleIds.size
      + schedules.filter((schedule) => !destinationScheduleIds.has(schedule.id)).length;
    const mergedPlaylistCount = new Set([
      ...destinationPlayer.queue.map((track) => track?.id).filter((id) => typeof id === 'string'),
      ...playerState.queue,
    ]).size;
    return {
      sourceTrackCount: sourceTracks.length,
      sourceDiscCount: sourceDiscs.length,
      totalBytes,
      requiredBytes,
      existingTracks,
      checksumConflicts,
      oversizedTracks: sourceTracks.filter((track) => track.sizeBytes > health.maxFileSize).length,
      sourcePlaylistCount: playerState.queue.length,
      destinationPlaylistCount: destinationPlayer.queue.length,
      sourceScheduleCount: schedules.length,
      destinationScheduleCount: destinationSchedules.schedules.length,
      mergedScheduleCount,
      mergedPlaylistCount,
      stateFits: mergedScheduleCount <= 200 && mergedPlaylistCount <= 5000,
      destinationFreeBytes: Number.isSafeInteger(health.freeBytes) ? health.freeBytes : null,
      enoughSpace: sourceTracks.some((track) => track.sizeBytes > health.maxFileSize)
        ? false
        : Number.isSafeInteger(health.freeBytes) ? health.freeBytes >= requiredBytes : null,
    };
  }

  function migrationSnapshot(migration) {
    return {
      id: migration.id,
      status: migration.status,
      totalTracks: migration.totalTracks,
      completedTracks: migration.completedTracks,
      transferredTracks: migration.transferredTracks,
      skippedTracks: migration.skippedTracks,
      conflictTracks: migration.conflictTrackIds.length,
      percent: migration.percent,
      currentTrack: migration.currentTrack,
      error: migration.error,
      preview: migration.preview,
    };
  }

  async function runMigration(migration, destination) {
    try {
      const sourceDiscs = listDiscs();
      migration.totalTracks = sourceDiscs.reduce((count, disc) => count + disc.tracks.length, 0);
      const preview = await getMigrationPreview(destination);
      migration.preview = preview;
      if (preview.enoughSpace === false) {
        throw new Error('El servidor destino no tiene espacio libre suficiente para los archivos que faltan.');
      }
      if (!preview.stateFits) {
        throw new Error('La unión superaría el límite de temas de playlist o canciones programadas del destino.');
      }
      migration.totalBytes = preview.totalBytes;
      persistMigrations();
      const destinationLibrary = await requestMigrationDestination(destination, '/api/discs');
      if (!Array.isArray(destinationLibrary.discs)) {
        throw new Error('La biblioteca de destino no devolvió una lista de discos válida.');
      }
      const existingTracks = new Map(destinationLibrary.discs
        .flatMap((disc) => Array.isArray(disc.tracks) ? disc.tracks : [])
        .map((track) => [track.id, track]));
      const completedTrackIds = new Set(migration.completedTrackIds);
      const transferredTrackIds = new Set(migration.transferredTrackIds);
      const skippedTrackIds = new Set(migration.skippedTrackIds);
      const conflictTrackIds = new Set(migration.conflictTrackIds);
      const updateProgress = () => {
        migration.completedTracks = completedTrackIds.size;
        migration.transferredTracks = transferredTrackIds.size;
        migration.skippedTracks = skippedTrackIds.size;
        migration.percent = migration.totalTracks
          ? Math.floor((migration.completedTracks / migration.totalTracks) * 95)
          : 0;
        persistMigrations();
      };

      for (const disc of sourceDiscs) {
        const created = await requestMigrationDestination(destination, '/api/discs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: disc.name }),
        });
        if (created.disc?.id !== disc.id) {
          throw new Error(`No se pudo conservar el disco "${disc.name}" en el destino.`);
        }

        for (const track of disc.tracks) {
          if (completedTrackIds.has(track.id)) continue;
          migration.currentTrack = `${disc.name} · ${track.title}`;
          const existingTrack = existingTracks.get(track.id);
          if (existingTrack) {
            skippedTrackIds.add(track.id);
            if (existingTrack.sha256 && existingTrack.sha256 !== track.sha256) {
              conflictTrackIds.add(track.id);
            }
          } else {
            const filePath = getTrackPath(track.id);
            if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
              throw new Error(`No se encontró el archivo "${track.name}" durante la migración.`);
            }
            const contents = fs.readFileSync(filePath);
            const checksum = createHash('sha256').update(contents).digest('hex');
            if (!contents.length || contents.length > maxFileSize || checksum !== track.sha256) {
              throw new Error(`No se pudo validar el tamaño o SHA-256 del archivo "${track.name}".`);
            }
            let uploaded;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              try {
                uploaded = await requestMigrationDestination(
                  destination,
                  `/api/tracks?disc=${encodeURIComponent(disc.name)}`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/octet-stream',
                      'X-Content-SHA256': checksum,
                      'X-File-Name': encodeURIComponent(track.name),
                    },
                    body: contents,
                  },
                );
                break;
              } catch (error) {
                if (error.status === 409) {
                  const refreshedLibrary = await requestMigrationDestination(destination, '/api/discs');
                  const remoteTrack = refreshedLibrary.discs
                    .flatMap((item) => Array.isArray(item.tracks) ? item.tracks : [])
                    .find((item) => item.id === track.id);
                  if (remoteTrack?.sha256 === checksum) {
                    skippedTrackIds.add(track.id);
                    uploaded = { track: remoteTrack };
                    break;
                  }
                  if (remoteTrack) {
                    skippedTrackIds.add(track.id);
                    conflictTrackIds.add(track.id);
                    uploaded = { track: remoteTrack };
                    break;
                  }
                }
                if (attempt === 2 || error.status < 500) throw error;
                await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
              }
            }
            if (!skippedTrackIds.has(track.id)
              && (uploaded?.track?.sha256 !== checksum || uploaded.track.sizeBytes !== track.sizeBytes)) {
              throw new Error(`No se pudo verificar el archivo "${track.name}" en el destino.`);
            }
            if (uploaded?.track) existingTracks.set(track.id, uploaded.track);
            if (!skippedTrackIds.has(track.id)) transferredTrackIds.add(track.id);
          }
          completedTrackIds.add(track.id);
          migration.completedTrackIds = [...completedTrackIds];
          migration.transferredTrackIds = [...transferredTrackIds];
          migration.skippedTrackIds = [...skippedTrackIds];
          migration.conflictTrackIds = [...conflictTrackIds];
          updateProgress();
        }
      }
      if (!migration.stateImported) {
        await requestMigrationDestination(destination, '/api/admin/import-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            player: {
              tracks: playerState.queue,
              currentTrackId: playerState.currentIndex === null ? null : playerState.queue[playerState.currentIndex],
              repeat: playerState.repeat,
            },
            schedules,
          }),
        });
        migration.stateImported = true;
        persistMigrations();
      }
      migration.status = 'completed';
      migration.percent = 100;
      migration.currentTrack = '';
      migration.error = '';
    } catch (error) {
      migration.status = 'failed';
      migration.error = error.message;
    } finally {
      activeMigrationId = null;
      persistMigrations();
    }
  }

  async function readBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxFileSize) {
        const error = new Error('El archivo no puede superar 100 MB.');
        error.status = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  function streamAudio(response, filePath, range) {
    const { size } = fs.statSync(filePath);
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}` });
        response.end();
        return;
      }
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : end;
      } else {
        start = Math.max(0, size - Number(match[2]));
      }
      if (start > end || start >= size) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}` });
        response.end();
        return;
      }
      end = Math.min(end, size - 1);
      status = 206;
    }
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'application/octet-stream',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    response.writeHead(status, headers);
    pipeline(fs.createReadStream(filePath, { start, end }), response, () => {});
  }

  async function handleRequest(request, response) {
    const requestUrl = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && ['/', '/index.html'].includes(requestUrl.pathname)) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/manifest.webmanifest') {
      response.writeHead(200, {
        'Content-Type': 'application/manifest+json; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      response.end(fs.readFileSync(path.join(__dirname, 'public', 'manifest.webmanifest')));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/service-worker.js') {
      response.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Service-Worker-Allowed': '/',
      });
      response.end(fs.readFileSync(path.join(__dirname, 'public', 'service-worker.js')));
      return;
    }
    const icon = /^\/icons\/(icon-(?:192|512)\.png)$/.exec(requestUrl.pathname);
    if (request.method === 'GET' && icon) {
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      response.end(fs.readFileSync(path.join(__dirname, 'public', 'icons', icon[1])));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/admin/config') {
      sendJson(response, 200, { configured: Boolean(adminToken) });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/admin/session') {
      if (!adminToken) {
        sendJson(response, 503, { ok: false, message: 'El servidor no configuró BIBLIOTECA_ADMIN_TOKEN.' });
        return;
      }
      if (!isAdminTokenValid(bearerToken(request))) {
        sendJson(response, 401, { ok: false, message: 'El token administrativo no es válido.' });
        return;
      }
      sendJson(response, 200, { authenticated: true });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
      sendJson(response, 200, {
        ok: true,
        apiVersion: 1,
        migrationSupport: true,
        maxFileSize,
        freeBytes: getFreeBytes(),
      });
      return;
    }
    if (requestUrl.pathname.startsWith('/api/')) {
      const adminRoute = requestUrl.pathname.startsWith('/api/admin/')
        || requestUrl.pathname.startsWith('/api/migrations');
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      if (adminRoute || mutating) {
        if (!adminToken) {
          sendJson(response, 503, {
            ok: false,
            message: 'Las operaciones administrativas están deshabilitadas: configura BIBLIOTECA_ADMIN_TOKEN.',
          });
          return;
        }
        if (!isAdminTokenValid(bearerToken(request))) {
          response.setHeader('WWW-Authenticate', 'Bearer');
          sendJson(response, 401, { ok: false, message: 'Se requiere un token administrativo válido.' });
          return;
        }
      }
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/admin/import-state') {
      let payload;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8'));
      } catch {
        const invalidJson = new Error('El estado importado debe enviarse como JSON válido.');
        invalidJson.status = 400;
        throw invalidJson;
      }
      sendJson(response, 200, mergeImportedState(payload));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/migrations/preview') {
      let payload;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8'));
      } catch {
        const invalidJson = new Error('La vista previa debe enviarse como JSON válido.');
        invalidJson.status = 400;
        throw invalidJson;
      }
      const destination = validateMigrationDestination(payload?.destinationUrl);
      const preview = await getMigrationPreview(destination);
      sendJson(response, 200, { preview });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/migrations') {
      sendJson(response, 200, {
        migrations: [...migrations.values()].map(migrationSnapshot),
      });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/migrations') {
      let payload;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8'));
      } catch (error) {
        if (error.status) throw error;
        const invalidJson = new Error('La migración debe enviarse como JSON válido.');
        invalidJson.status = 400;
        throw invalidJson;
      }
      const destination = validateMigrationDestination(payload?.destinationUrl);
      if (activeMigrationId) {
        const error = new Error('Ya hay una migración en curso.');
        error.status = 409;
        throw error;
      }
      if (migrations.size >= 20) {
        for (const [id, migration] of migrations) {
          if (migration.status !== 'running') migrations.delete(id);
          if (migrations.size < 20) break;
        }
      }
      const migration = {
        id: randomUUID(),
        status: 'running',
        destinationUrl: destination.href,
        totalTracks: 0,
        completedTracks: 0,
        transferredTracks: 0,
        skippedTracks: 0,
        conflictTrackIds: [],
        completedTrackIds: [],
        transferredTrackIds: [],
        skippedTrackIds: [],
        percent: 0,
        currentTrack: '',
        error: '',
        preview: null,
        stateImported: false,
      };
      migrations.set(migration.id, migration);
      activeMigrationId = migration.id;
      persistMigrations();
      runMigration(migration, destination).catch((error) => logger.error(`Falló la migración ${migration.id}: ${error.message}`));
      sendJson(response, 202, { migration: migrationSnapshot(migration) });
      return;
    }
    const resumeMigration = /^\/api\/migrations\/([a-f0-9-]+)\/resume$/.exec(requestUrl.pathname);
    if (request.method === 'POST' && resumeMigration) {
      const migration = migrations.get(resumeMigration[1]);
      if (!migration) {
        sendJson(response, 404, { ok: false, message: 'No se encontró la migración.' });
        return;
      }
      if (!['paused', 'failed'].includes(migration.status)) {
        sendJson(response, 409, { ok: false, message: 'Solo se pueden reanudar migraciones pausadas o fallidas.' });
        return;
      }
      if (activeMigrationId) {
        sendJson(response, 409, { ok: false, message: 'Ya hay una migración en curso.' });
        return;
      }
      const destination = validateMigrationDestination(migration.destinationUrl);
      migration.status = 'running';
      migration.error = '';
      activeMigrationId = migration.id;
      persistMigrations();
      runMigration(migration, destination).catch((error) => logger.error(`Falló la migración ${migration.id}: ${error.message}`));
      sendJson(response, 202, { migration: migrationSnapshot(migration) });
      return;
    }
    const migrationStatus = /^\/api\/migrations\/([a-f0-9-]+)$/.exec(requestUrl.pathname);
    if (request.method === 'GET' && migrationStatus) {
      const migration = migrations.get(migrationStatus[1]);
      if (!migration) {
        sendJson(response, 404, { ok: false, message: 'No se encontró la migración.' });
        return;
      }
      sendJson(response, 200, { migration: migrationSnapshot(migration) });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/player/state') {
      sendJson(response, 200, getPlayerSnapshot());
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/player/playlist') {
      sendJson(response, 200, getPlayerSnapshot());
      return;
    }
    if (request.method === 'PUT' && requestUrl.pathname === '/api/player/playlist') {
      let payload;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8'));
      } catch {
        const invalidJson = new Error('La playlist debe enviarse como JSON válido.');
        invalidJson.status = 400;
        throw invalidJson;
      }
      sendJson(response, 200, updatePlayerPlaylist(payload));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/player/current') {
      let payload;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8'));
      } catch {
        const invalidJson = new Error('La canción debe seleccionarse con JSON válido.');
        invalidJson.status = 400;
        throw invalidJson;
      }
      sendJson(response, 200, setCurrentTrack(payload?.index));
      return;
    }
    const playerAction = /^\/api\/player\/(next|previous|playback)$/.exec(requestUrl.pathname);
    if (playerAction && request.method === 'POST') {
      let payload;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8'));
      } catch {
        const invalidJson = new Error('La acción del reproductor debe enviarse como JSON válido.');
        invalidJson.status = 400;
        throw invalidJson;
      }
      const result = playerAction[1] === 'playback'
        ? setPlaybackState(payload?.isPlaying)
        : movePlayerTrack(playerAction[1] === 'next' ? 1 : -1);
      sendJson(response, 200, result);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/player/audio') {
      const currentTrackId = playerState.currentIndex === null
        ? null
        : playerState.queue[playerState.currentIndex];
      const filePath = getTrackPath(currentTrackId);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(response, 404, { ok: false, message: 'No hay una canción activa para reproducir.' });
        return;
      }
      streamAudio(response, filePath, request.headers.range);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/schedules') {
      sendJson(response, 200, { schedules });
      return;
    }
    if (request.method === 'PUT' && requestUrl.pathname === '/api/schedules') {
      let payload;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8'));
      } catch {
        const invalidJson = new Error('La programación debe enviarse como JSON válido.');
        invalidJson.status = 400;
        throw invalidJson;
      }
      const nextSchedules = validateSchedules(payload?.schedules);
      saveSchedules(nextSchedules);
      sendJson(response, 200, { schedules });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/discs') {
      sendJson(response, 200, { discs: listDiscs() });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/discs') {
      let payload;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8'));
      } catch (error) {
        if (error.status) throw error;
        const invalidJson = new Error('El nombre del disco debe enviarse como JSON válido.');
        invalidJson.status = 400;
        throw invalidJson;
      }
      if (!payload || typeof payload.name !== 'string') {
        const error = new Error('Indica el nombre del disco.');
        error.status = 400;
        throw error;
      }
      const result = createDisc(payload.name);
      sendJson(response, result.created ? 201 : 200, result);
      return;
    }
    if (request.method === 'DELETE' && requestUrl.pathname === '/api/discs') {
      const discId = requestUrl.searchParams.get('id');
      if (typeof discId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(discId)) {
        sendJson(response, 400, { ok: false, message: 'El disco indicado no es válido.' });
        return;
      }
      const discDirectory = path.resolve(rootDirectory, discId);
      if (path.dirname(discDirectory) !== rootDirectory || !fs.existsSync(discDirectory)
        || !fs.statSync(discDirectory).isDirectory()) {
        sendJson(response, 404, { ok: false, message: 'No se encontró el disco.' });
        return;
      }
      const trackIds = listDiscs().find((disc) => disc.id === discId)?.tracks.map((track) => track.id) || [];
      fs.rmSync(discDirectory, { recursive: true });
      removeTracksFromPlayer(trackIds);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/tracks') {
      const discName = requestUrl.searchParams.get('disc')?.trim() || '';
      const discId = getDiscId(discName);
      let filename;
      try {
        filename = decodeURIComponent(request.headers['x-file-name'] || '');
      } catch {
        const error = new Error('El nombre del archivo no es válido.');
        error.status = 400;
        throw error;
      }
      if (!discId || discName.length > 100 || !filename || filename.length > 180 || filename !== path.basename(filename)
        || filename.includes('/') || filename.includes('\\') || filename.startsWith('.')
        || /[\u0000-\u001f]/.test(filename) || !audioExtensions.has(path.extname(filename).toLowerCase())) {
        const error = new Error('El disco o el nombre/formato del archivo de audio no es válido.');
        error.status = 400;
        throw error;
      }
      const contents = await readBody(request);
      if (!contents.length) {
        const error = new Error('El archivo debe tener contenido.');
        error.status = 400;
        throw error;
      }
      const checksum = createHash('sha256').update(contents).digest('hex');
      const expectedChecksum = request.headers['x-content-sha256'];
      if (expectedChecksum !== undefined
        && (typeof expectedChecksum !== 'string' || !/^[a-f0-9]{64}$/.test(expectedChecksum)
          || expectedChecksum !== checksum)) {
        const error = new Error('El checksum SHA-256 del archivo no coincide.');
        error.status = 422;
        throw error;
      }
      const { disc } = createDisc(discName);
      const discDirectory = path.join(rootDirectory, disc.id);
      const filePath = path.join(discDirectory, filename);
      let fileCreated = false;
      try {
        fs.writeFileSync(filePath, contents, { flag: 'wx' });
        fileCreated = true;
        saveTrackMetadata(disc.id, filename, contents);
      } catch (error) {
        if (fileCreated && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        if (error.code === 'EEXIST') {
          error.status = 409;
          error.message = 'Ya existe un tema con ese nombre en este disco.';
        }
        throw error;
      }
      sendJson(response, 201, {
        track: {
          id: `${disc.id}/${filename}`,
          name: filename,
          title: path.parse(filename).name,
          discId: disc.id,
          discName: disc.name,
          sizeBytes: contents.length,
          sha256: checksum,
        },
      });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/audio') {
      const filePath = getTrackPath(requestUrl.searchParams.get('id'));
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(response, 404, { ok: false, message: 'No se encontró el tema.' });
        return;
      }
      streamAudio(response, filePath, request.headers.range);
      return;
    }
    if (request.method === 'DELETE' && requestUrl.pathname === '/api/tracks') {
      const trackId = requestUrl.searchParams.get('id');
      const filePath = getTrackPath(trackId);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(response, 404, { ok: false, message: 'No se encontró el tema.' });
        return;
      }
      fs.unlinkSync(filePath);
      removeTracksFromPlayer([trackId]);
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { ok: false, message: 'Ruta no encontrada.' });
  }

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      sendJson(response, error.status || 500, {
        ok: false,
        message: error.status ? error.message : 'No se pudo completar la operación de almacenamiento.',
      });
    });
  });
  const scheduleTimer = setInterval(() => {
    processDueSchedules().catch((error) => logger.error(`No se pudo revisar la programación: ${error.message}`));
  }, 10000);
  scheduleTimer.unref();
  server.once('close', () => clearInterval(scheduleTimer));
  return server;
}

function startServer({
  port = Number(process.env.PORT || 3001),
  host = process.env.HOST || '0.0.0.0',
  createServer = createLibraryServer,
} = {}) {
  const server = createServer();
  server.listen(port, host, () => {
    const address = server.address();
    const listeningPort = address && typeof address === 'object' ? address.port : port;
    console.log(`Biblioteca externa disponible en http://localhost:${listeningPort}`);
  });
  return server;
}

if (require.main === module) startServer();

module.exports = { createLibraryServer, startServer };
