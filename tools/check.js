/* 一键自检：JSON 合法性 + JS 语法 + 城市查询 + 站点切换回归 + i18n 覆盖
 * 用法： node tools/check.js
 * 注：本文件的注释一律使用 ASCII，避免在不同终端编码下被损坏。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..');
var fails = 0;

function ok(name, note) { console.log('  OK   ' + name + (note ? '  ' + note : '')); }
function bad(name, err) { fails++; console.log('  FAIL ' + name + '  ' + err); }

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

/* 把 pending 的 microtask / timer 队列跑干净，再执行断言。
 * chrome.* 被 cbCall 包成 Promise 之后，回调链至少跨若干 microtask，
 * 直接同步断言会读到中间态。整段断言会延后到当前同步流程结束后执行。 */
function flush(fn) {
  pending++;
  var ticks = 0;
  function step() {
    ticks++;
    if (ticks < 60) { setTimeout(step, 1); return; }
    try { fn(); } catch (e) { bad('flush', e.message); }
    pending--;
    finish();
  }
  setTimeout(step, 1);
}

var pending = 0;
var finished = false;
/* 段落队列：某些段落必须串行（否则 flush 的交错输出会让报告难以对读）。
 * finish() 只有在队列排空且 pending 归零时才真正退出。 */
var sectionQueue = [];

function finish() {
  if (finished) return;
  if (pending > 0) return;
  if (sectionQueue.length) {
    var next = sectionQueue.shift();
    try { next(); } catch (e) { bad('section', e.message); }
    setTimeout(finish, 1);
    return;
  }
  finished = true;
  console.log(fails ? '\nFAILURES: ' + fails : '\nALL PASS');
  process.exit(fails ? 1 : 0);
}

/* ---------- 1. JSON ---------- */
console.log('[1] JSON');
['manifest.json', '_locales/en/messages.json', '_locales/zh_CN/messages.json'].forEach(function (f) {
  try {
    var o = JSON.parse(read(f));
    ok(f, Object.keys(o).length + ' keys');
  } catch (e) { bad(f, e.message); }
});

/* ---------- 2. JS syntax ---------- */
console.log('[2] JS syntax');
var jsFiles = ['src/background.js', 'src/content.js',
  'src/lib/config.js', 'src/lib/sun.js', 'src/lib/matcher.js', 'src/lib/filter.js',
  'src/lib/store.js', 'src/lib/cities.js', 'src/lib/cities.data.js',
  'src/options/options.js', 'src/popup/popup.js'];
jsFiles.forEach(function (f) {
  try { new vm.Script(read(f), { filename: f }); ok(f); }
  catch (e) { bad(f, e.message); }
});

/* ---------- 3. lib 双环境加载 ----------
 * 扩展里 lib 挂到 globalThis；构建脚本里通过 require 使用。
 * 两条路都必须通。
 */
console.log('[3] lib loading');
['config', 'sun', 'matcher', 'filter', 'store', 'cities'].forEach(function (name) {
  try {
    var mod = require(path.join(ROOT, 'src/lib/' + name + '.js'));
    if (!mod || Object.keys(mod).length === 0) throw new Error('require returned empty');
    ok('require src/lib/' + name + '.js');
  } catch (e) { bad('require ' + name, e.message); }
});

