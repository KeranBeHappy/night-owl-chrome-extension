/* Night Owl - background (MV3 service worker, with event-page fallback)
 *
 * Load strategy:
 *   - Chrome / Edge / Firefox: importScripts works, real service worker.
 *   - If importScripts throws (the "Status code: 15" case) we fall back to an
 *     event page (MV2-style persistent background) by loading the same libs
 *     through require().
 *
 * CRITICAL - listener registration rule:
 *   Every listener is registered in its OWN try/catch block. They must never
 *   share one block. Reason: if any single registration line throws, a shared
 *   block aborts and silently kills every registration after it.
 *   This is exactly what killed runtime.onMessage once:
 *   contextMenus.onClicked threw on Chrome 152, onMessage was declared last,
 *   so onMessage was never registered. Result: popup / options could not talk
 *   to the background at all - "changes revert when I close the panel",
 *   "right-click whitelist does nothing". No error was visible anywhere
 *   because the popup swallowed the empty response.
 *
 *   Order also matters for damage control: runtime.onMessage and
 *   storage.onChanged go first, because they are the two channels the UI
 *   depends on. If something later fails, the UI still works.
 */

var NATIVE_OK = true;
try {
  importScripts(
    '/src/lib/config.js',
    '/src/lib/sun.js',
    '/src/lib/matcher.js'
  );
} catch (e) {
  NATIVE_OK = false;
  console.warn('[Night Owl] importScripts failed, falling back to event page:', e && e.message);
}

/* NW source:
 *   - native SW: importScripts already mounted each lib on self.NW
 *   - fallback: require() (libs export flat in a node-ish environment)
 */
var NW = (typeof self !== 'undefined' && self.NW) ? self.NW : {};
if (!NW.config || !NW.matcher) {
  try {
    NW = {
      config: require('./lib/config.js'),
      sun: require('./lib/sun.js'),
      matcher: require('./lib/matcher.js')
    };
  } catch (e) {
    console.error('[Night Owl] cannot load core modules:', e && e.message);
  }
}

var CFG = NW.config;
var SUN = NW.sun;
var MATCH = NW.matcher;

var ALARM_SWITCH = 'nw-switch';
var config = null;
var menuUrl = null;      // URL the context menu last targeted
var updating = false;    // true while we write storage ourselves (skip echo broadcast)

/* Must match manifest.content_scripts.js order - used for late injection */
var CONTENT_FILES = [
  'src/lib/config.js',
  'src/lib/sun.js',
  'src/lib/matcher.js',
  'src/lib/filter.js',
  'src/content.js'
];

/* chrome.* callback API -> Promise (also tolerates promise-returning impls)
 *
 * NOTE the trap this was written to avoid, and which bit us in broadcast():
 * a number of chrome.* APIs return a Promise in MV3 *and* still accept a
 * callback. If you hand such an API a callback it does not use, the Promise it
 * returns resolves but YOUR callback never fires - so a chain built on it
 * hangs forever with no error. `cbCall` therefore treats a returned
 * thenable as authoritative and only falls back to the callback when the call
 * returned nothing usable. */
function cbCall(fn) {
  var args = Array.prototype.slice.call(arguments, 1);
  return new Promise(function (resolve, reject) {
    var settled = false;
    function settle(err, result) {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(result);
    }
    var ret;
    try {
      ret = fn.apply(chrome, args.concat([function (result) {
        var err = chrome.runtime.lastError;
        settle(err ? new Error(err.message) : null, result);
      }]));
    } catch (e) {
      settle(e);
      return;
    }
    if (ret && typeof ret.then === 'function') {
      ret.then(function (result) { settle(null, result); }, function (e) { settle(e); });
    }
  });
}

function i18n(key) {
  try { return chrome.i18n.getMessage(key); } catch (e) { return key; }
}

/* ---------- listener registry ----------
 *
 * LOGICAL name  ->  where the listener actually lives.
 *
 * The mapping is explicit on purpose. On some builds an event object is NOT a
 * direct property of the expected namespace - the observed case is
 * `chrome.contextMenus.onShown` being absent on Chrome 152. Going through a
 * resolver lets us try several known locations and, when the API is genuinely
 * unavailable, mark it OPTIONAL instead of screaming at the user.
 */
