/* Night Owl — 设置页逻辑 */
(function () {
  'use strict';

  var CFG = window.NW.config;
  var SUN = window.NW.sun;
  var FILTER = window.NW.filter;
  var GEO = window.NW.geo;
  var STORE = window.NW.store;

  var config = null;
  var currentUrl = null;
  var toastTimer = null;
  var previewTimer = null;

  /* ---------- 面板换肤 ----------
   * 与 popup 同一套语义：设置页跟着"当前实际生效的明暗"走（sun.badgeState）。
   * 黑夜 → 暗色（CSS 默认），白天 / 总开关关闭 → 亮色（html.nw-light）。
   * 只切 CSS 变量，不套滤镜、不碰用户的外观参数。 */
  var THEME_KEY = 'night-owl:theme';   // localStorage：给"首帧上色"当缓存
  var themeTimer = null;

  /* 首帧先按上次的明暗上色，避免打开设置页时"先暗后亮"闪一下；
   * 真值等 load() 读完配置由 applyTheme 校准。 */
  try {
    if (localStorage.getItem(THEME_KEY) === 'light') {
      document.documentElement.classList.add('nw-light');
    }
  } catch (e) { /* 存储不可用就退化为默认暗色，不影响功能 */ }

  /* 按当前生效的明暗切换配色，并按"下一次自然切换点"排下一次重算。
   * 设置页会长时间开着，而自动模式的昼夜切换不会产生任何 storage 事件 ——
   * 不自己定时的话，页面会一直停在打开那一刻的配色。拿不到切换点（总开关
   * 关闭等）就 60s 兜底查一次。 */
  function applyTheme() {
    var light = false;
    if (config && SUN) light = !SUN.badgeState(config).on;
    try {
      document.documentElement.classList.toggle('nw-light', light);
      localStorage.setItem(THEME_KEY, light ? 'light' : 'dark');
    } catch (e) { }
    clearTimeout(themeTimer);
    var next = null;
    try { next = config && SUN ? SUN.nextSwitch(config) : null; } catch (e) { }
    var wait = (next && next.at > Date.now()) ? (next.at - Date.now() + 1000) : 60000;
    themeTimer = setTimeout(applyTheme, wait);
  }

  function msg(key, subs) {
    try { return chrome.i18n.getMessage(key, subs); } catch (e) { return key; }
  }

  function $(id) { return document.getElementById(id); }

  function applyI18n() {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var text = msg(nodes[i].getAttribute('data-i18n'));
      if (text) nodes[i].textContent = text;
    }
    document.title = msg('optTitle');
  }

  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }

  /* ---------- 读写 ----------
   * 直接走 chrome.storage.local，不经过 runtime.onMessage。
   * 原因见 src/lib/store.js 顶部：农场主这台 Chrome 152 上 SW 的
   * onMessage 注册不上去，任何"发消息"的写操作都会丢，表现就是
   * "设置页改完关掉又变回去了"。
   *
   * 错误条只在 storage 真的读写失败时才出现 —— 那才是扩展坏了的信号。 */

  function bgFail(why) {
    document.body.classList.add('bg-down');
    var bar = $('bgError');
    if (bar) {
      bar.textContent = msg('msgNoBackground') + (why ? ' (' + why + ')' : '');
      bar.style.display = '';
    }
  }

  function bgOk() {
    document.body.classList.remove('bg-down');
    var bar = $('bgError');
    if (bar) bar.style.display = 'none';
  }

  /* 徽标同帧写：与 popup 一样只写全局值，判定与颜色统一来自 sun.badgeState。
   * 落盘成功后不等后台（本机后台唤醒不可靠），后台稍后收到信号闹钟会再收敛
   * 一次 —— 同一个值，不冲突。 */
  function syncBadge(c) {
    if (!c || !SUN) return;
    try {
      var s = SUN.badgeState(c);
      chrome.action.setBadgeText({ text: s.text });
      chrome.action.setBadgeBackgroundColor({ color: s.color });
      console.debug('[Night Owl] badge ->', s.text, '(options)');
    } catch (e) { /* action API 不可用时只能靠后台，静默即可 */ }
  }

  function save(quiet) {
    echoGuard++;
    config = CFG.normalize(config);
    config.savedAt = Date.now();   // 供 SW 端按 savedAt 对账取新（回读可能滞后）
    STORE.write(config).then(function () {
      echoGuard--;
      bgOk();
      if (!quiet) toast(msg('msgSaved'));
      renderComputed();
      applyTheme();           // 换肤：mode / 总开关 / 时段设置都可能改变生效明暗
      syncBadge(config);      // 徽标同帧翻转，不等后台
      STORE.signal(config);   // 信号闹钟：把新配置带给后台（见 store.signal）
    }).catch(function (e) {
      echoGuard--;
      bgFail(e && e.message);
    });
  }

  function load() {
    STORE.read().then(function (raw) {
      bgOk();
      config = CFG.normalize(raw);
      render();
      syncBadge(config);   // 打开设置页时顺手校准可能陈旧的徽标
      /* 配置就绪后才绑定事件，避免空指针。
       * 之前用 setInterval(30ms) 轮询 config —— 每 30ms 一次定时器常驻直到
       * config 就绪，浪费且落后于"事件驱动"。改成"load 成功后一次性绑定"。 */
      if (!readyBound) {
        readyBound = true;
        bindGeneral();
        bindAppearance();
        bindLists();
        bindAdvanced();
        bindBackup();
      }
    }).catch(function (e) {
      bgFail(e && e.message);
    });
  }

  var readyBound = false;

  /* ---------- 渲染 ---------- */

  function setSeg(id, attr, value) {
    var btns = document.querySelectorAll('#' + id + ' button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-' + attr) === value);
    }
  }

  function setRadio(name, value) {
    var inputs = document.querySelectorAll('input[name=' + name + ']');
    for (var i = 0; i < inputs.length; i++) inputs[i].checked = inputs[i].value === value;
  }

  function renderList(kind) {
    var list = config.lists[kind];
    var box = $(kind + 'View');
    box.textContent = '';

    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'rule-empty';
      empty.textContent = msg('listEmpty');
      box.appendChild(empty);
      return;
    }

    list.forEach(function (rule, index) {
      var row = document.createElement('div');
      row.className = 'rule-item';

      var text = document.createElement('span');
      text.textContent = rule;

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rule-remove';
      btn.textContent = '\u00d7';
      btn.title = msg('btnRemove');
      btn.setAttribute('data-kind', kind);
      btn.setAttribute('data-index', String(index));

      row.appendChild(text);
      row.appendChild(btn);
      box.appendChild(row);
    });
  }

  function renderLists() {
    renderList('blacklist');
    renderList('whitelist');
  }

  /* 总开关是最顶层条件：关闭时昼夜模式不可切换（与 popup 同一套门控语义），
   * 同时显示提示，避免"点了没反应"被当成 bug。 */
  function syncModeGate() {
    var on = !!config.enabled;
    var btns = document.querySelectorAll('#modeSeg button');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = !on;
    var hint = $('modeDisabledHint');
    if (hint) hint.style.display = on ? 'none' : '';
  }

  function render() {
    $('enabled').checked = !!config.enabled;
    setSeg('modeSeg', 'mode', config.mode);
    setSeg('typeSeg', 'type', config.schedule.type);
    syncModeGate();

    $('latitude').value = config.schedule.latitude;
    $('longitude').value = config.schedule.longitude;
    $('sunsetOffset').value = config.schedule.sunsetOffset;
    $('sunriseOffset').value = config.schedule.sunriseOffset;
    $('startTime').value = config.schedule.start;
    $('endTime').value = config.schedule.end;

    $('invert').value = config.theme.invert;
    $('brightness').value = config.theme.brightness;
    $('contrast').value = config.theme.contrast;
    $('saturation').value = config.theme.saturation;
    $('temperature').value = config.theme.temperature;
    $('grayscale').value = config.theme.grayscale;
    $('mediaDim').value = config.advanced.mediaDim;
    syncOutputs();

    setRadio('target', config.advanced.target);
    renderLists();

    $('preserveMedia').checked = !!config.advanced.preserveMedia;
    $('skipDark').checked = !!config.advanced.skipDarkSites;
    syncMediaDimGate();

    toggleScheduleFields();
    updatePreview();
    renderComputed();
    refreshCity();
    applyTheme();
  }

  function syncOutputs() {
    $('invertOut').textContent = config.theme.invert + '%';
    $('brightnessOut').textContent = config.theme.brightness + '%';
    $('contrastOut').textContent = config.theme.contrast + '%';
    $('saturationOut').textContent = config.theme.saturation + '%';
    $('grayscaleOut').textContent = config.theme.grayscale + '%';
    $('mediaDimOut').textContent = config.advanced.mediaDim + '%';
    syncMediaDimReset();
    var t = config.theme.temperature;
    $('temperatureOut').textContent = t > 0 ? '+' + t : String(t);
  }

  /* 「媒体亮度」只在"保留原始色彩"开启时才有意义（关掉后媒体跟随整页一起被调），
   * 所以开关关闭时把滑杆置灰，避免"调了没反应"被当成 bug。 */
  function syncMediaDimGate() {
    var on = !!config.advanced.preserveMedia;
    $('mediaDim').disabled = !on;
    var row = $('mediaDimRow');
    if (row) row.classList.toggle('off', !on);
    syncMediaDimReset();
  }

  /** 媒体亮度「恢复默认」按钮：媒体保真关闭、或已是默认值 92 时置灰禁用 */
  function syncMediaDimReset() {
    var btn = $('resetMediaDim');
    if (!btn) return;
    var isDefault = config.advanced.mediaDim === CFG.DEFAULTS.advanced.mediaDim;
    btn.disabled = !config.advanced.preserveMedia || isDefault;
  }

  function toggleScheduleFields() {
    var isSun = config.schedule.type === 'sun';
    $('sunFields').style.display = isSun ? '' : 'none';
    $('timeFields').style.display = isSun ? 'none' : '';
    $('computed').style.display = isSun ? '' : 'none';
  }

  function updatePreview() {
    $('previewPage').style.filter = FILTER.build(config.theme);
    /* 「高级」里的示例图演示媒体在黑夜模式下的**净效果** = 白天原色 × 媒体亮度。
     * 真实页面里：媒体子级做逆运算、父级再套页面滤镜，两者相抵后只剩这层压暗；
     * 这里没有页面滤镜，所以直接给图套一层 brightness(媒体亮度) 即可，不必套 buildMedia。 */
    var img = $('previewMedia');
    if (img) {
      img.style.filter = config.advanced.preserveMedia
        ? 'brightness(' + (config.advanced.mediaDim / 100).toFixed(3) + ')'
        : 'none';
    }
  }

  function renderComputed() {
    if (config.schedule.type !== 'sun') {
      $('computedSunset').textContent = '—';
      $('computedSunrise').textContent = '—';
      return;
    }
    var st = SUN.sunTimes(new Date(), config.schedule.latitude, config.schedule.longitude);
    if (st.sunsetUTC === null || st.sunriseUTC === null) {
      $('computedSunset').textContent = '—';
      $('computedSunrise').textContent = '—';
      $('polarHint').classList.add('show');
      return;
    }
    $('polarHint').classList.remove('show');
    $('computedSunset').textContent = CFG.minutesToTime(
      SUN.utcHoursToLocalMinutes(st.sunsetUTC) + config.schedule.sunsetOffset);
    $('computedSunrise').textContent = CFG.minutesToTime(
      SUN.utcHoursToLocalMinutes(st.sunriseUTC) + config.schedule.sunriseOffset);
  }

  /* ---------- 位置 → 最近城市 ---------- */

  function formatKm(km) {
    if (!isFinite(km)) return '';
    if (km < 1) return '<1 km';
    if (km < 100) return (Math.round(km * 10) / 10) + ' km';
    return Math.round(km) + ' km';
  }

  /* 用内置城市库做最近邻匹配；查不到（数据缺失/坐标非法）返回 null */
  function lookupCity(lat, lng) {
    if (!GEO) return null;
    var hit = GEO.nearest(lat, lng);
    if (!hit) return null;
    var label = hit.name + ', ' + hit.country;
    var km = formatKm(hit.km);
    // major=false → 附近 30km 内没有收录城市，提醒用户别盲信
    var far = !hit.major || hit.km > 150;
    return {
      label: label,
      text: far ? msg('cityFar', [label, km]) : msg('cityNear', [label, km])
    };
  }

  function refreshCity() {
    var status = $('detectStatus');
    if (config.schedule.type !== 'sun') {
      status.textContent = '';
      return;
    }
    var info = lookupCity(config.schedule.latitude, config.schedule.longitude);
    if (!info) {
      // 城市库不可用时退回记住的标签
      status.textContent = config.schedule.city ? msg('cityKnown', [config.schedule.city]) : '';
      return;
    }
    config.schedule.city = info.label;
    status.textContent = info.text;
  }

  /* ---------- 标签页 ---------- */

  function showTab(name) {
    var secs = document.querySelectorAll('section[data-panel]');
    for (var i = 0; i < secs.length; i++) {
      secs[i].classList.toggle('active', secs[i].getAttribute('data-panel') === name);
    }
    var btns = document.querySelectorAll('#tabs button');
    for (var j = 0; j < btns.length; j++) {
      btns[j].classList.toggle('active', btns[j].getAttribute('data-tab') === name);
    }
    try { localStorage.setItem('night-owl:tab', name); } catch (e) {}
  }

  /* ---------- 备份 ---------- */

  /** 导出文件名用的时间戳：YYYYMMDD-HHMMSS（精确到秒，同一天多次导出不会互相覆盖）。 */
  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function exportConfig() {
    var blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'night-owl-settings-' + stamp() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function importConfig(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (e) {
        toast(msg('msgImportError'));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || !parsed.theme) {
        toast(msg('msgImportError'));
        return;
      }
      var next = CFG.normalize(parsed);
      next.savedAt = Date.now();   // 落盘打戳：后台按 savedAt 对账取新
      echoGuard++;
      STORE.write(next).then(function () {
        echoGuard--;
        bgOk();
        config = next;
        render();
        toast(msg('msgImported'));
        syncBadge(config);
        STORE.signal(config);
      }).catch(function (e) {
        echoGuard--;
        bgFail(e && e.message);
        toast(msg('msgImportError'));
      });
    };
    reader.readAsText(file);
  }

  function restoreDefaults() {
    if (!window.confirm(msg('msgRestoreConfirm'))) return;
    var next = CFG.normalize(CFG.DEFAULTS);
    next.savedAt = Date.now();   // 落盘打戳：后台按 savedAt 对账取新
    echoGuard++;
    STORE.write(next).then(function () {
      echoGuard--;
      bgOk();
      config = next;
      render();
      toast(msg('msgSaved'));
      syncBadge(config);
      STORE.signal(config);
    }).catch(function (e) {
      echoGuard--;
      bgFail(e && e.message);
    });
  }

  /* ---------- 事件 ---------- */

  function bindGeneral() {
    $('enabled').addEventListener('change', function (e) {
      config.enabled = e.target.checked;
      /* 立刻刷新门控与提示，不等落盘回声 —— 落盘失败时 UI 也不能说谎 */
      syncModeGate();
      save();
    });

    var modeBtns = document.querySelectorAll('#modeSeg button');
    for (var i = 0; i < modeBtns.length; i++) {
      modeBtns[i].addEventListener('click', function (e) {
        /* 总开关是最顶层条件：关闭时昼夜切换不生效（按钮已禁用，这里兜底） */
        if (!config || !config.enabled) return;
        /* 手动选黑夜/白天时记录下一个自然切换点作为失效时刻，到点自动回到自动。 */
        var next = SUN.nextSwitch(config);
        CFG.setManualMode(config, e.currentTarget.getAttribute('data-mode'), next ? next.at : 0);
        syncBadge(config);   // 徽标与点击同帧翻转，不等落盘与后台
        setSeg('modeSeg', 'mode', config.mode);
        save();
      });
    }

    var typeBtns = document.querySelectorAll('#typeSeg button');
    for (var j = 0; j < typeBtns.length; j++) {
      typeBtns[j].addEventListener('click', function (e) {
        config.schedule.type = e.currentTarget.getAttribute('data-type');
        setSeg('typeSeg', 'type', config.schedule.type);
        toggleScheduleFields();
        renderComputed();
        refreshCity();
        save();
      });
    }

    function num(id, key) {
      $(id).addEventListener('change', function (e) {
        var v = parseFloat(e.target.value);
        if (!isFinite(v)) { render(); return; }
        config.schedule[key] = v;
        save();
        renderComputed();
        refreshCity(); // 手动改坐标也重新认一次城市
      });
    }
    num('latitude', 'latitude');
    num('longitude', 'longitude');
    num('sunsetOffset', 'sunsetOffset');
    num('sunriseOffset', 'sunriseOffset');

    $('startTime').addEventListener('change', function (e) {
      config.schedule.start = CFG.parseTime(e.target.value, config.schedule.start);
      save();
    });
    $('endTime').addEventListener('change', function (e) {
      config.schedule.end = CFG.parseTime(e.target.value, config.schedule.end);
      save();
    });

    $('detect').addEventListener('click', function () {
      var status = $('detectStatus');
      if (!navigator.geolocation) {
        status.textContent = msg('detectFail');
        return;
      }
      status.textContent = msg('detectLocating');
      navigator.geolocation.getCurrentPosition(function (pos) {
        config.schedule.latitude = Math.round(pos.coords.latitude * 10000) / 10000;
        config.schedule.longitude = Math.round(pos.coords.longitude * 10000) / 10000;
        $('latitude').value = config.schedule.latitude;
        $('longitude').value = config.schedule.longitude;
        refreshCity(); // 定位成功 → 查最近城市并展示
        if (!$('detectStatus').textContent) $('detectStatus').textContent = msg('detectOk');
        save(true);
        renderComputed();
      }, function () {
        status.textContent = msg('detectFail');
      }, { timeout: 10000, maximumAge: 600000 });
    });
  }

  function bindAppearance() {
    var sliders = [
      ['invert', 'invert'],
      ['brightness', 'brightness'],
      ['contrast', 'contrast'],
      ['saturation', 'saturation'],
      ['temperature', 'temperature'],
      ['grayscale', 'grayscale']
    ];

    sliders.forEach(function (pair) {
      var el = $(pair[0]);
      el.addEventListener('input', function (e) {
        config.theme[pair[1]] = parseInt(e.target.value, 10);
        syncOutputs();
        updatePreview();
      });
      el.addEventListener('change', function () {
        save(true);
      });
    });

    $('resetAppearance').addEventListener('click', function () {
      config.theme = JSON.parse(JSON.stringify(CFG.DEFAULTS.theme));
      render();
      save();
    });

    // 「更多选项」折叠：默认收起，点击切换色温 / 黑白程度两滑杆的显示
    $('toggleAdvanced').addEventListener('click', function () {
      var box = $('advancedOptions');
      var open = box.classList.toggle('open');
      $('toggleAdvanced').classList.toggle('open', open);
      $('toggleAdvanced').setAttribute('aria-expanded', String(open));
    });
  }

  function bindLists() {
    ['blacklist', 'whitelist'].forEach(function (kind) {
      var input = $(kind + 'Input');
      var addBtn = $(kind + 'Add');
      if (!input || !addBtn) return;
      input.placeholder = msg('rulePlaceholder');

      function commit() {
        var value = input.value.trim();
        if (!value) return;
        if (config.lists[kind].indexOf(value) < 0) config.lists[kind].push(value);
        input.value = '';
        renderLists();
        save();
      }

      addBtn.addEventListener('click', commit);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      });
    });

    // 列表里的删除按钮：事件委托，列表每次重渲染不用重新绑定
    var boxes = document.querySelectorAll('.rule-list');
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.rule-remove') : null;
        if (!btn) return;
        var kind = btn.getAttribute('data-kind');
        var index = parseInt(btn.getAttribute('data-index'), 10);
        if (isNaN(index)) return;
        config.lists[kind].splice(index, 1);
        renderLists();
        save();
      });
    }
  }

  function bindAdvanced() {
    $('preserveMedia').addEventListener('change', function (e) {
      config.advanced.preserveMedia = e.target.checked;
      syncMediaDimGate();
      save();
    });
    $('mediaDim').addEventListener('input', function (e) {
      config.advanced.mediaDim = parseInt(e.target.value, 10);
      syncOutputs();
      updatePreview();
    });
    $('mediaDim').addEventListener('change', function () {
      save(true);
    });
    // 媒体亮度「恢复默认」：写回默认值并刷新滑杆 / 数值 / 示例图 / 落盘
    $('resetMediaDim').addEventListener('click', function () {
      if ($('resetMediaDim').disabled) return;
      config.advanced.mediaDim = CFG.DEFAULTS.advanced.mediaDim;
      syncOutputs();
      updatePreview();
      save();
    });
    $('skipDark').addEventListener('change', function (e) {
      config.advanced.skipDarkSites = e.target.checked;
      save();
    });
    var radios = document.querySelectorAll('input[name=target]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].addEventListener('change', function (e) {
        config.advanced.target = e.target.value;
        save();
      });
    }
  }

  function bindBackup() {
    $('exportBtn').addEventListener('click', exportConfig);
    $('restoreBtn').addEventListener('click', restoreDefaults);
    $('importBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (file) importConfig(file);
      e.target.value = '';
    });
  }

  function bindTabs() {
    var btns = document.querySelectorAll('#tabs button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (e) {
        showTab(e.currentTarget.getAttribute('data-tab'));
      });
    }
  }

  /* ---------- 外部改动同步 ----------
   * 设置页是独立上下文，只有在打开时读了一次配置。
   * 期间用户可能通过右键菜单 / 快捷键 / popup 改了名单或明暗，
   * 这里监听 storage，把这些改动实时反映到界面上。 */
  /* 自己 save 导致的回响计数器：每个 save 写盘前 ++，完成后 --。
   * 之所以用计数器而不是布尔，是因为 save 是异步的，多个并发的 save
   * 会导致布尔提前归零，把另一次 save 的回响当成"外部改动"误渲染，
   * 把用户正在拖的滑块/正在输入的框冲回旧值。 */
  var echoGuard = 0;
  function inOwnEcho() { return echoGuard > 0; }

  function bindExternalChanges() {
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes.config) return;
        if (inOwnEcho()) return;
        var next = CFG.normalize(changes.config.newValue);
        // 输入框里还没提交的内容不能被冲掉
        var blackDraft = $('blacklistInput') ? $('blacklistInput').value : '';
        var whiteDraft = $('whitelistInput') ? $('whitelistInput').value : '';
        config = next;
        render();
        if ($('blacklistInput')) $('blacklistInput').value = blackDraft;
        if ($('whitelistInput')) $('whitelistInput').value = whiteDraft;
      });
    } catch (e) {}

    // 从别的标签页切回来时再校准一次，兜住漏掉的变更
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) load();
    });
  }

  /* ---------- 启动 ---------- */

  // 扩展被重新加载前打开着旧设置页时，chrome.* 会整体失效，
  // 与其抛一堆 undefined 报错，不如明确提示一次
  function alive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  if (!alive()) {
    document.body.textContent = '';
    var tip = document.createElement('div');
    tip.className = 'wrap';
    tip.style.padding = '32px';
    tip.textContent = msg('msgReload');
    document.body.appendChild(tip);
    return;
  }

  applyI18n();
  bindTabs();
  bindExternalChanges();

  var initial = 'general';
  try { initial = localStorage.getItem('night-owl:tab') || 'general'; } catch (e) {}
  /* popup「了解更多」通过 options.html?tab=other 直达：URL 参数优先于记忆的 tab */
  try {
    var qs = new URLSearchParams(location.search);
    var askTab = qs.get('tab');
    if (askTab && document.querySelector('button[data-tab="' + askTab + '"]')) initial = askTab;
  } catch (e) {}
  showTab(initial);

  load();

  // options 页自身会抢占 active tab，因此取最近访问过的普通网页作为"当前站点"
  chrome.tabs.query({}, function (tabs) {
    var candidates = tabs.filter(function (t) {
      return t.url && (t.url.indexOf('http://') === 0 || t.url.indexOf('https://') === 0);
    });
    candidates.sort(function (a, b) {
      return (b.lastAccessed || 0) - (a.lastAccessed || 0);
    });
    if (!candidates.length) return;
    currentUrl = candidates[0].url;
    var host = null;
    try { host = new URL(currentUrl).hostname; } catch (e) {}
    $('currentSite').textContent = host || '—';
  });
})();
