const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWebserver } = require('../../server');

test('radio root is installable as the Radio PWA', async () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-pwa-'));
  const { server } = createWebserver({ dataDirectory });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const pageResponse = await fetch(`${baseUrl}/`);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(page, /serviceWorker\.register\('\/service-worker\.js'\)/);

    const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.name, 'Radio');
    assert.equal(manifest.short_name, 'Radio');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');

    const workerResponse = await fetch(`${baseUrl}/service-worker.js`);
    assert.equal(workerResponse.status, 200);
    assert.match(await workerResponse.text(), /addEventListener\('fetch'/);
    for (const size of [192, 512]) {
      assert.equal((await fetch(`${baseUrl}/icons/icon-${size}.png`)).status, 200);
    }
  } finally {
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});
