const { createTikTokMonitorService } = require('./tiktokMonitorService');
const { eventLabels, eventNames } = require('./eventConfig');
const { translateGiftName } = require('./giftTranslationService');
const fs = require('node:fs');
const path = require('node:path');
const { registerTikTokRoutes } = require('./routes');

const maxEvents = 500;

function createTikTokModule({
  stream,
  monitorService = createTikTokMonitorService(),
  configurationPath = process.env.WEBSERVER_CONFIG_PATH || path.join(__dirname, '..', '..', 'data', 'monitor-config.json'),
  defaultUsername = process.env.TIKTOK_USERNAME || 'hnaevalopez',
} = {}) {
  if (!stream || typeof stream.attach !== 'function' || typeof stream.broadcast !== 'function') {
    throw new Error('El módulo TikTok necesita su canal de eventos.');
  }
  const { events: availableEvents, labels: availableLabels, enabled } = monitorService.getAvailableEventsPayload();
  const enabledEvents = new Set(enabled);
  const eventHistory = [];
  const events = [];
  let ignoredEvents = new Set();
  const environmentUsername = process.env.TIKTOK_USERNAME?.trim().replace(/^@+/, '');
  const normalizedDefaultUsername = String(defaultUsername || 'hnaevalopez').trim().replace(/^@+/, '');
  let configuration = { username: environmentUsername || normalizedDefaultUsername, saved: false };

  try {
    const savedConfiguration = JSON.parse(fs.readFileSync(configurationPath, 'utf8'));
    if (typeof savedConfiguration.username !== 'string' || !Array.isArray(savedConfiguration.ignoredEvents)
      || (savedConfiguration.usernameConfigured !== undefined
        && typeof savedConfiguration.usernameConfigured !== 'boolean')
      || savedConfiguration.ignoredEvents.some((eventName) => typeof eventName !== 'string')) {
      throw new Error('La configuración guardada del servidor no es válida.');
    }
    const hasExplicitUsername = savedConfiguration.usernameConfigured === true;
    configuration = {
      username: environmentUsername
        || (hasExplicitUsername ? savedConfiguration.username.trim() : normalizedDefaultUsername),
      saved: true,
    };
    ignoredEvents = new Set(savedConfiguration.ignoredEvents);
    if (!environmentUsername && !hasExplicitUsername) {
      fs.writeFileSync(configurationPath, JSON.stringify({
        username: normalizedDefaultUsername,
        ignoredEvents: savedConfiguration.ignoredEvents,
        usernameConfigured: false,
      }, null, 2));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (configuration.saved) {
    enabledEvents.clear();
    for (const eventName of availableEvents) {
      if (!ignoredEvents.has(eventName)) enabledEvents.add(eventName);
    }
    monitorService.setEnabledEvents([...enabledEvents]);
  }

  const state = {
    connected: Boolean(monitorService.state.isConnected),
    status: monitorService.state.status,
    monitorStatus: monitorService.state.status,
    monitorError: monitorService.state.error || '',
    error: '',
    eventTypes: [...enabledEvents].filter((eventName) => !ignoredEvents.has(eventName)).length,
    username: configuration.username,
    lastEventAt: null,
  };

  function publish(event, payload) {
    stream.broadcast(event, payload);
  }

  function applyEventFilter(publishSnapshot = true) {
    events.splice(0, events.length, ...eventHistory
      .filter((entry) => enabledEvents.has(entry.type) && !ignoredEvents.has(entry.type)));
    state.eventTypes = [...enabledEvents].filter((eventName) => !ignoredEvents.has(eventName)).length;
    if (publishSnapshot) publish('snapshot', events);
    publish('status', { ...state });
  }

  function handleTikTokEvent(entry) {
    if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') return;

    eventHistory.unshift(entry);
    eventHistory.length = Math.min(eventHistory.length, maxEvents);
    state.lastEventAt = entry.time || new Date().toISOString();
    if (!enabledEvents.has(entry.type) || ignoredEvents.has(entry.type)) return;

    events.unshift(entry);
    events.length = Math.min(events.length, maxEvents);
    publish('update', { entry, events });
  }

  const unsubscribeEvents = monitorService.subscribeToEvents(handleTikTokEvent);
  const unsubscribeStatus = monitorService.subscribeToStatus((monitorStatus) => {
    state.connected = monitorStatus.isConnected;
    state.status = monitorStatus.status;
    state.monitorStatus = monitorStatus.status;
    state.monitorError = monitorStatus.error || '';
    state.error = monitorStatus.error || '';
    state.username = monitorStatus.username || '';
    publish('status', { ...state });
  });

  function getConfiguration() {
    return {
      username: configuration.username,
      ignoredEvents: [...ignoredEvents],
      events: availableEvents.map((name) => ({
        name,
        label: availableLabels[name] || name,
        enabled: enabledEvents.has(name),
      })).sort((first, second) => Number(second.enabled) - Number(first.enabled)),
    };
  }

  function saveConfiguration(body) {
    const username = typeof body?.username === 'string'
      ? body.username.trim().replace(/^@+/, '')
      : '';
    const submittedIgnoredEvents = body?.ignoredEvents;
    if (!username || !Array.isArray(submittedIgnoredEvents)
      || submittedIgnoredEvents.some((name) => typeof name !== 'string' || !availableEvents.includes(name))) {
      return { ok: false, message: 'Revisa el usuario y los eventos ignorados.' };
    }

    const uniqueIgnoredEvents = [...new Set(submittedIgnoredEvents)];
    enabledEvents.clear();
    for (const eventName of availableEvents) {
      if (!uniqueIgnoredEvents.includes(eventName)) enabledEvents.add(eventName);
    }
    monitorService.setEnabledEvents([...enabledEvents]);
    const savedConfiguration = { username, ignoredEvents: uniqueIgnoredEvents, usernameConfigured: true };
    fs.mkdirSync(path.dirname(configurationPath), { recursive: true });
    fs.writeFileSync(configurationPath, JSON.stringify(savedConfiguration, null, 2));
    configuration = { username, saved: true };
    ignoredEvents = new Set(uniqueIgnoredEvents);
    applyEventFilter();
    monitorService.connectUser(username);
    return { ok: true, username, ignoredEvents: uniqueIgnoredEvents };
  }

  function reconnectConfiguredUser() {
    if (!configuration.username) {
      return { ok: false, status: 409, message: 'Primero configura un usuario de TikTok en el panel de administración.' };
    }
    if (monitorService.state.isConnected
      || ['connecting', 'reconnecting'].includes(monitorService.state.status)) {
      return { ok: false, status: 409, message: 'La conexión ya está activa o intentando conectarse.' };
    }
    monitorService.connectUser(configuration.username);
    return { ok: true, username: configuration.username };
  }

  function getStatus() {
    return {
      ...state,
      configuredUsername: configuration.username,
      eventCount: events.length,
      connector: monitorService.getStatusPayload(),
    };
  }

  function openEventStream(response) {
    stream.attach(response, [
      ['status', { ...state }],
      ['snapshot', events],
    ]);
  }

  function registerRoutes(app) {
    registerTikTokRoutes(app, {
      getStatus,
      getConfiguration,
      saveConfiguration,
      reconnectConfiguredUser,
      openEventStream,
    });
  }

  if (configuration.username) monitorService.connectUser(configuration.username);

  return {
    monitorService,
    registerRoutes,
    close() {
      unsubscribeEvents();
      unsubscribeStatus();
      monitorService.disconnectUser();
    },
  };
}

module.exports = {
  createTikTokModule,
  createTikTokMonitorService,
  eventLabels,
  eventNames,
  translateGiftName,
};
