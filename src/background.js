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
 *   Real incident: contextMenus.onClicked threw on Chrome 152 and killed the
 *   registration declared after it (then runtime.onMessage), so the UI could
 *   not talk to the background at all - "changes revert when I close the
 *   panel" - with no visible error anywhere.
 *
 *   Order also matters for damage control: storage.onChanged goes first,
 *   because it is the channel everything else depends on. If something later
 *   fails, the UI still works.
 *
 * CHANNELS (two, both local-only - the extension never talks to the network):
 *   1. chrome.storage.local (+ storage.onChanged) - 配置的真相来源。
 *      popup/options 直写，本 SW 的 onChanged 接力：刷徽标、重排闹钟、广播页面。
 *   2. chrome.alarms - SW 的唤醒与定时中枢。
 *      · 'nw{...}' 信号闹钟：UI 落盘后把整份 config 编码进 name 发过来，
 *        本 SW 收到即采信（绝不回读 storage - 本机回读有"写一拍滞后"）；
 *      · 'nw-switch' 昼夜切换闹钟：到点重算状态。
 *   注：runtime.onMessage 已彻底不用 —— 本机 Chrome 152 上它根本注册不上，
 *   UI 也不再依赖它（历史上为它写过一堆兜底，全是死代码，已删除）。
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

/* ---------- config ---------- */

function readRawConfig() {
  return cbCall(chrome.storage.local.get, 'config').then(function (res) {
    return res && res.config;
  });
}

/* 回读 storage 并采用，带两个怪癖的防护：
 * 1. "写一拍滞后"（其它上下文刚写完，本上下文第一次回读是旧快照）→ 用
 *    savedAt 时间戳对账：回读命中的快照比内存旧就直接丢弃，保留内存状态；
 * 2. storage.onChanged 时灵时不灵、内存 config 可能停留在旧值 → 回读一次即
 *    可校正（savedAt 会告诉我们哪边更新）。
 * 需要"刚落盘的值"的路径（UI 改动）走信号闹钟，压根不回读这里。 */
