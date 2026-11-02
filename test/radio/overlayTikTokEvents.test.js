const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { eventNames } = require('../../modules/tiktok/eventConfig');

test('overlay dispatches every TikTok event to its matching live handler', () => {
  const overlay = fs.readFileSync(path.join(__dirname, '../../modules/overlay/index.html'), 'utf8');
  const start = overlay.indexOf('function initTikTokEventStream() {');
  const end = overlay.indexOf('\n    function initOperatorStream()', start);
  assert.notEqual(start, -1, 'TikTok event-stream handler exists in the overlay');
  assert.notEqual(end, -1, 'TikTok event-stream handler has a clear boundary');

  const listeners = new Map();
  const dispatched = [];
  class FakeEventSource {
    addEventListener(name, listener) {
      listeners.set(name, listener);
    }
  }
  const window = {
    onTikTokLike: (...args) => dispatched.push({ handler: 'like', args }),
    onTikTokGift: (payload) => dispatched.push({ handler: 'gift', payload }),
    onTikTokChat: (...args) => dispatched.push({ handler: 'chat', args }),
    onTikTokJoin: (...args) => dispatched.push({ handler: 'member', args }),
    onTikTokFollow: (...args) => dispatched.push({ handler: 'follow', args }),
    liveEvent: (payload) => dispatched.push({ handler: 'liveEvent', payload }),
  };
  vm.runInNewContext(`${overlay.slice(start, end)}\ninitTikTokEventStream();`, {
    EventSource: FakeEventSource,
    processedEventIds: new Set(),
    window,
  });

  const specificHandlers = new Map([
    ['like', 'like'],
    ['gift', 'gift'],
    ['chat', 'chat'],
    ['member', 'member'],
    ['follow', 'follow'],
  ]);
  for (const [index, type] of eventNames.entries()) {
    dispatched.length = 0;
    const entry = {
      id: `event-${index}`,
      type,
      username: `viewer-${index}`,
      content: type === 'gift' ? 'Envió Rosa x2' : `${type} event`,
      activityCount: 2,
      diamondCount: 5,
      avatar: 'https://example.com/avatar.png',
    };
    listeners.get('update')({ data: JSON.stringify({ entry }) });

    assert.equal(dispatched.length, 1, `${type} dispatches exactly once`);
    const [result] = dispatched;
    const expectedHandler = specificHandlers.get(type);
    if (expectedHandler === 'like') {
      assert.equal(result.handler, 'like');
      assert.deepEqual(result.args, [2, entry.username]);
    } else if (expectedHandler === 'gift') {
      assert.equal(result.handler, 'gift');
      assert.equal(result.payload.user, entry.username);
      assert.equal(result.payload.giftName, 'Rosa');
      assert.equal(result.payload.coins, 10);
      assert.equal(result.payload.count, 2);
      assert.equal(result.payload.avatar, entry.avatar);
    } else if (expectedHandler === 'chat') {
      assert.equal(result.handler, 'chat');
      assert.deepEqual(result.args, [entry.username, entry.content, entry.avatar]);
    } else if (expectedHandler === 'member' || expectedHandler === 'follow') {
      assert.equal(result.handler, expectedHandler);
      assert.deepEqual(result.args, [entry.username, entry.avatar]);
    } else {
      assert.equal(result.handler, 'liveEvent');
      assert.equal(result.payload.type, 'share' === type ? 'share' : 'activity');
      assert.equal(result.payload.user, entry.username);
      assert.equal(result.payload.text, entry.content);
      assert.equal(result.payload.avatar, entry.avatar);
    }
  }

  dispatched.length = 0;
  const duplicate = { id: 'duplicate-event', type: 'like', username: 'viewer' };
  const update = listeners.get('update');
  update({ data: JSON.stringify({ entry: duplicate }) });
  update({ data: JSON.stringify({ entry: duplicate }) });
  assert.equal(dispatched.length, 1);
});
