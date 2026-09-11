/* 端到端模拟（第 2 版）：用假 chrome 跑真实 background.js + content.js
 *
 * 复现并验证：「切换白天模式页面不会自动更新，刷新才生效」
 *
 * 三个场景精确区分故障位置：
 *   A 一切正常                      -> 页面应跟随
 *   B tab 无 content script         -> 补注入应生效
 *   C 有 content script 但 probe 不应答
 *        （只吞 nw:query，nw:tick 正常）
 *                                   -> 页面仍应跟随（修复前这里必失败）
 *   D 消息通道彻底坏（query/tick 都吞）
 *                                   -> 页面仍应跟随（靠 storage 自发通道）
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var ROOT = path.resolve(__dirname, '..');

var LOG = path.join(__dirname, 'sim.result.txt');
function log() {
  fs.appendFileSync(LOG, Array.prototype.slice.call(arguments).join(' ') + '\n', 'utf8');
}
try { fs.writeFileSync(LOG, '', 'utf8'); } catch (e) {}

var PASS = 0, FAIL = 0;
function assert(name, got, want) {
  var good = String(got) === String(want);
  if (good) PASS++; else FAIL++;
  log('  ' + (good ? 'PASS' : 'FAIL') + '  ' + name + '  got=' + got + ' want=' + want);
}

/* ---------- 事件 ---------- */
function makeEvent() {
  var ls = [];
  return {
    addListener: function (fn) { ls.push(fn); },
    removeListener: function (fn) { var i = ls.indexOf(fn); if (i >= 0) ls.splice(i, 1); },
    hasListener: function (fn) { return ls.indexOf(fn) >= 0; },
    _emit: function () { var a = Array.prototype.slice.call(arguments); ls.forEach(function (f) { f.apply(null, a); }); }
  };
}

function makeChrome(opts) {
  opts = opts || {};
  var store = {};
  var ev = {
    'runtime.onMessage': makeEvent(),
    'runtime.onInstalled': makeEvent(),
    'runtime.onStartup': makeEvent(),
    'storage.onChanged': makeEvent(),
    'alarms.onAlarm': makeEvent(),
    'commands.onCommand': makeEvent(),
    'contextMenus.onClicked': makeEvent(),
    'contextMenus.onShown': makeEvent(),
    'tabs.onActivated': makeEvent()
  };
  var pages = opts.pages || {};
  var tabs = opts.tabs || [];

  var chrome = {
    runtime: {
      id: 'sim', lastError: null,
      onMessage: ev['runtime.onMessage'],
      onInstalled: ev['runtime.onInstalled'],
      onStartup: ev['runtime.onStartup'],
      getURL: function (p) { return 'chrome-extension://sim/' + p; },
      openOptionsPage: function () { },
      sendMessage: function (m, cb) { if (cb) cb({ ok: true }); }
    },
    storage: {
      local: {
        get: function (key, cb) {
          var out = {};
          if (typeof key === 'string') { if (store[key] !== undefined) out[key] = store[key]; }
          else if (Array.isArray(key)) key.forEach(function (k) { if (store[k] !== undefined) out[k] = store[k]; });
          else Object.keys(store).forEach(function (k) { out[k] = store[k]; });
          setTimeout(function () { cb(out); }, 1);
        },
        set: function (obj, cb) {
          var ch = {};
          Object.keys(obj).forEach(function (k) {
            ch[k] = { oldValue: store[k], newValue: obj[k] };
            store[k] = obj[k];
          });
          setTimeout(function () { if (cb) cb(); ev['storage.onChanged']._emit(ch, 'local'); }, 1);
        }
      },
      onChanged: ev['storage.onChanged']
    },
    tabs: {
      query: function (q, cb) { setTimeout(function () { cb(tabs); }, 1); },
      get: function (id, cb) { setTimeout(function () { cb(tabs[0]); }, 1); },
      sendMessage: function (tabId, msg, cb) {
        var page = pages[tabId];
        var reply = null;
        if (page && page._onMsg) reply = page._onMsg(msg);
        /* reply: undefined=页面不存在/不处理, false=吞掉不应答, object=同步应答 */
        if (reply === undefined) {
          chrome.runtime.lastError = { message: 'Could not establish connection.' };
          if (cb) cb(undefined);
          chrome.runtime.lastError = null;
          return;
        }
        if (reply === false) {
          /* 吞掉：故意不应答，模拟 probe 超时 */
          return;
        }
        if (cb) cb(reply);
      }
    },
    alarms: {
      create: function () { }, clear: function (n, cb) { if (cb) cb(true); },
      onAlarm: ev['alarms.onAlarm']
    },
    action: { setBadgeText: function () { }, setBadgeBackgroundColor: function () { } },
    contextMenus: {
      removeAll: function (cb) { if (cb) cb(); },
      create: function (o, cb) { if (cb) cb(); },
      update: function (i, o, cb) { if (cb) cb(); },
      refresh: function () { },
      onClicked: ev['contextMenus.onClicked'],
      onShown: ev['contextMenus.onShown']
    },
    commands: { onCommand: ev['commands.onCommand'] },
    scripting: {
      executeScript: function (o) {
        var page = pages[o.target.tabId];
        if (page && page._inject) page._inject();
        return Promise.resolve([]);
      }
    },
    i18n: { getMessage: function (k) { return k; }, getUILanguage: function () { return 'zh-CN'; } }
  };
  return { chrome: chrome, store: store, ev: ev, pages: pages };
}

