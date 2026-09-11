/* Night Owl — 日出/日落计算（NOAA 近似算法，精度约 ±2 分钟）
 * 纯本地数学计算，不依赖任何网络请求、DOM 或扩展 API。
 */
(function () {
  'use strict';

  var root = (typeof module !== 'undefined' && module.exports)
    ? module.exports
    : (typeof globalThis !== 'undefined' ? globalThis : window);

  var RAD = Math.PI / 180;
  var ZENITH = 90.833; // 民用暮光，即太阳上缘接触地平线

  function norm360(v) {
    v = v % 360;
    return v < 0 ? v + 360 : v;
  }

  /* 返回 UTC 小时数（0–24），null 表示极昼/极夜 */
  function solve(date, lat, lng, isRise) {
    var year = date.getFullYear();
    var month = date.getMonth() + 1;
    var day = date.getDate();

    var n1 = Math.floor(275 * month / 9);
    var n2 = Math.floor((month + 9) / 12);
    var n3 = 1 + Math.floor((year - 4 * Math.floor(year / 4) + 2) / 3);
    var n = n1 - (n2 * n3) + day - 30;

    var lngHour = lng / 15;
    var t = n + ((isRise ? 6 : 18) - lngHour) / 24;

    var m = (0.9856 * t) - 3.289;

    var l = m + (1.916 * Math.sin(m * RAD)) + (0.020 * Math.sin(2 * m * RAD)) + 282.634;
    l = norm360(l);

    var ra = Math.atan(0.91764 * Math.tan(l * RAD)) / RAD;
    ra = norm360(ra);
    var lQuad = Math.floor(l / 90) * 90;
    var raQuad = Math.floor(ra / 90) * 90;
    ra = (ra + (lQuad - raQuad)) / 15;

    var sinDec = 0.39782 * Math.sin(l * RAD);
    var cosDec = Math.cos(Math.asin(sinDec));

    // 贴近两极时 cos(lat)→0 会除零，钳制到 ±89.9
    var safeLat = Math.max(-89.9, Math.min(89.9, lat));
    var cosH = (Math.cos(ZENITH * RAD) - (sinDec * Math.sin(safeLat * RAD))) /
               (cosDec * Math.cos(safeLat * RAD));

    if (cosH > 1) return null;   // 极夜：太阳全天不升起
    if (cosH < -1) return null;  // 极昼：太阳全天不落下

    var h = Math.acos(cosH) / RAD;
    if (isRise) h = 360 - h;
    h = h / 15;

    var localT = h + ra - (0.06571 * t) - 6.622;
    var utc = localT - lngHour;
    utc = utc % 24;
    return utc < 0 ? utc + 24 : utc;
  }

  function sunTimes(date, lat, lng) {
    return {
      sunriseUTC: solve(date, lat, lng, true),
      sunsetUTC: solve(date, lat, lng, false)
    };
  }

  /* UTC 小时 → 本机时区当天 0 点起的分钟数 */
  function utcHoursToLocalMinutes(utcHours) {
    var offsetHours = -new Date().getTimezoneOffset() / 60;
    var m = Math.round((utcHours + offsetHours) * 60);
    return ((m % 1440) + 1440) % 1440;
  }

  function norm1440(m) {
    return ((Math.round(m) % 1440) + 1440) % 1440;
  }

  /* 根据配置解析出今天的夜间窗口 { start, end, fallback }（单位：本地分钟） */
  function resolveWindow(config, date) {
    date = date || new Date();
    var s = config.schedule;
    var C = root.NW.config;

    if (s.type === 'time') {
      return {
        start: C.timeToMinutes(s.start),
        end: C.timeToMinutes(s.end),
        fallback: false
      };
    }

    var times = sunTimes(date, s.latitude, s.longitude);
    if (times.sunsetUTC === null || times.sunriseUTC === null) {
      // 极昼/极夜：算法无解，降级到用户设定的固定时间
      return {
        start: C.timeToMinutes(s.start),
        end: C.timeToMinutes(s.end),
        fallback: true
      };
    }

    return {
      start: norm1440(utcHoursToLocalMinutes(times.sunsetUTC) + s.sunsetOffset),
      end: norm1440(utcHoursToLocalMinutes(times.sunriseUTC) + s.sunriseOffset),
      fallback: false
    };
  }

  function isNight(minutes, win) {
    var s = win.start, e = win.end;
    if (s === e) return true;                 // 全天夜间
    if (s < e) return minutes >= s && minutes < e;
    return minutes >= s || minutes < e;        // 跨午夜的常规情况
  }

  function nowMinutes(date) {
    date = date || new Date();
    return date.getHours() * 60 + date.getMinutes();
  }

  function shouldBeDark(config, date) {
    if (!config.enabled) return false;
    if (config.mode === 'dark') return true;
    if (config.mode === 'light') return false;
    return isNight(nowMinutes(date), resolveWindow(config, date));
  }

  /* 距离下一次自动切换还有多久；mode 非 auto 时返回 null */
  function nextSwitch(config, date) {
    if (!config.enabled || config.mode !== 'auto') return null;
    date = date || new Date();

    var win = resolveWindow(config, date);
    var cur = nowMinutes(date);
    var night = isNight(cur, win);
    var boundary = night ? win.end : win.start;

    var delta = norm1440(boundary - cur);
    if (delta <= 0) delta = 1440;

    return {
      target: night ? 'light' : 'dark',
      minutes: delta,
      at: Date.now() + delta * 60000
    };
  }

  /* 只对外露出会被多模块使用的 API。
   * isNight / nowMinutes 是内部辅助，不外露。 */
  var api = {
    sunTimes: sunTimes,
    resolveWindow: resolveWindow,
    shouldBeDark: shouldBeDark,
    nextSwitch: nextSwitch,
    utcHoursToLocalMinutes: utcHoursToLocalMinutes
  };

  // mount: browser -> globalThis.NW.sun ; node -> flat module.exports
  root.NW = root.NW || {};
  root.NW.sun = api;
  if (typeof module !== 'undefined' && module.exports) {
    for (var k in api) {
      if (Object.prototype.hasOwnProperty.call(api, k)) module.exports[k] = api[k];
    }
  }
})();