/* 浏览器/扩展环境：按 manifest.content_scripts 的顺序依次执行 */
var sandbox = {
  console: console, Date: Date, Math: Math, JSON: JSON,
  isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat,
  // matcher 依赖 URL 解析，vm 沙箱不会自带这些 Web 全局对象
  URL: URL, encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
['config', 'sun', 'matcher', 'filter'].forEach(function (name) {
  new vm.Script(read('src/lib/' + name + '.js'), { filename: name + '.js' }).runInContext(sandbox);
});
sandbox.NW = sandbox.NW || {};
sandbox.NW.cities = require(path.join(ROOT, 'src/lib/cities.data.js')).NW.cities;
new vm.Script(read('src/lib/cities.js'), { filename: 'cities.js' }).runInContext(sandbox);

var NW = sandbox.NW;
var M = NW.matcher, C = NW.config, S = NW.sun, G = NW.geo;

['config', 'sun', 'matcher', 'filter', 'cities', 'geo'].forEach(function (k) {
  NW[k] ? ok('NW.' + k) : bad('NW.' + k, 'missing');
});
/* config: city 字段要能存住，skipDarkSites 不能被丢，未知键要丢弃 */
var cfg = C.normalize({
  schedule: { latitude: 31.2304, longitude: 121.4737, city: 'Shanghai, CN' },
  advanced: { skipDarkSites: false, skipDark: true, junk: 1 }
});
cfg.schedule.city === 'Shanghai, CN' ? ok('config.city kept') : bad('config.city', JSON.stringify(cfg.schedule.city));
cfg.advanced.skipDarkSites === false ? ok('skipDarkSites applied') : bad('skipDarkSites', String(cfg.advanced.skipDarkSites));
cfg.advanced.skipDark === undefined ? ok('unknown key skipDark dropped') : bad('skipDark', 'should be dropped');

/* ---------- 4. City lookup ---------- */
console.log('[4] City lookup');
var CITY_CASES = [
  [31.2304, 121.4737, /^Shanghai$/, 'Shanghai downtown'],
  [31.15, 121.40, /^Shanghai$/, 'Shanghai suburb'],
  [39.9042, 116.4074, /^Beijing$/, 'Beijing'],
  [22.5431, 114.0579, /^Shenzhen$/, 'Shenzhen'],
  [30.5728, 104.0668, /^Chengdu$/, 'Chengdu'],
  [30.2741, 120.1551, /^Hangzhou$/, 'Hangzhou'],
  [23.1291, 113.2644, /^Guangzhou$/, 'Guangzhou'],
  [40.7128, -74.0060, /^New York City$/, 'New York'],
  [34.0522, -118.2437, /^Los Angeles$/, 'Los Angeles'],
  [51.5074, -0.1278, /^London$/, 'London'],
  [35.6762, 139.6503, /^Tokyo$/, 'Tokyo'],
  [48.8566, 2.3522, /^Paris$/, 'Paris'],
  [52.52, 13.405, /^Berlin$/, 'Berlin'],
  [55.7558, 37.6173, /^Moscow$/, 'Moscow'],
  [19.076, 72.8777, /^Mumbai$/, 'Mumbai'],
  [-33.8688, 151.2093, /^Sydney$/, 'Sydney'],
  [-23.5505, -46.6333, /^S.o Paulo$/, 'Sao Paulo'],
  [30.0444, 31.2357, /^Cairo$/, 'Cairo']
];
CITY_CASES.forEach(function (t) {
  var hit = G.nearest(t[0], t[1]);
  if (!hit) { bad('lookup ' + t[3], 'null'); return; }
  if (!t[2].test(hit.name)) { bad('lookup ' + t[3], 'got ' + hit.name); return; }
  if (!hit.major) { bad('lookup ' + t[3], 'major=false'); return; }
  ok(t[3] + ' -> ' + hit.name + ', ' + hit.country, hit.km.toFixed(1) + ' km');
});

/* Remote area: result exists but marked non-major so UI asks to verify */
var remote = G.nearest(-10.5, -60.0);
(remote && remote.major === false)
  ? ok('Amazon -> ' + remote.name + ' ' + remote.km.toFixed(0) + ' km (major=false)')
  : bad('remote', JSON.stringify(remote));
G.nearest(NaN, 0) === null ? ok('NaN coords -> null') : bad('NaN coords', 'should be null');

/* ---------- 5. Site toggle semantics ----------
 * Regression guard: this is exactly the bug that made the popup toggle
 * appear dead on sites already in the whitelist. The toggle must judge by
 * the site's EFFECTIVE darkness (lists included), not the global one.
 */
console.log('[5] Site toggle');
(function () {
  var URL_A = 'https://example.com/page';

  // Global day -> click makes it dark (goes to blacklist)
  var c = C.normalize({ mode: 'light', lists: { blacklist: [], whitelist: [] } });
  M.toggleSiteDark(c, URL_A, M.siteEnabled(c, URL_A, S.shouldBeDark(c)));
  (c.lists.blacklist.length === 1 && c.lists.whitelist.length === 0)
    ? ok('global day + click -> blacklist (dark)')
    : bad('global day + click', JSON.stringify(c.lists));

  // Click again -> back to light (whitelist), not stuck in blacklist
  M.toggleSiteDark(c, URL_A, M.siteEnabled(c, URL_A, S.shouldBeDark(c)));
  (c.lists.blacklist.length === 0 && c.lists.whitelist.length === 1)
    ? ok('click again -> whitelist (light)')
    : bad('click again', JSON.stringify(c.lists));

  // 6 more clicks must leave exactly one rule behind
  for (var i = 0; i < 6; i++) {
    M.toggleSiteDark(c, URL_A, M.siteEnabled(c, URL_A, S.shouldBeDark(c)));
  }
  (c.lists.blacklist.length + c.lists.whitelist.length === 1)
    ? ok('repeated clicks keep one rule')
    : bad('repeated clicks', JSON.stringify(c.lists));

  // Global night + site already whitelisted -> one click must turn it dark
  var c2 = C.normalize({ mode: 'dark', lists: { blacklist: [], whitelist: ['example.com'] } });
  var darkBefore = M.siteEnabled(c2, URL_A, S.shouldBeDark(c2));
  darkBefore === false ? ok('whitelisted site stays light at night') : bad('whitelist priority', String(darkBefore));
  M.toggleSiteDark(c2, URL_A, darkBefore);
  M.siteEnabled(c2, URL_A, S.shouldBeDark(c2)) === true
    ? ok('whitelisted site -> dark in one click')
    : bad('whitelisted site toggle', JSON.stringify(c2.lists));

  // Context menu path: add to / remove from whitelist
  var c3 = C.normalize({ lists: { blacklist: [], whitelist: [] } });
  M.toggleWhitelist(c3, URL_A);
  (c3.lists.whitelist.length === 1) ? ok('context menu: add to whitelist') : bad('ctx add', JSON.stringify(c3.lists));
  M.toggleWhitelist(c3, URL_A);
  (c3.lists.whitelist.length === 0 && c3.lists.blacklist.length === 0)
    ? ok('context menu: remove from whitelist')
    : bad('ctx remove', JSON.stringify(c3.lists));

  // Blacklist in the way must be cleared when adding to whitelist
  var c4 = C.normalize({ lists: { blacklist: ['example.com'], whitelist: [] } });
  M.toggleWhitelist(c4, URL_A);
  (c4.lists.whitelist.length === 1 && c4.lists.blacklist.length === 0)
    ? ok('whitelist add clears blacklist rule')
    : bad('mutual exclusion', JSON.stringify(c4.lists));

  // 三态：follow / dark / light 互斥，且能从名单回到 follow
  var c5 = C.normalize({ lists: { blacklist: [], whitelist: [] } });
  M.setSiteMode(c5, URL_A, 'dark');
  (M.siteMode(c5, URL_A) === 'dark' && c5.lists.blacklist.length === 1)
    ? ok('三态：强制夜间 -> 黑名单') : bad('三态 dark', JSON.stringify(c5.lists));
  M.setSiteMode(c5, URL_A, 'light');
  (M.siteMode(c5, URL_A) === 'light' && c5.lists.blacklist.length === 0 && c5.lists.whitelist.length === 1)
    ? ok('三态：强制白天 -> 白名单（黑名单已清）') : bad('三态 light', JSON.stringify(c5.lists));
  M.setSiteMode(c5, URL_A, 'follow');
  (M.siteMode(c5, URL_A) === 'follow' && c5.lists.blacklist.length + c5.lists.whitelist.length === 0)
    ? ok('三态：跟随自动 -> 两个名单都清空') : bad('三态 follow', JSON.stringify(c5.lists));
})();

/* ---------- 5b. 手动模式的自动恢复 ----------
 * 手动选黑夜/白天不再永久锁死：记下下一个自然切换点作为失效时刻。
 * 到期后 shouldBeDark 与 normalize 都会自动回落 auto（闹钟缺席也自愈）。
 */
console.log('[5b] manual mode auto-recovery');
(function () {
  var c = C.normalize({ mode: 'dark', schedule: { type: 'time', start: '19:00', end: '07:00' } });
  c.manualUntil = Date.now() + 3600000;   // 1 小时后才失效
  S.shouldBeDark(c) === true
    ? ok('手动黑夜未到期：保持黑夜') : bad('手动未到期', 'expected dark');

  // 过期后必须回落到"与自动完全一致"的判定，而不是继续手动
  var autoC = C.normalize({ schedule: { type: 'time', start: '19:00', end: '07:00' } });
  var autoDark = S.shouldBeDark(autoC);
  c.manualUntil = Date.now() - 1000;
  S.shouldBeDark(c) === autoDark
    ? ok('手动已过期：回落为自动判定 (' + (autoDark ? 'dark' : 'light') + ')')
    : bad('手动过期自愈', 'manual=' + S.shouldBeDark(c) + ' auto=' + autoDark);

  var c2 = C.normalize({ mode: 'dark', manualUntil: Date.now() - 1000 });
  (c2.mode === 'auto' && c2.manualUntil === 0)
    ? ok('normalize 清除过期手动模式') : bad('normalize 过期', JSON.stringify({ m: c2.mode, u: c2.manualUntil }));

  var c3 = C.normalize({ mode: 'auto' });
  C.setManualMode(c3, 'light', Date.now() + 60000);
  (c3.mode === 'light' && c3.manualUntil > 0)
    ? ok('setManualMode 记录失效时刻') : bad('setManualMode', JSON.stringify(c3));

  // 手动模式下也要给出下一次切换点，闹钟靠它排程
  var n = S.nextSwitch(c3);
  (n && typeof n.at === 'number' && n.minutes > 0)
    ? ok('nextSwitch 手动模式返回切换点') : bad('nextSwitch 手动', JSON.stringify(n));

  C.setManualMode(c3, 'auto', 0);
  (c3.mode === 'auto' && c3.manualUntil === 0)
    ? ok('setManualMode(auto) 清除失效时刻') : bad('setManualMode auto', JSON.stringify(c3));
})();

/* ---------- 6. background.js in a simulated service worker ---------- */
console.log('[6] background.js');

function runBackground(opts) {
  var listeners = {};
  var sent = [];         // 记录 tabs.sendMessage，用于验证"广播是否真的发出去了"
  var menuUpdates = [];  // 记录 contextMenus.update，用于验证菜单项置灰
  var alarmsCreated = []; // 记录 alarms.create，用于验证触摸闹钟
  var stored = { config: (opts && opts.seedConfig) ? opts.seedConfig : {} };
  /* 记录 setBadgeText，用于验证徽标语义：text = 全局徽标，tabTexts = per-tab。
   * per-tab 应当永远是空的（徽标只写全局值）；背景代码若哪天又去"回读徽标"，
   * 会因为夹具没提供 getBadgeText 而立刻暴露。 */
  var badge = { text: null, tabTexts: {} };
  /* breakApi: make one specific addListener throw, to prove that a single
   * failed registration cannot take down the listeners registered after it. */
  var broken = opts && opts.breakApi ? String(opts.breakApi).split('.') : null;
  /* noApi: simulate a build where an event object does not exist at all
   * (the real report was chrome.contextMenus.onShown being absent). */
  var absent = opts && opts.noApi ? String(opts.noApi).split('.') : null;
  function isAbsent(ns, ev) {
    if (!absent) return false;
    return absent[absent.length - 1] === ev && (absent.length < 2 || absent[absent.length - 2] === ns);
  }
  function on(name) {
    return {
      addListener: function (fn) {
        if (broken && broken[broken.length - 1] === name) {
          throw new TypeError("Cannot read properties of undefined (reading 'addListener')");
        }
        listeners[name] = fn;
      }
    };
  }
  var chrome = {
    runtime: {
      lastError: null,
      onInstalled: on('onInstalled'),
      onStartup: on('onStartup'),
      onMessage: on('onMessage'),
      getURL: function (p) { return p; },
      openOptionsPage: function () {}
    },
    storage: {
      local: {
        get: function (k, cb) { cb({ config: stored.config }); },
        set: function (v, cb) { stored.config = v.config; if (cb) cb(); }
      },
      onChanged: on('storageChanged')
    },
    alarms: {
      create: function (o) { alarmsCreated.push(o && o.name); },
      clear: function () {},
      onAlarm: on('onAlarm')
    },
    commands: { onCommand: on('onCommand') },
    tabs: {
      query: function (q, cb) { cb([{ id: 1, url: 'https://example.com/' }]); },
      get: function (id, cb) { cb({ id: id, url: 'https://example.com/' }); },
      /* 真实 MV3 行为：返回 Promise，同时接受回调。
       * 夹具必须同时支持两种形态，否则会掩盖 cbCall/probeTab 的悬空 bug。 */
      sendMessage: function (id, msg, cb) {
        sent.push(msg && msg.type);
        if (typeof cb === 'function') { cb({ dark: true }); return undefined; }
        return Promise.resolve({ dark: true });
      },
      onActivated: on('onActivated'),
      onUpdated: on('onUpdated')
    },
    contextMenus: {
      removeAll: function (cb) { if (cb) cb(); },
      create: function (o, cb) { if (cb) cb(); },
      update: function (id, o, cb) { menuUpdates.push({ id: id, props: o }); if (cb) cb(); },
      refresh: function () {},
      onClicked: on('onClicked')
    },
    action: {
      /* 全局徽标记 badge.text；per-tab 徽标（受限页面黄叹号）记 badge.tabTexts */
      setBadgeText: function (o) {
        if (o && o.tabId) badge.tabTexts[o.tabId] = o.text;
        else badge.text = o && o.text;
      },
      setBadgeBackgroundColor: function () {}
    },
    scripting: { executeScript: function () { return Promise.resolve(); } },
    i18n: { getMessage: function (k) { return k; } }
  };
  // 只有在没有 noApi 指定时才挂 onShown，用于模拟老/新版本差异
  if (!isAbsent('contextMenus', 'onShown')) chrome.contextMenus.onShown = on('onShown');

  var box = {
    console: { log: function () {}, debug: function () {}, warn: function () {}, error: function () {} },
    chrome: chrome,
    Promise: Promise, Date: Date, Math: Math, JSON: JSON,
    Array: Array, Object: Object, String: String,
    isFinite: isFinite, URL: URL,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    TypeError: TypeError
  };
  box.self = box;
  box.globalThis = box;

  if (opts.native) {
    // 原生 SW：importScripts 把 lib 挂到 self.NW
    box.importScripts = function () {
      box.NW = {
        config: require(path.join(ROOT, 'src/lib/config.js')),
        sun: require(path.join(ROOT, 'src/lib/sun.js')),
        matcher: require(path.join(ROOT, 'src/lib/matcher.js'))
      };
    };
  } else {
    // 原生注册失败：importScripts 抛错，走 require 回退
    box.importScripts = function () { throw new Error('Service worker registration failed. Status code: 15'); };
    box.require = function (p) {
      var name = p.replace(/^\.\//, '').replace(/^src\//, '');
      return require(path.join(ROOT, 'src', name));
    };
  }

  vm.createContext(box);
  try {
    new vm.Script(read('src/background.js'), { filename: 'src/background.js' }).runInContext(box);
  } catch (e) {
    return { error: e.message, listeners: listeners };
  }

  /* 期待的监听器（移除右键菜单后剩 5 个）。 */
  var want = ['onInstalled', 'onStartup', 'onAlarm', 'onCommand', 'storageChanged'];
  var missing = want.filter(function (k) { return typeof listeners[k] !== 'function'; });
  return { missing: missing, listeners: listeners, box: box, sent: sent, stored: stored, badge: badge, menuUpdates: menuUpdates, alarmsCreated: alarmsCreated, regFail: box.REG_FAIL, regSkip: box.REG_SKIP };
}

(function () {
  // (a) native service worker path
  var sw = runBackground({ native: true });
  if (sw.error) { bad('SW 原生路径执行', sw.error); return; }
  sw.missing.length ? bad('SW 监听器', 'missing ' + sw.missing.join(',')) : ok('SW 原生路径：5 个监听器全部注册');

  /* REGRESSION: one throwing registration must not kill the others.
   * 真实事故：某个 addListener 抛错，把排在它后面的监听器一起拖死。
   * 这里用 commands.onCommand 注入故障，验证隔离机制仍然有效。 */
  (function () {
    var hostile = runBackground({ native: true, breakApi: 'commands.onCommand' });
    if (hostile.error) { bad('隔离注册（注入故障）', hostile.error); return; }
    var stillThere = ['storageChanged', 'onAlarm', 'onInstalled', 'onStartup']
      .filter(function (k) { return typeof hostile.listeners[k] === 'function'; });
    stillThere.length === 4
      ? ok('隔离注册：onCommand 抛错时 storage/alarms/installed/startup 仍存活')
      : bad('隔离注册', '被拖死的监听器: ' + ['storageChanged', 'onAlarm', 'onInstalled', 'onStartup']
        .filter(function (k) { return typeof hostile.listeners[k] !== 'function'; }).join(','));
    (hostile.regFail && hostile.regFail.length)
      ? ok('隔离注册：失败被记录 (' + hostile.regFail[0].slice(0, 40) + ')')
      : bad('隔离注册', 'REG_FAIL 未记录失败');
  })();

  // (b) importScripts 失败后的回退路径（就是农场主屏幕上那个 status code 15）
  var ep = runBackground({ native: false });
  if (ep.error) { bad('回退路径执行', ep.error); return; }
  ep.missing.length ? bad('回退路径监听器', 'missing ' + ep.missing.join(',')) : ok('回退路径：5 个监听器全部注册');
  var em = ep.box.NW && ep.box.NW.matcher;
  (em && typeof em.toggleSiteDark === 'function')
    ? ok('回退路径：NW.matcher 可用（require 分支）')
    : bad('回退路径模块加载', 'NW.matcher 未就绪');

  /* The resolver must map every logical event name onto the right object, and
   * must come back empty (not throw, not mis-map) when one is absent. */
  (function () {
    var names = ['storageChanged', 'onAlarm', 'onCommand',
                 'onInstalled', 'onStartup'];
    var full = sw.listeners;
    var allOk = names.every(function (k) { return typeof full[k] === 'function'; });
    allOk ? ok('解析器：5 个事件全部命中原对象')
          : bad('解析器', '未命中: ' + names.filter(function (k) { return typeof full[k] !== 'function'; }).join(','));
  })();

  /* 注：原先这里还有 nw:ping / nw:save / nw:read 的消息路由测试。
   * 消息通道（runtime.onMessage）已整体删除 —— 本机注册不上、UI 也不再依赖，
   * 滑块落盘/回读由 [9] 段的 storage 直连断言覆盖。 */

  /* 徽标语义：黑夜 ON，白天 OFF（不再白天留空） */
  (function () {
    var CC = require(path.join(ROOT, 'src/lib/config.js'));
    var day = runBackground({ native: true, seedConfig: CC.normalize({ mode: 'light' }) });
    var night = runBackground({ native: true, seedConfig: CC.normalize({ mode: 'dark' }) });
    var off = runBackground({ native: true, seedConfig: CC.normalize({ enabled: false }) });
    flush(function () {
      (day.badge.text === 'OFF') ? ok('徽标：白天模式 -> OFF') : bad('徽标白天', String(day.badge.text));
      (night.badge.text === 'ON') ? ok('徽标：黑夜模式 -> ON') : bad('徽标黑夜', String(night.badge.text));
      (off.badge.text === 'OFF') ? ok('徽标：总开关关闭 -> OFF') : bad('徽标关闭', String(off.badge.text));
    });
  })();
})();

console.log('[7] i18n keys');
var en = JSON.parse(read('_locales/en/messages.json'));
var zh = JSON.parse(read('_locales/zh_CN/messages.json'));
var enK = Object.keys(en), zhK = Object.keys(zh);
enK.filter(function (k) { return zhK.indexOf(k) < 0; }).forEach(function (k) { bad('zh missing', k); });
zhK.filter(function (k) { return enK.indexOf(k) < 0; }).forEach(function (k) { bad('en missing', k); });
['cityNear', 'cityFar', 'cityKnown', 'detectLocating', 'msgReload'].forEach(function (k) {
  (en[k] && zh[k]) ? ok(k) : bad(k, 'missing');
});

/* Every key referenced in code must exist in the locale files */
var allSrc = jsFiles.concat(['src/options/options.html', 'src/popup/popup.html'])
  .map(function (f) { try { return read(f); } catch (e) { return ''; } }).join('\n');
var used = {};
var re = /(?:msg\(|getMessage\()\s*'([a-zA-Z0-9_]+)'/g;
var m;
while ((m = re.exec(allSrc))) used[m[1]] = 1;
var re2 = /data-i18n="([a-zA-Z0-9_]+)"/g;
while ((m = re2.exec(allSrc))) used[m[1]] = 1;
Object.keys(used).forEach(function (k) {
  if (!en[k]) bad('undefined i18n key', k);
});
ok('scanned ' + Object.keys(used).length + ' keys');

/* [9] 排在 [8] 之后串行执行，保证报告顺序与代码顺序一致。
 * 队列由 finish() 在 pending 归零时自动排空。 */
function afterSections(fn) { sectionQueue.push(fn); }

console.log('[8] broadcast（异步断言）');
/* 回归：广播必须发生。曾经 broadcast() 定义了但没人调用，
 * 导致"手动切黑夜不生效""右键加白名单不同步"。
 * 这几组断言涉及 Promise 链，结果由 flush 延后输出 —— 排在最后。 */
(function () {
  // UI 落盘（popup 切模式 / 设置页保存都直写 storage）-> storage.onChanged 必须广播
  var r1 = runBackground({ native: true });
  r1.listeners.storageChanged({
    config: { newValue: C.normalize({ mode: 'dark' }), oldValue: null }
  }, 'local');
  flush(function () {
    r1.sent.indexOf('nw:tick') >= 0
      ? ok('UI 落盘 -> storage.onChanged 广播 nw:tick（手动切模式即时生效）')
      : bad('storage 广播', '未发送 nw:tick');
  });

  // 信号闹钟（UI 站点开关/保存后走的通道）必须广播 + 收敛徽标
  var r3 = runBackground({ native: true });
  var siteCfg = C.normalize({ mode: 'dark', lists: { blacklist: ['example.com'] } });
  siteCfg.savedAt = Date.now();
  r3.listeners.onAlarm({ name: 'nw{' + JSON.stringify(siteCfg) });
  flush(function () {
    r3.sent.indexOf('nw:tick') >= 0
      ? ok('信号闹钟 -> 广播 nw:tick')
      : bad('信号广播', '未发送 nw:tick');
    (r3.badge.text === 'ON')
      ? ok('信号闹钟 -> 全局徽标收敛为 ON')
      : bad('信号徽标', String(r3.badge.text));
  });

  // 快捷键切昼夜必须广播
  var r4 = runBackground({ native: true });
  r4.listeners.onCommand('nw-toggle-mode');
  flush(function () {
    r4.sent.indexOf('nw:tick') >= 0
      ? ok('快捷键 -> 广播 nw:tick')
      : bad('快捷键广播', '未发送 nw:tick');
    var mode = r4.stored.config && r4.stored.config.mode;
    (mode === 'dark' || mode === 'light')
      ? ok('快捷键 -> mode 已落盘 (' + mode + ')')
      : bad('快捷键落盘', String(mode));
  });

  // 回归：总开关是最顶层条件 —— 关闭时两个快捷键都不落盘、不广播
  var r5 = runBackground({ native: true, seedConfig: C.normalize({ enabled: false }) });
  var sentBefore = r5.sent.length;
  r5.listeners.onCommand('nw-toggle-mode');
  r5.listeners.onCommand('nw-toggle-site');
  flush(function () {
    var cfg = r5.stored.config;
    var listsClean = cfg && cfg.lists &&
      cfg.lists.blacklist.length + cfg.lists.whitelist.length === 0;
    (r5.sent.length === sentBefore && cfg && cfg.mode === 'auto' && listsClean)
      ? ok('总开关关闭：快捷键不切换昼夜/站点，也不广播')
      : bad('快捷键关态未门控', JSON.stringify({ sent: r5.sent.length, before: sentBefore, m: cfg && cfg.mode }));
  });

  /* 回归：徽标只有一个全局值 —— 任何路径都不得写 per-tab。
   * per-tab 覆盖一旦写入就与全局断开、且 Chrome 没有"解除覆盖"的 API，于是
   * 必然引出"回读当前全局值 → 再写回每个 tab"的一整条维护链（历史上就是它
   * 制造了"ON/OFF 不主动显示、点开 popup 才出现、被写空后再也回不来"）。
   * 现在整套删除，这里用夹具的 tabTexts 钉死：它必须永远是空的。 */
  (function () {
    var bg = runBackground({ native: true, seedConfig: C.normalize({ mode: 'dark' }) });
    flush(function () {
      var tabWrites = Object.keys(bg.badge.tabTexts).length;
      (bg.badge.text === 'ON' && tabWrites === 0)
        ? ok('徽标：只写全局值，无任何 per-tab 写入')
        : bad('徽标写了 per-tab', JSON.stringify({ global: bg.badge.text, tabTexts: bg.badge.tabTexts }));
    });
  })();

  // 回归：停在受限页面（chrome:// 等）时徽标仍表达全局昼夜，不打黄叹号；
  // 标签页激活/导航也不再参与徽标计算（那套监听器已整体删除）。
  (function () {
    var bg = runBackground({ native: true, seedConfig: C.normalize({ mode: 'dark' }) });
    var sentBefore = bg.sent.length;
    bg.box.chrome.tabs.query = function (q, cb) { cb([{ id: 1, url: 'chrome://extensions/' }]); };
    bg.box.chrome.tabs.get = function (id, cb) { cb({ id: id, url: 'chrome://extensions/' }); };
    flush(function () {
      var cfg = bg.stored.config;
      (bg.badge.text === 'ON' && Object.keys(bg.badge.tabTexts).length === 0 &&
        bg.sent.length === sentBefore && cfg && cfg.mode === 'dark')
        ? ok('受限页：徽标仍是全局 ON、零 per-tab、黑白状态不受影响')
        : bad('受限页徽标', JSON.stringify({ g: bg.badge.text, tabs: bg.badge.tabTexts, sent: bg.sent.length }));
    });
  })();

  // 回归：昼夜切换（storage.onChanged 主通道）只重写全局徽标
  (function () {
    var bg = runBackground({ native: true, seedConfig: C.normalize({ mode: 'dark' }) });
    flush(function () {
      bg.listeners.storageChanged({
        config: { newValue: C.normalize({ mode: 'light' }), oldValue: null }
      }, 'local');
      flush(function () {
        (bg.badge.text === 'OFF' && Object.keys(bg.badge.tabTexts).length === 0)
          ? ok('昼夜切换：全局徽标翻转为 OFF')
          : bad('昼夜切换徽标', JSON.stringify({ g: bg.badge.text, tabs: bg.badge.tabTexts }));
      });
    });
  })();

  // 回归：SW 冷启动（扩展管理页"重新加载"、没有任何 tabs 事件）也要写对全局
  // 徽标 —— 这是"扩展重载后角标空白"的守卫。
  (function () {
    var bg = runBackground({ native: true, seedConfig: C.normalize({ mode: 'dark' }) });
    flush(function () {
      (bg.badge.text === 'ON')
        ? ok('冷启动：全局徽标写为 ON')
        : bad('冷启动徽标', String(bg.badge.text));
    });
  })();

  // sun.badgeState —— 徽标文本与颜色的唯一出口（三个写入方共用）
  (function () {
    var dark = S.badgeState(C.normalize({ mode: 'dark' }));
    var light = S.badgeState(C.normalize({ mode: 'light' }));
    var off = S.badgeState(C.normalize({ enabled: false }));
    (dark.text === 'ON' && dark.color === '#3B6D11' &&
      light.text === 'OFF' && light.color === '#8A8A8A' && off.text === 'OFF')
      ? ok('sun.badgeState：黑夜 ON(绿) / 白天 OFF(灰) / 总开关关闭 OFF')
      : bad('sun.badgeState', JSON.stringify({ dark: dark, light: light, off: off }));
  })();

  // 回归：savedAt 时间戳对账 —— loadConfig 回读命中滞后旧快照（savedAt 比内存
  // 小）时，保留内存中的较新状态（供启动/alarm/自愈等仍需读 storage 的路径使用）。
  (function () {
    var seed = C.normalize({ mode: 'dark' });
    seed.savedAt = Date.now() + 10000;   // 内存/落盘均为"较新"的时间戳
    var bg = runBackground({ native: true, seedConfig: seed });
    flush(function () {
      /* 模拟滞后：回读返回 savedAt 更小的旧白天快照 */
      bg.box.chrome.storage.local.get = function (k, cb) {
        var stale = C.normalize({ mode: 'light' });
        stale.savedAt = Date.now() - 10000;
        cb({ config: stale });
      };
      bg.listeners.onAlarm({ name: 'nw-switch' });   // 昼夜切换闹钟走 loadConfig 路径
      flush(function () {
        (bg.badge.text === 'ON' && bg.stored.config.mode === 'dark')
          ? ok('savedAt 对账：滞后旧快照不覆盖内存较新状态')
          : bad('savedAt 对账失败', JSON.stringify({ g: bg.badge.text, m: bg.stored.config && bg.stored.config.mode }));
      });
    });
  })();

  // 回归：normalize 保留 savedAt 字段（unknown key 会被丢弃，savedAt 必须幸存）
  (function () {
    var c = C.normalize({ savedAt: 12345 });
    (c.savedAt === 12345)
      ? ok('normalize 保留 savedAt 时间戳')
      : bad('normalize 丢 savedAt', String(c.savedAt));
  })();

  // 回归：nw 信号闹钟（config 编码进 name）—— UI 落盘后的可靠同步通道
  // （onMessage 不注册、onChanged 不可靠、回读 storage 滞后），SW 收到后
  // 直接采信信号里的 config，全量收敛：徽标 + 活动 tab per-tab + 广播。
  (function () {
    var bg = runBackground({ native: true, seedConfig: C.normalize({ mode: 'dark' }) });
    flush(function () {
      var lightCfg = C.normalize({ mode: 'light' });
      lightCfg.savedAt = Date.now();   // popup 落盘时打的戳
      bg.listeners.onAlarm({ name: 'nw{' + JSON.stringify(lightCfg) });
      flush(function () {
        var broadcasted = bg.sent.indexOf('nw:tick') >= 0;
        var noTabWrites = Object.keys(bg.badge.tabTexts).length === 0;
        (bg.badge.text === 'OFF' && broadcasted && noTabWrites)
          ? ok('nw 信号：采信信号 config，徽标收敛 OFF + 广播（零 per-tab）')
          : bad('nw 信号未收敛', JSON.stringify({ g: bg.badge.text, tabs: bg.badge.tabTexts, sent: bg.sent }));
      });
    });
  })();

  // 回归：乱序保护 —— 迟到的旧信号（savedAt 更小）不得覆盖新状态
  (function () {
    var bg = runBackground({ native: true, seedConfig: C.normalize({ mode: 'dark' }) });
    flush(function () {
      var newer = C.normalize({ mode: 'light' });
      newer.savedAt = Date.now();
      var older = C.normalize({ mode: 'dark' });
      older.savedAt = Date.now() - 10000;
      bg.listeners.onAlarm({ name: 'nw{' + JSON.stringify(newer) });
      bg.listeners.onAlarm({ name: 'nw{' + JSON.stringify(older) });
      flush(function () {
        (bg.badge.text === 'OFF')
          ? ok('乱序保护：迟到的旧信号被丢弃，徽标保持新状态 (OFF)')
          : bad('乱序信号覆盖新状态', String(bg.badge.text));
      });
    });
  })();

  // 回归：过期手动模式被 normalize 自愈时必须落盘并广播。
  // 真实场景：闹钟缺席（SW 休眠）跨过失效点，自愈只改内存的话徽标按白天算 OFF，
  // 而所有页面还停留在最后一次广播的黑夜 —— 状态分裂"页面黑夜 + 徽标全 OFF"。
  (function () {
    var raw = C.normalize({ mode: 'dark' });
    raw.manualUntil = Date.now() - 1000;   // 已过期（不经 normalize，模拟 storage 原值）
    var bg = runBackground({ native: true, seedConfig: raw });
    flush(function () {
      var cfg = bg.stored.config;
      var broadcast = bg.sent.indexOf('nw:tick') >= 0;
      /* 自愈后是 auto 模式，徽标应与 auto 的实时判定一致（白天 OFF / 黑夜 ON） */
      var expect = S.shouldBeDark(C.normalize({ mode: 'auto' })) ? 'ON' : 'OFF';
      (cfg && cfg.mode === 'auto' && cfg.manualUntil === 0 && bg.badge.text === expect && broadcast)
        ? ok('过期手动自愈：落盘回 auto + 徽标同步 (' + expect + ') + 广播收敛页面')
        : bad('过期自愈未收敛', JSON.stringify({ m: cfg && cfg.mode, u: cfg && cfg.manualUntil, b: bg.badge.text, expect: expect, sent: bg.sent }));
    });
  })();
})();

/* [9] storage 直写通道（UI 与后台之间唯一的"变更"通道）
 *
 * 现场证据（Chrome Secure Preferences -> serviceworkerevents）：本机 Chrome 152
 * 上后台成功注册的监听器里**没有** runtime.onMessage —— popup 里所有走
 * sendMessage 的操作全部石沉大海，症状就是"改完关掉面板又变回去"。
 * 所以 popup/options 只做两件事：直写 chrome.storage.local + 发信号闹钟；
 * runtime.onMessage 那套分支已彻底删除（在本机是死代码）。
 *
 * 下面用最小 DOM 夹具把 popup.js 真跑一遍，验证：
 *   a) store.js 读写正常
 *   b) popup 能读到配置（不依赖任何消息通道）
 *   c) popup 改亮度能落盘
 *   d) popup 站点开关能落盘
 *   e) 后台靠 storage.onChanged 完成广播
 *   f) 徽标同帧翻转（UI 自己写全局徽标）
 *   g) 后台 storage.onChanged 路径刷徽标
 *   h) 信号闹钟两端一致（store.signal 的 name 能被 background 解析）
 *   i) 总开关门控 / j) 受限页门控 / k) 落盘后发信号闹钟
 */
afterSections(function () {
  console.log('[9] storage 直写通道（UI 变更的唯一入口）');
  /* ---- 最小 DOM 夹具：只实现 popup.js 真正用到的部分 ---- */
  function makePopupDom() {
    var nodes = {};
    function el(tag) {
      return {
        tagName: tag, style: {}, title: '', value: '', textContent: '',
        checked: false, className: '', children: [],
        classList: {
          _s: {},
          add: function (c) { this._s[c] = 1; },
          remove: function (c) { delete this._s[c]; },
          toggle: function (c, on) { if (on) this._s[c] = 1; else delete this._s[c]; },
          contains: function (c) { return !!this._s[c]; }
        },
        addEventListener: function (ev, fn) { this._h = this._h || {}; this._h[ev] = fn; },
        /* 真 DOM 的 .click() 会带上 currentTarget；夹具也补上，
         * 否则依赖 e.currentTarget 的处理器会被喂 undefined。 */
        click: function () {
          var fn = this._h && this._h.click;
          if (fn) fn({ currentTarget: this, target: this });
        },
        appendChild: function (c) { this.children.push(c); return c; },
        getAttribute: function (a) { return this._attrs && this._attrs[a]; },
        querySelector: function () { return null; }
      };
    }
    ['status', 'brightness', 'brightnessOut', 'temperature', 'temperatureOut',
     'siteName', 'openOptions', 'learnMore',
     /* 唯一的"为什么用不了"提示块 + 两行原因（对应 popup.html #noticeBlock） */
     'noticeBlock', 'noticeDisabled', 'noticeUnsupported'].forEach(function (id) {
      nodes[id] = el('div');
      nodes[id].id = id;
    });
    var modeBtns = ['auto', 'dark', 'light'].map(function (m) {
      var b = el('button');
      b._attrs = { 'data-mode': m };
      return b;
    });
    /* 站点三态按钮：follow / dark / light（对应 popup.html #siteSeg） */
    var siteBtns = ['follow', 'dark', 'light'].map(function (m) {
      var b = el('button');
      b._attrs = { 'data-site': m };
      return b;
    });
    var siteRow = el('div');

    var doc = {
      getElementById: function (id) { return nodes[id] || null; },
      querySelector: function (sel) { return sel === '.site' ? siteRow : null; },
      querySelectorAll: function (sel) {
        if (sel === '#modeSeg button') return modeBtns;
        if (sel === '#siteSeg button') return siteBtns;
        return [];
      },
      createElement: el,
      body: el('body'),
      /* 面板换肤把 .nw-light 挂在 <html> 上（见 popup.js applyTheme），
       * 夹具必须有 documentElement，否则 [9] 段直接崩。 */
      documentElement: el('html')
    };
    return { doc: doc, nodes: nodes, modeBtns: modeBtns, siteBtns: siteBtns, siteRow: siteRow };
  }

  /* ---- 存储夹具：真的存、真的读，能触发 onChanged ---- */
  function makeStorage() {
    var data = {};
    var subs = [];
    return {
      data: data,
      subs: subs,
      local: {
        get: function (key, cb) { var r = {}; r[key] = data[key]; cb(r); },
        set: function (obj, cb) {
          var changes = {};
          Object.keys(obj).forEach(function (k) {
            changes[k] = { oldValue: data[k], newValue: obj[k] };
            data[k] = obj[k];
          });
          if (cb) cb();
          subs.forEach(function (fn) { fn(changes, 'local'); });
        }
      }
    };
  }

  /* ---- 跑 popup.js ---- */
  function runPopup(opts) {
    opts = opts || {};
    var fix = makePopupDom();
    var st = makeStorage();
    if (opts.seed) st.data.config = opts.seed;

    var sendCalls = [];
    var badge = { text: null, color: null, tabTexts: {} };
    var alarmsCreated = [];   // 记录 alarms.create（nw{...} 信号闹钟）
    /* localStorage 桩：面板换肤的"首帧上色"缓存（html.nw-light 防闪的依据） */
    var ls = {
      data: {},
      getItem: function (k) {
        return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null;
      },
      setItem: function (k, v) { this.data[k] = String(v); }
    };
    var chrome = {
      runtime: {
        id: 'test',
        lastError: null,
        openOptionsPage: function () {},
        getURL: function (p) { return 'chrome-extension://test/' + p; }
      },
      action: {
        /* 全局徽标记 badge.text；tabTexts 记 per-tab —— 面板不该往里写任何东西 */
        setBadgeText: function (o) {
          if (o && o.tabId) badge.tabTexts[o.tabId] = o.text;
          else badge.text = o && o.text;
        },
        setBadgeBackgroundColor: function (o) { badge.color = o && o.color; }
      },
      alarms: {
        create: function (name) { alarmsCreated.push(name); }
      },
      storage: {
        local: st.local,
        onChanged: { addListener: function (fn) { st.subs.push(fn); }, removeListener: function () {} }
      },
      tabs: {
        /* opts.url：模拟受限页面（chrome:// 等）下打开面板 */
        query: function (q, cb) { cb([{ id: 1, url: (opts && opts.url) || 'https://example.com/page' }]); },
        create: function (o) { sendCalls.push('tabs.create:' + (o && o.url)); },
        sendMessage: function () { return Promise.resolve(); }
      },
      i18n: { getMessage: function (k) { return k; }, getUILanguage: function () { return 'zh-CN'; } }
    };

    var box = {
      console: console, Promise: Promise, Date: Date, Math: Math, JSON: JSON,
      Array: Array, Object: Object, String: String, Number: Number,
      isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat,
      setTimeout: setTimeout, clearTimeout: clearTimeout,
      URL: URL, chrome: chrome, document: fix.doc, localStorage: ls,
      addEventListener: function () {}, removeEventListener: function () {}
    };
    box.window = box;
    box.globalThis = box;
    vm.createContext(box);

    ['config', 'sun', 'matcher', 'store'].forEach(function (n) {
      new vm.Script(read('src/lib/' + n + '.js'), { filename: n + '.js' }).runInContext(box);
    });
    new vm.Script(read('src/popup/popup.js'), { filename: 'popup.js' }).runInContext(box);

    return {
      box: box, fix: fix, st: st, sendCalls: sendCalls, chrome: chrome,
      badge: badge, alarmsCreated: alarmsCreated, ls: ls
    };
  }

  // (a) store.js 基本读写
  (function () {
    var st = makeStorage();
    var box = {
      console: console, Promise: Promise, URL: URL,
      chrome: {
        runtime: {},
        storage: {
          local: st.local,
          onChanged: { addListener: function () {}, removeListener: function () {} }
        }
      }
    };
    box.window = box; box.globalThis = box;
    vm.createContext(box);
    new vm.Script(read('src/lib/store.js'), { filename: 'store.js' }).runInContext(box);
    var S = box.NW.store;
    S.read().then(function (v) {
      return S.write({ probe: 1 }).then(function () { return v; });
    }).then(function (v) {
      flush(function () {
        (v === null) ? ok('store.read 空存储返回 null') : bad('store.read', String(v));
        (st.data.config && st.data.config.probe === 1)
          ? ok('store.write 真的写进了 storage')
          : bad('store.write', JSON.stringify(st.data.config));
      });
    }).catch(function (e) { bad('store', e.message); });
  })();

  // (b)(c)(d) 无消息通道时 popup 的读 / 写 / 站点开关（全靠 storage 直连）
  (function () {
    var seed = require(path.join(ROOT, 'src/lib/config.js'))
      .normalize({ mode: 'dark', theme: { brightness: 77, temperature: -25 } });
    var p = runPopup({ seed: seed });

    flush(function () {
      var b = p.fix.nodes.brightness.value;
      var t = p.fix.nodes.temperature.value;
      (b === 77) ? ok('无消息通道：popup 读到 brightness=77') : bad('popup 读 brightness', String(b));
      (t === -25) ? ok('无消息通道：popup 读到 temperature=-25') : bad('popup 读 temperature', String(t));
      (p.fix.nodes.status.textContent !== 'msgNoBackground')
        ? ok('无消息通道：不误报"连不上后台"')
        : bad('popup 误报', '状态行显示通信失败，但 storage 是通的');

      // 拖动亮度并松手 -> 必须落盘
      p.fix.nodes.brightness.value = '62';
      p.fix.nodes.brightness._h.input({ target: { value: '62' } });
      p.fix.nodes.brightness._h.change({ target: {} });

      flush(function () {
        var saved = p.st.data.config && p.st.data.config.theme && p.st.data.config.theme.brightness;
        (saved === 62) ? ok('无消息通道：亮度改动已落盘 (=62)') : bad('亮度落盘', String(saved));
        (p.fix.nodes.status.textContent !== 'msgNoBackground')
          ? ok('无消息通道：落盘成功且无错误提示')
          : bad('落盘后误报', '状态行报错');

        p.fix.siteBtns[1].click();   // 强制夜间 -> 黑名单
        flush(function () {
          var lists = p.st.data.config && p.st.data.config.lists;
          var total = lists ? lists.blacklist.length + lists.whitelist.length : 0;
          (total === 1 && lists.blacklist.length === 1)
            ? ok('无消息通道：站点三态已落盘（黑名单 1 条）')
            : bad('站点三态落盘', JSON.stringify(lists));
        });
      });
    });
  })();

  // (e) 后台在 onMessage 缺席时，靠 storage.onChanged 完成广播
  (function () {
    var bg = runBackground({ native: true });
    var next = require(path.join(ROOT, 'src/lib/config.js')).normalize({ mode: 'dark' });
    bg.listeners.storageChanged({ config: { newValue: next, oldValue: null } }, 'local');
    flush(function () {
      bg.sent.indexOf('nw:tick') >= 0
        ? ok('storage.onChanged 触发广播（UI 直写也能让页面跟着变）')
        : bad('storage 广播', '未发出 nw:tick；sent=' + JSON.stringify(bg.sent));
    });
  })();

  // (f) popup 点击模式 -> 徽标同帧翻转（不等落盘，更不等后台）
  (function () {
    var CC = require(path.join(ROOT, 'src/lib/config.js'));
    var p = runPopup({ seed: CC.normalize({ mode: 'dark' }) });
    flush(function () {
      (p.badge.text === 'ON')
        ? ok('popup 打开面板即校准徽标：黑夜 -> ON')
        : bad('popup 徽标校准', String(p.badge.text));

      p.fix.modeBtns[2].click();   // 切到白天
      (p.badge.text === 'OFF')
        ? ok('点击白天：徽标同帧变 OFF（不等落盘与后台）')
        : bad('白天徽标同帧', String(p.badge.text));

      p.fix.modeBtns[1].click();   // 再切回黑夜
      (p.badge.text === 'ON')
        ? ok('点击黑夜：徽标同帧变 ON')
        : bad('黑夜徽标同帧', String(p.badge.text));
    });
  })();

  // (g) 后台 storage.onChanged 路径的徽标更新（先徽标后排程，排程出错不连累徽标）
  (function () {
    var CC = require(path.join(ROOT, 'src/lib/config.js'));
    var bg = runBackground({ native: true, seedConfig: CC.normalize({ mode: 'dark' }) });
    flush(function () {
      (bg.badge.text === 'ON')
        ? ok('后台启动：黑夜徽标 ON')
        : bad('后台徽标 ON', String(bg.badge.text));

      bg.listeners.storageChanged({
        config: { newValue: CC.normalize({ mode: 'light' }), oldValue: null }
      }, 'local');
      flush(function () {
        (bg.badge.text === 'OFF')
          ? ok('storage.onChanged -> 徽标 OFF（先徽标后排程）')
          : bad('storage 徽标', String(bg.badge.text));
      });
    });
  })();

  // (h) 信号闹钟两端一致：store.signal 生成的 name 必须能被 background 解析，
  // 且后台直接采信信号里的 config、绝不回读 storage
  // （真机实证：本机其它上下文刚 set 完，SW 侧立刻 get 拿到的是"上一次"的旧值）。
  (function () {
    var CC = require(path.join(ROOT, 'src/lib/config.js'));

    /* 用 store.js 自己生成信号，保证前缀/编码方式与 UI 侧一字不差 */
    var sigName = null;
    var sbox = {
      console: console, Promise: Promise, Date: Date, JSON: JSON, Object: Object,
      chrome: { alarms: { create: function (n) { sigName = n; } } }
    };
    sbox.window = sbox; sbox.globalThis = sbox;
    vm.createContext(sbox);
    new vm.Script(read('src/lib/store.js'), { filename: 'store.js' }).runInContext(sbox);
    var light = CC.normalize({ mode: 'light' });
    light.savedAt = Date.now();
    sbox.NW.store.signal(light);

    (sigName && sigName.indexOf('nw{') === 0)
      ? ok('store.signal：信号闹钟 name 以 nw{ 开头')
      : bad('store.signal', String(sigName));

    var bg = runBackground({ native: true, seedConfig: CC.normalize({ mode: 'dark' }) });
    var stale = false;
    flush(function () {
      (bg.badge.text === 'ON')
        ? ok('后台启动：黑夜徽标 ON（信号前置）')
        : bad('后台徽标 ON', String(bg.badge.text));

      /* 恒返回旧值的 get：后台若错误地回读 storage，徽标就会停在 ON */
      bg.box.chrome.storage.local.get = function (k, cb) {
        stale = true; cb({ config: CC.normalize({ mode: 'dark' }) });
      };
      bg.listeners.onAlarm({ name: sigName });
      (bg.badge.text === 'OFF')
        ? ok('信号闹钟：后台采信信号里的 config，徽标同帧 OFF')
        : bad('信号未收敛', String(bg.badge.text));

      flush(function () {
        (!stale)
          ? ok('信号闹钟：未回读 storage（绕开写一拍滞后）')
          : bad('信号回读了 storage', '本机 get 有写一拍滞后，禁止回读');
        (bg.badge.text === 'OFF')
          ? ok('信号闹钟：徽标不被后续异步链改写')
          : bad('信号徽标被改写', String(bg.badge.text));
      });
    });
  })();

  /* (i) 门控统一：总开关关闭 → 所有控件（含滑杆）禁用、提示只从 noticeBlock 出、
   * 状态行留空；点击/拖动一律不落盘。 */
  (function () {
    var p = runPopup({ seed: C.normalize({ enabled: false }) });
    flush(function () {
      var n = p.fix.nodes;
      var allDisabled = p.fix.modeBtns[0].disabled && p.fix.modeBtns[1].disabled &&
        p.fix.siteBtns[1].disabled && n.brightness.disabled && n.temperature.disabled;
      var notice = n.noticeBlock.style.display !== 'none' &&
        n.noticeDisabled.style.display !== 'none' &&
        n.noticeUnsupported.style.display === 'none' &&
        n.learnMore.style.display === 'none';
      (allDisabled && notice && n.status.textContent === '')
        ? ok('总开关关闭：全部控件（含滑杆）禁用 + 提示只走 noticeBlock + 状态行留空')
        : bad('总开关门控', JSON.stringify({
            allDisabled: allDisabled, notice: notice, status: n.status.textContent
          }));

      p.fix.modeBtns[1].click();   // 黑夜 —— 应被忽略
      p.fix.siteBtns[1].click();   // 强制夜间 —— 应被忽略
      n.brightness.value = '80';
      n.brightness._h.input({ target: { value: '80' } });
      n.brightness._h.change({ target: {} });
      flush(function () {
        var cfg = p.st.data.config;
        (cfg && cfg.mode === 'auto' && cfg.manualUntil === 0 &&
          cfg.lists.blacklist.length + cfg.lists.whitelist.length === 0 &&
          cfg.theme.brightness === 100)
          ? ok('总开关关闭：昼夜/站点/滑杆操作均不落盘')
          : bad('popup 关态未门控', JSON.stringify({
              m: cfg && cfg.mode, u: cfg && cfg.manualUntil,
              l: cfg && cfg.lists, b: cfg && cfg.theme.brightness
            }));
      });
    });
  })();

  /* (j) 受限页（chrome:// 等）：控件统一禁用（含滑杆）、站点整行隐藏、
   * 提示只走 noticeBlock 的"不支持"一行；徽标仍只写全局值。 */
  (function () {
    var p = runPopup({ seed: C.normalize({ enabled: true }), url: 'chrome://settings/' });
    flush(function () {
      var n = p.fix.nodes;
      (Object.keys(p.badge.tabTexts).length === 0)
        ? ok('受限页：popup 不写任何 per-tab 徽标')
        : bad('popup 写了 per-tab', JSON.stringify(p.badge.tabTexts));

      var allDisabled = p.fix.modeBtns[0].disabled && p.fix.modeBtns[1].disabled &&
        n.brightness.disabled && n.temperature.disabled;
      var notice = n.noticeBlock.style.display !== 'none' &&
        n.noticeUnsupported.style.display !== 'none' &&
        n.noticeDisabled.style.display === 'none' &&
        n.learnMore.style.display !== 'none' &&
        n.status.textContent === '';
      (allDisabled && notice && p.fix.siteRow.style.display === 'none')
        ? ok('受限页：控件禁用 + 站点行隐藏 + 提示只走 noticeBlock（不支持一行）')
        : bad('受限页控件/提示', JSON.stringify({
            allDisabled: allDisabled, notice: notice, siteRow: p.fix.siteRow.style.display
          }));

      p.fix.modeBtns[1].click();   // 黑夜 —— 应被忽略
      p.fix.siteBtns[1].click();   // 强制夜间 —— 同样应被忽略（handler 兜底新补了本页判定）
      flush(function () {
        var cfg = p.st.data.config;
        (cfg && cfg.mode === 'auto' && cfg.manualUntil === 0 &&
          cfg.lists.blacklist.length + cfg.lists.whitelist.length === 0)
          ? ok('受限页：昼夜与站点操作均不生效')
          : bad('popup 受限页未门控', JSON.stringify({
              m: cfg && cfg.mode, u: cfg && cfg.manualUntil, l: cfg && cfg.lists
            }));
      });
    });
  })();

  /* (j2) 两种原因同时成立（总开关关闭 + 受限页）：同一个提示块里显示两行，
   * 不再像以前那样两块提示各说各话。 */
  (function () {
    var p = runPopup({ seed: C.normalize({ enabled: false }), url: 'chrome://settings/' });
    flush(function () {
      var n = p.fix.nodes;
      (n.noticeBlock.style.display !== 'none' &&
        n.noticeDisabled.style.display !== 'none' &&
        n.noticeUnsupported.style.display !== 'none' &&
        n.learnMore.style.display !== 'none')
        ? ok('总开关关闭 + 受限页：两行原因合并进同一个提示块')
        : bad('提示叠加处理', JSON.stringify({
            b: n.noticeBlock.style.display, d: n.noticeDisabled.style.display,
            u: n.noticeUnsupported.style.display
          }));
    });
  })();

  /* (j3) 普通页 + 已启用：一切正常 —— 控件可用、无提示块、状态行有昼夜文案。 */
  (function () {
    var p = runPopup({ seed: C.normalize({ mode: 'dark' }) });
    flush(function () {
      var n = p.fix.nodes;
      (!p.fix.modeBtns[0].disabled && !p.fix.siteBtns[0].disabled &&
        !n.brightness.disabled && n.noticeBlock.style.display === 'none' &&
        n.status.textContent !== '')
        ? ok('普通页 + 已启用：控件可用、无提示块、状态行有文案')
        : bad('正常态渲染', JSON.stringify({
            mode: p.fix.modeBtns[0].disabled, slider: n.brightness.disabled,
            block: n.noticeBlock.style.display, status: n.status.textContent
          }));
    });
  })();

  // (k) 回归：popup 落盘后必须发 nw 信号闹钟，且 name 里携带白天 config
  (function () {
    var p = runPopup({ seed: C.normalize({ mode: 'dark' }) });
    flush(function () {
      p.fix.modeBtns[2].click();   // 点白天 → save()
      flush(function () {
        var sig = p.alarmsCreated.filter(function (n) {
          return n && n.indexOf('nw{') === 0 && n.indexOf('"mode":"light"') >= 0;
        })[0];
        sig
          ? ok('popup 落盘后发 nw 信号闹钟（name 携带白天 config）')
          : bad('popup 未发信号闹钟', JSON.stringify(p.alarmsCreated).slice(0, 120));
      });
    });
  })();

  // (l) 面板换肤：popup 跟随"当前实际生效的明暗"（sun.badgeState）——
  // 黑夜 → 暗色（不加 nw-light），白天 / 总开关关闭 → 亮色（加 nw-light），
  // 并把结果写进 localStorage 供下次首帧上色（防"先暗后亮"闪一下）。
  (function () {
    var dark = runPopup({ seed: C.normalize({ mode: 'dark' }) });
    var light = runPopup({ seed: C.normalize({ mode: 'light' }) });
    var off = runPopup({ seed: C.normalize({ enabled: false }) });
    var auto = runPopup({ seed: C.normalize({ mode: 'auto' }) });
    /* auto 的期望值必须实时算：跑测试的时刻可能本来就是黑夜 */
    var autoLight = !S.shouldBeDark(C.normalize({ mode: 'auto' }));
    flush(function () {
      function lightOf(p) { return p.fix.doc.documentElement.classList.contains('nw-light'); }
      var got = { dark: lightOf(dark), light: lightOf(light), off: lightOf(off), auto: lightOf(auto) };
      (!got.dark && got.light && got.off && got.auto === autoLight)
        ? ok('面板换肤：黑夜暗色 / 白天亮色 / 关总开关亮色（跟随生效明暗）')
        : bad('面板换肤', JSON.stringify(got) + ' auto期望=' + autoLight);
      (light.ls.getItem('night-owl:theme') === 'light')
        ? ok('面板换肤：结果写进 localStorage（首帧防闪缓存）')
        : bad('面板换肤缓存', String(light.ls.getItem('night-owl:theme')));
    });
  })();
});

/* [10] preserveMedia 滤镜数学（媒体还原的正确性）
 *
 * 现场症状（2026-09-11 首次 / 2026-09-13 用户复查）：黑夜模式下网页图片观感不对
 * —— 发灰、偏色、变浑浊（用户报"图片元素很奇怪"）。
 *
 * 硬约束：父级滤镜作用在 html 上，CSS **没有**把媒体子树"摘出去"的 API，
 * 所以"图片保持原样"只能靠媒体子级做**精确逆运算**。这要求父级只用可反向算子：
 *   invert(1) / hue-rotate / brightness / contrast / saturate —— 可反向；
 *   sepia（色温）、grayscale（灰度）—— 不可反向，一旦用在父级，图片必然偏色/发灰。
 *
 * 这些断言锁死修复后的不变量：
 *   a) preserveMedia 开启 -> 父级 invert 必须是 1（可逆前提）
 *   b) 关闭 -> 父级沿用用户设定的 invert 强度
 *   c) 媒体子级必须逐项抵消父级的 invert 与 hue-rotate
 *   d) 父子两侧的 invert 参数互为逆（1 与 1）
 *   e) preserveMedia 关闭 -> 不生成媒体规则（图片跟随父级变暗）
 *   f) 用户调饱和时，媒体子级出现 1/s 反向补偿
 *   g) **父级绝不出现 sepia / grayscale**（不可反向）—— 色温改用 hue-rotate+saturate，
 *      灰度折进 saturate(1-g)，两者都可被媒体精确反向
 *   h) 媒体子级含固定压暗 brightness(0.92) 且排在逆运算最前（= 只比白天暗一档）
 *   i) 父级 brightness / contrast 都被媒体反向补偿
 *   j) 色温冷/暖方向相反且媒体取反
 *   k) 媒体选择器覆盖 img/video/canvas…，含 svg:has(image) 与 [data-nw-preserve]
 */
afterSections(function () {
  console.log('[10] preserveMedia 滤镜数学');
  var FC = require(path.join(ROOT, 'src/lib/filter.js'));
  var CC = require(path.join(ROOT, 'src/lib/config.js'));

  function parsed(f) {
    var out = {};
    var re = /([a-zA-Z-]+)\(([^)]+)\)/g, m;
    while ((m = re.exec(String(f)))) out[m[1]] = m[2].trim();
    return out;
  }

  var onCfg = CC.normalize({ theme: { invert: 92 }, advanced: { preserveMedia: true } });
  var offCfg = CC.normalize({ theme: { invert: 92 }, advanced: { preserveMedia: false } });

  var onParent = FC.build(onCfg.theme, onCfg);
  var offParent = FC.build(offCfg.theme, offCfg);
  var onMedia = FC.buildMedia(onCfg.theme, onCfg);
  var offMedia = FC.buildMedia(offCfg.theme, offCfg);

  // (a) 开启保留 -> 父级 invert 必须为 1
  var pOn = parsed(onParent);
  (pOn['invert'] === '1')
    ? ok('保留开：父级 invert=1（可逆前提，媒体才能被还原）')
    : bad('保留开 invert', 'got invert(' + pOn['invert'] + ')，必须为 1 才能可逆还原');

  // (b) 关闭保留 -> 沿用用户强度 92%
  var pOff = parsed(offParent);
  (pOff['invert'] === '0.92')
    ? ok('保留关：父级沿用用户 invert=0.92')
    : bad('保留关 invert', 'got invert(' + pOff['invert'] + ')，应为 0.92');

  // (c) 媒体子级必须同时含 hue-rotate(180deg) 与 invert
  var mOn = parsed(onMedia);
  (mOn['hue-rotate'] === '180deg')
    ? ok('媒体子级含 hue-rotate(180deg)：抵消父级色相旋转')
    : bad('媒体子级 hue-rotate', JSON.stringify(mOn));
  (mOn['invert'] === '1')
    ? ok('媒体子级含 invert(1)：抵消父级 invert(1)（invert(1) 复合为恒等）')
    : bad('媒体子级 invert', JSON.stringify(mOn));

  // (d) 父子 invert 参数互为逆：1 与 1
  (pOn['invert'] === '1' && mOn['invert'] === '1')
    ? ok('父子 invert 配平：invert(1) · invert(1) = 恒等')
    : bad('父子 invert 配平', 'parent=' + pOn['invert'] + ' child=' + mOn['invert']);

  // (e) 关闭保留 -> 不生成媒体规则
  (offMedia === 'none')
    ? ok('保留关：媒体滤镜为 none（图片跟随父级一起变暗）')
    : bad('保留关媒体滤镜', 'got ' + offMedia);

  // (f) 用户调饱和 -> 媒体子级用 1/s 反向补偿
  var satCfg = CC.normalize({ theme: { saturation: 80 }, advanced: { preserveMedia: true } });
  var satMedia = parsed(FC.buildMedia(satCfg.theme, satCfg));
  var satVal = parseFloat(satMedia['saturate']);
  (isFinite(satVal) && Math.abs(satVal - 1.25) < 0.01)
    ? ok('饱和补偿：父级 saturate(0.8) -> 媒体 saturate(1.25)')
    : bad('饱和补偿', 'got saturate(' + satMedia['saturate'] + ')，期望 1.25');

  // (g) 关闭保留时不应出现饱和补偿
  var offSatCfg = CC.normalize({ theme: { saturation: 80 }, advanced: { preserveMedia: false } });
  (FC.buildMedia(offSatCfg.theme, offSatCfg) === 'none')
    ? ok('保留关：无饱和补偿（媒体规则不存在）')
    : bad('保留关饱和', '媒体规则应为 none');

  /* (h) 父级绝不出现 sepia / grayscale —— 本轮修复的核心回归守卫。
   * 它们不可反向，一旦回到父级，媒体再多补偿也还原不了（用户报的"图片奇怪"）。
   * 色温必须表达成 hue-rotate+saturate，灰度必须折进 saturate(1-g)。 */
  var grayCfg = CC.normalize({ theme: { grayscale: 50, temperature: 60 }, advanced: { preserveMedia: true } });
  var grayParent = FC.build(grayCfg.theme, grayCfg);
  (!/sepia\(/.test(grayParent) && !/grayscale\(/.test(grayParent))
    ? ok('父级无不可反向算子：不含 sepia / grayscale')
    : bad('父级含不可反向算子', grayParent);

  // (i) 灰度折进 saturate：grayscale(50) 等价 saturate(0.5)，媒体反向为 saturate(2)
  var grayMedia = FC.buildMedia(grayCfg.theme, grayCfg);
  (/saturate\(0\.450\)/.test(grayParent) && /saturate\(2\.222\)/.test(grayMedia))
    ? ok('灰度折进 saturate：父级 saturate(0.45)、媒体 saturate(2.222) 精确反向')
    : bad('灰度折进 saturate', JSON.stringify({ p: grayParent, m: grayMedia }));

  /* (j) 媒体固定压暗：brightness(0.92) 必须排在逆运算最前（否则会被父级 invert 反过来） */
  var onFirst = String(onMedia).split(' ')[0];
  (onFirst === 'brightness(0.920)')
    ? ok('媒体固定压暗：brightness(0.920) 居首（比白天暗一档）')
    : bad('媒体压暗', 'got ' + onFirst + '，期望 brightness(0.920) 居首');

  // (k) 亮度 / 对比度反向补偿
  var bcCfg = CC.normalize({ theme: { brightness: 80, contrast: 120 }, advanced: { preserveMedia: true } });
  var bcParent = FC.build(bcCfg.theme, bcCfg);
  var bcMedia = FC.buildMedia(bcCfg.theme, bcCfg);
  (/brightness\(0\.800\)/.test(bcParent) && /brightness\(1\.250\)/.test(bcMedia) &&
    /contrast\(1\.200\)/.test(bcParent) && /contrast\(0\.833\)/.test(bcMedia))
    ? ok('亮度/对比度补偿：父级 0.8/1.2 -> 媒体 1.25/0.833')
    : bad('亮度对比度补偿', JSON.stringify({ p: bcParent, m: bcMedia }));

  // (l) 色温：暖 = 负角、冷 = 正角，媒体取反
  var warmCfg = CC.normalize({ theme: { temperature: 100 }, advanced: { preserveMedia: true } });
  var coolCfg = CC.normalize({ theme: { temperature: -100 }, advanced: { preserveMedia: true } });
  (/hue-rotate\(-15deg\)/.test(FC.build(warmCfg.theme, warmCfg)) &&
    /hue-rotate\(15deg\)/.test(FC.buildMedia(warmCfg.theme, warmCfg)) &&
    /hue-rotate\(15deg\)/.test(FC.build(coolCfg.theme, coolCfg)) &&
    /hue-rotate\(-15deg\)/.test(FC.buildMedia(coolCfg.theme, coolCfg)))
    ? ok('色温改可反向算子：暖 -15deg / 冷 +15deg，媒体取反')
    : bad('色温算子', JSON.stringify({
        warm: FC.build(warmCfg.theme, warmCfg), warmM: FC.buildMedia(warmCfg.theme, warmCfg)
      }));

  // (m) 媒体选择器：覆盖位图类元素 + svg:has(image) + 手动标记
  ['img', 'video', 'canvas', 'svg:has(image)', '[data-nw-preserve]'].every(function (sel) {
    return FC.MEDIA_SELECTOR.indexOf(sel) >= 0;
  })
    ? ok('媒体选择器：img/video/canvas + svg:has(image) + [data-nw-preserve]')
    : bad('媒体选择器', FC.MEDIA_SELECTOR);

  // (n) 媒体亮度可调：取自 advanced.mediaDim（设置页「高级·媒体亮度」，60–100），
  //     随配置导出/导入；越界值被 normalize 钳制。
  var md80 = CC.normalize({ advanced: { preserveMedia: true, mediaDim: 80 } });
  var mdLow = CC.normalize({ advanced: { preserveMedia: true, mediaDim: 30 } });
  var md80First = String(FC.buildMedia(md80.theme, md80)).split(' ')[0];
  var mdLowFirst = String(FC.buildMedia(mdLow.theme, mdLow)).split(' ')[0];
  (md80First === 'brightness(0.800)' && mdLowFirst === 'brightness(0.600)')
    ? ok('媒体亮度可调：取自 advanced.mediaDim 且钳制在 60–100')
    : bad('媒体亮度可调', JSON.stringify({ at80: md80First, at30: mdLowFirst }));
});

/* [11] content.js 消息通道（tick 优先采用消息配置，缺失才回读 storage）
 *
 * 真机复现（tools/badge.e2e.js）确认的机器怪癖：其它上下文刚
 * chrome.storage.local.set 完，本上下文立刻 get 会拿到"上一次"的旧值
 * （写一拍滞后）。所以收到 tick 时消息里的配置（后台取自 storage.onChanged
 * 事件的新值）反而比回读更可靠；只有没带配置时才回读 storage。
 * （nw:apply 预览语义不变：直接应用消息配置。）
 */
afterSections(function () {
  console.log('[11] content.js 抗回退（stale 消息不得回退页面）');
  var CC = require(path.join(ROOT, 'src/lib/config.js'));
  var darkCfg = CC.normalize({ mode: 'dark' });
  var lightCfg = CC.normalize({ mode: 'light' });

  /* 与 [9] 段的 makeStorage 同款（那边是闭包局部，这里复用不了） */
  function makeStorage() {
    var data = {};
    var subs = [];
    return {
      data: data,
      subs: subs,
      local: {
        get: function (key, cb) { var r = {}; r[key] = data[key]; cb(r); },
        set: function (obj, cb) {
          var changes = {};
          Object.keys(obj).forEach(function (k) {
            changes[k] = { oldValue: data[k], newValue: obj[k] };
            data[k] = obj[k];
          });
          if (cb) cb();
          subs.forEach(function (fn) { fn(changes, 'local'); });
        }
      }
    };
  }

  function makeContentEnv(seedConfig) {
    var st = makeStorage();
    if (seedConfig) st.data.config = seedConfig;

    function el(tag) {
      return {
        tagName: tag, style: {}, textContent: '', id: '', type: '',
        children: [], isConnected: true, className: '',
        classList: {
          _s: {},
          add: function (c) { this._s[c] = 1; },
          remove: function (c) { delete this._s[c]; },
          toggle: function (c, on) {
            if (on === undefined) on = !this._s[c];
            if (on) this._s[c] = 1; else delete this._s[c];
          },
          contains: function (c) { return !!this._s[c]; }
        },
        appendChild: function (c) { this.children.push(c); return c; }
      };
    }

    var root = el('html'), head = el('head'), body = el('body');
    var ssStore = {};
    var rafQueue = [];
    var msgListeners = [];
    var chromeFake = {
      runtime: {
        lastError: null,
        onMessage: { addListener: function (fn) { msgListeners.push(fn); } }
      },
      storage: {
        local: st.local,
        onChanged: { addListener: function (fn) { st.subs.push(fn); } }
      }
    };

    var box = {
      console: console, Promise: Promise, Date: Date, Math: Math, JSON: JSON,
      Array: Array, Object: Object, String: String, Number: Number, Boolean: Boolean,
      isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat,
      setTimeout: setTimeout, clearTimeout: clearTimeout,
      /* rAF 手动排队：深色站点检测的时序由测试显式推进 */
      requestAnimationFrame: function (fn) { rafQueue.push(fn); return rafQueue.length; },
      /* 夹具页面无背景色 -> 检测走完 6 层后返回 false（确定性路径） */
      getComputedStyle: function () { return { backgroundColor: '' }; },
      chrome: chromeFake,
      location: { hostname: 'example.com', href: 'https://example.com/page' },
      sessionStorage: {
        getItem: function (k) {
          return Object.prototype.hasOwnProperty.call(ssStore, k) ? ssStore[k] : null;
        },
        setItem: function (k, v) { ssStore[k] = String(v); },
        removeItem: function (k) { delete ssStore[k]; }
      },
      document: {
        documentElement: root, head: head, body: body,
        getElementById: function () { return null; },
        createElement: el,
        addEventListener: function () {}
      }
    };
    box.window = box; box.globalThis = box;
    vm.createContext(box);

    ['config', 'sun', 'matcher', 'filter'].forEach(function (n) {
      new vm.Script(read('src/lib/' + n + '.js'), { filename: n + '.js' }).runInContext(box);
    });
    new vm.Script(read('src/content.js'), { filename: 'content.js' }).runInContext(box);

    return {
      st: st, root: root, chrome: chromeFake, rafQueue: rafQueue,
      isDark: function () { return root.classList.contains('nw-dark'); },
      runRaf: function () { rafQueue.splice(0).forEach(function (fn) { fn(); }); },
      dispatch: function (msg) { msgListeners.forEach(function (fn) { fn(msg, {}, function () {}); }); },
      tick: function (raw) { box.__nightOwlTick(raw); }
    };
  }

  // (a) 启动即按 storage 应用：黑夜配置 -> 页面变黑
  var env = makeContentEnv(darkCfg);
  env.runRaf();   // skipDarkSites 默认开：首轮深色站点检测排队在 rAF 里
  env.isDark()
    ? ok('content 启动：storage 黑夜 -> 页面 nw-dark')
    : bad('content 启动', '应为暗');

  // (b) storage 变白 -> 页面立即脱掉 nw-dark（storage.onChanged 主通道）
  env.st.local.set({ config: lightCfg }, function () {});
  (!env.isDark())
    ? ok('storage 变白天 -> 页面立即变白')
    : bad('storage 白天', '仍为暗');

  // (c) tick 携带配置 -> 直接采用（消息配置来自后台的事件新值，最可靠）
  env.dispatch({ type: 'nw:tick', config: lightCfg });
  (!env.isDark())
    ? ok('tick 携带 light 配置：页面保持白天')
    : bad('tick 配置', '应为亮');

  // (d) 补注入 __nightOwlTick()（无配置）-> 回读 storage，保持白天
  env.tick();
  (!env.isDark())
    ? ok('补注入 __nightOwlTick（无配置）：回读 storage 保持白天')
    : bad('补注入回读', '应为亮');

  // (e) tick 不带配置且 storage 读取失败 -> 保持现状（绝无回退）
  var env2 = makeContentEnv(lightCfg);
  env2.runRaf();
  var realGet = env2.st.local.get;
  env2.st.local.get = function (key, cb) {
    env2.chrome.runtime.lastError = { message: 'Extension context invalidated.' };
    cb(undefined);
    env2.chrome.runtime.lastError = null;
  };
  env2.dispatch({ type: 'nw:tick' });
  (!env2.isDark())
    ? ok('tick 无配置且读取失败：页面保持白天（不回退）')
    : bad('读取失败回退', '被旧状态打回黑夜');
  env2.st.local.get = realGet;
  // 读取恢复后一次正常 tick -> 回到 storage 最新值（白天）
  env2.dispatch({ type: 'nw:tick' });
  (!env2.isDark())
    ? ok('读取恢复后 tick：页面回到白天')
    : bad('读取恢复', '仍为暗');
});

/* [12] 面板换肤：两套主题的 CSS 变量必须齐全
 *
 * popup / 设置页靠 html.nw-light 切亮暗（见 AGENTS.md 不变量 9）。最容易犯的
 * 错是"加了个新颜色只写在 :root 里"，亮色下那一处就漏了。这里做静态校验：
 *   1) CSS 里用到的每个 var(--x) 都必须在 :root 里有定义；
 *   2) :root 里的颜色变量必须在 html.nw-light 里也给出取值
 *      —— 纯尺寸变量（--radius）列进白名单豁免。
 * 换句话说：以后往面板里加颜色，你没法"只改暗色那一套"。
 */
afterSections(function () {
  console.log('[12] 面板换肤 CSS（两套主题变量齐全）');
  var LAYOUT_ONLY = ['radius'];   // 纯尺寸/结构变量，不需要两套主题各定义一份

  /* 取出某个选择器块里声明的变量名（这些块里没有嵌套大括号，取首个 } 即可） */
  function themeVars(css, selector) {
    var i = css.indexOf(selector + ' {');
    if (i < 0) return null;
    var end = css.indexOf('}', i);
    if (end < 0) return null;
    var body = css.slice(i + selector.length, end);
    var out = [], m, re = /--([a-z0-9-]+)\s*:/g;
    while ((m = re.exec(body))) out.push(m[1]);
    return out;
  }

  [['popup', 'src/popup/popup.css'], ['options', 'src/options/options.css']].forEach(function (pair) {
    var name = pair[0], css = read(pair[1]);
    var base = themeVars(css, ':root');
    var light = themeVars(css, 'html.nw-light');
    if (!base || !light) {
      bad(name + ' 主题变量', '缺 :root 或 html.nw-light 变量块');
      return;
    }
    var used = [], m, re = /var\(--([a-z0-9-]+)/g;
    while ((m = re.exec(css))) if (used.indexOf(m[1]) < 0) used.push(m[1]);

    var undef = used.filter(function (k) { return base.indexOf(k) < 0; });
    var missingInLight = base.filter(function (k) {
      return LAYOUT_ONLY.indexOf(k) < 0 && light.indexOf(k) < 0;
    });
    (!undef.length && !missingInLight.length)
      ? ok(name + '：' + base.length + ' 个变量，用到的都有定义且亮色主题齐全')
      : bad(name + ' 主题变量', JSON.stringify({ undefined: undef, missingInLight: missingInLight }));
  });
});

finish();
