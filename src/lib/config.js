/* Night Owl — 配置 schema、默认值与校验
 * 运行环境：content script / background service worker / options / popup
 * 挂载方式：globalThis.NW（兼容 importScripts、多 <script> 顺序加载与 node require）
 */
(function () {
  'use strict';

  // node 环境（构建脚本 / 自检）下把 globalThis 换成 module.exports
  var root = (typeof module !== 'undefined' && module.exports)
    ? module.exports
    : (typeof globalThis !== 'undefined' ? globalThis : window);

  var VERSION = 1;

  var DEFAULTS = {
    version: VERSION,
    enabled: true,               // 总开关
    mode: 'auto',                // 'auto' | 'dark' | 'light'
    theme: {
      invert: 92,                // 反色强度 %（60–100）
      brightness: 100,           // %
      contrast: 100,             // %
      saturation: 90,            // %
      temperature: 15,           // -100（冷）… +100（暖）
      grayscale: 0               // %
    },
    schedule: {
      type: 'sun',               // 'sun' | 'time'
      latitude: 31.2304,
      longitude: 121.4737,
      start: '19:00',            // type=time 时的夜间开始
      end: '07:00',              // type=time 时的夜间结束
      sunsetOffset: 0,           // 相对日落的偏移（分钟，可负）
      sunriseOffset: 0,          // 相对日出的偏移（分钟，可负）
      city: ''                   // 最近城市标签（仅用于展示，可空）
    },
    lists: {
      // 黑名单 = 这些网址要变暗；白名单 = 这些网址不变暗（豁免，优先级更高）
      blacklist: [],
      whitelist: []
    },
    advanced: {
      preserveMedia: true,       // 图片/视频反向还原
      skipDarkSites: true,       // 跳过本身已是深色的站点
      target: 'html'             // 'html' | 'body'
    }
  };

  /* 数值钳制：被 config / sun / filter 三处使用。挂在 NW.config 上作为
   * 公共 helper，避免每个 lib 各自写一份。 */
  function clamp(n, min, max) {
    n = Number(n);
    if (!isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  /* 深合并：只接受 DEFAULTS 中已存在的键，丢弃未知键（防止导入脏数据） */
  function merge(base, patch) {
    if (!isObj(patch)) return JSON.parse(JSON.stringify(base));
    var out = {};
    Object.keys(base).forEach(function (k) {
      var bv = base[k];
      var pv = patch[k];
      if (pv === undefined) {
        out[k] = Array.isArray(bv) ? bv.slice() : (isObj(bv) ? merge(bv, {}) : bv);
      } else if (isObj(bv)) {
        out[k] = merge(bv, pv);
      } else if (Array.isArray(bv)) {
        out[k] = Array.isArray(pv)
          ? pv.filter(function (x) { return typeof x === 'string'; }).map(function (x) { return x.trim(); }).filter(Boolean)
          : bv.slice();
      } else if (typeof bv === 'number') {
        out[k] = pv; // 数值范围在具体字段处单独 clamp
      } else if (typeof bv === 'boolean') {
        out[k] = typeof pv === 'boolean' ? pv : bv;
      } else {
        out[k] = typeof pv === 'string' ? pv : bv;
      }
    });
    return out;
  }

  var MODES = ['auto', 'dark', 'light'];
  var SCHEDULE_TYPES = ['sun', 'time'];
  var TARGETS = ['html', 'body'];

  function parseTime(str, fallback) {
    if (typeof str !== 'string') return fallback;
    var m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
    if (!m) return fallback;
    var h = clamp(m[1], 0, 23);
    var mi = clamp(m[2], 0, 59);
    return (h < 10 ? '0' + h : '' + h) + ':' + (mi < 10 ? '0' + mi : '' + mi);
  }

  /* 归一化 + 数值钳制，任何来源（storage / 导入文件）的数据都必须过这一层 */
  function normalize(raw) {
    var c = merge(DEFAULTS, isObj(raw) ? raw : {});
    c.version = VERSION;

    c.enabled = typeof raw === 'object' && raw !== null && typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled;
    if (MODES.indexOf(c.mode) < 0) c.mode = 'auto';
    if (SCHEDULE_TYPES.indexOf(c.schedule.type) < 0) c.schedule.type = 'sun';
    if (TARGETS.indexOf(c.advanced.target) < 0) c.advanced.target = 'html';

    var t = c.theme;
    t.invert = Math.round(clamp(t.invert, 60, 100));
    t.brightness = Math.round(clamp(t.brightness, 40, 150));
    t.contrast = Math.round(clamp(t.contrast, 50, 150));
    t.saturation = Math.round(clamp(t.saturation, 0, 150));
    t.temperature = Math.round(clamp(t.temperature, -100, 100));
    t.grayscale = Math.round(clamp(t.grayscale, 0, 100));

    var s = c.schedule;
    s.latitude = Math.round(clamp(s.latitude, -90, 90) * 10000) / 10000;
    s.longitude = Math.round(clamp(s.longitude, -180, 180) * 10000) / 10000;
    s.sunsetOffset = Math.round(clamp(s.sunsetOffset, -300, 300));
    s.sunriseOffset = Math.round(clamp(s.sunriseOffset, -300, 300));
    s.start = parseTime(s.start, DEFAULTS.schedule.start);
    s.end = parseTime(s.end, DEFAULTS.schedule.end);
    s.city = typeof s.city === 'string' ? s.city.slice(0, 64) : '';

    return c;
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  var api = {
    VERSION: VERSION,
    DEFAULTS: DEFAULTS,
    /* normalize / parseTime / timeToMinutes / minutesToTime / clamp —— 公共 API */
    normalize: normalize,
    parseTime: parseTime,
    timeToMinutes: function (str) {
      var m = /^(\d{1,2}):(\d{2})$/.exec(String(str || ''));
      if (!m) return 0;
      return clamp(m[1], 0, 23) * 60 + clamp(m[2], 0, 59);
    },
    minutesToTime: function (mins) {
      mins = Math.round(mins);
      var total = ((mins % 1440) + 1440) % 1440;
      var h = Math.floor(total / 60);
      var mi = total % 60;
      return (h < 10 ? '0' + h : '' + h) + ':' + (mi < 10 ? '0' + mi : '' + mi);
    },
    clamp: clamp
    /* merge / clone 是 normalize 内部用，不外露 —— 以前在 api 里是死代码。
     * normalize 的对外契约是"输入任何形状的数据，输出合法 config"，调用方
     * 不应该自己拼接 merge 调用。 */
  };

  // mount: browser -> globalThis.NW.config ; node -> flat module.exports
  root.NW = root.NW || {};
  root.NW.config = api;
  if (typeof module !== 'undefined' && module.exports) {
    for (var k in api) {
      if (Object.prototype.hasOwnProperty.call(api, k)) module.exports[k] = api[k];
    }
  }
})();
