const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const audioExtensions = new Set(['.aac', '.m4a', '.mp3', '.ogg', '.opus', '.wav']);

function createCatalogRepository({ rootDirectory }) {
  function isAudioFileName(filename) {
    return audioExtensions.has(path.extname(filename).toLowerCase());
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
        return { id: entry.name, name: discName, tracks };
      })
      .sort((first, second) => first.name.localeCompare(second.name, 'es'));
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

  return {
    createDisc,
    getDiscId,
    getTrackPath,
    isAudioFileName,
    listDiscs,
    saveTrackMetadata,
  };
}

module.exports = { createCatalogRepository };