var REG_FAIL = [];    // required listeners that could not be registered
var REG_SKIP = [];    // optional listeners whose API does not exist here
var MESSAGING_OK = false;  // true once runtime.onMessage is actually live

/* Collect every plausible location for an event, in priority order.
 *
 * IMPORTANT - why this is written the way it is:
 *   The previous version "probed three levels" but levels 1 and 2 both walked
 *   the same dotted path, so they resolved to the SAME object. After dedup the
 *   candidate list had length 1 for all nine events, meaning a single throwing
 *   addListener() was fatal - there was nothing left to fall back to. Measured
 *   on the real profile: runtime.onMessage had candidates=1 and never
 *   registered, while the six listeners declared after it all survived.
 *   A resolver that cannot actually resolve anything else is worse than none,
 *   because it looks like a safety net.
 *
 * So: candidates are now genuinely independent objects, the resolver reports
 * how many it found, and failures carry that count so the console tells us
 * which kind of failure this is (no such API vs. the API is there but refuses
 * the listener). */
function resolveEvent(name) {
  var parts = name.split('.');
  var tail = parts.pop();
  var cands = [];
  var bases = [];

  function addBase(b) {
    if (b && bases.indexOf(b) < 0) bases.push(b);
  }

  /* (1) the exact dotted path: runtime.onMessage -> chrome.runtime */
  var exact = chrome;
  for (var i = 0; i < parts.length; i++) {
    exact = exact && exact[parts[i]];
  }
  addBase(exact);

  /* (2) walk from the root one segment at a time, so an event that lives
   *     deeper (or shallower) than expected still gets a shot */
  var root = chrome;
  for (var j = 1; j <= parts.length; j++) {
    var probe = chrome;
    for (var k = 0; k < j; k++) probe = probe && probe[parts[k]];
    addBase(probe);
  }
  addBase(chrome);

  /* (3) last resort: every known API namespace that could own this event */
  ['runtime', 'contextMenus', 'tabs', 'storage', 'alarms', 'commands', 'action', 'webNavigation']
    .forEach(function (api) { addBase(chrome[api]); });

  /* (4) and a full sweep of the chrome object itself, for good measure */
  for (var g in chrome) {
    try { addBase(chrome[g]); } catch (e) { }
  }

  bases.forEach(function (b) {
    var ev = null;
    try { ev = b && b[tail]; } catch (e) { ev = null; }
    if (ev && typeof ev.addListener === 'function' && cands.indexOf(ev) < 0) cands.push(ev);
  });
  return cands;
}

/* opts.optional - API may legitimately be unavailable; do not warn. */
function on(name, target, fn, opts) {
  var optional = !!(opts && opts.optional);

  /* target may be a single event, an iterable of candidates, or undefined */
  var list = [];
  if (target && typeof target.addListener === 'function') {
    list = [target];
  } else if (target && typeof target.length === 'number') {
    for (var i = 0; i < target.length; i++) list.push(target[i]);
  }
  if (!list.length) list = resolveEvent(name);

  /* Keep the last throw so a failure says WHY, not just THAT. The old code
   * swallowed it, which is how a broken registration stayed invisible. */
  var lastErr = null;
  for (var k = 0; k < list.length; k++) {
    try {
      list[k].addListener(fn);
      return true;
    } catch (e) {
      lastErr = e;
      /* try the next candidate location */
    }
  }

  var detail = list.length
    ? 'addListener failed after ' + list.length + ' candidate(s): ' + (lastErr && lastErr.message)
    : 'api missing (no event object found)';

  if (optional) REG_SKIP.push(name);
  else REG_FAIL.push(name + ' (' + detail + ')');
  return false;
}

/* Shorthand: register against a computed candidate list. */
function onEvent(name, fn, opts) {
  return on(name, resolveEvent(name), fn, opts);
}

/* ---------- context menu ---------- */

function createMenus() {
  if (!chrome.contextMenus) return;
  try {
    chrome.contextMenus.removeAll(function () {
      if (chrome.runtime.lastError) return;
      try {
        chrome.contextMenus.create({
          id: 'nw-whitelist',
          title: i18n('ctxAddWhitelist'),
          contexts: ['page', 'action']
        }, function () { void chrome.runtime.lastError; });
      } catch (e) { /* older/newer signatures differ; non-fatal */ }
      try {
        chrome.contextMenus.create({
          id: 'nw-open-options',
          title: i18n('ctxOpenOptions'),
          contexts: ['action']
        }, function () { void chrome.runtime.lastError; });
      } catch (e) { }
    });
  } catch (e) {
    console.warn('[Night Owl] context menu setup failed:', e && e.message);
  }
}

