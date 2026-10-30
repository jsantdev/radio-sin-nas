const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');
const { eventNames, eventLabels, defaultEnabledEvents } = require('./eventConfig');
const { createEventFeedStore } = require('./eventFeedService');
const { translateGiftName } = require('./giftTranslationService');

function createTikTokMonitorService({
  eventFeedStore = createEventFeedStore(),
  TikTokLiveConnectionClass = TikTokLiveConnection,
  webcastEvents = WebcastEvent,
  controlEvents = ControlEvent,
  retryBaseDelayMs = 1000,
  retryMaxDelayMs = 30000,
  connectTimeoutMs = 30000,
  maxConnectionAttempts = 3,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
} = {}) {
  if (!Number.isFinite(retryBaseDelayMs) || retryBaseDelayMs <= 0
    || !Number.isFinite(retryMaxDelayMs) || retryMaxDelayMs <= 0
    || !Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0
    || !Number.isInteger(maxConnectionAttempts) || maxConnectionAttempts < 1) {
    throw new Error('Los intervalos de reintento y conexión deben ser números positivos.');
  }

  const state = {
    username: '',
    status: 'idle',
    isConnected: false,
    error: '',
    lastEvent: null,
    logs: [],
    eventFeed: [],
    recentJoiners: [],
    connection: null,
    retryAttempt: 0,
    connectionAttempts: 0,
    nextRetryAt: null,
    serverInstanceId: null,
    enabledEvents: new Set(defaultEnabledEvents.filter((eventName) => eventNames.includes(eventName))),
    connectionEventListeners: new Map(),
  };
  const activityListeners = new Set();
  const statusListeners = new Set();
  let connectionGeneration = 0;
  let connectedInGeneration = false;
  let retryTimer = null;
  let connectTimer = null;

  function broadcastStatus() {
    for (const listener of statusListeners) listener({ ...state });
  }

  function addLog(message, metadata = {}) {
    const entry = {
      time: new Date().toISOString(),
      message,
      ...metadata,
    };
    state.logs.unshift(entry);
    return entry;
  }

  function updateEventFeedState() {
    state.eventFeed = eventFeedStore.getAll();
    return state.eventFeed;
  }

  function safeUserName(user) {
    if (!user) return 'usuario';
    if (typeof user === 'string') return user;
    return user.uniqueId || user.nickname || user.displayName || 'usuario';
  }

  function summarizeEvent(eventName, data) {
    if (!data || typeof data !== 'object') return `${eventName} recibido`;
    if (data.comment) return `${safeUserName(data.user)}: ${data.comment}`;
    if (data.giftName || data.gift?.name) return `${safeUserName(data.user || data.sender)} envió ${data.giftName || data.gift?.name}`;
    if (data.followCount || data.followerCount) return `${safeUserName(data.user)} siguió el live`;
    if (data.likeCount) return `Likes: ${data.likeCount}`;
    if (data.roomUserCount || data.viewerCount) return `Viewers: ${data.roomUserCount || data.viewerCount}`;
    return `${eventName} recibido`;
  }

  function eventAuthor(data) {
    const user = data && (data.user || data.sender);
    return user ? safeUserName(user) : 'Sistema';
  }

  function eventAvatar(data) {
    const user = data && (data.user || data.sender);
    if (!user || typeof user !== 'object') return '';
    const picture = user.profilePictureUrl
      || user.profilePictureUrls
      || user.avatarThumb?.urlList?.[0]
      || user.avatarThumb?.url_list?.[0]
      || '';
    return Array.isArray(picture) ? picture[0] || '' : picture;
  }

  function eventActivityCount(eventName, data) {
    if (!data || typeof data !== 'object') return undefined;
    const rawCount = eventName === webcastEvents.GIFT
      ? data.repeatCount || data.comboCount
      : eventName === webcastEvents.LIKE
        ? data.incrementalLikeCount || data.likeCount
        : undefined;
    return Number.isFinite(rawCount) && rawCount > 0 ? Math.min(100, Math.floor(rawCount)) : undefined;
  }

  function eventDiamondCount(eventName, data) {
    if (eventName !== webcastEvents.GIFT || !data || typeof data !== 'object') return undefined;
    const rawCount = data.diamondCount
      ?? data.diamonds
      ?? data.giftDetails?.diamondCount
      ?? data.giftDetails?.diamond_count
      ?? data.gift?.diamondCount
      ?? data.gift?.diamond_count;
    return Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : undefined;
  }

  function eventContent(eventName, data) {
    if (!data || typeof data !== 'object') return `${eventName} recibido`;

    if (eventName === webcastEvents.CHAT) {
      return data.comment || data.content || data.text || data.displayText || 'Envió un mensaje';
    }
    if (eventName === webcastEvents.GIFT) {
      const giftName = translateGiftName(data.giftName || data.gift?.name || data.giftDetails?.giftName);
      const repeatCount = data.repeatCount || data.comboCount;
      return giftName ? `Envió ${giftName}${repeatCount > 1 ? ` x${repeatCount}` : ''}` : 'Envió un regalo';
    }
    if (eventName === webcastEvents.LIKE) {
      const likeCount = data.likeCount || data.totalLikeCount || data.incrementalLikeCount;
      return likeCount ? `Envió ${likeCount} likes` : 'Envió likes';
    }
    if (eventName === webcastEvents.FOLLOW) return 'Siguió el live';
    if (eventName === webcastEvents.SHARE) return 'Compartió el live';
    if (eventName === webcastEvents.MEMBER) return 'Entró al live';
    if (eventName === webcastEvents.ROOM_USER) {
      const viewerCount = data.totalUser || data.roomUserCount || data.viewerCount || data.total;
      return viewerCount ? `Audiencia actual: ${viewerCount}` : 'Actualizó la audiencia';
    }

    const summary = summarizeEvent(eventName, data);
    if (summary !== `${eventName} recibido`) return summary;
    return 'Evento recibido';
  }

  function applyEventSubscriptions(connection) {
    const listeners = state.connectionEventListeners.get(connection);
    if (!listeners) return;

    for (const [eventName, listener] of listeners) {
      connection.off(eventName, listener);
      if (state.enabledEvents.has(eventName)) {
        connection.on(eventName, listener);
      }
    }
  }

  function subscribe(connection) {
    const listeners = new Map();
    for (const eventName of eventNames) {
      listeners.set(eventName, (payload) => {
        if (state.connection !== connection || !state.enabledEvents.has(eventName)) return;
        const summary = summarizeEvent(eventName, payload);
        const username = eventAuthor(payload);
        const content = eventContent(eventName, payload);
        const activityCount = eventActivityCount(eventName, payload);
        const diamondCount = eventDiamondCount(eventName, payload);

        if (eventName === webcastEvents.MEMBER && username !== 'Sistema') {
          state.recentJoiners.unshift({ username, time: new Date().toISOString() });
          state.recentJoiners = state.recentJoiners.slice(0, 10);
        }

        state.lastEvent = {
          event: eventName,
          summary,
          username,
          content,
          time: new Date().toISOString(),
          payload,
        };

        const entry = addLog(`${eventName}: ${summary}`, {
          type: eventName,
          eventLabel: eventLabels[eventName] || eventName,
          username,
          avatar: eventAvatar(payload),
          content,
          ...(activityCount === undefined ? {} : { activityCount }),
          ...(diamondCount === undefined ? {} : { diamondCount }),
        });

        for (const listener of activityListeners) listener(entry);
        eventFeedStore.push(entry);
        updateEventFeedState();
      });
    }

    state.connectionEventListeners.set(connection, listeners);
    applyEventSubscriptions(connection);
  }

  function cancelScheduledRetry() {
    if (retryTimer !== null) {
      cancelTimeout(retryTimer);
      retryTimer = null;
    }
    state.nextRetryAt = null;
  }

  function cancelConnectionTimeout() {
    if (connectTimer !== null) {
      cancelTimeout(connectTimer);
      connectTimer = null;
    }
  }

  function disconnectConnection(connection) {
    try {
      Promise.resolve(connection.disconnect()).catch((error) => {
        addLog(`No se pudo cerrar la conexión: ${error.message || error}`);
      });
    } catch (error) {
      addLog(`No se pudo cerrar la conexión: ${error.message || error}`);
    }
  }

  function scheduleReconnect(username, generation, message, failedConnection = state.connection) {
    if (generation !== connectionGeneration || retryTimer !== null) return;

    cancelConnectionTimeout();
    if (failedConnection && state.connection === failedConnection) {
      state.connectionEventListeners.delete(failedConnection);
      state.connection = null;
      disconnectConnection(failedConnection);
    }

    state.isConnected = false;
    if (message) state.error = message;
    if (state.connectionAttempts >= maxConnectionAttempts) {
      state.status = 'failed';
      state.nextRetryAt = null;
      addLog(`Se agotaron los ${maxConnectionAttempts} intentos de conexión a @${username}.`);
      broadcastStatus();
      return;
    }

    const delay = Math.min(retryBaseDelayMs * (2 ** state.retryAttempt), retryMaxDelayMs);
    state.retryAttempt += 1;
    state.nextRetryAt = new Date(Date.now() + delay).toISOString();
    state.status = 'reconnecting';
    addLog(`Se reintentará conectar a @${username} en ${Math.ceil(delay / 1000)} s (intento ${state.connectionAttempts + 1} de ${maxConnectionAttempts}).`);
    broadcastStatus();
    retryTimer = scheduleTimeout(() => {
      retryTimer = null;
      state.nextRetryAt = null;
      if (generation !== connectionGeneration) return;
      connectAttempt(username, generation);
    }, delay);
  }

  function connectAttempt(username, generation) {
    if (generation !== connectionGeneration) return;

    state.connectionAttempts += 1;
    state.status = state.retryAttempt ? 'reconnecting' : 'connecting';
    state.isConnected = false;
    broadcastStatus();
    let connection;
    try {
      connection = new TikTokLiveConnectionClass(username, {
        processInitialData: true,
        fetchRoomInfoOnConnect: true,
        enableExtendedGiftInfo: false,
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error || 'No se pudo crear la conexión');
      scheduleReconnect(username, generation, message);
      return;
    }
    state.connection = connection;
    subscribe(connection);

    const markConnected = () => {
      if (generation !== connectionGeneration || state.connection !== connection || state.isConnected) return;
      cancelConnectionTimeout();
      cancelScheduledRetry();
      state.retryAttempt = 0;
      state.status = 'connected';
      state.isConnected = true;
      state.error = '';
      connectedInGeneration = true;
      addLog(`Conectado a @${username}.`);
      broadcastStatus();
    };

    connection.on(controlEvents.CONNECTED, markConnected);
    connection.on(controlEvents.DISCONNECTED, () => {
      if (generation !== connectionGeneration || state.connection !== connection) return;
      if (connectedInGeneration) {
        cancelConnectionTimeout();
        cancelScheduledRetry();
        state.connectionEventListeners.delete(connection);
        state.connection = null;
        state.status = 'finalized';
        state.isConnected = false;
        state.retryAttempt = 0;
        state.nextRetryAt = null;
        state.error = '';
        addLog(`El directo de @${username} finalizó. No se volverá a intentar conectar.`);
        broadcastStatus();
        return;
      }
      scheduleReconnect(username, generation, state.error);
    });
    connection.on(controlEvents.ERROR, (error) => {
      if (generation !== connectionGeneration || state.connection !== connection) return;
      const message = error && error.message ? error.message : String(error || 'Error desconocido');
      scheduleReconnect(username, generation, message);
    });

    connectTimer = scheduleTimeout(() => {
      connectTimer = null;
      if (generation !== connectionGeneration || state.connection !== connection || state.isConnected) return;
      scheduleReconnect(username, generation, `Tiempo de espera agotado al conectar con @${username}.`, connection);
    }, connectTimeoutMs);

    try {
      Promise.resolve(connection.connect()).then(markConnected).catch((error) => {
        if (generation !== connectionGeneration || state.connection !== connection) return;
        const message = error && error.message ? error.message : String(error || 'No se pudo conectar');
        scheduleReconnect(username, generation, message);
      });
    } catch (error) {
      if (generation !== connectionGeneration || state.connection !== connection) return;
      const message = error && error.message ? error.message : String(error || 'No se pudo conectar');
      scheduleReconnect(username, generation, message);
    }
  }

  function connectUser(username) {
    const clean = String(username || '').trim().replace(/^@+/, '');
    if (!clean) throw new Error('Debes indicar un usuario de TikTok Live.');

    connectionGeneration += 1;
    const generation = connectionGeneration;
    connectedInGeneration = false;
    cancelScheduledRetry();
    cancelConnectionTimeout();
    state.retryAttempt = 0;
    state.connectionAttempts = 0;
    if (state.connection) {
      const previousConnection = state.connection;
      state.connection = null;
      state.connectionEventListeners.delete(previousConnection);
      disconnectConnection(previousConnection);
    }

    state.username = clean;
    state.status = 'connecting';
    state.isConnected = false;
    state.error = '';
    state.recentJoiners = [];
    addLog(`Conectando a @${clean}...`);
    broadcastStatus();
    connectAttempt(clean, generation);
  }

  function disconnectUser() {
    connectionGeneration += 1;
    connectedInGeneration = false;
    cancelScheduledRetry();
    cancelConnectionTimeout();
    state.retryAttempt = 0;
    if (!state.connection) {
      state.status = 'disconnected';
      state.isConnected = false;
      state.username = '';
      state.error = '';
      addLog('Sin conexión activa.');
      broadcastStatus();
      return;
    }

    const connection = state.connection;
    state.connection = null;
    state.connectionEventListeners.delete(connection);
    disconnectConnection(connection);
    state.status = 'disconnected';
    state.isConnected = false;
    state.username = '';
    state.error = '';
    addLog('Conexión detenida.');
    broadcastStatus();
  }

  function setEnabledEvents(enabled) {
    const nextEnabled = Array.isArray(enabled) ? enabled : [];
    state.enabledEvents = new Set(nextEnabled);
    if (state.connection) applyEventSubscriptions(state.connection);
    return [...state.enabledEvents];
  }

  function getStatusPayload(serverInstanceId) {
    return {
      serverInstanceId,
      username: state.username,
      status: state.status,
      isConnected: state.isConnected,
      error: state.error,
      retryAttempt: state.retryAttempt,
      connectionAttempts: state.connectionAttempts,
      maxConnectionAttempts,
      nextRetryAt: state.nextRetryAt,
      lastEvent: state.lastEvent,
      logs: state.logs,
      events: updateEventFeedState(),
      recentJoiners: state.recentJoiners,
      count: state.logs.length,
    };
  }

  function getAvailableEventsPayload() {
    return {
      events: eventNames,
      labels: eventLabels,
      enabled: [...state.enabledEvents],
    };
  }

  function subscribeToEvents(listener) {
    if (typeof listener !== 'function') throw new Error('El suscriptor de eventos debe ser una función.');
    activityListeners.add(listener);
    return () => activityListeners.delete(listener);
  }

  function subscribeToStatus(listener) {
    if (typeof listener !== 'function') throw new Error('El suscriptor de estado debe ser una función.');
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
  }

  return {
    state,
    connectUser,
    disconnectUser,
    setEnabledEvents,
    getStatusPayload,
    getAvailableEventsPayload,
    getEventFeed: () => updateEventFeedState(),
    subscribeToEvents,
    subscribeToStatus,
  };
}

module.exports = { createTikTokMonitorService };
