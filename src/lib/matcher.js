/* Night Owl — 黑白名单规则解析与匹配
 * 支持写法：
 *   example.com              精确匹配该域名
 *   *.example.com            匹配该域名及其所有子域名
 *   https://example.com/mail 匹配指定 scheme + 路径前缀
 *   *://*.example.com/*      完整 match pattern
 *   localhost:8080           带端口
 */
(function () {
  'use strict';

  var root = (typeof module !== 'undefined' && module.exports)
    ? module.exports
    : (typeof globalThis !== 'undefined' ? globalThis : window);

  function parseRule(rule) {
    rule = String(rule == null ? '' : rule).trim();
    if (!rule || rule === '<all_urls>') return null;

    var scheme = null;
    var sm = /^([a-zA-Z*]+):\/\//.exec(rule);
    if (sm) {
      scheme = sm[1].toLowerCase();
      rule = rule.slice(sm[0].length);
    }

    var slash = rule.indexOf('/');
    var host = slash >= 0 ? rule.slice(0, slash) : rule;
    var path = slash >= 0 ? rule.slice(slash) : '';

    var at = host.lastIndexOf('@');
    if (at >= 0) host = host.slice(at + 1);

    var port = null;
    var pm = /^(.*):(\d+)$/.exec(host);
    if (pm) {
      host = pm[1];
      port = pm[2];
    }

    var wildcardSub = false;
    if (host.indexOf('*.') === 0) {
      wildcardSub = true;
      host = host.slice(2);
    } else if (host === '*') {
      wildcardSub = true;
      host = '';
    }

    host = host.toLowerCase();
    if (!host) return null;
    if (path && path.charAt(0) !== '/') path = '/' + path;

    return {
      scheme: scheme,
      host: host,
      port: port,
      path: path,
      wildcardSub: wildcardSub
    };
  }

  function matchOne(parsed, url) {
    if (!parsed) return false;
    var u;
    try {
      u = new URL(url);
    } catch (e) {
      return false;
    }

    var scheme = u.protocol.replace(':', '').toLowerCase();
    if (parsed.scheme && parsed.scheme !== '*' && parsed.scheme !== scheme) return false;

    var host = u.hostname.toLowerCase();
    if (parsed.host) {
      if (parsed.wildcardSub) {
        if (!(host === parsed.host || host.slice(-('.' + parsed.host).length) === ('.' + parsed.host))) return false;
      } else if (host !== parsed.host) {
        return false;
      }
    }

    if (parsed.port && u.port && parsed.port !== u.port) return false;

    if (parsed.path && parsed.path !== '/' && parsed.path !== '/*') {
      var prefix = parsed.path.replace(/\*+$/, '');
      if (prefix && u.pathname.indexOf(prefix) !== 0) return false;
    }

    return true;
  }

  function isListed(rules, url) {
    if (!Array.isArray(rules) || !url) return false;
    for (var i = 0; i < rules.length; i++) {
      if (matchOne(parseRule(rules[i]), url)) return true;
    }
    return false;
  }

  /* 当前站点是否应该变暗。
   * 优先级：白名单豁免（不变暗） > 黑名单强制变暗 > 跟随全局明暗。
   * globalDark 由调用方传入（自动 / 黑夜 / 白天 三态解析后的结果）。
   * 因此：加入白名单 → 立刻变白天；移出白名单 → 恢复到全局该有的样子。 */
  function siteEnabled(config, url, globalDark) {
    if (isListed(config.lists.whitelist, url)) return false;
    if (isListed(config.lists.blacklist, url)) return true;
    return !!globalDark;
  }

  /* 站点三态：'follow' 跟随全局 / 'dark' 强制夜间（黑名单）/ 'light' 强制白天（白名单）。
   * 白名单优先级最高，所以先判白名单。 */
  function siteMode(config, url) {
    if (isListed(config.lists.whitelist, url)) return 'light';
    if (isListed(config.lists.blacklist, url)) return 'dark';
    return 'follow';
  }

  /* 按三态落名单：dark -> 黑名单，light -> 白名单，follow -> 两边都摘除。
   * 三个状态互斥，切换时先清掉两边旧规则，避免同一条 URL 同时占两个名单。 */
  function setSiteMode(config, url, mode) {
    var rule = ruleFor(url);
    if (!rule) return false;

    var w = config.lists.whitelist;
    var b = config.lists.blacklist;
    var rw = matchedRule(w, url);
    var rb = matchedRule(b, url);
    if (rw) w.splice(w.indexOf(rw), 1);
    if (rb) b.splice(b.indexOf(rb), 1);

    if (mode === 'dark') b.push(rule);
    else if (mode === 'light') w.push(rule);
    /* mode === 'follow'：什么都不加，回到跟随全局 */
    return true;
  }

  /* 旧接口：按目标明暗落名单，内部走三态。 */
  function setSiteDark(config, url, wantDark) {
    return setSiteMode(config, url, wantDark ? 'dark' : 'light');
  }

  /* 站点级"合并版"开关：当前是暗的就关掉，当前是亮的就点亮。
   * 必须传入该站点**实际**的明暗（含名单生效后的结果），否则黑白名单会互相打架：
   * 例如某站点已被右键加入白名单 → 实际是亮的 → 开关应把它移出白名单变暗，
   * 若误用全局明暗判断，就会把它又塞进黑名单，出现"点了没反应"。 */
  function toggleSiteDark(config, url, currentDark) {
    return setSiteDark(config, url, !currentDark);
  }

  /* 站点白名单开关专用（快捷键 `nw-toggle-site` 走这里）：只在白名单里增删。
   * 加入时同步从黑名单摘除（否则黑名单会把它拽回黑夜）；
   * 移出后站点恢复为"跟随全局"，全局是夜里就会立刻变暗。 */
  function toggleWhitelist(config, url) {
    var rule = ruleFor(url);
    if (!rule) return false;

    var w = config.lists.whitelist;
    var existing = matchedRule(w, url);
    if (existing) {
      w.splice(w.indexOf(existing), 1);
      return true;
    }

    var b = config.lists.blacklist;
    var inBlack = matchedRule(b, url);
    if (inBlack) b.splice(b.indexOf(inBlack), 1);
    w.push(rule);
    return true;
  }

  /* 为当前 URL 生成一条规则（host + 非默认端口） */
  function ruleFor(url) {
    try {
      var u = new URL(url);
      var port = u.port;
      if (port && port !== '80' && port !== '443') return u.hostname + ':' + port;
      return u.hostname;
    } catch (e) {
      return null;
    }
  }

  /* 该 URL 命中的规则文本（用于从名单中移除） */
  function matchedRule(rules, url) {
    if (!Array.isArray(rules)) return null;
    for (var i = 0; i < rules.length; i++) {
      if (matchOne(parseRule(rules[i]), url)) return rules[i];
    }
    return null;
  }

  /* 公共 API：名单匹配 + 增删改的"用户操作层"函数。
   * parseRule / matchOne / isListed / ruleFor / matchedRule 全部是这一层的
   * 内部实现，不再外露 —— 调用方应当用语义化的 siteEnabled / siteMode /
   * setSiteMode / toggleWhitelist。
   * setSiteDark / toggleSiteDark 是"按目标明暗落名单"的旧兼容层，src 内已无
   * 调用点，仅 check.js [5] 的站点开关回归断言还在用（删它要同步改那段断言）。 */
  var api = {
    siteEnabled: siteEnabled,
    siteMode: siteMode,
    setSiteMode: setSiteMode,
    setSiteDark: setSiteDark,
    toggleSiteDark: toggleSiteDark,
    toggleWhitelist: toggleWhitelist
  };

  // mount: browser -> globalThis.NW.matcher ; node -> flat module.exports
  root.NW = root.NW || {};
  root.NW.matcher = api;
  if (typeof module !== 'undefined' && module.exports) {
    for (var k in api) {
      if (Object.prototype.hasOwnProperty.call(api, k)) module.exports[k] = api[k];
    }
  }
})();
