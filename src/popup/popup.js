/* Night Owl — popup 逻辑
 *
 * 通信模型（重要）：
 *   本面板**不依赖** runtime.onMessage。
 *   在农场主这台 Chrome 152 上，SW 里的 onMessage 注册不上去
 *   （Chrome 自己的账本 serviceworkerevents 里没有它），
 *   所以所有"发消息给后台"的操作都会石沉大海 —— 这正是
 *   "改了配置关掉面板就弹回去"的原因。
 *
 *   现在配置直接读写 chrome.storage.local：
 *     - 读：storage.local.get('config')
 *     - 写：storage.local.set({config})
 *   storage.onChanged 在后台是活的，变更会自然广播到所有标签页。
 *   sendMessage 只作为"顺手通知后台刷新角标"的尽力而为通道，
 *   失败不提示用户 —— 因为落盘已经成功了。
 */
(function () {
  'use strict';

  var CFG = window.NW.config;
  var SUN = window.NW.sun;
  var MATCH = window.NW.matcher;
  var STORE = window.NW.store;

  var config = null;
  var currentUrl = null;
  var previewTimer = null;
  var unsubscribe = null;

  function msg(key, subs) {
    try { return chrome.i18n.getMessage(key, subs); } catch (e) { return key; }
  }

  function isZh() {
    return (chrome.i18n.getUILanguage() || '').toLowerCase().indexOf('zh') === 0;
  }

  function fmtDuration(mins) {
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    if (isZh()) {
      if (h && m) return h + ' 小时 ' + m + ' 分';
      if (h) return h + ' 小时';
      return m + ' 分';
    }
    if (h && m) return h + 'h ' + m + 'm';
    if (h) return h + 'h';
    return m + 'm';
  }

  function fmtTime(mins) {
    return CFG.minutesToTime(mins);
  }

  function applyI18n() {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var text = msg(nodes[i].getAttribute('data-i18n'));
      if (text) nodes[i].textContent = text;
    }
  }

  function $(id) { return document.getElementById(id); }

  /* ---------- 错误提示 ----------
   * 只有"连 storage 都读不到/写不进"才是真错误 —— 那意味着扩展整体坏了。
   * sendMessage 失败不再报错，因为它已经不是主通道。 */
  var lastError = '';

  function fail(text) {
    lastError = text || msg('msgNoBackground');
    var el = $('status');
    el.textContent = lastError;
    el.classList.add('error');
  }

  function ok() {
    if (lastError) {
      lastError = '';
      $('status').classList.remove('error');
    }
  }

  /* ---------- 渲染 ---------- */

  function renderSite() {
    var host = null;
    try { host = new URL(currentUrl).hostname; } catch (e) {}

    var siteRow = document.querySelector('.site');
    if (!host || !currentUrl || currentUrl.indexOf('http') !== 0) {
      siteRow.style.display = 'none';
      return;
    }
    siteRow.style.display = '';
    $('siteName').textContent = host;

    var globalDark = SUN.shouldBeDark(config);
    var on = MATCH.siteEnabled(config, currentUrl, globalDark);
    var btn = $('siteToggle');
    btn.textContent = on ? 'ON' : 'OFF';
    btn.classList.toggle('on', on);
    btn.title = on ? msg('popupSiteOn') : msg('popupSiteOff');
  }

  function stateFor(c) {
    return {
      dark: SUN.shouldBeDark(c),
      window: SUN.resolveWindow(c),
      next: SUN.nextSwitch(c)
    };
  }

  function renderStatus(state) {
    var text = '';
    if (!config.enabled) {
      text = msg('popupDisabled');
    } else if (config.mode === 'auto') {
      if (!state.dark) {
        text = msg('popupNotNow');
        if (state && state.next) text += ' · ' + msg('popupNextSwitch', fmtDuration(state.next.minutes));
      } else if (config.schedule.type === 'sun' && state.window) {
        text = msg('popupSunTimes', [fmtTime(state.window.start), fmtTime(state.window.end)]);
        if (state && state.next) text += ' · ' + msg('popupNextSwitch', fmtDuration(state.next.minutes));
      } else if (state && state.next) {
        text = msg('popupNextSwitch', fmtDuration(state.next.minutes));
      }
    }
    // 通信错误的提示优先级最高，不能被状态文案盖掉
    if (!lastError) $('status').textContent = text;
  }

  function render(state) {
    $('master').checked = !!config.enabled;

    var buttons = document.querySelectorAll('#modeSeg button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', buttons[i].getAttribute('data-mode') === config.mode);
    }

    $('brightness').value = config.theme.brightness;
    $('brightnessOut').textContent = config.theme.brightness + '%';
    $('temperature').value = config.theme.temperature;
    $('temperatureOut').textContent = config.theme.temperature > 0
      ? '+' + config.theme.temperature
      : String(config.theme.temperature);

    renderSite();
    renderStatus(state || stateFor(config));
  }

  /* ---------- 读写 ---------- */

  /* 从 storage 重新载入并渲染。这是唯一的"读"入口。 */
  function refresh() {
    return STORE.read().then(function (raw) {
      ok();
      config = CFG.normalize(raw);
      render(stateFor(config));
      return config;
    }).catch(function (e) {
      fail(msg('msgNoBackground') + ' · ' + (e && e.message ? e.message : 'storage'));
      return null;
    });
  }

  /* 落盘。先 normalize（保证存进去的永远是合法结构），再写 storage，
   * 最后尽力通知后台刷新角标。 */
  function save() {
    config = CFG.normalize(config);
    return STORE.write(config).then(function () {
      ok();
      return STORE.nudge({ type: 'nw:saved', config: config });
    }).catch(function (e) {
      fail(msg('msgNoBackground') + ' · ' + (e && e.message ? e.message : 'storage'));
    });
  }

  /* 拖动滑块时只给当前标签页发预览指令（不落盘），松手才写 storage。
   * 预览走 tabs.sendMessage —— 即使这条失败，也只是少了个实时预览，
   * 松手后的落盘 + storage.onChanged 广播仍会让页面正确变色。 */
  function preview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          if (!tabs[0] || !tabs[0].id) return;
          try {
            /* MV3 里 tabs.sendMessage 返回 Promise，但本机 Chrome 152 build
             * 偶发返回 undefined —— 直接 .catch 会 TypeError。
             * 抹平两种情况：Promise 接 .catch，否则 try/catch 兜底。 */
            var ret = chrome.tabs.sendMessage(tabs[0].id, { type: 'nw:apply', config: config });
            if (ret && typeof ret.catch === 'function') ret.catch(function () { });
          } catch (e) { }
        });
      } catch (e) { }
    }, 80);
  }

  /* ---------- 事件 ---------- */

  function bind() {
    $('master').addEventListener('change', function (e) {
      if (!config) return;
      config.enabled = e.target.checked;
      save();
      render();
    });

    var buttons = document.querySelectorAll('#modeSeg button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (e) {
        if (!config) return;
        config.mode = e.currentTarget.getAttribute('data-mode');
        // 先把选中态画出来，用户立刻就有点击反馈
        render();
        save();
      });
    }

    $('brightness').addEventListener('input', function (e) {
      if (!config) return;
      config.theme.brightness = parseInt(e.target.value, 10);
      $('brightnessOut').textContent = config.theme.brightness + '%';
      preview();
    });
    $('brightness').addEventListener('change', function () {
      if (config) save();
    });

    $('temperature').addEventListener('input', function (e) {
      if (!config) return;
      config.theme.temperature = parseInt(e.target.value, 10);
      $('temperatureOut').textContent = config.theme.temperature > 0
        ? '+' + config.theme.temperature
        : String(config.theme.temperature);
      preview();
    });
    $('temperature').addEventListener('change', function () {
      if (config) save();
    });

    /* 站点开关：按该站点**实际**的明暗取反（含名单生效后的结果），
     * 不能用全局明暗，否则已在白名单里的站点会点了没反应。
     * 直接改 config 后落盘，不再需要后台代劳。 */
    $('siteToggle').addEventListener('click', function () {
      if (!config || !currentUrl) return;
      var dark = MATCH.siteEnabled(config, currentUrl, SUN.shouldBeDark(config));
      MATCH.toggleSiteDark(config, currentUrl, dark);
      render();
      save();
    });

    $('openOptions').addEventListener('click', function () {
      try { chrome.runtime.openOptionsPage(); } catch (e) { fail(); }
    });
  }

  /* ---------- 启动 ---------- */

  // 扩展被重新加载后，之前打开的 popup 上下文已失效
  function alive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  if (!alive()) {
    document.body.textContent = '';
    var tip = document.createElement('div');
    tip.style.padding = '16px';
    tip.textContent = msg('msgReload');
    document.body.appendChild(tip);
    return;
  }

  applyI18n();
  bind();

  /* 外部改动（设置页、右键菜单、快捷键）实时反映到本面板。
   * 这是 storage 通道的"反向"半边，让双通道真正闭环。 */
  unsubscribe = STORE.subscribe(function (raw) {
    if (!config) return;
    config = CFG.normalize(raw);
    render(stateFor(config));
  });
  window.addEventListener('unload', function () {
    if (unsubscribe) unsubscribe();
  });

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs && tabs[0]) currentUrl = tabs[0].url || null;
    refresh();
  });
})();
