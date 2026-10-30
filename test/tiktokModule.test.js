const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { WebcastEvent } = require('tiktok-live-connector');
const { createTikTokMonitorService, translateGiftName } = require('../modules/tiktok');

class FakeTikTokConnection extends EventEmitter {
  constructor(username, options) {
    super();
    this.username = username;
    this.options = options;
  }

  connect() {
    return Promise.resolve();
  }

  disconnect() {
    return Promise.resolve();
  }
}

test('TikTok module exports gift translations and normalized events with diamond values', async () => {
  const monitor = createTikTokMonitorService({
    TikTokLiveConnectionClass: FakeTikTokConnection,
    connectTimeoutMs: 1000,
  });
  let received;
  monitor.subscribeToEvents((entry) => { received = entry; });

  monitor.connectUser('@battlehost');
  await new Promise((resolve) => setImmediate(resolve));
  const connection = monitor.state.connection;
  assert.ok(connection instanceof FakeTikTokConnection);
  assert.equal(connection.options.enableExtendedGiftInfo, false);

  connection.emit(WebcastEvent.GIFT, {
    user: { uniqueId: 'rosa-fan' },
    giftName: 'Rose',
    repeatCount: 2,
    diamondCount: 1,
  });

  assert.equal(received.username, 'rosa-fan');
  assert.equal(received.activityCount, 2);
  assert.equal(received.diamondCount, 1);
  assert.match(received.content, /Rosa/);
  assert.equal(translateGiftName('lion'), 'León');
  monitor.disconnectUser();
});