/* ---------- config ---------- */

function loadConfig() {
  return cbCall(chrome.storage.local.get, 'config').then(function (res) {
    config = CFG ? CFG.normalize(res && res.config) : (res && res.config);
    return config;
  }).catch(function () {
    config = CFG ? CFG.normalize(null) : null;
    return config;
  });
}

/* Persist config. notify => broadcast to every tab.
 * Any path where the user actively changed day/night or the lists MUST pass
 * true, otherwise pages keep the old look until they happen to re-read. */
function saveConfig(next, notify) {
  config = CFG ? CFG.normalize(next) : next;
  updating = true;
  return cbCall(chrome.storage.local.set, { config: config }).then(function () {
    scheduleNext();
    updateBadge('saveConfig');
    if (notify) broadcast(false);
    return config;
  }).catch(function () {
    return config;
  }).then(function (c) {
    updating = false;
    return c;
  });
}

/* One-shot alarm for the next real transition (no polling)
 *
 * clear/create 的顺序必须是回调链，不能并排写：alarms.clear 是异步的，
 * 若 create 先落地、随后才轮到 clear 执行，clear 会把刚建好的新闹钟一并
 * 删掉 —— 手动模式的"到点恢复自动"就这样无声消失。同名 create 本身就会
 * 替换旧闹钟，clear 只是清理，放进回调里串行执行才安全。 */
function scheduleNext() {
  var go = function () {
    try {
      if (!config || !SUN) return;
      var next = SUN.nextSwitch(config);
      if (!next) return;
      chrome.alarms.create(ALARM_SWITCH, { when: next.at });
    } catch (e) { }
  };
  try {
    chrome.alarms.clear(ALARM_SWITCH, function () { void chrome.runtime.lastError; go(); });
  } catch (e) {
    go();
  }
}

/* 手动模式到期后回到自动。闹钟就在"下一次自然切换点"触发，即手动覆盖的
 * 失效时刻。若闹钟因休眠/重启缺席，sun.shouldBeDark 与 config.normalize
 * 还会各自兜底自愈，这里只是让持久化的 mode 也同步干净。 */
function expireManual() {
  if (!config || config.mode === 'auto') return false;
  if (!config.manualUntil || Date.now() < config.manualUntil) return false;
  config.mode = 'auto';
  config.manualUntil = 0;
  return true;
}

function updateBadge(tag) {
  if (!config || !SUN) return;
  /* 徽标明确表达当前明暗：黑夜 ON，白天或总开关关闭 OFF。 */
  var on = config.enabled && SUN.shouldBeDark(config);
  var text = on ? 'ON' : 'OFF';
  try {
    chrome.action.setBadgeText({ text: text });
    chrome.action.setBadgeBackgroundColor({ color: on ? '#3B6D11' : '#8A8A8A' });
    /* tag 标明调用点，mode/until 便于事后从 SW 控制台定位"谁用旧状态覆盖了徽标" */
    console.debug('[Night Owl] badge ->', text,
      '(background:' + (tag || '?') + ')',
      'mode=' + config.mode, 'until=' + config.manualUntil, 'now=' + Date.now());
  } catch (e) { }
}

/* Probe whether a tab still has a live Night Owl content script.
 *
 * REGRESSION NOTE - why this no longer uses cbCall() and why the ceiling is
 * generous:
 *   `chrome.tabs.sendMessage` returns a Promise in MV3 *and* accepts a
 *   callback. cbCall() appends a callback, the API ignores it and resolves its
 *   own Promise... except when the receiving end does not exist, in which case
 *   the callback fires with an error while the returned Promise is still
 *   pending, or vice versa depending on the overload chosen. Either way the
 *   probe could hang, so the follow-up nw:tick was never sent.
 *
 *   The ceiling used to be 250ms, which is far too tight: a service worker
 *   that has just been woken up, a page in the middle of a heavy script, or a
 *   content script that has not yet reached its addListener line all exceed
 *   it. Every such timeout was misread as "no content script here", which sent
 *   the broadcast down the re-injection path - and re-injection is a no-op
 *   because content.js guards itself with window.__nightOwlLoaded. So the tab
 *   got NO update at all: settings were saved, the page kept the old look, and
 *   only a manual refresh fixed it.
 *
 *   Two changes fix that: a wider ceiling (1200ms) so we stop crying wolf, and
 *   probe failures now lead to a tick anyway (see broadcast). A redundant tick
 *   into a tab that already applied the config is harmless - setActive() only
 *   writes when the CSS actually differs. A missing tick is a silent,
 *   user-visible failure. Always prefer the harmless outcome. */
