const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { ControlEvent, WebcastEvent } = require('tiktok-live-connector');
const { eventNames } = require('../modules/tiktok/eventConfig');
const { createEventFeedStore } = require('../modules/tiktok/eventFeedService');
const { createTikTokMonitorService } = require('../modules/tiktok/tiktokMonitorService');

function createTimers() {
  let nextId = 0;
  const pending = new Map();
  return {
    pending,
    schedule(callback, delay) {
      const id = ++nextId;
      pending.set(id, { callback, delay });
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
    fire(id = pending.keys().next().value) {
      const timer = pending.get(id);
      assert.ok(timer, `Timer ${id} is not scheduled`);
      pending.delete(id);
      timer.callback();
      return timer.delay;
    },
  };
}

class FakeConnection extends EventEmitter {
  static instances = [];
  static connectBehavior = 'resolve';
  static disconnectBehavior = 'resolve';

  constructor(username, options) {
    super();
    this.username = username;
    this.options = options;
    this.disconnected = false;
    FakeConnection.instances.push(this);
  }

  connect() {
    if (FakeConnection.connectBehavior === 'throw') throw new Error('connect threw');
    if (FakeConnection.connectBehavior === 'reject') return Promise.reject(new Error('connect rejected'));
    if (FakeConnection.connectBehavior === 'pending') return new Promise(() => {});
    return Promise.resolve();
  }

  disconnect() {
    this.disconnected = true;
    if (FakeConnection.disconnectBehavior === 'throw') throw new Error('disconnect threw');
    if (FakeConnection.disconnectBehavior === 'reject') return Promise.reject(new Error('disconnect rejected'));
    return Promise.resolve();
  }
}

function createMonitor(options = {}) {
  FakeConnection.instances = [];
  FakeConnection.connectBehavior = 'resolve';
  FakeConnection.disconnectBehavior = 'resolve';
  const timers = createTimers();
  const monitor = createTikTokMonitorService({
    TikTokLiveConnectionClass: FakeConnection,
    scheduleTimeout: timers.schedule,
    cancelTimeout: timers.cancel,
    ...options,
  });
  return { monitor, timers };
}

test('monitor validates timing and subscription contracts', () => {
  for (const options of [
    { retryBaseDelayMs: 0 },
    { retryMaxDelayMs: Infinity },
    { connectTimeoutMs: -1 },
    { maxConnectionAttempts: 1.5 },
  ]) {
    assert.throws(() => createTikTokMonitorService(options), /números positivos/);
  }

  const { monitor } = createMonitor();
  assert.throws(() => monitor.subscribeToEvents(null), /suscriptor de eventos/);
  assert.throws(() => monitor.subscribeToStatus(null), /suscriptor de estado/);
  assert.throws(() => monitor.connectUser('  '), /indicar un usuario/);
  assert.deepEqual(monitor.setEnabledEvents(null), []);
  assert.deepEqual(monitor.getAvailableEventsPayload().enabled, []);
  monitor.disconnectUser();
});

test('monitor normalizes every webcast event and event payload shape', async () => {
  const { monitor } = createMonitor();
  const received = [];
  const statuses = [];
  const unsubscribe = monitor.subscribeToEvents((entry) => received.push(entry));
  monitor.subscribeToStatus((status) => statuses.push(status));
  monitor.setEnabledEvents(eventNames);
  monitor.connectUser('@@battlehost');
  const connection = FakeConnection.instances[0];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(monitor.state.status, 'connected');
  assert.equal(connection.username, 'battlehost');
  assert.equal(connection.options.processInitialData, true);

  const cases = [
    [WebcastEvent.CHAT, { user: { uniqueId: 'ana', profilePictureUrl: 'avatar' }, comment: 'Hola' }],
    [WebcastEvent.CHAT, { user: 'chat-user', content: 'contenido' }],
    [WebcastEvent.CHAT, { text: 'texto' }],
    [WebcastEvent.CHAT, { displayText: 'display' }],
    [WebcastEvent.CHAT, {}],
    [WebcastEvent.GIFT, { user: { nickname: 'gift-user' }, giftName: 'Rose', repeatCount: 2, diamondCount: 3 }],
    [WebcastEvent.GIFT, { sender: { displayName: 'sender' }, gift: { name: 'Lion', diamond_count: 7 }, comboCount: 3 }],
    [WebcastEvent.GIFT, { giftDetails: { giftName: 'Whale Diving', diamondCount: 5 } }],
    [WebcastEvent.GIFT, { giftName: 'unknown', repeatCount: 0, diamonds: 0 }],
    [WebcastEvent.LIKE, { user: { uniqueId: 'liker' }, likeCount: 5, incrementalLikeCount: 2 }],
    [WebcastEvent.LIKE, { totalLikeCount: 10 }],
    [WebcastEvent.LIKE, {}],
    [WebcastEvent.FOLLOW, { user: { nickname: 'follower' }, followCount: 1 }],
    [WebcastEvent.SHARE, { user: { uniqueId: 'sharer' } }],
    [WebcastEvent.MEMBER, { user: { uniqueId: 'joiner', avatarThumb: { urlList: ['member.png'] } } }],
    [WebcastEvent.MEMBER, {}],
    [WebcastEvent.ROOM_USER, { totalUser: 10, roomUserCount: 8, viewerCount: 7, total: 5 }],
    [WebcastEvent.ROOM_USER, { roomUserCount: 8 }],
    [WebcastEvent.ROOM_USER, { viewerCount: 7 }],
    [WebcastEvent.ROOM_USER, { total: 5 }],
    [WebcastEvent.ROOM_USER, {}],
    [eventNames.at(-1), { comment: 'summary comment', user: 'commenter' }],
    [eventNames.at(-1), { gift: { name: 'gift-summary' }, sender: 'sender' }],
    [eventNames.at(-1), { followerCount: 1, user: 'follow-summary' }],
    [eventNames.at(-1), { likeCount: 4 }],
    [eventNames.at(-1), { viewerCount: 3 }],
    [eventNames.at(-1), {}],
  ];

  for (const [eventName, payload] of cases) connection.emit(eventName, payload);
  assert.equal(received.length, cases.length);
  assert.equal(received[0].username, 'ana');
  assert.equal(received[0].avatar, 'avatar');
  assert.equal(received[0].content, 'Hola');
  assert.equal(received[5].activityCount, 2);
  assert.equal(received[5].diamondCount, 3);
  assert.match(received[5].content, /Rosa x2/);
  assert.equal(received[6].diamondCount, 7);
  assert.equal(received[14].avatar, 'member.png');
  assert.equal(received[15].username, 'Sistema');
  assert.equal(monitor.state.recentJoiners.length, 1);
  assert.equal(monitor.getEventFeed().length, cases.length);
  assert.equal(monitor.getStatusPayload('server-1').serverInstanceId, 'server-1');
  assert.ok(statuses.length > 0);

  monitor.setEnabledEvents(['not-a-real-event']);
  const count = received.length;
  connection.emit(WebcastEvent.CHAT, { comment: 'not delivered' });
  assert.equal(received.length, count);
  unsubscribe();
  monitor.disconnectUser();
  assert.equal(monitor.state.status, 'disconnected');
});

test('monitor retries rejected, thrown, and timed-out connections until the limit', async () => {
  const { monitor, timers } = createMonitor({
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 15,
    connectTimeoutMs: 5,
    maxConnectionAttempts: 4,
  });

  FakeConnection.connectBehavior = 'reject';
  monitor.connectUser('@retries');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(monitor.state.status, 'reconnecting');
  assert.equal(timers.pending.size, 1);
  FakeConnection.connectBehavior = 'throw';
  assert.equal(timers.fire(), 10);
  assert.equal(monitor.state.connectionAttempts, 2);
  FakeConnection.connectBehavior = 'pending';
  assert.equal(timers.fire(), 15);
  const timedOutConnection = FakeConnection.instances.at(-1);
  assert.equal(timers.fire(), 5);
  assert.equal(timedOutConnection.disconnected, true);
  assert.equal(monitor.state.status, 'reconnecting');
  assert.equal(timers.fire(), 15);
  const finalConnection = FakeConnection.instances.at(-1);
  assert.equal(timers.fire(), 5);
  assert.equal(finalConnection.disconnected, true);
  assert.equal(monitor.state.status, 'failed');
  assert.equal(monitor.state.connectionAttempts, 4);
  assert.equal(timers.pending.size, 0);
  monitor.disconnectUser();
});

test('monitor cancels retries, ignores stale connections, and finalizes an ended live', async () => {
  const { monitor, timers } = createMonitor();
  monitor.connectUser('first');
  const first = FakeConnection.instances[0];
  monitor.connectUser('second');
  const second = FakeConnection.instances[1];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.disconnected, true);
  assert.equal(monitor.state.username, 'second');

  first.emit(ControlEvent.ERROR, new Error('stale'));
  assert.equal(monitor.state.status, 'connected');
  second.emit(ControlEvent.DISCONNECTED);
  assert.equal(monitor.state.status, 'finalized');
  assert.equal(monitor.state.error, '');
  assert.equal(timers.pending.size, 0);
  monitor.disconnectUser();
  assert.equal(monitor.state.status, 'disconnected');
});