/* ---------- 页面 ---------- */
function makePage(tabId, url, behavior) {
  /* behavior: 'normal' | 'swallow-query' | 'swallow-all' */
  behavior = behavior || 'normal';
  var cls = {};
  var msgListeners = [];
  var tickFn = null;

  function clsApi() {
    return {
      toggle: function (n, force) {
        var has = !!cls[n];
        var want = (force === undefined) ? !has : !!force;
        if (want) cls[n] = true; else delete cls[n];
      },
      contains: function (n) { return !!cls[n]; },
      add: function (n) { cls[n] = true; },
      remove: function (n) { delete cls[n]; }
    };
  }

  var sandbox = {
    console: { log: function () { }, warn: function () { }, error: function () { } },
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
    clearInterval: clearInterval, Promise: Promise, JSON: JSON, Date: Date, Math: Math,
    Object: Object, Array: Array, String: String, Number: Number, isFinite: isFinite,
    parseInt: parseInt, parseFloat: parseFloat, URL: URL,
    encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    requestAnimationFrame: function (fn) { setTimeout(fn, 0); },
    navigator: { userAgent: 'sim' },
    location: {
      href: url,
      hostname: (function () { try { return new URL(url).hostname; } catch (e) { return ''; } })(),
      protocol: (function () { try { return new URL(url).protocol; } catch (e) { return 'https:'; } })()
    },
    document: {
      hidden: false,
      documentElement: { classList: clsApi() },
      body: { nodeName: 'BODY' },
      head: { appendChild: function () { } },
      createElement: function () {
        return { id: '', type: '', textContent: '', style: {}, setAttribute: function () { }, appendChild: function () { } };
      },
      getElementById: function () { return null; },
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; },
      addEventListener: function () { }
    },
    sessionStorage: (function () {
      var m = {};
      return {
        getItem: function (k) { return m[k] === undefined ? null : m[k]; },
        setItem: function (k, v) { m[k] = String(v); },
        removeItem: function (k) { delete m[k]; }
      };
    })(),
    getComputedStyle: function () { return { backgroundColor: 'rgba(0,0,0,0)' }; },
    chrome: null
  };

  var pageChrome = {
    runtime: {
      id: 'sim', lastError: null,
      onMessage: {
        addListener: function (fn) { msgListeners.push(fn); },
        removeListener: function () { }
      }
    },
    storage: {
      local: {
        get: function (k, cb) { sandbox.chrome.storage.local.get(k, cb); },
        set: function (o, cb) { sandbox.chrome.storage.local.set(o, cb); }
      },
      onChanged: {
        addListener: function (fn) { sandbox._storageCbs.push(fn); },
        removeListener: function () { }
      }
    }
  };
  sandbox._storageCbs = [];
  sandbox.chrome = pageChrome;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  /* storage.onChanged 转发 */
  var realGet = pageChrome.storage.local.get;
  vm.createContext(sandbox);

  function runFile(rel) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  }

  var injected = false;
  function inject() {
    injected = true;
    ['src/lib/config.js', 'src/lib/sun.js', 'src/lib/matcher.js',
      'src/lib/filter.js', 'src/content.js'].forEach(runFile);
  }

  return {
    _inject: inject,
    isInjected: function () { return injected; },
    isDark: function () { return !!cls['nw-dark']; },
    _storageCbs: sandbox._storageCbs,
    /* 模拟 SW -> content 的消息投递。返回 undefined=不处理, false=吞掉。 */
    _onMsg: function (msg) {
      if (behavior === 'swallow-all') return false;
      if (behavior === 'swallow-query' && msg && msg.type === 'nw:query') return false;
      var replied = undefined;
      for (var i = 0; i < msgListeners.length; i++) {
        msgListeners[i](msg, { id: 'sim' }, function (r) { replied = r || {}; });
      }
      return replied;
    },
    /* 模拟页面对 storage 的自发订阅（content.js 自己注册的回调） */
    fireStorage: function (newVal) {
      sandbox._storageCbs.forEach(function (fn) {
        fn({ config: { oldValue: null, newValue: newVal } }, 'local');
      });
    },
    sandbox: sandbox
  };
}