function probeTab(tabId) {
  return new Promise(function (resolve) {
    var done = false;
    function fin(okFlag) {
      if (done) return;
      done = true;
      resolve(okFlag);
    }
    try {
      var ret = chrome.tabs.sendMessage(tabId, { type: 'nw:query' }, function () {
        var err = chrome.runtime.lastError;
        fin(!err);
      });
      if (ret && typeof ret.then === 'function') {
        ret.then(function () { fin(true); }, function () { fin(false); });
      }
    } catch (e) {
      fin(false);
    }
    /* Hard ceiling: a tab that never answers must not stall the broadcast for
     * the other tabs. */
    setTimeout(function () { fin(false); }, 1200);
  });
}

function sendTick(tabId) {
  try {
    var ret = chrome.tabs.sendMessage(tabId, { type: 'nw:tick', config: config });
    if (ret && typeof ret.then === 'function') ret.catch(function () { });
  } catch (e) { }
}

/* Re-injection is only worth attempting when the tab genuinely has no content
 * script. Doing it on a page that already has one is not just useless: running
 * the libs a second time rebuilds NW.config / NW.sun / NW.matcher / NW.filter
 * while content.js bails out on its own re-entry guard, leaving the live
 * instance holding closures over the old objects. Keep it as a last resort. */
function injectAndTick(tabId) {
  return cbCall(chrome.scripting.executeScript, {
    target: { tabId: tabId },
    files: CONTENT_FILES
  }).then(function () {
    sendTick(tabId);
  }, function () {
    /* Injection can legitimately fail (chrome:// pages, the Web Store, PDF
     * viewers). Still send the tick - a content script may already be there
     * after all, and if it is not, the page will pick the new config up
     * through chrome.storage.onChanged when it next loads. */
    sendTick(tabId);
  });
}

/* Push fresh state to every tab.
 *
 * `inject` no longer gates a probe-then-maybe-inject dance; the tick is sent
 * unconditionally and injection is the fallback. Rationale: the tick is
 * idempotent and cheap, while skipping it is a silently broken UI. The page
 * also listens to chrome.storage.onChanged on its own, so even a completely
 * failed tick path still converges - this function is now an accelerator, not
 * a lifeline. */
function broadcast(inject) {
  if (!config) return;
  cbCall(chrome.tabs.query, {}).then(function (tabs) {
    (tabs || []).forEach(function (tab) {
      if (!tab.id) return;
      if (!isHttpUrl(tab.url)) return;

      if (!inject) { sendTick(tab.id); return; }

      probeTab(tab.id).then(function (alive) {
        if (alive) { sendTick(tab.id); return; }
        injectAndTick(tab.id);
      });
    });
  }).catch(function () { });
}

/* ---------- site helpers ---------- */

/* whitelist-only toggle (context menu): add => also drop from blacklist so the
 * blacklist cannot drag it back to dark. */
function toggleWhitelistFor(url) {
  if (!url || !MATCH) return;
  MATCH.toggleWhitelist(config, url);
}

/* popup: set an explicit target state, the two lists stay mutually exclusive */
function setSiteDark(url, wantDark) {
  if (!url || !MATCH) return;
  MATCH.setSiteDark(config, url, !!wantDark);
}

/* popup: per-site toggle. currentDark is the site's EFFECTIVE state (lists
 * included). Falls back to the global state only when not supplied. */
function toggleSiteDark(url, currentDark) {
  if (!url || !MATCH) return;
  var dark = (typeof currentDark === 'boolean') ? currentDark : SUN.shouldBeDark(config);
  MATCH.toggleSiteDark(config, url, dark);
}

