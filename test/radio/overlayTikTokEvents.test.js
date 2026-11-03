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
  assert.equal(lnkT.textContent, 'REINTENTANDO…');
  assert.equal(classes.has('pending'), true);

  renderTikTokStatus({ connected: false, status: 'disconnected' });
  assert.equal(lnkT.textContent, 'DESCONECTADO');
  assert.equal(classes.has('bad'), true);

  renderTikTokStatus({});
  assert.equal(lnkT.textContent, 'SIN ESTADO');
  assert.equal(classes.has('unknown'), true);
});

test('radio advances one track per completed coin goal and keeps leftover coins', async () => {
  const overlay = fs.readFileSync(path.join(__dirname, '../../Radio_Cristiana_Pentecostal_BUBSDT_TikTok_Live_v10.html'), 'utf8');
  const start = overlay.indexOf('let goalMax=500,goalNow=0;');
  const end = overlay.indexOf("\nfetch('/api/overlay/settings')", start);
  assert.notEqual(start, -1, 'song-goal progress handler exists in the active overlay');
  assert.notEqual(end, -1, 'song-goal progress handler has a clear boundary');

  const actions = [];
  const saved = new Map();
  const elements = new Map([
    ['#gP', { textContent: '' }],
    ['#gB', { style: {} }],
  ]);
  const banners = [];
  const context = {
    localStorage: {
      getItem: (key) => saved.get(key) || null,
      setItem: (key, value) => saved.set(key, value),
    },
    $: (selector) => elements.get(selector),
    showBanner: (...args) => banners.push(args),
    chime: () => {},
    requestRadioAction: async (action) => actions.push(action),
    console,
    performance: { now: () => 1 },
  };
  vm.runInNewContext(overlay.slice(start, end), context);
  vm.runInContext('setGoalMax(500); addCoins(450); addCoins(100);', context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext('goalNow', context), 50);
  assert.equal(saved.get('radio-song-goal-progress-v1'), '50');
  assert.deepEqual(actions, ['next']);

  vm.runInContext('addCoins(1000);', context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext('goalNow', context), 50);
  assert.deepEqual(actions, ['next', 'next', 'next']);
  assert.equal(banners.length, 2);
});

test('overlay engagement alerts appear centered in a TikTok-style panel', () => {
  const overlay = fs.readFileSync(path.join(__dirname, '../../Radio_Cristiana_Pentecostal_BUBSDT_TikTok_Live_v10.html'), 'utf8');
  assert.match(overlay, /\.cta\{left:60px;top:1340px;width:960px;height:290px/);
  assert.match(overlay, /background:var\(--gold\);color:var\(--ink\)/);
  assert.match(overlay, /Toca la pantalla/);
  assert.match(overlay, /Escribe AMÉN/);
  assert.match(overlay, /Comparte el live/);
});

test('radio overlay removes the scrolling ticker and enlarges the Walkman case', () => {
  const overlay = fs.readFileSync(path.join(__dirname, '../../Radio_Cristiana_Pentecostal_BUBSDT_TikTok_Live_v10.html'), 'utf8');
  assert.doesNotMatch(overlay, /@keyframes mq|<div class="tick"><span id="tk"/);
  assert.match(overlay, /\.cass\{left:40px;top:235px;width:1000px;height:659px/);
  assert.match(overlay, /viewBox="100 2 440 290"/);
  assert.match(overlay, /\.chips\{left:60px;top:950px/);
});

test('radio playback does not mix a generated white-noise track', () => {
  const overlay = fs.readFileSync(path.join(__dirname, '../../Radio_Cristiana_Pentecostal_BUBSDT_TikTok_Live_v10.html'), 'utf8');
  const audioSection = overlay.slice(overlay.indexOf('/* ===== Audio:'), overlay.indexOf('/* ===== Mensajes de ayuda */'));
  assert.doesNotMatch(audioSection, /createBufferSource|Math\.random\(\)\*2-1|nzF|nzG/);
  assert.match(audioSection, /radioPlayer\.play\(\)/);
});
