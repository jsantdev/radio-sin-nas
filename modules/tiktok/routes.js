function registerTikTokRoutes(app, { getStatus, getConfiguration, saveConfiguration, openEventStream }) {
  app.get('/api/status', (request, response) => {
    response.json(getStatus());
  });

  app.get('/api/config', (request, response) => {
    response.json(getConfiguration());
  });

  app.put('/api/config', (request, response) => {
    const result = saveConfiguration(request.body);
    if (!result.ok) {
      response.status(400).json(result);
      return;
    }
    response.json(result);
  });

  app.get('/api/events', (request, response) => {
    openEventStream(response);
  });
}

module.exports = { registerTikTokRoutes };
