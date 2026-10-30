function createSseHub() {
  const clients = new Set();

  function broadcast(event, payload) {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      if (client.writableEnded || client.destroyed) clients.delete(client);
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
    initialMessages.forEach(([event, payload]) => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    });
    response.on('close', () => clients.delete(response));
  }

  function close() {
    for (const client of clients) client.end();
    clients.clear();
  }

  return { attach, broadcast, close };
}

module.exports = { createSseHub };
