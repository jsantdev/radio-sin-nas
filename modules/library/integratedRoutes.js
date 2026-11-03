const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream');
const { Readable } = require('node:stream');

function registerIntegratedLibrary(app, libraryServer, libraryPort, externalLibrary) {
  const libraryPublicDirectory = path.resolve(__dirname, '..', '..', 'public', 'biblioteca');
  const libraryIconNames = new Set(['icon-192.png', 'icon-512.png']);
  let libraryServerError = null;
  libraryServer.on('error', (error) => {
    libraryServerError = error;
  });

  app.use('/biblioteca', async (request, response, next) => {
    if (!externalLibrary || externalLibrary.isLocalServer()) {
      next();
      return;
    }

    const requestUrl = new URL(request.originalUrl, 'http://localhost');
    const pathname = requestUrl.pathname.slice('/biblioteca'.length) || '/';
    const allowedPath = pathname === '/' || pathname === '/datos'
      || ['/dashboard.css', '/manifest.webmanifest', '/service-worker.js'].includes(pathname)
      || /^\/icons\/icon-(?:192|512)\.png$/.test(pathname)
      || /^\/api\/(?:health$|admin\/|migrations(?:\/|$)|imports(?:\/|$)|player\/|schedules$|discs$|tracks$|audio$)/
        .test(pathname);
    if (!allowedPath || !externalLibrary.getServerUrl()
      || typeof externalLibrary.proxyRequest !== 'function') {
      response.status(404).end();
      return;
    }

    try {
      const headers = {};
      for (const name of ['accept', 'content-length', 'content-type', 'if-none-match', 'range', 'x-file-name']) {
        const value = request.headers[name];
        if (value) headers[name] = value;
      }
      const upstream = await externalLibrary.proxyRequest(`${pathname}${requestUrl.search}`, {
        method: request.method,
        headers,
        ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: request }),
        ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { duplex: 'half' }),
      });

      const contentType = upstream.headers.get('content-type') || '';
      if (pathname === '/api/admin/config' && upstream.ok && externalLibrary.isAdminTokenConfigured()) {
        const configuration = await upstream.json();
        const sessionResponse = await externalLibrary.proxyRequest('/api/admin/session');
        const session = sessionResponse.ok ? await sessionResponse.json() : { authenticated: false };
        response.status(upstream.status).set('Cache-Control', 'no-store').json({
          ...configuration,
          proxyAuthenticated: session.authenticated === true,
        });
        return;
      }
      if (pathname === '/manifest.webmanifest' && upstream.ok) {
        const manifest = await upstream.json();
        response.status(upstream.status).type('application/manifest+json').json({
          ...manifest,
          id: '/biblioteca/',
          start_url: '/biblioteca/',
          scope: '/biblioteca/',
          icons: Array.isArray(manifest.icons)
            ? manifest.icons.map((icon) => ({ ...icon, src: `/biblioteca${icon.src}` }))
            : [],
        });
        return;
      }
      if (contentType.includes('text/html')) {
        let html = await upstream.text();
        html = html
          .replaceAll("href=\"/\"", "href=\"/biblioteca/\"")
          .replaceAll("href=\"/datos\"", "href=\"/biblioteca/datos\"")
          .replaceAll('/api/', '/biblioteca/api/')
          .replaceAll('/dashboard.css', '/biblioteca/dashboard.css')
          .replaceAll('/manifest.webmanifest', '/biblioteca/manifest.webmanifest')
          .replaceAll('/icons/', '/biblioteca/icons/')
          .replace("register('/service-worker.js')", "register('/biblioteca/service-worker.js')");
        response.status(upstream.status).type('html').send(html);
        return;
      }
      if (pathname === '/service-worker.js') {
        let worker = await upstream.text();
        worker = worker
          .replaceAll("['/',", "['/biblioteca/',")
          .replaceAll("'/dashboard.css'", "'/biblioteca/dashboard.css'")
          .replaceAll("'/manifest.webmanifest'", "'/biblioteca/manifest.webmanifest'")
          .replaceAll("'/icons/", "'/biblioteca/icons/")
          .replaceAll("caches.put('/', copy)", "caches.put('/biblioteca/', copy)")
          .replaceAll("caches.match('/')", "caches.match('/biblioteca/')")
          .replace("url.pathname.startsWith('/api/')", "url.pathname.startsWith('/biblioteca/api/')");
        response.status(upstream.status).type('application/javascript')
          .set('Cache-Control', 'no-cache').send(worker);
        return;
      }

      for (const name of ['accept-ranges', 'cache-control', 'content-disposition', 'content-length',
        'content-range', 'content-type', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name);
        if (value) response.set(name, value);
      }
      response.status(upstream.status);
      if (!upstream.body) {
        response.end();
        return;
      }
      pipeline(Readable.fromWeb(upstream.body), response, (error) => {
        if (error && !response.headersSent) next(error);
      });
    } catch (error) {
      next(error);
    }
  });

  app.get(['/biblioteca', '/biblioteca/'], (request, response, next) => {
    fs.readFile(path.join(libraryPublicDirectory, 'index.html'), 'utf8', (error, html) => {
      if (error) {
        next(error);
        return;
      }
      response.type('html').send(html
        .replaceAll('/manifest.webmanifest', '/biblioteca/manifest.webmanifest')
        .replaceAll('/dashboard.css', '/biblioteca/dashboard.css')
        .replaceAll('/icons/', '/biblioteca/icons/')
        .replace("register('/service-worker.js')", "register('/biblioteca/service-worker.js')"));
    });
  });

  app.get(['/biblioteca/datos', '/biblioteca/datos/'], (request, response, next) => {
    fs.readFile(path.join(libraryPublicDirectory, 'datos.html'), 'utf8', (error, html) => {
      if (error) {
        next(error);
        return;
      }
      response.type('html').send(html
        .replaceAll('href="/"', 'href="/biblioteca/"')
        .replaceAll('href="/datos"', 'href="/biblioteca/datos"')
        .replaceAll('/dashboard.css', '/biblioteca/dashboard.css'));
    });
  });

  app.get('/biblioteca/dashboard.css', (request, response, next) => {
    response.sendFile(path.resolve(__dirname, '..', '..', 'public', 'dashboard.css'), (error) => {
      if (error) next(error);
    });
  });

  app.get('/biblioteca/manifest.webmanifest', (request, response, next) => {
    fs.readFile(path.join(libraryPublicDirectory, 'manifest.webmanifest'), 'utf8', (error, contents) => {
      if (error) {
        next(error);
        return;
      }
      try {
        const manifest = JSON.parse(contents);
        manifest.id = '/biblioteca/';
        manifest.start_url = '/biblioteca/';
        manifest.scope = '/biblioteca/';
        manifest.icons = manifest.icons.map((icon) => ({
          ...icon,
          src: `/biblioteca${icon.src}`,
        }));
        response.type('application/manifest+json').send(manifest);
      } catch (parseError) {
        next(parseError);
      }
    });
  });

  app.get('/biblioteca/service-worker.js', (request, response, next) => {
    fs.readFile(path.join(libraryPublicDirectory, 'service-worker.js'), 'utf8', (error, contents) => {
      if (error) {
        next(error);
        return;
      }
      response.type('application/javascript').set('Cache-Control', 'no-cache').send(contents
        .replaceAll("['/',", "['/biblioteca/',")
        .replaceAll("'/dashboard.css'", "'/biblioteca/dashboard.css'")
        .replaceAll("'/manifest.webmanifest'", "'/biblioteca/manifest.webmanifest'")
        .replaceAll("'/icons/", "'/biblioteca/icons/")
        .replaceAll("caches.put('/', copy)", "caches.put('/biblioteca/', copy)")
        .replaceAll("caches.match('/')", "caches.match('/biblioteca/')"));
    });
  });

  app.get('/biblioteca/icons/:filename', (request, response, next) => {
    if (!libraryIconNames.has(request.params.filename)) {
      response.status(404).end();
      return;
    }
    response.sendFile(path.join(libraryPublicDirectory, 'icons', request.params.filename), (error) => {
      if (error) next(error);
    });
  });

  app.use((request, response, next) => {
    if (!/^\/api\/(?:health$|admin\/|migrations(?:\/|$)|player\/|schedules$|discs$|tracks$|audio$)/
      .test(request.path)) {
      next();
      return;
    }

    const forwardRequest = () => {
      const target = http.request({
        host: '127.0.0.1',
        port: libraryPort,
        method: request.method,
        path: request.originalUrl,
        headers: {
          ...request.headers,
          host: `127.0.0.1:${libraryPort}`,
          'x-radio-client-address': request.socket.remoteAddress || '',
        },
      }, (upstream) => {
        response.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(response);
      });
      target.on('error', (error) => {
        if (response.headersSent) {
          response.destroy(error);
          return;
        }
        response.status(502).json({ ok: false, message: `No se pudo conectar con Biblioteca: ${error.message}` });
      });
      request.pipe(target);
      response.on('close', () => {
        if (!response.writableEnded) target.destroy();
      });
    };

    if (libraryServerError) {
      response.status(502).json({ ok: false, message: `No se pudo iniciar Biblioteca: ${libraryServerError.message}` });
      return;
    }
    if (libraryServer.listening) {
      forwardRequest();
      return;
    }
    libraryServer.once('listening', forwardRequest);
    libraryServer.once('error', (error) => response.status(502).json({
      ok: false,
      message: `No se pudo iniciar Biblioteca: ${error.message}`,
    }));
  });
}

module.exports = { registerIntegratedLibrary };