function isHttpUrl(url) {
  return typeof url === 'string' && url.indexOf('http') === 0;
}

function refreshMenuTitle(url) {
  if (!isHttpUrl(url) || !MATCH || !chrome.contextMenus) return;
  menuUrl = url;
  var inList = MATCH.inWhitelist(config, url);
  try {
    chrome.contextMenus.update('nw-whitelist', {
      title: inList ? i18n('ctxRemoveWhitelist') : i18n('ctxAddWhitelist')
    }, function () {
      void chrome.runtime.lastError;
      try { if (chrome.contextMenus.refresh) chrome.contextMenus.refresh(); } catch (e) { }
    });
  } catch (e) { }
}

/* flip day/night based on the CURRENT effective state。
 * 快捷键切换属于"临时覆盖"：记录下一次自然切换点作为失效时刻，到点回到自动。 */
function toggleDayNight() {
  var nowDark = config.enabled && SUN.shouldBeDark(config);
  var next = SUN.nextSwitch(config);
  CFG.setManualMode(config, nowDark ? 'light' : 'dark', next ? next.at : 0);
}

/* =========================================================================
 * Listener registration - one block per listener, no shared try/catch.
 * ========================================================================= */

/* (1) runtime.onMessage - the optional fast channel for the UI.
 * The popup and options page do NOT depend on it any more: they read and write
 * chrome.storage.local directly and rely on storage.onChanged below. This is
 * now purely an accelerator (it lets a panel see a save acknowledgement and
 * lets the popup ping us on open).
 *
 * It is registered FIRST for historical damage control, but note that the
 * previous attempt to make ordering the safety mechanism did not work: on the
 * real Chrome 152 profile this listener failed to register while the six
 * declared after it succeeded, so ordering was never the actual protection.
 * Real protection is (a) independent try/catch per listener, and (b) the UI
 * not having a hard dependency on any single channel. */
MESSAGING_OK = onEvent('runtime.onMessage', function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'nw:ping') {
    sendResponse({ ok: true, version: CFG ? CFG.VERSION : null });
    return;
  }

  /* The popup / options page already wrote chrome.storage.local themselves.
   * This is only a nudge so the badge and the next-switch alarm are refreshed
   * without waiting for storage.onChanged to wake the worker. We deliberately
   * do NOT write storage here - a double write would fire a second
   * storage.onChanged and a redundant broadcast. Just re-derive the derived
   * state from the already-persisted value. */
  if (msg.type === 'nw:saved') {
    /* 关键：直接采用消息携带的刚落盘配置，绝不能在这里 loadConfig() 重读。
     * 实证（tools/badge.e2e.js）：本机构建上其它上下文刚 set 完，SW 侧立刻
     * get 会拿到"上一次"的旧值 —— 点白天后事件里是 light，紧随的 get 却是
     * dark/auto，把徽标写回 ON。这正是"徽标不跟着变 OFF"的根因。 */
    if (msg.config) {
      config = CFG ? CFG.normalize(msg.config) : msg.config;
      scheduleNext();
      updateBadge('nw:saved');
    } else {
      loadConfig().then(function () {
        scheduleNext();
        updateBadge('nw:saved');
      }).catch(function () { });
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'nw:save') {
    saveConfig(msg.config, true).then(function (saved) {
      sendResponse({ ok: true, config: saved });
    }).catch(function (e) {
      sendResponse({ ok: false, error: String(e && e.message) });
    });
    return true;
  }

  if (msg.type === 'nw:read') {
    loadConfig().then(function (c) {
      sendResponse({
        ok: true,
        config: c,
        dark: SUN.shouldBeDark(c),
        window: SUN.resolveWindow(c),
        next: SUN.nextSwitch(c)
      });
    }).catch(function (e) {
      sendResponse({ ok: false, error: String(e && e.message) });
    });
    return true;
  }

  if (msg.type === 'nw:site-toggle') {
    /* all three parameter styles converge on one mutually-exclusive path */
    loadConfig().then(function () {
      if (typeof msg.dark === 'boolean' || typeof msg.wantDark === 'boolean') {
        setSiteDark(msg.url, typeof msg.dark === 'boolean' ? msg.dark : msg.wantDark);
      } else {
        toggleSiteDark(msg.url, msg.currentDark);
      }
      return saveConfig(config, true);
    }).then(function (saved) {
      sendResponse({ ok: true, config: saved });
    }).catch(function (e) {
      sendResponse({ ok: false, error: String(e && e.message) });
    });
    return true;
  }

  return undefined;
});