function loadConfig() {
  return readRawConfig().then(function (raw) {
    var incoming = CFG ? CFG.normalize(raw) : raw;
    if (config && (config.savedAt || 0) > (incoming.savedAt || 0)) {
      /* 回读命中滞后旧快照（比内存还旧）：保留内存中的较新状态。
       * 过期自愈的收敛交给后续 loadConfig/闹钟路径。 */
      return config;
    }
    config = incoming;
    /* 过期手动模式被 normalize 自愈（原始 mode 非 auto、normalize 后变 auto）
     * 时，必须立即落盘并广播：自愈只改内存的话，徽标/排程按 auto 计算，
     * 而页面还停留在最后一次广播的状态 —— 状态分裂。 */
    if (raw && raw.mode && raw.mode !== 'auto' && config.mode === 'auto') {
      saveConfig(config, true);
    }
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
  config.savedAt = Date.now();   // 落盘打时间戳：供各上下文按 savedAt 对账取新
  updating = true;
  return cbCall(chrome.storage.local.set, { config: config }).then(function () {
    scheduleNext();
    syncBadge('saveConfig');
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

/* 徽标：只有一个全局值（黑夜 ON 绿 / 白天 OFF 灰），判定与颜色统一由
 * sun.badgeState 提供 —— 三个写入方（popup / options / 本 SW）共用同一出口。
 *
 * 为什么彻底不用 per-tab 徽标（历史教训，别再走回头路）：
 *   Chrome 的 per-tab 徽标一旦写入就与全局断开，且**没有"解除覆盖"的 API**。
 *   当初为了「受限页黄叹号」用了 per-tab，于是被迫连锁：切页时要重写覆盖值 →
 *   需要知道"当前全局值" → 回读 → 本机回读不可靠 → 过滤/兜底/残留纠正/启动
 *   补算……任何一环把值写成空串，那个标签页的徽标就永久消失（用户看到的
 *   "ON/OFF 不主动显示、点开 popup 才出现"就是这么来的）。
 *   现在改成：徽标只表达全局昼夜（受限页在 popup 有「不支持」提示块、设置页
 *   有说明），写入方永远只写全局值 —— 无覆盖、无回读、无残留。 */
function syncBadge(tag) {
  if (!config || !SUN) return;
  try {
    var s = SUN.badgeState(config);
    chrome.action.setBadgeText({ text: s.text });
    chrome.action.setBadgeBackgroundColor({ color: s.color });
    /* tag 标明调用点，便于从 SW 控制台定位"谁最后一次写了徽标" */
    console.debug('[Night Owl] badge ->', s.text,
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

/* whitelist-only toggle (site switch command): add => also drop from blacklist
 * so the blacklist cannot drag it back to dark. */
function toggleWhitelistFor(url) {
  if (!url || !MATCH) return;
  MATCH.toggleWhitelist(config, url);
}

function isHttpUrl(url) {
  return typeof url === 'string' && url.indexOf('http') === 0;
}

/* flip day/night based on the CURRENT effective state。
 * 快捷键切换属于"临时覆盖"：记录下一次自然切换点作为失效时刻，到点回到自动。 */
function toggleDayNight() {
  /* 总开关是最顶层条件：关闭时快捷键不切换昼夜（不落盘、不广播），
   * 避免用户"按了没反应"还写回 mode=dark + manualUntil=0 的锁死配置。 */
  if (!config || !config.enabled) return false;
  var nowDark = config.enabled && SUN.shouldBeDark(config);
  var next = SUN.nextSwitch(config);
  CFG.setManualMode(config, nowDark ? 'light' : 'dark', next ? next.at : 0);
  return true;
}

/* =========================================================================
 * Listener registration - one block per listener, no shared try/catch.
 * ========================================================================= */

/* (1) storage.onChanged - 变更的主通道（popup/options 直写 storage 后由它接力）。
 *
 * 它必须独立完成全套动作：采用新配置、重排闹钟、刷新徽标、把新状态推给所有
 * 标签页。`updating` 只在"后台自己写 storage"时为 true —— 那时 saveConfig()
 * 已经广播过，不能重复广播。 */
var broadcastTimer = null;
onEvent('storage.onChanged', function (changes, area) {
  if (area !== 'local' || !changes.config) return;
  try {
    config = CFG ? CFG.normalize(changes.config.newValue) : changes.config.newValue;
    /* 徽标先更新、排程在后：排程一旦抛错绝不能连累徽标（历史上徽标更新排在
     * scheduleNext 之后，正是"切了白天还挂着 ON"的成因之一）。 */
    syncBadge('storage.onChanged');
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
    /* inject=true: 对不回答的标签页补注入内容脚本。配置变更能到页面的通道只有
     * 本 SW 的 nw:tick（外加页面自己的 storage.onChanged），而扩展加载前就开着
     * 的标签页可能根本没有内容脚本 —— 没有补注入它们会永远保持旧外观
     * （"我改了设置，这个页面没反应"）。 */
    broadcast(true);
  }, 50);
});

/* (2) alarms.onAlarm */
/* 前缀必须与 store.js 的 SIGNAL_PREFIX 一致（check.js 有断言钉住）。 */
var ALARM_SIGNAL_PREFIX = 'nw{';   // name 编码：'nw{' + JSON.stringify(config)

/* UI（popup/options）落盘后把整份 config 编码进 alarm name 发过来。
 * alarms 是本机 SW 唯一可靠的唤醒/回调机制（onMessage 注册不上、onChanged
 * 时灵时不灵、回读 storage 有写一拍滞后）—— 收到的 config 直接采信（写入方
 * 是权威，绝不回读 storage 二次确认），savedAt 乱序保护后全量收敛：
 * 全局徽标 + 页面广播。 */
function adoptRemoteConfig(incomingRaw) {
  var incoming = CFG ? CFG.normalize(incomingRaw) : incomingRaw;
  if (config && (config.savedAt || 0) > (incoming.savedAt || 0)) {
    /* 乱序信号（迟到的旧状态）：丢弃，避免旧值覆盖新值 */
    console.debug('[Night Owl] signal ignored (older savedAt)');
    return null;
  }
  config = incoming;
  /* 手动模式在信号途中过期（popup 写时未到期、alarm 到达时已过）：
   * 按 auto 收敛并落盘广播。 */
  if (config.mode !== 'auto' && config.manualUntil && Date.now() >= config.manualUntil) {
    config.mode = 'auto';
    config.manualUntil = 0;
    return saveConfig(config, true);
  }
  scheduleNext();
  syncBadge('nw-signal');
  broadcast(false);
  return null;
}

onEvent('alarms.onAlarm', function (alarm) {
  var name = alarm && alarm.name;
  if (name && name.indexOf(ALARM_SIGNAL_PREFIX) === 0) {
    try {
      adoptRemoteConfig(JSON.parse(name.slice(ALARM_SIGNAL_PREFIX.length)));
    } catch (e) {
      console.warn('[Night Owl] signal parse failed:', e && e.message);
    }
    return;
  }
  if (!alarm || alarm.name !== ALARM_SWITCH) return;
  console.debug('[Night Owl] alarm fired, scheduledAt=', alarm.scheduledTime, 'now=', Date.now());
  loadConfig().then(function () {
    /* 到点了：如果手动覆盖到期就落盘回到自动并广播；否则只是常规昼夜切换。 */
    if (expireManual()) {
      console.debug('[Night Owl] manual mode expired -> auto');
      return saveConfig(config, true);
    }
    scheduleNext();
    syncBadge('alarm');
    broadcast(true);   // SW may have been recycled - re-inject to be safe
  }).catch(function () { });
});

/* (4) commands.onCommand */
onEvent('commands.onCommand', function (command) {
  loadConfig().then(function () {
    /* 总开关是最顶层条件：关闭时两个快捷键都直接忽略（不落盘、不广播） */
    if (command === 'nw-toggle-mode') {
      if (!toggleDayNight()) return null;
      return saveConfig(config, true);
    }
    if (command === 'nw-toggle-site') {
      if (!config || !config.enabled) return null;
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
    .catch(function () { });
});

/* (6) runtime.onStartup */
onEvent('runtime.onStartup', function () {
  loadConfig().then(function () {
    scheduleNext();
    syncBadge('startup');
  }).catch(function () { });
});

/* ---------- startup ---------- */

/* Which listeners are the UI's lifeline. If any of these is missing the popup
 * and options page genuinely cannot work, and the user sees "changes revert"
 * with no explanation. Say so plainly. Anything else is a degraded feature,
 * reported at warn level so it does not look like a crash. */
var CRITICAL = ['storage.onChanged'];

function report() {
  var crippled = REG_FAIL.filter(function (n) {
    return CRITICAL.indexOf(String(n).split(' ')[0]) >= 0;
  });
  var soft = REG_FAIL.filter(function (n) { return crippled.indexOf(n) < 0; });

  if (crippled.length) {
    /* storage.onChanged 是唯一的"变更"入口：它没了，popup/options 改了配置
     * 也没人广播、更没人刷徽标。这是真正的致命缺失，必须说清楚。 */
    console.warn('[Night Owl] storage.onChanged unavailable - popup/options save '
      + 'changes but nothing can react to them. Detail: ' + crippled.join(' | '));
  }
  if (soft.length) {
    console.warn('[Night Owl] optional features unavailable on this Chrome build: ' + soft.join(' | '));
  }

  /* 监听器总数 = onEvent 调用点数量（移除右键菜单后剩 5 个）。
   * 改监听器数量时这里和 check.js 的断言要同步。 */
  var okn = 5 - REG_FAIL.length - REG_SKIP.length;
  console.log('[Night Owl] ready - listeners ok=' + okn
    + ' failed=' + REG_FAIL.length
    + ' optional-skipped=' + REG_SKIP.length
    + (REG_SKIP.length ? ' [' + REG_SKIP.join(',') + ']' : '')
    + ' native=' + NATIVE_OK);
}

loadConfig().then(function () {
  scheduleNext();
  syncBadge('startup');
  report();
}).catch(function () { report(); });