test('monitor handles connection constructor failures and disconnect failures', async () => {
  class ConstructorFailure {
    constructor() {
      throw new Error('constructor failed');
    }
  }
  const timers = createTimers();
  const monitor = createTikTokMonitorService({
    TikTokLiveConnectionClass: ConstructorFailure,
    scheduleTimeout: timers.schedule,
    cancelTimeout: timers.cancel,
    maxConnectionAttempts: 1,
  });
  monitor.connectUser('broken');
  assert.equal(monitor.state.status, 'failed');
  monitor.disconnectUser();

  const working = createMonitor();
  working.monitor.connectUser('disconnect-test');
  FakeConnection.disconnectBehavior = 'throw';
  working.monitor.disconnectUser();
  assert.ok(working.monitor.state.logs.some((entry) => entry.message.includes('disconnect threw')));

  FakeConnection.disconnectBehavior = 'reject';
  working.monitor.connectUser('disconnect-reject');
  working.monitor.disconnectUser();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(working.monitor.state.logs.some((entry) => entry.message.includes('disconnect rejected')));
});

test('event feed sorting is stable by priority and newest timestamp', () => {
  const store = createEventFeedStore({ priorities: { gift: 0, chat: 1 } });
  const oldChat = { type: 'chat', time: '2020-01-01T00:00:00Z' };
  const newChat = { type: 'chat', time: '2021-01-01T00:00:00Z' };
  const gift = { type: 'gift', time: '2019-01-01T00:00:00Z' };
  store.push(oldChat);
  store.push(newChat);
  store.push(gift);
  assert.deepEqual(store.getAll(), [gift, newChat, oldChat]);
  assert.equal(store.push({ type: 'unknown', time: '2022-01-01T00:00:00Z' }), 4);
  store.clear();
  assert.deepEqual(store.getAll(), []);
});
