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
})();

/* ---------- 6. background.js in a simulated service worker ---------- */
console.log('[6] background.js');

function runBackground(opts) {
  var listeners = {};
  var sent = [];         // 记录 tabs.sendMessage，用于验证"广播是否真的发出去了"
  var stored = { config: {} };
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
    alarms: { create: function () {}, clear: function () {}, onAlarm: on('onAlarm') },
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
      onActivated: on('onActivated')
    },
    contextMenus: {
      removeAll: function (cb) { if (cb) cb(); },
      create: function (o, cb) { if (cb) cb(); },
      update: function (id, o, cb) { if (cb) cb(); },
      refresh: function () {},
      onClicked: on('onClicked')
    },
    action: { setBadgeText: function () {}, setBadgeBackgroundColor: function () {} },
    scripting: { executeScript: function () { return Promise.resolve(); } },
    i18n: { getMessage: function (k) { return k; } }
  };
  // 只有在没有 noApi 指定时才挂 onShown，用于模拟老/新版本差异
  if (!isAbsent('contextMenus', 'onShown')) chrome.contextMenus.onShown = on('onShown');

  var box = {
    console: { log: function () {}, warn: function () {}, error: function () {} },
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

  var want = ['onInstalled', 'onStartup', 'onAlarm', 'onCommand', 'onShown', 'onClicked', 'onMessage', 'storageChanged'];
  var missing = want.filter(function (k) { return typeof listeners[k] !== 'function'; });
  return { missing: missing, listeners: listeners, box: box, sent: sent, stored: stored, regFail: box.REG_FAIL, regSkip: box.REG_SKIP };
}