function bootSW(env) {
  var sandbox = {
    console: { log: function () { }, warn: function () { }, error: function () { } },
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
    clearInterval: clearInterval, Promise: Promise, JSON: JSON, Date: Date, Math: Math,
    Object: Object, Array: Array, String: String, Number: Number, isFinite: isFinite,
    parseInt: parseInt, parseFloat: parseFloat, URL: URL,
    chrome: env.chrome, self: null,
    importScripts: function () { throw new Error('sim: no importScripts'); },
    require: function (p) { return require(path.join(ROOT, p.replace(/^\.\//, 'src/'))); }
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  var CFG = require(path.join(ROOT, 'src/lib/config.js'));
  sandbox.NW = {
    config: CFG,
    sun: require(path.join(ROOT, 'src/lib/sun.js')),
    matcher: require(path.join(ROOT, 'src/lib/matcher.js'))
  };
  sandbox.NW.sun.NW = sandbox.NW.sun.NW || {};
  sandbox.NW.sun.NW.config = CFG;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8'), sandbox, { filename: 'src/background.js' });
  return sandbox;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var CFGmod = require(path.join(ROOT, 'src/lib/config.js'));

async function scenario(title, behavior, opts) {
  opts = opts || {};
  log('');
  log('### ' + title);

  var TAB = 1, URL = 'https://t.test/p';
  var page = makePage(TAB, URL, behavior);
  var env = makeChrome({
    tabs: [{ id: TAB, url: URL, active: true }],
    pages: { 1: page }
  });
  bootSW(env);
  if (opts.preInjected !== false) page._inject();
  await sleep(20);

  /* 初始配置 */
  var cfg0 = CFGmod.normalize({ mode: 'dark' });
  env.store.config = cfg0;
  page.fireStorage(cfg0);
  await sleep(30);

  if (opts.preInjected === false) {
    /* 页面没有 content script：此时 storage 通道无人监听，页面当然是白的。
     * 这正是补注入存在的意义 —— 真正的验收在切模式那一步。 */
    assert(title + ' · 初始无监听（预期未着色）', page.isDark(), false);
    assert(title + ' · 初始未注入', page.isInjected(), false);
  } else {
    assert(title + ' · 初始为黑夜', page.isDark(), true);
  }

  /* 用户切「白天」：popup 写 storage，同时 storage.onChanged 广播 */
  var cfg1 = CFGmod.normalize({ mode: 'light' });
  env.store.config = cfg1;
  env.ev['storage.onChanged']._emit({ config: { oldValue: cfg0, newValue: cfg1 } }, 'local');
  page.fireStorage(cfg1);
  await sleep(1600);   /* 覆盖 1200ms probe 上限 + 补注入往返 */

  assert(title + ' · 切白天页面跟随', page.isDark(), false);
  if (opts.preInjected === false) {
    assert(title + ' · 补注入已发生', page.isInjected(), true);
  }
}

async function main() {
  log('初始化：加载 lib（全局单例）');
  log('');

  await scenario('A 一切正常', 'normal', {});

  await scenario('B tab 无 content script（补注入路径）', 'normal', { preInjected: false });

  await scenario('C 有 content script 但 probe 不应答', 'swallow-query', {});

  await scenario('D 消息通道彻底坏（query+tick 全吞）', 'swallow-all', {});

  log('');
  log('==============================');
  log('  PASS=' + PASS + '  FAIL=' + FAIL);
  log('  ' + (FAIL ? 'HAS FAILURE' : 'ALL PASS'));
  log('==============================');
}

main().then(function () { setTimeout(function () { process.exit(FAIL ? 1 : 0); }, 100); })
  .catch(function (e) { log('EXCEPTION ' + (e && e.stack || e)); process.exit(1); });
