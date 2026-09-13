/* Night Owl - popup / options 的通道封装（读 / 写 / 信号 / 订阅）
 *
 * WHY THIS EXISTS
 *   本机 Chrome 152 上，后台 SW 的 `chrome.runtime.onMessage` 注册不上
 *   （Chrome 自己的 serviceworkerevents 账本里没有它），消息石沉大海 ——
 *   表现是"面板里改完，关掉再打开又变回去了"。
 *   所以面板不走消息：直接读写 chrome.storage.local。
 *
 * CHANNEL PRIORITY（两条腿，各司其职）
 *   1. chrome.storage.local —— 真相来源，落盘即持久（read / write / subscribe）
 *   2. chrome.alarms        —— 落盘后给后台发"信号闹钟"（signal）：
 *      alarms 是本机 SW 唯一可靠的唤醒/回调机制；信号里带着刚落盘的 config，
 *      后台收到即采信，不回读 storage（回读有"写一拍滞后"）。
 */
(function () {
  'use strict';

  var root = (typeof module !== 'undefined' && module.exports)
    ? module.exports
    : (typeof globalThis !== 'undefined' ? globalThis : window);

  var KEY = 'config';
  /* 信号闹钟的名字前缀与延迟；前缀必须与 background.js 的 ALARM_SIGNAL_PREFIX
   * 保持一致（check.js 有断言钉住）。 */
  var SIGNAL_PREFIX = 'nw{';
  var SIGNAL_DELAY_MS = 300;

  function hasStorage() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
    } catch (e) { return false; }
  }

  /* Read the raw stored config. Resolves to null when nothing is stored yet
   * (a fresh install), which callers normalise against DEFAULTS. */
  function read() {
    return new Promise(function (resolve, reject) {
      if (!hasStorage()) { reject(new Error('chrome.storage.local unavailable')); return; }
      try {
        chrome.storage.local.get(KEY, function (res) {
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err) { reject(new Error(err.message)); return; }
          resolve(res && res[KEY] !== undefined ? res[KEY] : null);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /* Write the config. This is the operation that makes a change stick. */
  function write(config) {
    return new Promise(function (resolve, reject) {
      if (!hasStorage()) { reject(new Error('chrome.storage.local unavailable')); return; }
      var payload = {};
      payload[KEY] = config;
      try {
        chrome.storage.local.set(payload, function () {
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err) { reject(new Error(err.message)); return; }
          resolve(config);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /* 信号闹钟：唤醒后台的**唯一可靠**通道。
   *
   * 为什么不用 runtime.sendMessage：本机 Chrome 上后台的 onMessage 根本注册
   * 不上（Chrome 自己的 serviceworkerevents 账本里没有它），消息石沉大海。
   * storage.onChanged 虽然活着，但时灵时不灵、且唤醒有延迟。
   *
   * 为什么把整份 config 编码进 alarm name：后台回读 storage 有"写一拍滞后"
   * （刚写完立刻读会拿到旧值），所以让写入方把新配置随信号一起带走 ——
   * 后台收到即采信，不回读、无滞后。前缀 'nw{' 与 background.js 的
   * ALARM_SIGNAL_PREFIX 必须一致（check.js 有断言钉住）。
   *
   * 失败静默：落盘已经成功，storage.onChanged 通常还能兜住，不该打扰用户。 */
  function signal(config) {
    try {
      if (typeof chrome === 'undefined' || !chrome.alarms) return false;
      chrome.alarms.create(SIGNAL_PREFIX + JSON.stringify(config), {
        when: Date.now() + SIGNAL_DELAY_MS
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  /* Subscribe to external config changes (other panels, context menu,
   * background). Returns an unsubscribe function. */
  function subscribe(fn) {
    if (!hasStorage() || !chrome.storage.onChanged) return function () {};
    var handler = function (changes, area) {
      if (area !== 'local' || !changes[KEY]) return;
      fn(changes[KEY].newValue);
    };
    try {
      chrome.storage.onChanged.addListener(handler);
    } catch (e) {
      return function () {};
    }
    return function () {
      try { chrome.storage.onChanged.removeListener(handler); } catch (e) { }
    };
  }

  /* KEY 是实现细节，调用方不该关心键名；保持内部常量。 */
  var api = {
    read: read,
    write: write,
    signal: signal,
    subscribe: subscribe
  };

  // mount: browser -> globalThis.NW.store ; node -> flat module.exports
  root.NW = root.NW || {};
  root.NW.store = api;
  if (typeof module !== 'undefined' && module.exports) {
    for (var k in api) {
      if (Object.prototype.hasOwnProperty.call(api, k)) module.exports[k] = api[k];
    }
  }
})();
