/* Night Owl — 页面渲染引擎（content script，document_start 注入）
 *
 * 防白闪策略：
 *   1. document_start 同步读 sessionStorage 缓存 → 0 延迟应用上一状态
 *   2. 再异步读 chrome.storage.local 校准（通常 <5ms，早于首次绘制）
 */
(function () {
  'use strict';

  /* 防重入：正常情况下 content.js 只该跑一次。
   *
   * 但补注入（scripting.executeScript）会把这个文件再跑一遍，
   * 此时不能简单 return —— 那会让"页面没有监听器"和"页面有监听器但没响应"
   * 两种情况都无法修复。正确做法是询问既有实例的状态：
   *   - 已有实例且响应正常 -> 什么都不做（库文件重跑会重建 NW.* 对象，
   *     而旧实例的闭包仍指向旧对象，重跑没有意义且有害）
   *   - 已有实例但没响应    -> 让它重新应用一次
   * 由于每次注入都是全新的闭包，无法直接拿到旧实例，改用全局函数握手。 */
  if (window.__nightOwlLoaded) {
    try {
      if (typeof window.__nightOwlTick === 'function') window.__nightOwlTick();
    } catch (e) { }
    return;
  }
  window.__nightOwlLoaded = true;

  var NW = window.NW || (window.NW = {});
  var CFG = NW.config, SUN = NW.sun, MATCH = NW.matcher, FILTER = NW.filter;
  if (!CFG || !SUN || !MATCH || !FILTER) return;

  var STYLE_ID = 'night-owl-runtime-style';
  var CACHE_KEY = 'night-owl:state';
  var DARK_SITE_KEY = 'night-owl:dark:' + (location.hostname || 'unknown');

  var config = null;
  var styleEl = null;
  var siteDarkDetected = null; // null=未知 true=本身深色 false=浅色

  function buildCss(c) {
    var target = c.advanced.target === 'body' ? 'body' : 'html';
    var scope = target === 'body' ? 'html.nw-dark body' : 'html.nw-dark';
    var css = scope + ' { filter: ' + FILTER.build(c.theme) + ' !important; }\n';

    if (c.advanced.preserveMedia) {
      css += FILTER.MEDIA_SELECTOR.split(',').map(function (sel) {
        return scope + ' ' + sel.trim();
      }).join(',\n') + ' { filter: ' + FILTER.buildMedia(c.theme) + ' !important; }\n';
    }

    // 滚动条不参与 filter，单独指定深色（scrollbar-color 对 Chrome 121+ 生效）
    css += 'html.nw-dark { scrollbar-color: #6b6b6b #1c1c1c; }\n';
    css += 'html.nw-dark::-webkit-scrollbar { width: 12px; height: 12px; }\n';
    css += 'html.nw-dark::-webkit-scrollbar-track { background: #1c1c1c; }\n';
    css += 'html.nw-dark::-webkit-scrollbar-thumb { background: #56565e; border-radius: 6px; }\n';

    return css;
  }

  /* ---------- DOM 写入 ---------- */

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return styleEl;
    var parent = document.head || document.documentElement;
    if (!parent) return null;
    styleEl = document.getElementById(STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.type = 'text/css';
      parent.appendChild(styleEl);
    }
    return styleEl;
  }

  function setActive(on) {
    var root = document.documentElement;
    if (!root) return;
    root.classList.toggle('nw-dark', !!on);
    var el = ensureStyle();
    if (el) {
      // 只在需要时写 CSS，避免每次切换都触发样式重算
      var next = on && config ? buildCss(config) : '';
      if (el.textContent !== next) el.textContent = next;
    }
  }

  /* ---------- 深色站点检测 ---------- */

  function parseColor(str) {
    var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?/i.exec(String(str || ''));
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] ? parseFloat(m[4]) : 1 };
  }

  /* 读出「该站点本身是深色」的既有结论，没有就跑一次检测并固化。
   * 返回值会同时写入 siteDarkDetected，供 resolveOn() 使用。 */
  function detectDarkSite() {
    if (siteDarkDetected !== null) return siteDarkDetected;
    try {
      var cached = sessionStorage.getItem(DARK_SITE_KEY);
      if (cached === '1') { siteDarkDetected = true; return true; }
      if (cached === '0') { siteDarkDetected = false; return false; }
    } catch (e) {}

    var node = document.body || document.documentElement;
    var depth = 0;
    while (node && depth < 6) {
      var c = parseColor(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.4) {
        var l = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
        siteDarkDetected = l < 0.22;
        try { sessionStorage.setItem(DARK_SITE_KEY, siteDarkDetected ? '1' : '0'); } catch (e) {}
        return siteDarkDetected;
      }
      node = node.parentElement;
      depth++;
    }
    return false;
  }

  /* ---------- 状态计算 ---------- */

  /* 该站点是否应该变暗（不含"本身是深色站点"这一层判断）。
   * 拆出来是因为这一层在 document_start 就能算，而深色判定要等 body 就绪。 */
  function wantsDark() {
    if (!config) return false;
    // 全局明暗（已考虑 enabled 与 mode），再交给名单做覆盖
    var globalDark = SUN.shouldBeDark(config);
    return MATCH.siteEnabled(config, location.href, globalDark);
  }

  /* 综合"想变暗"与"该站点本身是深色 -> 跳过"两个条件后的最终结果。
   * 只在 siteDarkDetected 已有结论时才可能返回 false。 */
  function resolveOn() {
    if (!wantsDark()) return false;
    if (config.advanced.skipDarkSites && siteDarkDetected === true) return false;
    return true;
  }

  function cacheState(on) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ c: config, d: on }));
    } catch (e) {}
  }

  function apply() {
    var on = resolveOn();

    /* 深色站点检测需要 body 与样式表就绪。
     * 关键：**必须先拿到结论再着色**，否则会先加 filter 再撤销，产生可见白闪。
     * document_start 时 siteDarkDetected 还是 null，此时才走"先着色、后判定、
     * 命中则撤销"的三步走；判定完成后立刻把最终状态写回缓存，
     * 使后续刷新能一步到位不再闪。 */
    var pendingDetection = on && config.advanced.skipDarkSites && siteDarkDetected === null;

    setActive(on);

    if (pendingDetection) {
      var check = function () {
        /* 触发检测并把结论写进 siteDarkDetected —— 这一步之前一直是 missing 的，
         * 旧的 check 直接 setActive(false) 但没把 siteDarkDetected 置位，
         * 导致下一个 tick 再次走 pendingDetection 分支，循环白闪。 */
        detectDarkSite();
        if (!resolveOn()) {
          setActive(false);
          cacheState(false);
          return;
        }
        cacheState(true);
      };
      if (document.body) requestAnimationFrame(check);
      else document.addEventListener('DOMContentLoaded', function () {
        requestAnimationFrame(check);
      }, { once: true });
    } else {
      cacheState(on);
    }
  }

  function setConfig(raw) {
    config = CFG.normalize(raw);
    apply();
  }

  /* ---------- 启动 ---------- */

  function bootstrap() {
    /* 1) 同步缓存，抢在首次绘制之前。
     *    同时把"该站点本身是深色"的结论一并读出来，让 resolveOn()
     *    在 document_start 阶段就能给出最终值，避免"先着色再撤销"的白闪。 */
    try {
      var d = sessionStorage.getItem(DARK_SITE_KEY);
      if (d === '1') siteDarkDetected = true;
      else if (d === '0') siteDarkDetected = false;
    } catch (e) {}

    var cached = null;
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) cached = JSON.parse(raw);
    } catch (e) {}
    if (cached && cached.c) {
      config = CFG.normalize(cached.c);
      setActive(!!cached.d && wantsDark());
    }

    // 2) 真实配置校准
    try {
      chrome.storage.local.get('config', function (res) {
        // 扩展被重载 / SW 被回收后上下文会失效，读 lastError 顺手把它吃掉
        if (chrome.runtime.lastError) return;
        setConfig(res && res.config);
      });
    } catch (e) {}

    // 3) 后续变更
    try {
      /* storage.onChanged 是**主通道**，不是备份。
       *
       * 为什么必须由页面自己监听：
       *   后台推 tick 依赖 chrome.tabs.sendMessage，而后台在推之前要先
       *   probe 页面是否应答；probe 有 250ms 硬超时，SW 冷启动、页面正忙、
       *   content script 还没执行到 addListener 都会让 probe 超时。
       *   probe 一超时，后台就以为"页面没有 content script"，于是走
       *   scripting.executeScript 补注入 —— 但 content.js 顶部有防重入
       *   （window.__nightOwlLoaded），补注入等于什么都没做，tick 也白搭。
       *   结果：设置已经落盘，页面却保持旧样子，**刷新后才对**。
       *
       *   页面自己监听 storage 就绕开了整条消息链路：只要 storage 变了，
       *   页面必然收到通知，不依赖任何一次 sendMessage 能否送达。 */
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes.config) setConfig(changes.config.newValue);
      });
    } catch (e) {}

    try {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (!msg || !msg.type) return;
        if (msg.type === 'nw:apply' && msg.config) setConfig(msg.config);
        if (msg.type === 'nw:tick') {
          if (msg.config) config = CFG.normalize(msg.config);
          apply();
        }
        if (msg.type === 'nw:query') {
          sendResponse({ dark: document.documentElement.classList.contains('nw-dark') });
          return;
        }
        /* 后台在执行补注入前会先问一句"你在不在"。
         * 应答这个探针，后台就不必做那次注定无效的 executeScript。 */
        if (msg.type === 'nw:ping-page') {
          sendResponse({ ok: true, loaded: true });
        }
      });
    } catch (e) {}
  }

  /* 供补注入使用：让被重新注入的脚本能触发现有实例重新应用一次配置，
   * 而不是被 __nightOwlLoaded 防重入静默丢弃。 */
  window.__nightOwlTick = function (rawConfig) {
    if (rawConfig) config = CFG.normalize(rawConfig);
    apply();
  };

  bootstrap();
})();