/* (2) storage.onChanged - THE lifeline.
 *
 * This is now the primary path, not a fallback. The popup and options page
 * write chrome.storage.local directly, so every user change arrives here. It
 * must therefore do the full job on its own: adopt the new config, reschedule
 * the alarm, refresh the badge, and push the new state to every open tab.
 *
 * `updating` is only true while the BACKGROUND itself is writing, in which
 * case saveConfig() already broadcast and we must not do it twice. */
var broadcastTimer = null;
onEvent('storage.onChanged', function (changes, area) {
  if (area !== 'local' || !changes.config) return;
  try {
    config = CFG ? CFG.normalize(changes.config.newValue) : changes.config.newValue;
    /* 徽标先更新，排程在后：本机 runtime.onMessage 不注册，storage.onChanged
     * 是徽标唯一的更新来源；排程一旦抛错绝不能连累它（以前 updateBadge 排在
     * scheduleNext 之后，正是徽标"切了白天还挂着 ON"的候选成因之一）。 */
    updateBadge('storage.onChanged');
    scheduleNext();
  } catch (e) {
    console.warn('[Night Owl] storage.onChanged handler failed:', e && e.message);
  }
  if (updating) return;

  /* Trailing-edge coalescing, not a throttle that drops. A slider drag or an
   * import can fire this several times within a few ms; every one of those
   * must still end with the tabs showing the FINAL value, so we debounce and
   * then broadcast once. A leading-edge throttle would silently drop the last
   * change and leave tabs one step behind - which is the exact class of bug
   * we are here to eliminate. */
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(function () {
    /* inject=true: re-inject content scripts into tabs that do not answer.
     * This matters more than it used to. With onMessage unavailable, this
     * storage-driven broadcast is the ONLY way a config change reaches a page,
     * and tabs that were open before the extension loaded have no content
     * script to receive it. Without the inject path those tabs would keep the
     * old look forever - "I changed the setting and this page never reacted". */
    broadcast(true);
  }, 50);
});

/* (3) alarms.onAlarm */
onEvent('alarms.onAlarm', function (alarm) {
  if (!alarm || alarm.name !== ALARM_SWITCH) return;
  console.debug('[Night Owl] alarm fired, scheduledAt=', alarm.scheduledTime, 'now=', Date.now());
  loadConfig().then(function () {
    /* 到点了：如果手动覆盖到期就落盘回到自动并广播；否则只是常规昼夜切换。 */
    if (expireManual()) {
      console.debug('[Night Owl] manual mode expired -> auto');
      return saveConfig(config, true);
    }
    scheduleNext();
    updateBadge('alarm');
    broadcast(true);   // SW may have been recycled - re-inject to be safe
  }).catch(function () { });
});

/* (4) commands.onCommand */
onEvent('commands.onCommand', function (command) {
  loadConfig().then(function () {
    if (command === 'nw-toggle-mode') {
      toggleDayNight();
      return saveConfig(config, true);
    }
    if (command === 'nw-toggle-site') {
      return cbCall(chrome.tabs.query, { active: true, currentWindow: true }).then(function (tabs) {
        if (tabs && tabs[0] && tabs[0].url) toggleWhitelistFor(tabs[0].url);
        return saveConfig(config, true);
      });
    }
    return null;
  }).catch(function () { });
});

/* (5) runtime.onInstalled */
onEvent('runtime.onInstalled', function () {
  loadConfig()
    .then(function () { return saveConfig(config, true); })
    .then(function () { createMenus(); })
    .catch(function () { });
});

/* (6) runtime.onStartup */
onEvent('runtime.onStartup', function () {
  loadConfig().then(function () {
    scheduleNext();
    updateBadge();
  }).catch(function () { });
});

/* (7) contextMenus.onShown - rewrite the label before the menu appears.
 * OPTIONAL: not every Chrome build exposes this event. When it is missing we
 * simply lose the proactive label refresh - the menu item still works, because
 * refreshMenuTitle() is also called from onClicked's data path and the title
 * falls back to a generic "add to whitelist". Degrading quietly is correct
 * here; treating it as a hard failure produced a scary red console error for
 * a purely cosmetic capability. */
