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
 *   storage.onChanged 在后台是活的，变更会自然广播到所有标签页；
 *   落盘后再发一个"信号闹钟"（store.signal）叫醒后台收敛徽标与排程，
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

  /* ---------- 面板换肤 ----------
   * 面板跟着"当前实际生效的明暗"走（与网页夜间模式同一个判定，见 sun.badgeState）：
   * 黑夜 → 暗色（CSS 默认），白天 / 总开关关闭 → 亮色（html.nw-light）。
   * 只切 CSS 变量，不套任何滤镜，也不碰用户的外观参数。 */
  var THEME_KEY = 'night-owl:theme';   // localStorage：给"首帧上色"当缓存

  /* 首帧先按上次的明暗上色：popup 打开到 storage 回读完成之间有一段空白，
   * 不做这一步会"先暗后亮"闪一下。真值等 refresh() 读完配置由 applyTheme 校准。 */
  try {
    if (localStorage.getItem(THEME_KEY) === 'light') {
      document.documentElement.classList.add('nw-light');
    }
  } catch (e) { /* 存储不可用就退化为默认暗色，不影响功能 */ }

  /** 按当前生效的明暗切换面板配色，并缓存结果供下次首帧使用。 */
  function applyTheme() {
    if (!config || !SUN) return;
    var light = !SUN.badgeState(config).on;
    try {
      document.documentElement.classList.toggle('nw-light', light);
      localStorage.setItem(THEME_KEY, light ? 'light' : 'dark');
    } catch (e) { }
  }

  /* 受限页面：chrome:// 设置页、应用商店、PDF 查看器等，浏览器禁止注入
   * 内容脚本，夜间模式无法生效。与 background.isHttpUrl（同样只认 http 前缀）同一口径。 */
  function isUnsupported(url) {
    return !url || String(url).indexOf('http') !== 0;
  }

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

  /* 站点开关：三态（跟随自动 / 强制夜间 / 强制白天），直接读写黑白名单。
   * 高亮当前实际生效的那一档，点哪档就进哪档。 */
  /* ---------- 控件可用性：唯一判定出口 ----------
   * popup 的控件会因两种原因失效，而且可能同时成立：
   *   - masterOff  ：设置页的总开关关闭 → 页面不变暗，所有控件都不生效
   *   - unsupported：当前页面（chrome:// 等）禁止注入内容脚本 → 本页控件不生效
   * 以前每个控件各写一套条件，于是滑杆漏了 masterOff、站点三态漏了 unsupported。
   * 现在渲染与 handler 守卫都只查这一个纯函数 —— 以后加控件不会再漏条件。 */
  function controlsState() {
    var masterOff = !config || !config.enabled;
    var unsupported = isUnsupported(currentUrl);
    return { masterOff: masterOff, unsupported: unsupported, disabled: masterOff || unsupported };
  }

  /** 按需显示/隐藏一个节点（只碰 display，不引入别的状态）。 */
  function show(el, on) {
    if (el) el.style.display = on ? '' : 'none';
  }

  /* 「为什么用不了」的唯一出口：一个提示块，按原因显示 1~2 行。
   * 总开关关闭与本页不支持可以同时成立，那就两行一起显示 —— 同一个块里说清楚，
   * 不再像以前那样一半在状态行、一半在另一个块里（互相遮蔽、还会同时出现）。 */
  function renderNotice(st) {
    show($('noticeDisabled'), st.masterOff);
    show($('noticeUnsupported'), st.unsupported);
    show($('learnMore'), st.unsupported);   // 只有"本页不支持"才需要看限制说明
    show($('noticeBlock'), st.disabled);
  }

  /* 站点三态只对当前站点有意义：受限页整行隐藏（不是禁用），其余按统一判定禁用。 */
  function renderSite(st) {
    var host = null;
    try { host = new URL(currentUrl).hostname; } catch (e) {}

    var siteRow = document.querySelector('.site');
    if (!host || st.unsupported) {
      siteRow.style.display = 'none';
      return;
    }
    siteRow.style.display = '';
    $('siteName').textContent = host;

    var mode = MATCH.siteMode(config, currentUrl);
    var btns = document.querySelectorAll('#siteSeg button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = st.disabled;
      btns[i].classList.toggle('active', btns[i].getAttribute('data-site') === mode);
    }
  }

  function stateFor(c) {
    return {
      dark: SUN.shouldBeDark(c),
      window: SUN.resolveWindow(c),
      next: SUN.nextSwitch(c)
    };
  }

  /* 状态行只讲"昼夜状态"。控件不可用时留空 —— 原因已经在提示块里讲过了，
   * 这里再显示"夜间时段 19:00–07:00"只会让人以为一切正常（以前的老毛病）。 */
  function renderStatus(state, st) {
    var text = '';
    if (st.disabled) {
      text = '';
    } else if (config.mode !== 'auto') {
      /* 手动模式是"临时覆盖"：到下一个自然切换点会自动回到自动。 */
      text = msg('popupManual', [config.mode === 'dark' ? msg('popupNight') : msg('popupDay')]);
      if (state && state.next) text += ' · ' + msg('popupManualUntil', fmtDuration(state.next.minutes));
    } else if (!state.dark) {
      text = msg('popupNotNow');
      if (state && state.next) text += ' · ' + msg('popupNextSwitch', fmtDuration(state.next.minutes));
    } else if (config.schedule.type === 'sun' && state.window) {
      text = msg('popupSunTimes', [fmtTime(state.window.start), fmtTime(state.window.end)]);
      if (state && state.next) text += ' · ' + msg('popupNextSwitch', fmtDuration(state.next.minutes));
    } else if (state && state.next) {
      text = msg('popupNextSwitch', fmtDuration(state.next.minutes));
    }
    // 通信错误的提示优先级最高，不能被状态文案盖掉
    if (!lastError) $('status').textContent = text;
  }

  function render(state) {
    var st = controlsState();

    var buttons = document.querySelectorAll('#modeSeg button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].disabled = st.disabled;
      buttons[i].classList.toggle('active', buttons[i].getAttribute('data-mode') === config.mode);
    }

    $('brightness').disabled = st.disabled;
    $('temperature').disabled = st.disabled;
    $('brightness').value = config.theme.brightness;
    $('brightnessOut').textContent = config.theme.brightness + '%';
    $('temperature').value = config.theme.temperature;
    $('temperatureOut').textContent = config.theme.temperature > 0
      ? '+' + config.theme.temperature
      : String(config.theme.temperature);

    renderNotice(st);
    applyTheme();
    renderSite(st);
    renderStatus(state || stateFor(config), st);
  }

  /* ---------- 读写 ---------- */

  /* 从 storage 重新载入并渲染。这是唯一的"读"入口。 */
  function refresh() {
    return STORE.read().then(function (raw) {
      ok();
      config = CFG.normalize(raw);
      render(stateFor(config));
      syncBadge(config);   // 打开面板时顺手校准可能陈旧的徽标
      return config;
    }).catch(function (e) {
      fail(msg('msgNoBackground') + ' · ' + (e && e.message ? e.message : 'storage'));
      return null;
    });
  }

  /* 徽标同帧写（不依赖后台）：本机后台 onMessage 注册不上、onChanged 唤醒也
   * 不可靠，所以点按钮的瞬间由面板自己把全局徽标改到位；后台稍后收到信号
   * 闹钟会再收敛一次 —— 写的是同一个值，不冲突。
   * 判定与颜色统一来自 sun.badgeState（三个写入方共用一个出口），并且只写
   * 全局徽标、绝不写 per-tab：per-tab 覆盖没有"解除"API，写过一次就得永远
   * 维护它（详见 background.js 里的说明）。 */
  function syncBadge(c) {
    if (!c || !SUN) return;
    try {
      var s = SUN.badgeState(c);
      chrome.action.setBadgeText({ text: s.text });
      chrome.action.setBadgeBackgroundColor({ color: s.color });
      console.debug('[Night Owl] badge ->', s.text, '(popup)');
    } catch (e) { /* action API 不可用时只能靠后台，静默即可 */ }
  }

  /* 落盘。先 normalize（保证存进去的永远是合法结构），写 storage，然后
   * ①同帧写徽标 ②发信号闹钟唤醒后台（两条都不依赖消息通道）。 */
  function save() {
    config = CFG.normalize(config);
    config.savedAt = Date.now();   // 供 SW 端按 savedAt 对账取新（回读可能滞后）
    return STORE.write(config).then(function () {
      ok();
      syncBadge(config);      // 徽标同帧翻转，不等后台
      STORE.signal(config);   // 信号闹钟：把新配置带给后台（见 store.signal）
      return config;
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
    /* 所有交互的守卫都查同一个 controlsState()（按钮已禁用，这里只是兜底）；
     * 以前每个 handler 各写一套条件 —— 站点三态就漏了"本页不支持"。 */

    /* 模式：自动 / 黑夜 / 白天。选黑夜或白天时记录"下一次自然切换点"作为
     * 失效时刻 —— 到点自动回到自动，不会永久锁死。 */
    var buttons = document.querySelectorAll('#modeSeg button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (e) {
        if (controlsState().disabled) return;
        var next = SUN.nextSwitch(config);
        CFG.setManualMode(config, e.currentTarget.getAttribute('data-mode'), next ? next.at : 0);
        /* 徽标与点击同帧翻转：放在 save() 的异步链里会"慢一拍"甚至丢失
         * （后台收不到通知时没人补写），必须在这里同步写。 */
        syncBadge(config);
        // 先把选中态画出来，用户立刻就有点击反馈
        render();
        save();
      });
    }

    $('brightness').addEventListener('input', function (e) {
      if (controlsState().disabled) return;
      config.theme.brightness = parseInt(e.target.value, 10);
      $('brightnessOut').textContent = config.theme.brightness + '%';
      preview();
    });
    $('brightness').addEventListener('change', function () {
      if (controlsState().disabled) return;
      save();
    });

    $('temperature').addEventListener('input', function (e) {
      if (controlsState().disabled) return;
      config.theme.temperature = parseInt(e.target.value, 10);
      $('temperatureOut').textContent = config.theme.temperature > 0
        ? '+' + config.theme.temperature
        : String(config.theme.temperature);
      preview();
    });
    $('temperature').addEventListener('change', function () {
      if (controlsState().disabled) return;
      save();
    });

    /* 站点开关：三态选择，直接落黑名单 / 白名单 / 都不落（跟随全局）。 */
    var siteBtns = document.querySelectorAll('#siteSeg button');
    for (var k = 0; k < siteBtns.length; k++) {
      siteBtns[k].addEventListener('click', function (e) {
        if (controlsState().disabled || !currentUrl) return;
        MATCH.setSiteMode(config, currentUrl, e.currentTarget.getAttribute('data-site'));
        render();
        save();
      });
    }

    $('openOptions').addEventListener('click', function () {
      try { chrome.runtime.openOptionsPage(); } catch (e) { fail(); }
    });

    /* 了解更多：直达设置页「其他」tab，看浏览器安全限制的完整说明 */
    $('learnMore').addEventListener('click', function () {
      try {
        chrome.tabs.create({
          url: chrome.runtime.getURL('src/options/options.html?tab=other')
        });
      } catch (e) { fail(); }
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

  /* 外部改动（设置页、快捷键、另一个面板窗口）实时反映到本面板。
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
