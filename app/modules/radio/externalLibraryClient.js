const fs = require('node:fs');
const path = require('node:path');

const audioExtensions = new Set(['.aac', '.m4a', '.mp3', '.ogg', '.opus', '.wav']);

function createExternalLibraryClient({
  configurationPath = path.join(__dirname, '..', '..', 'data', 'external-library-config.json'),
  fetchImpl = globalThis.fetch,
} = {}) {
  let serverUrl = '';
  if (fs.existsSync(configurationPath)) {
    const savedConfiguration = JSON.parse(fs.readFileSync(configurationPath, 'utf8'));
    if (!savedConfiguration || typeof savedConfiguration.serverUrl !== 'string') {
      throw new Error('La configuración del servidor de biblioteca externo no es válida.');
    }
    serverUrl = validateServerUrl(savedConfiguration.serverUrl);
  }

  function validateServerUrl(value) {
    if (typeof value !== 'string') {
      throw new Error('La URL del servidor de biblioteca debe ser texto.');
    }
    const trimmedUrl = value.trim();
    if (!trimmedUrl) return '';

    let parsedUrl;
    try {
      parsedUrl = new URL(trimmedUrl);
    } catch {
      throw new Error('Ingresa una URL válida para el servidor de biblioteca.');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)
      || parsedUrl.username || parsedUrl.password) {
      throw new Error('La URL del servidor debe usar HTTP o HTTPS y no incluir credenciales.');
    }
    return parsedUrl.href.replace(/\/+$/, '');
  }

  function setServerUrl(value) {
    const nextServerUrl = validateServerUrl(value);
    fs.mkdirSync(path.dirname(configurationPath), { recursive: true });
    fs.writeFileSync(configurationPath, JSON.stringify({ serverUrl: nextServerUrl }, null, 2));
    serverUrl = nextServerUrl;
    return { serverUrl };
  }

  async function request(url, options = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('No está disponible el cliente HTTP para conectar con la biblioteca externa.');
    }
    try {
      return await fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw new Error(`No se pudo conectar con el servidor de biblioteca: ${error.message}`);
    }
  }

  async function fetchDiscs() {
    if (!serverUrl) return [];
    const response = await request(`${serverUrl}/api/discs`);
    if (!response.ok) throw new Error(`El servidor de biblioteca respondió HTTP ${response.status}.`);

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('El servidor de biblioteca no devolvió JSON válido.');
    }
    if (!payload || !Array.isArray(payload.discs) || payload.discs.length > 500) {
      throw new Error('La respuesta de biblioteca debe incluir una lista válida de discos.');
    }

    const ids = new Set();
    let trackCount = 0;
    return payload.discs.map((disc) => {
      if (!disc || typeof disc.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(disc.id)
        || ids.has(disc.id) || typeof disc.name !== 'string' || !disc.name.trim()
        || !Array.isArray(disc.tracks)) {
        throw new Error('Cada disco debe incluir un identificador y una lista de temas válidos.');
      }
      ids.add(disc.id);
      const trackIds = new Set();
      const tracks = disc.tracks.map((track) => {
        trackCount += 1;
        if (trackCount > 5000 || !track || typeof track.id !== 'string'
          || track.id !== `${disc.id}/${track.name}` || trackIds.has(track.id)
          || typeof track.name !== 'string' || track.name !== path.basename(track.name)
          || track.name.includes('/') || track.name.includes('\\') || track.name.startsWith('.')
          || !audioExtensions.has(path.extname(track.name).toLowerCase())
          || typeof track.title !== 'string' || !track.title.trim()
          || track.discId !== disc.id || typeof track.discName !== 'string') {
          throw new Error('El servidor devolvió un tema inválido o repetido.');
        }
        trackIds.add(track.id);
        return {
          id: track.id,
          name: track.name,
          title: track.title.trim(),
          discId: disc.id,
          discName: track.discName.trim() || disc.name.trim(),
        };
      });
      return { id: disc.id, name: disc.name.trim(), tracks };
    });
  }

  async function createDisc(name) {
    if (!serverUrl) throw new Error('Configura primero la URL del servidor de biblioteca.');
    const response = await request(`${serverUrl}/api/discs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('El servidor de biblioteca no devolvió JSON válido.');
    }
    if (!response.ok) {
      const error = new Error(payload.message || `El servidor de biblioteca respondió HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    if (!payload.disc || typeof payload.disc.id !== 'string'
      || typeof payload.disc.name !== 'string' || typeof payload.created !== 'boolean') {
      throw new Error('El servidor de biblioteca no devolvió un disco válido.');
    }
    return payload;
  }

  async function uploadTrack(discName, filename, contents) {
    if (!serverUrl) throw new Error('Configura primero la URL del servidor de biblioteca.');
    const url = new URL(`${serverUrl}/api/tracks`);
    url.searchParams.set('disc', discName);
    const response = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(filename),
      },
      body: contents,
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('El servidor de biblioteca no devolvió JSON válido.');
    }
    if (!response.ok) throw new Error(payload.message || `El servidor de biblioteca respondió HTTP ${response.status}.`);
    return payload.track;
  }

  async function deleteTrack(id) {
    if (!serverUrl) throw new Error('Configura primero la URL del servidor de biblioteca.');
    const url = new URL(`${serverUrl}/api/tracks`);
    url.searchParams.set('id', id);
    const response = await request(url, { method: 'DELETE' });
    if (!response.ok) {
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        throw new Error('El servidor de biblioteca no devolvió JSON válido.');
      }
      const error = new Error(payload.message || `El servidor de biblioteca respondió HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
  }

  async function fetchTrack(id, range) {
    if (!serverUrl) throw new Error('Configura primero la URL del servidor de biblioteca.');
    const url = new URL(`${serverUrl}/api/audio`);
    url.searchParams.set('id', id);
    const response = await request(url, { headers: range ? { Range: range } : {} });
    if (!response.ok) {
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        throw new Error('El servidor de biblioteca no devolvió JSON válido.');
      }
      const error = new Error(payload.message || `El servidor de biblioteca respondió HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return response;
  }

  return {
    fetchDiscs,
    fetchTrack,
    createDisc,
    getServerUrl: () => serverUrl,
    setServerUrl,
    uploadTrack,
    deleteTrack,
  };
}

module.exports = { createExternalLibraryClient };
