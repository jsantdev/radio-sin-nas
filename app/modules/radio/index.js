const fs = require('node:fs');
const path = require('node:path');
const { registerRadioRoutes } = require('./routes');

const audioExtensions = new Set(['.aac', '.m4a', '.mp3', '.ogg', '.opus', '.wav']);
const maxAudioFileSize = 100 * 1024 * 1024;

function createRadioModule({
  stream,
  audioDirectory = path.join(__dirname, '..', '..', 'data', 'music'),
  playlistPath = path.join(__dirname, '..', '..', 'data', 'radio-playlist.json'),
  externalLibrary,
} = {}) {
  if (!stream || typeof stream.attach !== 'function' || typeof stream.broadcast !== 'function') {
    throw new Error('El módulo de radio necesita su canal de actualizaciones.');
  }

  fs.mkdirSync(audioDirectory, { recursive: true });
  let queue = [];
  if (fs.existsSync(playlistPath)) {
    const savedQueue = JSON.parse(fs.readFileSync(playlistPath, 'utf8'));
    if (!Array.isArray(savedQueue) || savedQueue.some((filename) => typeof filename !== 'string')) {
      throw new Error('La playlist guardada no es válida.');
    }
    queue = savedQueue;
  }

  function isSupportedAudio(filename) {
    return audioExtensions.has(path.extname(filename).toLowerCase());
  }

  function resolveAudioFile(filename) {
    if (typeof filename !== 'string' || !filename || filename !== path.basename(filename)
      || filename.includes('/') || filename.includes('\\') || !isSupportedAudio(filename)) {
      return null;
    }
    const filePath = path.resolve(audioDirectory, filename);
    return path.dirname(filePath) === path.resolve(audioDirectory) && fs.existsSync(filePath)
      && fs.statSync(filePath).isFile()
      ? filePath
      : null;
  }

  if ((!externalLibrary || !externalLibrary.getServerUrl())
    && queue.some((filename) => !resolveAudioFile(filename))) {
    throw new Error('La playlist guardada contiene archivos de audio inexistentes o no válidos.');
  }

  let remoteTracks = [];
  let remoteDiscs = [];
  let externalError = '';
  let externalConnected = false;
  let currentIndex = queue.length ? 0 : null;
  let isPlaying = false;

  function formatTrack(filename) {
    return {
      name: filename,
      title: path.parse(filename).name,
      url: `/audio/${encodeURIComponent(filename)}`,
    };
  }

  function getSnapshot() {
    const externalMode = Boolean(externalLibrary?.getServerUrl());
    const remoteById = new Map(remoteTracks.map((track) => [track.id, track]));
    const tracks = queue.map((filename) => {
      if (!externalMode) return formatTrack(filename);
      const remoteTrack = remoteById.get(filename);
      return {
        name: filename,
        title: remoteTrack?.title || path.parse(filename.split('/').pop()).name,
        discName: remoteTrack?.discName || '',
        url: `/audio/${encodeURIComponent(filename)}`,
      };
    });
    return {
      status: tracks.length ? 'ready' : 'empty',
      audioSource: externalMode ? 'external-files' : 'local-files',
      isPlaying,
      currentIndex,
      currentTrack: currentIndex === null ? null : tracks[currentIndex],
      queue: tracks,
    };
  }

  async function getAvailableTracks() {
    if (externalLibrary?.getServerUrl()) {
      try {
        const discs = await externalLibrary.fetchDiscs();
        remoteDiscs = discs;
        remoteTracks = discs.flatMap((disc) => disc.tracks);
        externalError = '';
        externalConnected = true;
        return remoteTracks.map((track) => ({
          name: track.id,
          title: track.title,
          discName: track.discName,
          url: `/audio/${encodeURIComponent(track.id)}`,
        }));
      } catch (error) {
        externalError = error.message;
        externalConnected = false;
        throw error;
      }
    }
    return fs.readdirSync(audioDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isSupportedAudio(entry.name))
      .map((entry) => formatTrack(entry.name))
      .sort((first, second) => first.name.localeCompare(second.name, 'es'));
  }

  function getAvailableDiscs() {
    return remoteDiscs.map((disc) => ({
      id: disc.id,
      name: disc.name,
      trackCount: disc.tracks.length,
    }));
  }

  async function createExternalDisc(name) {
    if (!externalLibrary?.getServerUrl()) {
      return { ok: false, status: 409, message: 'Configura primero el servidor externo de temas.' };
    }
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
      return { ok: false, status: 400, message: 'El nombre del disco debe tener entre 1 y 100 caracteres.' };
    }
    try {
      const result = await externalLibrary.createDisc(name.trim());
      await getAvailableTracks();
      const disc = remoteDiscs.find((entry) => entry.id === result.disc.id);
      if (!disc) {
        return { ok: false, status: 502, message: 'El servidor no incluyó el disco recién creado en su biblioteca.' };
      }
      return { ok: true, disc: { id: disc.id, name: disc.name, trackCount: disc.tracks.length }, created: result.created };
    } catch (error) {
      return { ok: false, status: error.status || 502, message: error.message };
    }
  }

  function getStorageConfiguration() {
    const serverUrl = externalLibrary?.getServerUrl() || '';
    return {
      serverUrl,
      external: Boolean(serverUrl),
      connected: Boolean(serverUrl) && externalConnected,
      error: externalError,
      discCount: remoteDiscs.length,
      trackCount: remoteTracks.length,
    };
  }

  async function saveStorageConfiguration(value) {
    if (!externalLibrary) {
      return { ok: false, status: 500, message: 'No está disponible la configuración de biblioteca externa.' };
    }
    let configuration;
    try {
      configuration = externalLibrary.setServerUrl(value);
    } catch (error) {
      return { ok: false, status: 400, message: error.message };
    }
    remoteTracks = [];
    remoteDiscs = [];
    externalError = '';
    externalConnected = false;
    if (configuration.serverUrl) {
      try {
        await getAvailableTracks();
      } catch (error) {
        return {
          ok: false,
          status: 502,
          message: `La URL quedó guardada, pero no se pudo conectar: ${error.message}`,
          configuration: getStorageConfiguration(),
        };
      }
    }
    publish();
    return { ok: true, configuration: getStorageConfiguration() };
  }

  function saveQueue(nextQueue) {
    fs.mkdirSync(path.dirname(playlistPath), { recursive: true });
    fs.writeFileSync(playlistPath, JSON.stringify(nextQueue, null, 2));
    queue = nextQueue;
  }

  function publish() {
    stream.broadcast('update', getSnapshot());
  }

  async function setPlaylist(submittedTracks) {
    if (externalLibrary?.getServerUrl()) {
      try {
        await getAvailableTracks();
      } catch (error) {
        return { ok: false, status: 502, message: error.message };
      }
    }
    const validTrack = externalLibrary?.getServerUrl()
      ? (filename) => remoteTracks.some((track) => track.id === filename)
      : (filename) => resolveAudioFile(filename);
    if (!Array.isArray(submittedTracks)
      || submittedTracks.some((filename) => typeof filename !== 'string')
      || new Set(submittedTracks).size !== submittedTracks.length
      || submittedTracks.some((filename) => !validTrack(filename))) {
      return { ok: false, status: 400, message: 'La playlist debe incluir temas disponibles y sin duplicados.' };
    }

    const selectedTrack = currentIndex === null ? null : queue[currentIndex];
    saveQueue(submittedTracks);
    currentIndex = selectedTrack && queue.includes(selectedTrack)
      ? queue.indexOf(selectedTrack)
      : queue.length ? 0 : null;
    if (currentIndex === null) isPlaying = false;
    publish();
    return { ok: true, state: getSnapshot() };
  }

  async function addAudioFile(filename, contents, discName = '') {
    if (externalLibrary?.getServerUrl()) {
      if (typeof discName !== 'string' || !discName.trim() || discName.length > 100) {
        return { ok: false, status: 400, message: 'Indica el nombre del disco para guardar el tema.' };
      }
      try {
        const track = await externalLibrary.uploadTrack(discName.trim(), filename, contents);
        await getAvailableTracks();
        const availableTrack = remoteTracks.find((entry) => entry.id === track.id);
        if (!availableTrack) {
          return { ok: false, status: 502, message: 'El servidor no incluyó el tema recién cargado en su biblioteca.' };
        }
        return {
          ok: true,
          track: {
            name: availableTrack.id,
            title: availableTrack.title,
            discName: availableTrack.discName,
            url: `/audio/${encodeURIComponent(availableTrack.id)}`,
          },
        };
      } catch (error) {
        return { ok: false, status: error.status || 502, message: error.message };
      }
    }
    if (typeof filename !== 'string' || !filename || filename.length > 180
      || filename !== path.basename(filename) || filename.includes('/')
      || filename.includes('\\') || /[\u0000-\u001f]/.test(filename)
      || filename.startsWith('.') || !isSupportedAudio(filename)) {
      return { ok: false, status: 400, message: 'El nombre o formato del archivo de audio no es válido.' };
    }
    if (!Buffer.isBuffer(contents) || !contents.length || contents.length > maxAudioFileSize) {
      return { ok: false, status: 400, message: 'El archivo debe tener contenido y no superar 100 MB.' };
    }

    const filePath = path.join(audioDirectory, filename);
    try {
      fs.writeFileSync(filePath, contents, { flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') {
        return { ok: false, status: 409, message: 'Ya existe un archivo con ese nombre.' };
      }
      throw error;
    }
    return { ok: true, track: formatTrack(filename) };
  }

  async function deleteAudioFile(filename) {
    if (externalLibrary?.getServerUrl()) {
      try {
        await externalLibrary.deleteTrack(filename);
        remoteTracks = remoteTracks.filter((track) => track.id !== filename);
      } catch (error) {
        return { ok: false, status: error.status || 502, message: error.message };
      }
      if (queue.includes(filename)) {
        const nextQueue = queue.filter((track) => track !== filename);
        const selectedTrack = currentIndex === null ? null : queue[currentIndex];
        saveQueue(nextQueue);
        currentIndex = selectedTrack && queue.includes(selectedTrack)
          ? queue.indexOf(selectedTrack)
          : queue.length ? 0 : null;
        if (currentIndex === null) isPlaying = false;
        publish();
      }
      return { ok: true, state: getSnapshot() };
    }
    const filePath = resolveAudioFile(filename);
    if (!filePath) return { ok: false, status: 404, message: 'No se encontró el archivo de audio.' };
    fs.unlinkSync(filePath);
    if (queue.includes(filename)) {
      const nextQueue = queue.filter((track) => track !== filename);
      const selectedTrack = currentIndex === null ? null : queue[currentIndex];
      saveQueue(nextQueue);
      currentIndex = selectedTrack && queue.includes(selectedTrack)
        ? queue.indexOf(selectedTrack)
        : queue.length ? 0 : null;
      if (currentIndex === null) isPlaying = false;
      publish();
    }
    return { ok: true, state: getSnapshot() };
  }

  function setCurrentTrack(index) {
    if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
      return { ok: false, status: 400, message: 'El índice no corresponde a una canción de la playlist.' };
    }
    currentIndex = index;
    publish();
    return { ok: true, state: getSnapshot() };
  }

  function moveTrack(direction) {
    if (!queue.length) return { ok: false, status: 409, message: 'La playlist está vacía.' };
    currentIndex = currentIndex === null
      ? 0
      : (currentIndex + direction + queue.length) % queue.length;
    publish();
    return { ok: true, state: getSnapshot() };
  }

  function setPlaybackState(playing) {
    if (typeof playing !== 'boolean') {
      return { ok: false, status: 400, message: 'El estado de reproducción debe ser booleano.' };
    }
    isPlaying = playing && queue.length > 0;
    publish();
    return { ok: true, state: getSnapshot() };
  }

  function registerRoutes(app) {
    registerRadioRoutes(app, {
      addAudioFile,
      deleteAudioFile,
      getAvailableTracks,
      getAvailableDiscs,
      createExternalDisc,
      getSnapshot,
      moveTrack,
      setCurrentTrack,
      setPlaybackState,
      setPlaylist,
      stream,
      resolveAudioFile,
      externalLibrary,
      getStorageConfiguration,
      saveStorageConfiguration,
      maxAudioFileSize,
    });
  }

  if (externalLibrary?.getServerUrl()) {
    getAvailableTracks().catch((error) => { externalError = error.message; });
  }

  return {
    getSnapshot,
    registerRoutes,
    close() {},
  };
}

module.exports = { createRadioModule };
