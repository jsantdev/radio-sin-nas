const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
  createHash,
  randomUUID,
  timingSafeEqual,
} = require('node:crypto');
const { pipeline } = require('node:stream');
const { createCatalogRepository } = require('./catalog/repository');
const { createPlaybackService } = require('./playback/service');

const maxAudioFileSize = 100 * 1024 * 1024;

function createLibraryServer({
  dataDirectory = process.env.BIBLIOTECA_DATA_DIR || path.join(__dirname, '..', '..', 'data', 'biblioteca', 'discs'),
  maxFileSize = maxAudioFileSize,
  adminToken = process.env.BIBLIOTECA_ADMIN_TOKEN || '',
  adminAuthDisabled = process.env.BIBLIOTECA_AUTH_DISABLED === 'true',
  trustClientAddressHeader = false,
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
  if (adminAuthDisabled && process.env.NODE_ENV !== 'development') {
    throw new Error('BIBLIOTECA_AUTH_DISABLED solo se puede activar en desarrollo.');
  }
  if (adminToken && (Buffer.byteLength(adminToken) < 32 || adminToken.trim() !== adminToken)) {
    throw new Error('BIBLIOTECA_ADMIN_TOKEN debe tener al menos 32 bytes y no incluir espacios externos.');
  }

  function isLoopbackAddress(address) {
    return address === '::1' || address === '127.0.0.1'
      || /^::ffff:127(?:\.\d{1,3}){3}$/.test(address || '');
  }

  function isLocalDevelopmentRequest(request) {
    const address = trustClientAddressHeader
      ? request.headers['x-radio-client-address'] || request.socket.remoteAddress
      : request.socket.remoteAddress;
    return adminAuthDisabled && !adminToken
    && process.env.NODE_ENV === 'development' && isLoopbackAddress(address);
  }

  function requiresAdminAuth(request) {
    return !isLocalDevelopmentRequest(request);
  }
  fs.mkdirSync(rootDirectory, { recursive: true });
  const {
    createDisc,
    getDiscId,
    getTrackPath,
    isAudioFileName,
    listDiscs,
    saveTrackMetadata,
  } = createCatalogRepository({ rootDirectory });
  if (fs.existsSync(migrationsPath)) {
    const savedMigrations = JSON.parse(fs.readFileSync(migrationsPath, 'utf8'));
    if (!Array.isArray(savedMigrations)) throw new Error('El historial de migraciones no es válido.');
    for (const savedMigration of savedMigrations) {
      if (!savedMigration || typeof savedMigration.id !== 'string'
        || !['running', 'paused', 'failed', 'completed'].includes(savedMigration.status)
        || !['export', 'import'].includes(savedMigration.direction || 'export')
        || typeof (savedMigration.direction === 'import' ? savedMigration.sourceUrl : savedMigration.destinationUrl) !== 'string'
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

  const playback = createPlaybackService({
    playerStatePath,
    schedulesPath,
    listDiscs,
    logger,
  });
  const {
    getPlayerState,
    getPlayerSnapshot,
    getSchedules,
    mergeImportedState,
    movePlayerTrack,
    processDueSchedules,
    removeTracks,
    saveSchedules,
    setCurrentTrack,
    setPlaybackState,
    updatePlayerPlaylist,
    validateSchedules,
  } = playback;

  function isAdminTokenValid(value, request) {
    if (request && isLocalDevelopmentRequest(request)) return true;
    if (!adminToken || typeof value !== 'string') return false;
    const supplied = Buffer.from(value);
    const expected = Buffer.from(adminToken);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  function bearerToken(request) {
    const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || '');
    return match ? match[1] : '';
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

  function validateMigrationDestination(value, label = 'destino') {
    if (typeof value !== 'string' || !value.trim()) {
      const error = new Error(`Indica la URL de la biblioteca de ${label}.`);
      error.status = 400;
      throw error;
    }
    let destination;
    try {
      destination = new URL(value.trim());
    } catch {
      const error = new Error(`Ingresa una URL válida para la biblioteca de ${label}.`);
      error.status = 400;
      throw error;
    }
    if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password
      || destination.search || destination.hash) {
      const error = new Error(`La URL de ${label} debe ser HTTP o HTTPS y no incluir credenciales, parámetros ni fragmentos.`);
      error.status = 400;
      throw error;
    }
    if (destination.protocol === 'http:' && !allowInsecureMigrationHttp) {
      const error = new Error(`Las migraciones requieren HTTPS; HTTP solo puede habilitarse explícitamente en una red privada confiable.`);
      error.status = 400;
      throw error;
    }
    const allowed = migrationAllowedHosts.includes(destination.hostname.toLowerCase())
      || migrationAllowedHosts.includes(destination.host.toLowerCase());
    if (!allowed) {
      const error = new Error(`El host de ${label} no está autorizado. Configúralo en BIBLIOTECA_MIGRATION_ALLOWED_HOSTS.`);
      error.status = 403;
      throw error;
    }
    destination.pathname = `${destination.pathname.replace(/\/+$/, '')}/`;
    return destination;
  }

  async function requestMigrationDestination(destination, pathname, options = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('No está disponible el cliente HTTP para migrar la biblioteca.');
    if (!adminToken) {
      const destinationHost = destination.hostname.replace(/^\[|\]$/g, '');
      if (!(adminAuthDisabled && process.env.NODE_ENV === 'development'
        && isLoopbackAddress(destinationHost))) {
        throw new Error('Configura BIBLIOTECA_ADMIN_TOKEN para autenticar la Biblioteca de destino.');
      }
    }
    let response;
    try {
      response = await fetchImpl(new URL(pathname.replace(/^\/+/, ''), destination), {
        ...options,
        headers: {
          ...options.headers,
          ...(adminToken ? { Authorization: 'Bearer ' + adminToken } : {}),
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
    const playerState = playback.getPlayerState();
    const schedules = playback.getSchedules();
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

  async function getImportPreview(source) {
    const [health, sourceLibrary, sourcePlayer, sourceSchedules] = await Promise.all([
      requestMigrationDestination(source, '/api/health'),
      requestMigrationDestination(source, '/api/discs'),
      requestMigrationDestination(source, '/api/player/state'),
      requestMigrationDestination(source, '/api/schedules'),
    ]);
    if (health.apiVersion !== 1 || !Number.isSafeInteger(health.maxFileSize)
      || health.maxFileSize <= 0 || !Array.isArray(sourceLibrary.discs)
      || !Array.isArray(sourcePlayer.queue) || typeof sourcePlayer.repeat !== 'boolean'
      || !Array.isArray(sourceSchedules.schedules)) {
      const error = new Error('La URL no corresponde a una biblioteca compatible.');
      error.status = 409;
      throw error;
    }

    const sourceTracks = [];
    for (const disc of sourceLibrary.discs) {
      if (!disc || typeof disc.id !== 'string' || typeof disc.name !== 'string'
        || !Array.isArray(disc.tracks) || getDiscId(disc.name) !== disc.id) {
        const error = new Error('La biblioteca de origen devolvió discos no válidos.');
        error.status = 409;
        throw error;
      }
      for (const track of disc.tracks) {
        if (!track || track.discId !== disc.id || typeof track.name !== 'string'
          || track.id !== `${disc.id}/${track.name}` || getTrackPath(track.id) === null
          || !Number.isSafeInteger(track.sizeBytes) || track.sizeBytes <= 0
          || typeof track.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(track.sha256)) {
          const error = new Error('La biblioteca de origen devolvió temas no válidos.');
          error.status = 409;
          throw error;
        }
        sourceTracks.push(track);
      }
    }
    const sourceTrackIds = new Set(sourceTracks.map((track) => track.id));
    if (sourcePlayer.queue.some((track) => !track || typeof track.id !== 'string'
      || !sourceTrackIds.has(track.id))
      || new Set(sourcePlayer.queue.map((track) => track.id)).size !== sourcePlayer.queue.length
      || (sourcePlayer.currentTrack !== null
        && (!sourcePlayer.currentTrack || typeof sourcePlayer.currentTrack.id !== 'string'
          || !sourcePlayer.queue.some((track) => track.id === sourcePlayer.currentTrack.id)))) {
      const error = new Error('La biblioteca de origen devolvió una playlist no válida.');
      error.status = 409;
      throw error;
    }
    const scheduleIds = new Set();
    if (sourceSchedules.schedules.some((schedule) => {
      if (!schedule || typeof schedule.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(schedule.id)
        || scheduleIds.has(schedule.id) || !sourceTrackIds.has(schedule.trackId)
        || typeof schedule.scheduledAt !== 'string' || !Number.isFinite(Date.parse(schedule.scheduledAt))
        || !['once', 'daily', 'weekly'].includes(schedule.recurrence)) return true;
      scheduleIds.add(schedule.id);
      return false;
    })) {
      const error = new Error('La biblioteca de origen devolvió una programación no válida.');
      error.status = 409;
      throw error;
    }

    const destinationTracks = new Map(listDiscs()
      .flatMap((disc) => disc.tracks)
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
        if (existing.sha256 !== track.sha256) checksumConflicts += 1;
      }
    }
    const destinationState = playback.getPlayerState();
    const mergedPlaylistCount = new Set([
      ...destinationState.queue,
      ...sourcePlayer.queue.map((track) => track.id),
    ]).size;
    const destinationScheduleIds = new Set(playback.getSchedules().map((schedule) => schedule.id));
    const mergedScheduleCount = destinationScheduleIds.size
      + sourceSchedules.schedules.filter((schedule) => schedule && typeof schedule.id === 'string'
        && !destinationScheduleIds.has(schedule.id)).length;
    const oversizedTracks = sourceTracks.filter((track) =>
      track.sizeBytes > Math.min(health.maxFileSize, maxFileSize)).length;
    const freeBytes = getFreeBytes();

    return {
      sourceDiscCount: sourceLibrary.discs.length,
      sourceTrackCount: sourceTracks.length,
      totalBytes: sourceTracks.reduce((total, track) => total + track.sizeBytes, 0),
      requiredBytes,
      existingTracks,
      checksumConflicts,
      oversizedTracks,
      sourcePlaylistCount: sourcePlayer.queue.length,
      destinationPlaylistCount: destinationState.queue.length,
      sourceScheduleCount: sourceSchedules.schedules.length,
      destinationScheduleCount: playback.getSchedules().length,
      mergedScheduleCount,
      mergedPlaylistCount,
      stateFits: mergedScheduleCount <= 200 && mergedPlaylistCount <= 5000,
      destinationFreeBytes: freeBytes,
      enoughSpace: Number.isSafeInteger(freeBytes) ? freeBytes >= requiredBytes : null,
    };
  }

  async function requestMigrationAudio(source, trackId) {
    if (typeof fetchImpl !== 'function') throw new Error('No está disponible el cliente HTTP para importar la biblioteca.');
    let response;
    try {
      response = await fetchImpl(new URL(`api/audio?id=${encodeURIComponent(trackId)}`, source), {
        redirect: 'error',
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
    } catch (error) {
      const connectionError = new Error(`No se pudo descargar el tema desde la biblioteca de origen: ${error.message}`);
      connectionError.status = 502;
      throw connectionError;
    }
    if (!response.ok) {
      const requestError = new Error(`La biblioteca de origen respondió HTTP ${response.status} al descargar un tema.`);
      requestError.status = response.status;
      throw requestError;
    }
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > maxFileSize) {
      const error = new Error('El tema de origen supera el tamaño máximo permitido.');
      error.status = 413;
      throw error;
    }
    const contents = Buffer.from(await response.arrayBuffer());
    if (!contents.length || contents.length > maxFileSize
      || (Number.isFinite(declaredSize) && declaredSize !== contents.length)) {
      const error = new Error('El tema descargado tiene un tamaño no válido.');
      error.status = 422;
      throw error;
    }
    return contents;
  }

  function migrationSnapshot(migration) {
    return {
      id: migration.id,
      direction: migration.direction || 'export',
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
        const playerState = playback.getPlayerState();
        const schedules = playback.getSchedules();
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

  async function runImport(migration, source) {
    try {
      const sourceLibrary = await requestMigrationDestination(source, '/api/discs');
      const preview = await getImportPreview(source);
      migration.preview = preview;
      migration.totalTracks = preview.sourceTrackCount;
      if (preview.oversizedTracks) {
        throw new Error('La biblioteca de origen contiene temas que superan el tamaño máximo permitido.');
      }
      if (preview.enoughSpace === false) {
        throw new Error('Este servidor no tiene espacio libre suficiente para los temas que faltan.');
      }
      if (!preview.stateFits) {
        throw new Error('La combinación superaría el límite de temas de playlist o canciones programadas.');
      }
      persistMigrations();

      const localTracks = new Map(listDiscs().flatMap((disc) => disc.tracks).map((track) => [track.id, track]));
      const completedTrackIds = new Set(migration.completedTrackIds);
      const transferredTrackIds = new Set(migration.transferredTrackIds);
      const skippedTrackIds = new Set(migration.skippedTrackIds);
      const conflictTrackIds = new Set(migration.conflictTrackIds || []);
      const updateProgress = () => {
        migration.completedTracks = completedTrackIds.size;
        migration.transferredTracks = transferredTrackIds.size;
        migration.skippedTracks = skippedTrackIds.size;
        migration.percent = migration.totalTracks
          ? Math.floor((migration.completedTracks / migration.totalTracks) * 95)
          : 0;
        migration.completedTrackIds = [...completedTrackIds];
        migration.transferredTrackIds = [...transferredTrackIds];
        migration.skippedTrackIds = [...skippedTrackIds];
        migration.conflictTrackIds = [...conflictTrackIds];
        persistMigrations();
      };

      for (const disc of sourceLibrary.discs) {
        const created = createDisc(disc.name);
        if (created.disc.id !== disc.id || created.disc.name !== disc.name) {
          throw new Error(`No se pudo conservar el disco "${disc.name}" en esta biblioteca.`);
        }
        for (const track of disc.tracks) {
          if (completedTrackIds.has(track.id) && localTracks.has(track.id)) continue;
          migration.currentTrack = `${disc.name} · ${track.title || track.name}`;
          const existingTrack = localTracks.get(track.id);
          if (existingTrack) {
            skippedTrackIds.add(track.id);
            if (existingTrack.sha256 !== track.sha256) conflictTrackIds.add(track.id);
          } else {
            const contents = await requestMigrationAudio(source, track.id);
            const checksum = createHash('sha256').update(contents).digest('hex');
            if (contents.length !== track.sizeBytes || checksum !== track.sha256) {
              const error = new Error(`No se pudo validar el tamaño o SHA-256 del tema "${track.name}".`);
              error.status = 422;
              throw error;
            }
            const filePath = getTrackPath(track.id);
            if (!filePath) throw new Error(`La ruta del tema "${track.name}" no es válida.`);
            let fileCreated = false;
            try {
              fs.writeFileSync(filePath, contents, { flag: 'wx' });
              fileCreated = true;
              saveTrackMetadata(disc.id, track.name, contents);
            } catch (error) {
              if (fileCreated && fs.existsSync(filePath)) fs.unlinkSync(filePath);
              if (error.code === 'EEXIST') {
                error.status = 409;
                error.message = `Ya existe el tema "${track.name}" en esta biblioteca.`;
              }
              throw error;
            }
            const importedTrack = { ...track, discName: disc.name };
            localTracks.set(track.id, importedTrack);
            transferredTrackIds.add(track.id);
          }
          completedTrackIds.add(track.id);
          updateProgress();
        }
      }

      if (!migration.stateImported) {
        const [sourcePlayer, sourceSchedules] = await Promise.all([
          requestMigrationDestination(source, '/api/player/state'),
          requestMigrationDestination(source, '/api/schedules'),
        ]);
        if (!Array.isArray(sourcePlayer.queue) || !Array.isArray(sourceSchedules.schedules)) {
          throw new Error('La biblioteca de origen devolvió un estado no válido.');
        }
        mergeImportedState({
          player: {
            tracks: sourcePlayer.queue.map((track) => track.id),
            currentTrackId: sourcePlayer.currentTrack?.id || null,
            repeat: sourcePlayer.repeat,
          },
          schedules: sourceSchedules.schedules,
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
    const playerState = playback.getPlayerState();
    const schedules = playback.getSchedules();
    const requestUrl = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && ['/', '/index.html'].includes(requestUrl.pathname)) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'biblioteca', 'index.html')));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/dashboard.css') {
      response.writeHead(200, {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      response.end(fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'dashboard.css')));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/manifest.webmanifest') {
      response.writeHead(200, {
        'Content-Type': 'application/manifest+json; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      response.end(fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'biblioteca', 'manifest.webmanifest')));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/service-worker.js') {
      response.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Service-Worker-Allowed': '/',
      });
      response.end(fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'biblioteca', 'service-worker.js')));
      return;
    }
    const icon = /^\/icons\/(icon-(?:192|512)\.png)$/.exec(requestUrl.pathname);
    if (request.method === 'GET' && icon) {
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      response.end(fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'biblioteca', 'icons', icon[1])));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/admin/config') {
      sendJson(response, 200, {
        configured: Boolean(adminToken),
        authRequired: requiresAdminAuth(request),
      });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/admin/session') {
      sendJson(response, 200, {
        authenticated: isAdminTokenValid(bearerToken(request), request),
      });
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
        || requestUrl.pathname.startsWith('/api/migrations')
        || requestUrl.pathname.startsWith('/api/imports');
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      if (adminRoute || mutating) {
        if (!isLocalDevelopmentRequest(request) && !adminToken) {
          sendJson(response, 503, {
            ok: false,
            message: 'Las operaciones administrativas están deshabilitadas: configura BIBLIOTECA_ADMIN_TOKEN.',
          });
          return;
        }
        if (!isLocalDevelopmentRequest(request) && !isAdminTokenValid(bearerToken(request), request)) {
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
    if (request.method === 'POST' && requestUrl.pathname === '/api/imports/preview') {
      let payload;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8'));
      } catch {
        const invalidJson = new Error('La vista previa de importación debe enviarse como JSON válido.');
        invalidJson.status = 400;
        throw invalidJson;
      }
      const source = validateMigrationDestination(payload?.sourceUrl, 'origen');
      const preview = await getImportPreview(source);
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
    if (request.method === 'POST' && requestUrl.pathname === '/api/imports') {
      let payload;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8'));
      } catch (error) {
        if (error.status) throw error;
        const invalidJson = new Error('La importación debe enviarse como JSON válido.');
        invalidJson.status = 400;
        throw invalidJson;
      }
      const source = validateMigrationDestination(payload?.sourceUrl, 'origen');
      if (activeMigrationId) {
        const error = new Error('Ya hay una migración o importación en curso.');
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
        direction: 'import',
        status: 'running',
        sourceUrl: source.href,
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
      runImport(migration, source).catch((error) => logger.error(`Falló la importación ${migration.id}: ${error.message}`));
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
      const isImport = migration.direction === 'import';
      const peer = validateMigrationDestination(
        isImport ? migration.sourceUrl : migration.destinationUrl,
        isImport ? 'origen' : 'destino',
      );
      migration.status = 'running';
      migration.error = '';
      activeMigrationId = migration.id;
      persistMigrations();
      const operation = isImport ? runImport(migration, peer) : runMigration(migration, peer);
      operation.catch((error) => logger.error(`Falló la migración ${migration.id}: ${error.message}`));
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
      sendJson(response, 200, { schedules: playback.getSchedules() });
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
      removeTracks(trackIds);
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
        || /[\u0000-\u001f]/.test(filename) || !isAudioFileName(filename)) {
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
      const trackId = `${disc.id}/${filename}`;
      const queue = getPlayerState().queue;
      const queued = queue.includes(trackId) || queue.length < 5000;
      if (queued && !queue.includes(trackId)) {
        updatePlayerPlaylist({ tracks: [...queue, trackId] });
      }
      sendJson(response, 201, {
        queued,
        ...(queued ? {} : { message: 'El tema se subió, pero la playlist alcanzó el límite de 5000 temas.' }),
        track: {
          id: trackId,
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
      removeTracks([trackId]);
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
