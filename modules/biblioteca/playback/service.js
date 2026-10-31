const fs = require('node:fs');
const path = require('node:path');

function createPlaybackService({ playerStatePath, schedulesPath, listDiscs, logger = console }) {
  let playerState = { queue: [], currentIndex: null, isPlaying: false, repeat: true };
  let schedules = [];

  if (fs.existsSync(schedulesPath)) {
    const savedSchedules = JSON.parse(fs.readFileSync(schedulesPath, 'utf8'));
    if (!Array.isArray(savedSchedules)) throw new Error('La programación de canciones no es válida.');
    schedules = savedSchedules;
  }

  function saveSchedules(nextSchedules) {
    fs.mkdirSync(path.dirname(schedulesPath), { recursive: true });
    fs.writeFileSync(schedulesPath, JSON.stringify(nextSchedules, null, 2));
    schedules = nextSchedules;
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

  function removeTracks(trackIds) {
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

  return {
    getPlayerSnapshot,
    getPlayerState: () => playerState,
    getSchedules: () => schedules,
    mergeImportedState,
    movePlayerTrack,
    playScheduledTrack,
    processDueSchedules,
    removeTracks,
    saveSchedules,
    setCurrentTrack,
    setPlaybackState,
    updatePlayerPlaylist,
    validateSchedules,
  };
}

module.exports = { createPlaybackService };