onEvent('contextMenus.onShown', function (info) {
  var url = (info && (info.pageUrl || info.frameUrl)) || '';
  if (isHttpUrl(url)) {
    loadConfig().then(function () { refreshMenuTitle(url); }).catch(function () { });
    return;
  }
  cbCall(chrome.tabs.query, { active: true, currentWindow: true }).then(function (tabs) {
    if (!tabs || !tabs[0] || !tabs[0].url) return;
    var fallback = tabs[0].url;
    loadConfig().then(function () { refreshMenuTitle(fallback); }).catch(function () { });
  }).catch(function () { });
}, { optional: true });

/* (8) contextMenus.onClicked */
onEvent('contextMenus.onClicked', function (info) {
  if (!info) return;
  if (info.menuItemId === 'nw-whitelist') {
    var url = info.pageUrl || info.frameUrl || menuUrl;
    loadConfig().then(function () {
      toggleWhitelistFor(url);
      return saveConfig(config, true);
    }).then(function () {
      /* Self-heal the label. onShown is the nice path but it is not available
       * on every build, so after each click we re-sync the title ourselves -
       * that keeps the next open showing the correct add/remove wording even
       * when onShown never fires. */
      if (url) refreshMenuTitle(url);
    }).catch(function () { });
    return;
  }
  if (info.menuItemId === 'nw-open-options') {
    try { chrome.runtime.openOptionsPage(); } catch (e) { }
  }
});

/* (9) tabs.onActivated - also refresh the label on tab switches.
 * Cheap and only useful when onShown is missing; guarded so we do not add a
 * listener that is not needed on builds that have the real event. */
if (!chrome.contextMenus || !chrome.contextMenus.onShown) {
  onEvent('tabs.onActivated', function (info) {
    if (!info || !info.tabId) return;
    cbCall(chrome.tabs.get, info.tabId).then(function (tab) {
      if (tab && tab.url) {
        loadConfig().then(function () { refreshMenuTitle(tab.url); }).catch(function () { });
      }
    }).catch(function () { });
  }, { optional: true });
}

/* ---------- startup ---------- */

/* Which listeners are the UI's lifeline. If any of these is missing the popup
 * and options page genuinely cannot work, and the user sees "changes revert"
 * with no explanation. Say so plainly. Anything else is a degraded feature,
 * reported at warn level so it does not look like a crash. */
var CRITICAL = ['runtime.onMessage', 'storage.onChanged'];

function report() {
  var crippled = REG_FAIL.filter(function (n) {
    return CRITICAL.indexOf(String(n).split(' ')[0]) >= 0;
  });
  var soft = REG_FAIL.filter(function (n) { return crippled.indexOf(n) < 0; });

  if (crippled.length) {
    /* A missing onMessage does NOT break the extension any more: the popup and
     * options page read and write chrome.storage.local directly and the
     * storage.onChanged listener (registered below) still drives the tabs.
     * Report it as a degradation, and name the working path, so this cannot be
     * mistaken for "everything is broken". */
    console.warn('[Night Owl] runtime.onMessage unavailable on this Chrome build - '
      + 'popup/options are using the direct chrome.storage path instead. Messaging-based '
      + 'features (keyboard shortcut replies) will be limited. Detail: ' + crippled.join(' | '));
  }
  if (soft.length) {
    console.warn('[Night Owl] optional features unavailable on this Chrome build: ' + soft.join(' | '));
  }

  var okn = 8 - REG_FAIL.length - REG_SKIP.length;
  console.log('[Night Owl] ready - listeners ok=' + okn
    + ' failed=' + REG_FAIL.length
    + ' optional-skipped=' + REG_SKIP.length
    + (REG_SKIP.length ? ' [' + REG_SKIP.join(',') + ']' : '')
    + ' native=' + NATIVE_OK
    + ' mode=' + (MESSAGING_OK ? 'messaging+storage' : 'storage-only'));
}

if (NATIVE_OK) {
  loadConfig().then(function () {
    scheduleNext();
    updateBadge('startup');
    report();
  }).catch(function () { report(); });
} else {
  loadConfig().then(function () {
    createMenus();
    scheduleNext();
    updateBadge('startup');
    report();
  }).catch(function () { report(); });
}
