const fs = require('node:fs');
const path = require('node:path');
const { registerRadioRoutes } = require('./routes');

const audioExtensions = new Set(['.aac', '.m4a', '.mp3', '.ogg', '.opus', '.wav']);
const maxAudioFileSize = 100 * 1024 * 1024;

function createRadioModule({
  stream,
  audioDirectory = path.join(__dirname, '..', '..', 'data', 'music'),
  playlistPath = path.join(__dirname, '..', '..', 'data', 'radio-playlist.json'),
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

  if (queue.some((filename) => !resolveAudioFile(filename))) {
    throw new Error('La playlist guardada contiene archivos de audio inexistentes o no válidos.');
  }

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
    const tracks = queue.map(formatTrack);
    return {
      status: tracks.length ? 'ready' : 'empty',
      audioSource: 'local-files',
      isPlaying,
      currentIndex,
      currentTrack: currentIndex === null ? null : tracks[currentIndex],
      queue: tracks,
    };
  }

  function getAvailableTracks() {
    return fs.readdirSync(audioDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isSupportedAudio(entry.name))
      .map((entry) => formatTrack(entry.name))
      .sort((first, second) => first.name.localeCompare(second.name, 'es'));
  }

  function saveQueue(nextQueue) {
    fs.mkdirSync(path.dirname(playlistPath), { recursive: true });
    fs.writeFileSync(playlistPath, JSON.stringify(nextQueue, null, 2));
    queue = nextQueue;
  }

  function publish() {
    stream.broadcast('update', getSnapshot());
  }

  function setPlaylist(submittedTracks) {
    if (!Array.isArray(submittedTracks)
      || submittedTracks.some((filename) => typeof filename !== 'string')
      || new Set(submittedTracks).size !== submittedTracks.length
      || submittedTracks.some((filename) => !resolveAudioFile(filename))) {
      return { ok: false, status: 400, message: 'La playlist debe incluir archivos de audio locales válidos y sin duplicados.' };
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

  function addAudioFile(filename, contents) {
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

  function deleteAudioFile(filename) {
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
      getSnapshot,
      moveTrack,
      setCurrentTrack,
      setPlaybackState,
      setPlaylist,
      stream,
      resolveAudioFile,
      maxAudioFileSize,
    });
  }

  return {
    getSnapshot,
    registerRoutes,
    close() {},
  };
}

module.exports = { createRadioModule };
