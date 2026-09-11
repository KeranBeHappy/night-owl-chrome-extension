/* Night Owl - direct storage channel (popup + options page)
 *
 * WHY THIS EXISTS
 *   On the user's Chrome 152 build, `chrome.runtime.onMessage` refuses to
 *   register in the service worker. Verified from Chrome's own ledger
 *   (Secure Preferences -> serviceworkerevents): the accumulated set holds
 *   alarms/commands/contextMenus/runtime.onInstalled/runtime.onStartup/
 *   storage.onChanged/tabs.onActivated - and NOT runtime.onMessage.
 *
 *   Every popup control except the per-site button goes through
 *   sendMessage -> onMessage. With onMessage dead, the panel could read
 *   nothing and save nothing: "changes revert when I close the panel".
 *
 *   The fix is not to keep fighting the messaging channel. The panel now
 *   reads and writes chrome.storage.local directly, which is confirmed
 *   working on this machine (storage.onChanged is registered and firing).
 *
 * CHANNEL PRIORITY
 *   1. chrome.storage.local  - always available, this is the source of truth
 *   2. chrome.runtime.sendMessage - best-effort only; used to nudge the
 *      background (badge / alarm rescheduling) and to answer instantly.
 *      A failure here is NOT an error the user needs to see, because the
 *      storage write already succeeded.
 */
(function () {
  'use strict';

  var root = (typeof module !== 'undefined' && module.exports)
    ? module.exports
    : (typeof globalThis !== 'undefined' ? globalThis : window);

  var KEY = 'config';

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

  /* Best-effort nudge to the background so it can refresh the badge and
   * reschedule the alarm without waiting for storage.onChanged to wake it.
   * Never rejects: a dead messaging channel is expected and harmless here. */
  function nudge(message) {
    return new Promise(function (resolve) {
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
          resolve(false); return;
        }
        chrome.runtime.sendMessage(message, function () {
          // Swallow lastError - the storage write already succeeded, so the
          // user must not be shown a scary "cannot reach background" banner.
          void (chrome.runtime && chrome.runtime.lastError);
          resolve(true);
        });
      } catch (e) {
        resolve(false);
      }
    });
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
    nudge: nudge,
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
