const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function registerIntegratedLibrary(app, libraryServer, libraryPort) {
  const libraryPublicDirectory = path.resolve(__dirname, '..', '..', 'public', 'biblioteca');
  const libraryIconNames = new Set(['icon-192.png', 'icon-512.png']);
  let libraryServerError = null;
  libraryServer.on('error', (error) => {
    libraryServerError = error;
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
