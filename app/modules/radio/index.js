const { registerRadioRoutes } = require('./routes');

const emptySnapshot = {
  status: 'empty',
  audioSource: 'external-library',
  isPlaying: false,
  repeat: true,
  currentIndex: null,
  currentTrack: null,
  queue: [],
};

function createRadioModule({
  stream,
  externalLibrary,
} = {}) {
  if (!stream || typeof stream.attach !== 'function' || typeof stream.broadcast !== 'function') {
    throw new Error('El módulo de radio necesita su canal de actualizaciones.');
  }
  if (!externalLibrary) throw new Error('El módulo de radio necesita la biblioteca musical.');

  let snapshot = { ...emptySnapshot };
  let externalError = '';
  let externalConnected = false;
  let externalDiscs = [];
  let externalTracks = [];
  let refreshing = false;

  function getStorageConfiguration() {
    const serverUrl = externalLibrary.getServerUrl();
    return {
      serverUrl,
      external: Boolean(serverUrl),
      connected: Boolean(serverUrl) && externalConnected,
      error: externalError,
      discCount: externalDiscs.length,
      trackCount: externalTracks.length,
    };
  }

  async function refreshState() {
    if (refreshing) return snapshot;
    if (!externalLibrary.getServerUrl()) {
      externalConnected = false;
      externalError = 'Configura la URL de la biblioteca musical en /backend.';
      return snapshot;
    }
    refreshing = true;
    try {
      const [nextSnapshot, discs] = await Promise.all([
        externalLibrary.fetchPlaybackState(),
        externalLibrary.fetchDiscs(),
      ]);
      nextSnapshot.currentTrack = nextSnapshot.currentTrack
        ? { ...nextSnapshot.currentTrack, url: '/audio/current' }
        : null;
      nextSnapshot.queue = nextSnapshot.queue.map((track) => ({ ...track, url: '/audio/current' }));
      const changed = JSON.stringify(snapshot) !== JSON.stringify(nextSnapshot);
      snapshot = nextSnapshot;
      externalDiscs = discs;
      externalTracks = discs.flatMap((disc) => disc.tracks);
      externalError = '';
      externalConnected = true;
      if (changed) stream.broadcast('update', snapshot);
      return snapshot;
    } catch (error) {
      externalError = error.message;
      externalConnected = false;
      throw error;
    } finally {
      refreshing = false;
    }
  }

  async function saveStorageConfiguration(value) {
    let configuration;
    try {
      configuration = externalLibrary.setServerUrl(value);
    } catch (error) {
      return { ok: false, status: 400, message: error.message };
    }
    snapshot = { ...emptySnapshot };
    externalError = '';
    externalConnected = false;
    externalDiscs = [];
    externalTracks = [];
    if (!configuration.serverUrl) {
      stream.broadcast('update', snapshot);
      return { ok: true, configuration: getStorageConfiguration() };
    }
    try {
      await refreshState();
      return { ok: true, configuration: getStorageConfiguration() };
    } catch (error) {
      return {
        ok: false,
        status: error.status || 502,
        message: `La URL quedó guardada, pero no se pudo conectar: ${error.message}`,
        configuration: getStorageConfiguration(),
      };
    }
  }

  async function playerAction(action, body) {
    try {
      snapshot = await externalLibrary.playerAction(action, body);
      externalConnected = true;
      externalError = '';
      stream.broadcast('update', snapshot);
      return { ok: true, state: snapshot };
    } catch (error) {
      externalError = error.message;
      externalConnected = false;
      return { ok: false, status: error.status || 502, message: error.message };
    }
  }

  function registerRoutes(app) {
    registerRadioRoutes(app, {
      getSnapshot: () => snapshot,
      getStorageConfiguration,
      playerAction,
      refreshState,
      saveStorageConfiguration,
      stream,
      externalLibrary,
    });
  }

  if (externalLibrary.getServerUrl()) {
    refreshState().catch(() => {});
  }

  const refreshTimer = setInterval(() => {
    refreshState().catch(() => {});
  }, 2000);
  refreshTimer.unref();

  return {
    close() {
      clearInterval(refreshTimer);
    },
    getSnapshot: () => snapshot,
    registerRoutes,
  };
}

module.exports = { createRadioModule };
