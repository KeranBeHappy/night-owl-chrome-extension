/* 真机复现：popup 点「白天」后徽标的写入时序。
 *
 * 做法：
 *   1. 用 playwright-core 启动本机 Chrome，加载本扩展（--load-extension）
 *   2. 种入黑夜配置，打开本地测试页 + popup（以标签页形式打开 popup.html）
 *   3. 依次点击 黑夜 / 白天，每 25ms 轮询一次真实徽标文本
 *   4. 同时抓取 SW 与 popup 两边控制台 —— 代码里有
 *      `[Night Owl] badge -> ... (popup|options|background)` 调试输出，
 *      谁写了什么一目了然
 *
 * 用法：node tools/badge.e2e.js
 * 依赖：本机装有 Chrome（channel: 'chrome'）；playwright-core 取自全局 @playwright/cli。
 */
'use strict';
var path = require('path');
var http = require('http');

var ROOT = path.join(__dirname, '..');
var PW_CANDIDATES = [
  'D:/Program Data/npm_global/node_modules/@playwright/cli/node_modules/playwright-core',
  'playwright-core'
];

var chromium = null;
for (var i = 0; i < PW_CANDIDATES.length && !chromium; i++) {
  try { chromium = require(PW_CANDIDATES[i]).chromium; } catch (e) { }
}
if (!chromium) { console.error('playwright-core 不可用'); process.exit(1); }

var CFG = require(path.join(ROOT, 'src/lib/config.js'));

async function launch(headless, channel) {
  return chromium.launchPersistentContext('', {
    channel: channel,
    headless: headless,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      /* Chrome 137+ 在自动化场景默认忽略 --load-extension，需要显式放行 */
      '--enable-unsafe-extension-debugging',
      '--disable-extensions-except=' + ROOT,
      '--load-extension=' + ROOT
    ]
  });
}

function waitSw(ctx, ms) {
  var sw = ctx.serviceWorkers()[0];
  if (sw) return Promise.resolve(sw);
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error('service worker 未出现')); }, ms);
    ctx.once('serviceworker', function (w) { clearTimeout(timer); resolve(w); });
  });
}

(async function main() {
  /* 本地测试页（127.0.0.1 命中 <all_urls>，content script 正常注入） */
  var server = http.createServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><style>' +
      'body{background:#fff;color:#222;font:16px sans-serif}</style></head>' +
      '<body><h1>Night Owl badge repro</h1><p>placeholder</p></body></html>');
  }).listen(0);
  var port = server.address().port;

  /* 先试无头（新无头支持扩展、不弹窗口）；拿不到 SW 再退回有头 */
  var ctx = null, sw = null;
  var channels = ['chrome', 'msedge', 'chrome'];
  for (var ci = 0; ci < channels.length && !sw; ci++) {
    var ch = channels[ci];
    try {
      ctx = await launch(ci === 0, ch);
      sw = await waitSw(ctx, ci === 0 ? 8000 : 15000).catch(function () { return null; });
      if (!sw) {
        /* 从 WebUI 查扩展到底装上没有，顺便打印浏览器版本 */
        var ver = '';
        try { ver = ctx.browser ? (ctx.browser() && ctx.browser().version()) : ''; } catch (e0) { }
        var extPage = await ctx.newPage();
        await extPage.goto('chrome://extensions/');
        var info = await extPage.evaluate(function () {
          return new Promise(function (resolve) {
            try {
              chrome.developerPrivate.getExtensionsInfo(function (list) {
                resolve(list.map(function (x) {
                  return { name: x.name, id: x.id, state: x.state };
                }));
              });
            } catch (e) { resolve([{ error: String(e) }]); }
          });
        });
        console.log('[' + ch + ' ' + ver + '] 已安装扩展:', JSON.stringify(info));
        await extPage.close();
        try { await ctx.close(); } catch (e2) { }
        ctx = null;
      }
    } catch (e3) {
      console.log('[' + ch + '] 启动失败:', e3 && e3.message);
      try { if (ctx) await ctx.close(); } catch (e4) { }
      ctx = null;
    }
  }
  if (!sw) { console.error('没有任何 channel 能加载扩展'); process.exit(3); }

  /* 若 SW 迟迟不出现，从 chrome://extensions 的 WebUI 里查扩展到底装上没有 */
  if (!sw) {
    var extPage = await ctx.newPage();
    await extPage.goto('chrome://extensions/');
    var info = await extPage.evaluate(function () {
      return new Promise(function (resolve) {
        try {
          chrome.developerPrivate.getExtensionsInfo(function (list) {
            resolve(list.map(function (x) {
              return { name: x.name, id: x.id, state: x.state, errors: (x.runtimeErrors || []).length + '/' + (x.manifestErrors || []).length };
            }));
          });
        } catch (e) { resolve([{ error: String(e) }]); }
      });
    });
    console.log('已安装扩展:', JSON.stringify(info, null, 2));
    await extPage.close();
    sw = ctx.serviceWorkers()[0];
  }

  var sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await new Promise(function (res) { ctx.once('serviceworker', res); });
  var extId = new URL(sw.url()).host;
  console.log('ext id:', extId);
  sw.on('console', function (m) { console.log('[SW   ]', m.text()); });

  var darkCfg = CFG.normalize({ mode: 'dark' });
  var lightCfg = CFG.normalize({ mode: 'light' });

  /* 种黑夜配置（与 popup 点黑夜等价的存储写入） */
  await sw.evaluate(function (cfg) { return chrome.storage.local.set({ config: cfg }); }, darkCfg);

  var page = await ctx.newPage();
  await page.goto('http://127.0.0.1:' + port + '/');
  var popup = await ctx.newPage();
  popup.on('console', function (m) { console.log('[POPUP]', m.text()); });
  await popup.goto('chrome-extension://' + extId + '/src/popup/popup.html');
  await popup.waitForSelector('[data-mode="light"]');

  async function badge() {
    return sw.evaluate(function () { return chrome.action.getBadgeText({}); });
  }

  /* 每 25ms 轮询真实徽标，仅在变化时打印（时间线） */
  async function poll(label, ms) {
    var t0 = Date.now();
    var last = null;
    while (Date.now() - t0 < ms) {
      var b = await badge();
      if (b !== last) {
        console.log('  [' + label + ' +' + (Date.now() - t0) + 'ms] badge =', JSON.stringify(b));
        last = b;
      }
      await new Promise(function (r) { setTimeout(r, 25); });
    }
    return last;
  }

  console.log('--- 初始（storage=黑夜） ---');
  await poll('init', 1000);

  console.log('--- popup 点击 黑夜 ---');
  await popup.click('[data-mode="dark"]');
  await poll('dark', 1500);

  console.log('--- popup 点击 白天 ---');
  await popup.click('[data-mode="light"]');
  var finalBadge = await poll('light', 3000);

  var pageDark = await page.evaluate(function () {
    return document.documentElement.classList.contains('nw-dark');
  });
  console.log('页面 nw-dark =', pageDark);
  console.log('最终徽标 =', JSON.stringify(finalBadge));
  console.log(finalBadge === 'OFF' && !pageDark ? '>>> PASS' : '>>> FAIL');

  await ctx.close();
  server.close();
  process.exit(finalBadge === 'OFF' && !pageDark ? 0 : 2);
})().catch(function (e) {
  console.error('E2E FAIL:', e && e.stack || e);
  process.exit(1);
});