(function () {
  // (a) native service worker path
  var sw = runBackground({ native: true });
  if (sw.error) { bad('SW 原生路径执行', sw.error); return; }
  sw.missing.length ? bad('SW 监听器', 'missing ' + sw.missing.join(',')) : ok('SW 原生路径：8 个监听器全部注册');

  /* REGRESSION: one throwing registration must not kill the others.
   * This is the bug that made runtime.onMessage disappear on Chrome 152:
   * contextMenus.onClicked threw, onMessage was registered last, so the
   * popup/options had no channel to the background at all. */
  (function () {
    var hostile = runBackground({ native: true, breakApi: 'contextMenus.onClicked' });
    if (hostile.error) { bad('隔离注册（注入故障）', hostile.error); return; }
    var stillThere = ['onMessage', 'storageChanged', 'onAlarm', 'onCommand']
      .filter(function (k) { return typeof hostile.listeners[k] === 'function'; });
    stillThere.length === 4
      ? ok('隔离注册：onClicked 抛错时 onMessage/storage/alarms/commands 仍存活')
      : bad('隔离注册', '被拖死的监听器: ' + ['onMessage', 'storageChanged', 'onAlarm', 'onCommand']
        .filter(function (k) { return typeof hostile.listeners[k] !== 'function'; }).join(','));
    (hostile.regFail && hostile.regFail.length)
      ? ok('隔离注册：失败被记录 (' + hostile.regFail[0].slice(0, 40) + ')')
      : bad('隔离注册', 'REG_FAIL 未记录失败');
  })();

  /* REGRESSION: an event object that does not exist on this build.
   * The real report was `[Night Owl] FAILED to register:
   * contextMenus.onShown (api missing)` - the event is simply absent on
   * Chrome 152. Treating a cosmetic feature as a hard failure produced a
   * scary red console error and worried the user for no reason. */
  (function () {
    var noShown = runBackground({ native: true, noApi: 'contextMenus.onShown' });
    if (noShown.error) { bad('缺失事件（注入）', noShown.error); return; }
    (noShown.regSkip && noShown.regSkip.indexOf('contextMenus.onShown') >= 0)
      ? ok('缺失事件：onShown 被记为 optional-skipped')
      : bad('缺失事件', 'REG_SKIP 未记录 onShown');
    (!noShown.regFail || noShown.regFail.length === 0)
      ? ok('缺失事件：不产生 REG_FAIL（不再误报为致命错误）')
      : bad('缺失事件', '被误判为致命: ' + noShown.regFail.join(','));
    // 命脉仍然全部就位
    ['onMessage', 'storageChanged', 'onAlarm', 'onCommand', 'onClicked']
      .every(function (k) { return typeof noShown.listeners[k] === 'function'; })
      ? ok('缺失事件：onShown 不在时其余 8 项照常注册')
      : bad('缺失事件', '有监听器被连带拖死');
    // 兜底路径接管：onShown 缺席时应改用 tabs.onActivated
    (typeof noShown.listeners.onActivated === 'function')
      ? ok('缺失事件：兜底启用 tabs.onActivated')
      : bad('缺失事件', '兜底 tabs.onActivated 未注册');
  })();

  // (b) importScripts 失败后的回退路径（就是农场主屏幕上那个 status code 15）
  var ep = runBackground({ native: false });
  if (ep.error) { bad('回退路径执行', ep.error); return; }
  ep.missing.length ? bad('回退路径监听器', 'missing ' + ep.missing.join(',')) : ok('回退路径：8 个监听器全部注册');
  var em = ep.box.NW && ep.box.NW.matcher;
  (em && typeof em.toggleSiteDark === 'function')
    ? ok('回退路径：NW.matcher 可用（require 分支）')
    : bad('回退路径模块加载', 'NW.matcher 未就绪');

  /* The resolver must map every logical event name onto the right object, and
   * must come back empty (not throw, not mis-map) when one is absent. */
  (function () {
    var names = ['onMessage', 'storageChanged', 'onAlarm', 'onCommand',
                 'onInstalled', 'onStartup', 'onShown', 'onClicked'];
    var full = sw.listeners;
    var allOk = names.every(function (k) { return typeof full[k] === 'function'; });
    allOk ? ok('解析器：8 个事件全部命中原对象')
          : bad('解析器', '未命中: ' + names.filter(function (k) { return typeof full[k] !== 'function'; }).join(','));

    // 缺 onShown 时不能错配到别的对象上
    var deg = runBackground({ native: true, noApi: 'contextMenus.onShown' });
    (typeof deg.listeners.onShown !== 'function'
      && typeof deg.listeners.onClicked === 'function'
      && typeof deg.listeners.onMessage === 'function')
      ? ok('解析器：onShown 缺失时无错配，其余照常')
      : bad('解析器', 'onShown 缺失导致了错配');
  })();

  // onMessage 路由不能因垃圾消息抛错，异步应答必须返回 true
  try {
    var L = sw.listeners;
    L.onMessage(null, {}, function () {});
    L.onMessage({ type: 'unknown' }, {}, function () {});
    L.onMessage({ type: 'nw:read' }, {}, function () {}) === true
      ? ok('nw:read 异步应答（返回 true）')
      : bad('nw:read', '应返回 true');
  } catch (e) {
    bad('onMessage 路由', e.message);
  }

  /* nw:ping - popup uses it on open to detect a dead background immediately
   * instead of silently showing a panel where nothing works. */
  (function () {
    var p = runBackground({ native: true });
    var got = null;
    p.listeners.onMessage({ type: 'nw:ping' }, {}, function (r) { got = r; });
    (got && got.ok === true)
      ? ok('nw:ping 同步应答')
      : bad('nw:ping', JSON.stringify(got));
  })();

  /* END-TO-END: drag a popup slider, close, reopen - the value must stick.
   * This is the exact report: "options revert after I close the panel". */
  (function () {
    var p = runBackground({ native: true });
    var saved = null;
    // popup 'change' -> save() -> nw:save
    var cfg = JSON.parse(JSON.stringify(require(path.join(ROOT, 'src/lib/config.js')).DEFAULTS));
    cfg.theme.brightness = 62;
    cfg.theme.temperature = -40;
    p.listeners.onMessage({ type: 'nw:save', config: cfg }, {}, function (r) { saved = r; });
    flush(function () {
      var b = p.stored.config && p.stored.config.theme && p.stored.config.theme.brightness;
      var t = p.stored.config && p.stored.config.theme && p.stored.config.theme.temperature;
      (b === 62) ? ok('滑块落盘：brightness=62 持久化') : bad('滑块落盘 brightness', String(b));
      (t === -40) ? ok('滑块落盘：temperature=-40 持久化') : bad('滑块落盘 temperature', String(t));
      // reopen: nw:read must return the stored values
      var read = null;
      p.listeners.onMessage({ type: 'nw:read' }, {}, function (r) { read = r; });
      flush(function () {
        (read && read.ok && read.config.theme.brightness === 62)
          ? ok('重开面板：nw:read 返回 62（不回弹）')
          : bad('重开面板回读', JSON.stringify(read && read.config && read.config.theme));
      });
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
  // nw:save（popup 切模式 / 设置页保存）必须广播
  var r1 = runBackground({ native: true });
  r1.listeners.onMessage({ type: 'nw:save', config: { mode: 'dark' } }, {}, function () {});
  flush(function () {
    r1.sent.indexOf('nw:tick') >= 0
      ? ok('nw:save -> 广播 nw:tick（手动切模式即时生效）')
      : bad('nw:save 广播', '未发送 nw:tick');
  });

  // 右键菜单点击必须广播，且白名单要落盘
  var r2 = runBackground({ native: true });
  r2.listeners.onClicked({ menuItemId: 'nw-whitelist', pageUrl: 'https://example.com/' });
  flush(function () {
    r2.sent.indexOf('nw:tick') >= 0
      ? ok('右键菜单 -> 广播 nw:tick')
      : bad('右键菜单广播', '未发送 nw:tick');
    var wl = r2.stored.config && r2.stored.config.lists && r2.stored.config.lists.whitelist;
    (wl && wl.length === 1 && wl[0] === 'example.com')
      ? ok('右键菜单 -> 白名单已落盘')
      : bad('右键菜单落盘', JSON.stringify(wl));
  });

  // nw:site-toggle（popup 站点开关）必须广播
  var r3 = runBackground({ native: true });
  r3.listeners.onMessage({ type: 'nw:site-toggle', url: 'https://example.com/', currentDark: false }, {}, function () {});
  flush(function () {
    r3.sent.indexOf('nw:tick') >= 0
      ? ok('nw:site-toggle -> 广播 nw:tick')
      : bad('nw:site-toggle 广播', '未发送 nw:tick');
    var bl = r3.stored.config && r3.stored.config.lists && r3.stored.config.lists.blacklist;
    (bl && bl.length === 1) ? ok('nw:site-toggle -> 黑名单已落盘') : bad('nw:site-toggle 落盘', JSON.stringify(bl));
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
})();

/* [9] storage 直写通道（onMessage 缺席时的主通道）
 *
 * 本轮核心回归。
 *
 * 现场证据（Chrome Secure Preferences -> serviceworkerevents）：
 *   成功注册的是 alarms/commands/contextMenus/runtime.onInstalled/
 *   runtime.onStartup/storage.onChanged/tabs.onActivated —— 7 个，
 *   唯独没有 runtime.onMessage。
 * 于是 popup 里所有走 sendMessage 的操作全部石沉大海，
 * 症状就是"改完关掉面板又变回去"。
 *
 * 修复后 popup/options 直接读写 chrome.storage.local。
 * 下面用最小 DOM 夹具把 popup.js 真跑一遍，验证：
 *   a) store.js 读写正常
 *   b) onMessage 完全不可用时，popup 依然能读到配置
 *   c) onMessage 完全不可用时，popup 改亮度依然能落盘
 *   d) popup 站点开关依然能落盘
 *   e) 后台在 onMessage 缺席时，靠 storage.onChanged 完成广播
 */
afterSections(function () {
  console.log('[9] storage 直写通道（onMessage 缺席时的主通道）');
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
        appendChild: function (c) { this.children.push(c); return c; },
        getAttribute: function (a) { return this._attrs && this._attrs[a]; },
        querySelector: function () { return null; }
      };
    }
    ['master', 'status', 'brightness', 'brightnessOut', 'temperature',
     'temperatureOut', 'siteName', 'siteToggle', 'openOptions'].forEach(function (id) {
      nodes[id] = el('div');
      nodes[id].id = id;
    });
    var modeBtns = ['auto', 'dark', 'light'].map(function (m) {
      var b = el('button');
      b._attrs = { 'data-mode': m };
      return b;
    });
    var siteRow = el('div');

    var doc = {
      getElementById: function (id) { return nodes[id] || null; },
      querySelector: function (sel) { return sel === '.site' ? siteRow : null; },
      querySelectorAll: function (sel) {
        if (sel === '#modeSeg button') return modeBtns;
        return [];
      },
      createElement: el,
      body: el('body')
    };
    return { doc: doc, nodes: nodes, modeBtns: modeBtns, siteRow: siteRow };
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
    var chrome = {
      runtime: {
        id: 'test',
        lastError: null,
        openOptionsPage: function () {},
        /* messagingAvailable=false 就是农场主机器上的真实情况 */
        sendMessage: function (m, cb) {
          sendCalls.push(m && m.type);
          if (opts.messagingAvailable === false) {
            chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
            if (cb) cb(undefined);
            chrome.runtime.lastError = null;
            return;
          }
          if (cb) cb({ ok: true });
        }
      },
      storage: {
        local: st.local,
        onChanged: { addListener: function (fn) { st.subs.push(fn); }, removeListener: function () {} }
      },
      tabs: {
        query: function (q, cb) { cb([{ id: 1, url: 'https://example.com/page' }]); },
        sendMessage: function () { return Promise.resolve(); }
      },
      i18n: { getMessage: function (k) { return k; }, getUILanguage: function () { return 'zh-CN'; } }
    };

    var box = {
      console: console, Promise: Promise, Date: Date, Math: Math, JSON: JSON,
      Array: Array, Object: Object, String: String, Number: Number,
      isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat,
      setTimeout: setTimeout, clearTimeout: clearTimeout,
      URL: URL, chrome: chrome, document: fix.doc,
      addEventListener: function () {}, removeEventListener: function () {}
    };
    box.window = box;
    box.globalThis = box;
    vm.createContext(box);

    ['config', 'sun', 'matcher', 'store'].forEach(function (n) {
      new vm.Script(read('src/lib/' + n + '.js'), { filename: n + '.js' }).runInContext(box);
    });
    new vm.Script(read('src/popup/popup.js'), { filename: 'popup.js' }).runInContext(box);

    return { box: box, fix: fix, st: st, sendCalls: sendCalls, chrome: chrome };
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

  // (b)(c)(d) onMessage 不可用时 popup 的读 / 写 / 站点开关
  (function () {
    var seed = require(path.join(ROOT, 'src/lib/config.js'))
      .normalize({ mode: 'dark', theme: { brightness: 77, temperature: -25 } });
    var p = runPopup({ seed: seed, messagingAvailable: false });

    flush(function () {
      var b = p.fix.nodes.brightness.value;
      var t = p.fix.nodes.temperature.value;
      (b === 77) ? ok('onMessage 死：popup 仍读到 brightness=77') : bad('popup 读 brightness', String(b));
      (t === -25) ? ok('onMessage 死：popup 仍读到 temperature=-25') : bad('popup 读 temperature', String(t));
      (p.fix.nodes.status.textContent !== 'msgNoBackground')
        ? ok('onMessage 死：不误报"连不上后台"')
        : bad('popup 误报', '状态行显示通信失败，但 storage 是通的');

      // 拖动亮度并松手 -> 必须落盘
      p.fix.nodes.brightness.value = '62';
      p.fix.nodes.brightness._h.input({ target: { value: '62' } });
      p.fix.nodes.brightness._h.change({ target: {} });

      flush(function () {
        var saved = p.st.data.config && p.st.data.config.theme && p.st.data.config.theme.brightness;
        (saved === 62) ? ok('onMessage 死：亮度改动已落盘 (=62)') : bad('亮度落盘', String(saved));
        (p.fix.nodes.status.textContent !== 'msgNoBackground')
          ? ok('onMessage 死：落盘成功且无错误提示')
          : bad('落盘后误报', '状态行报错');

        p.fix.nodes.siteToggle._h.click();
        flush(function () {
          var lists = p.st.data.config && p.st.data.config.lists;
          var total = lists ? lists.blacklist.length + lists.whitelist.length : 0;
          (total === 1)
            ? ok('onMessage 死：站点开关已落盘（1 条规则）')
            : bad('站点开关落盘', JSON.stringify(lists));
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
});

/* [10] preserveMedia 滤镜数学（媒体还原的正确性）
 *
 * 本轮修复的回归守卫。
 *
 * 现场症状：设置页「保留图片与视频的原始色彩」无论开关，网页图片都反色。
 *
 * 根因（真实 Chromium 像素实测，tools/e2e.js）：
 *   CSS filter 里 invert(k) 可逆 当且仅当 k=1；hue-rotate(180deg) 在 linearRGB
 *   做色相矩阵，高饱和色会超色域被 clamp，同样不可逆。
 *   旧父级 = invert(0.92) hue180 saturate(0.9) sepia(0.075) 是四重不可逆叠加，
 *   子级怎么补偿都还原不了 —— 实测 8 源色平均色差 Δ=154。
 *
 * 这些断言锁死修复后的不变量：
 *   a) preserveMedia 开启 -> 父级 invert 必须是 1（可逆前提）
 *   b) 关闭 -> 父级沿用用户设定的 invert 强度
 *   c) 媒体子级必须逐项抵消父级的 invert 与 hue-rotate
 *   d) 父子两侧的 invert 参数互为逆（1 与 1）
 *   e) preserveMedia 关闭 -> 不生成媒体规则（图片跟随父级变暗）
 *   f) 用户调饱和时，媒体子级出现 1/s 反向补偿
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
});

finish();
