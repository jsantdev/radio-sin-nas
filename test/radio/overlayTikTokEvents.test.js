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

test('radio overlay renders the actual TikTok connection state', () => {
  const overlay = fs.readFileSync(path.join(__dirname, '../../Radio_Cristiana_Pentecostal_BUBSDT_TikTok_Live_v10.html'), 'utf8');
  const start = overlay.indexOf('function renderTikTokStatus(status={}){');
  const end = overlay.indexOf('\nasync function refreshTikTokStatus()', start);
  assert.notEqual(start, -1, 'connection-status renderer exists in the radio overlay');
  assert.notEqual(end, -1, 'connection-status renderer has a clear boundary');

  const classes = new Set();
  const lnk = {
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
    dataset: {},
  };
  const lnkT = { textContent: '' };
  const renderTikTokStatus = vm.runInNewContext(`(${overlay.slice(start, end)})`, { lnk, lnkT });
  renderTikTokStatus({ connected: true, username: 'canal', status: 'connected' });
  assert.equal(lnkT.textContent, 'EN LÍNEA');
  assert.doesNotMatch(lnk.title, /canal/);
  assert.equal(classes.has('bad'), false);

  renderTikTokStatus({ connector: { isConnected: false, status: 'reconnecting' } });
  assert.equal(lnkT.textContent, 'REINTENTANDO...');
  assert.equal(classes.has('pending'), true);

  renderTikTokStatus({ connected: false, status: 'disconnected' });
  assert.equal(lnkT.textContent, 'DESCONECTADO');
  assert.equal(classes.has('bad'), true);

  renderTikTokStatus({});
  assert.equal(lnkT.textContent, 'ESTADO DESCONOCIDO');
  assert.equal(classes.has('unknown'), true);
});

test('radio advances one track per completed coin goal and keeps leftover coins', async () => {
  const overlay = fs.readFileSync(path.join(__dirname, '../../Radio_Cristiana_Pentecostal_BUBSDT_TikTok_Live_v10.html'), 'utf8');
  const start = overlay.indexOf('let songGoalCoinGoal=500,songGoalCoinProgress=0;');
  const end = overlay.indexOf('\nfunction ev(', start);
  assert.notEqual(start, -1, 'song-goal progress handler exists in the active overlay');
  assert.notEqual(end, -1, 'song-goal progress handler has a clear boundary');

  const actions = [];
  const saved = new Map();
  const radioHint = { textContent: '' };
  const context = {
    localStorage: {
      getItem: (key) => saved.get(key) || null,
      setItem: (key, value) => saved.set(key, value),
    },
    radioHint,
    requestRadioAction: async (action) => actions.push(action),
    console,
  };
  vm.runInNewContext(overlay.slice(start, end), context);
  vm.runInContext('setSongGoalCoinGoal(500); addSongGoalCoins(450); addSongGoalCoins(100);', context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext('songGoalCoinProgress', context), 50);
  assert.equal(saved.get('radio-song-goal-progress-v1'), '50');
  assert.deepEqual(actions, ['next']);

  vm.runInContext('addSongGoalCoins(1000);', context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext('songGoalCoinProgress', context), 50);
  assert.deepEqual(actions, ['next', 'next', 'next']);
  assert.match(radioHint.textContent, /Meta musical alcanzada/);
});

test('overlay engagement alerts appear centered in a TikTok-style panel', () => {
  const overlay = fs.readFileSync(path.join(__dirname, '../../Radio_Cristiana_Pentecostal_BUBSDT_TikTok_Live_v10.html'), 'utf8');
  assert.match(overlay, /#al\{position:absolute;left:50%;top:50%/);
  assert.match(overlay, /background:rgba\(15,16,24,\.97\)/);
  assert.match(overlay, /EN VIVO\s+·\s+TU PARTICIPACIÓN CUENTA/);
  assert.match(overlay, /¡Saluda en el chat!/);
  assert.match(overlay, /Cada toque suma para la meta comunitaria/);
  assert.match(overlay, /¡Invita a alguien!/);
});

test('radio overlay removes the scrolling ticker and enlarges the Walkman case', () => {
  const overlay = fs.readFileSync(path.join(__dirname, '../../Radio_Cristiana_Pentecostal_BUBSDT_TikTok_Live_v10.html'), 'utf8');
  assert.doesNotMatch(overlay, /class="tick"|id="tk"|@keyframes mq/);
  assert.match(overlay, /\.wm\{position:absolute;left:0;top:122px;width:1080px;height:900px/);
  assert.match(overlay, /\.wm>div\{position:absolute;transform:scale\(1\.06\);transform-origin:top left\}/);
  assert.match(overlay, /\.deck\{position:absolute;left:20px;top:1044px;width:1040px;height:850px/);
});
