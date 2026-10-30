function createSseHub({ heartbeatIntervalMs = 25000 } = {}) {
  const clients = new Set();
  const heartbeatTimers = new Map();

  function broadcast(event, payload) {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      if (client.writableEnded || client.destroyed) {
        clients.delete(client);
        const timer = heartbeatTimers.get(client);
        if (timer) clearInterval(timer);
        heartbeatTimers.delete(client);
      }
      else client.write(message);
    }
  }

  function attach(response, initialMessages = []) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    clients.add(response);
    const heartbeat = setInterval(() => {
      if (response.writableEnded || response.destroyed) {
        clearInterval(heartbeat);
        heartbeatTimers.delete(response);
        clients.delete(response);
        return;
      }
      response.write(': keep-alive\n\n');
    }, heartbeatIntervalMs);
    heartbeat.unref?.();
    heartbeatTimers.set(response, heartbeat);
    initialMessages.forEach(([event, payload]) => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    });
    response.on('close', () => {
      clients.delete(response);
      clearInterval(heartbeatTimers.get(response));
      heartbeatTimers.delete(response);
    });
  }

  function close() {
    for (const client of clients) {
      clearInterval(heartbeatTimers.get(client));
      client.end();
    }
    clients.clear();
    heartbeatTimers.clear();
  }

  return { attach, broadcast, close };
}

module.exports = { createSseHub };
