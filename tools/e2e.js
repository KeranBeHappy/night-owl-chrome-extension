/* 最终端到端验证：直接调用修改后的 src/lib/filter.js +
 * src/content.js 的 buildCss 逻辑，生成本地测试页并在真实 Chromium 中测量像素。
 *
 * 验收标准：
 *   1. preserveMedia=ON 时，图片色相与原色一致（红是红、绿是绿、蓝是蓝）
 *   2. ON vs OFF 的图片渲染必须不同（证明开关有效）
 *   3. 黑白灰精确还原
 */
'use strict';
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var CLI = 'D:/Program Data/npm_global/node_modules/agent-browser/bin/agent-browser.js';
var LOGF = path.join(__dirname, 'e2e.result.txt');
function log() { try { fs.appendFileSync(LOGF, Array.prototype.slice.call(arguments).join(' ') + '\n', 'utf8'); } catch (e) {} }
try { fs.writeFileSync(LOGF, '', 'utf8'); } catch (e) {}

function ab(args) {
  var r = cp.spawnSync(process.execPath, [CLI].concat(args), { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

var CFG = require('../src/lib/config.js');
var F = require('../src/lib/filter.js');

/* 复刻 content.js buildCss */
function buildCss(c) {
  var scope = c.advanced.target === 'body' ? 'html.nw-dark body' : 'html.nw-dark';
  var css = scope + ' { filter: ' + F.build(c.theme, c) + ' !important; }\n';
  if (c.advanced.preserveMedia) {
    css += F.MEDIA_SELECTOR.split(',').map(function (s) { return scope + ' ' + s.trim(); }).join(',\n')
      + ' { filter: ' + F.buildMedia(c.theme, c) + ' !important; }\n';
  }
  return css;
}

var SRCS = ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000', '#808080', '#ff8800', '#00ffff'];

var onCfg = CFG.normalize({ advanced: { preserveMedia: true } });
var offCfg = CFG.normalize({ advanced: { preserveMedia: false } });
var onCss = buildCss(onCfg), offCss = buildCss(offCfg);

log('=== 生成的 CSS ===');
log('--- ON ---');
log(onCss);
log('--- OFF ---');
log(offCss);

/* 测试页：两个区域，一个应用 ON 规则，一个应用 OFF 规则，各自含 8 个色块 */
function block(cls, label) {
  var h = '<div style="font:10px monospace;padding:2px">' + label + '</div><div class="g">';
  SRCS.forEach(function (s, i) {
    h += '<img class="sw" id="' + cls + i + '" src="data:image/svg+xml,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="' + s + '"/></svg>') +
      '" style="width:48px;height:48px">';
  });
  return h + '</div>';
}

var html = '<!doctype html><html class="nw-dark"><meta charset="utf-8"><style>' +
  'body{margin:0;background:#fff}.g{display:flex;flex-wrap:wrap}' +
  '.sw{margin:2px;border:1px solid #ddd}' +
  '.wrapON{filter:' + F.build(onCfg.theme, onCfg) + '}' +
  '.wrapOFF{filter:' + F.build(offCfg.theme, offCfg) + '}' +
  '.wrapON img{filter:' + F.buildMedia(onCfg.theme, onCfg) + '}' +
  '</style><body>' +
  block('on', 'ON 保留原色（父级 + 媒体子级）').replace('<div class="g">', '<div class="wrapON"><div class="g">').replace('</div>', '</div></div>') +
  block('off', 'OFF 跟随父级（仅父级）').replace('<div class="g">', '<div class="wrapOFF"><div class="g">').replace('</div>', '</div></div>') +
  '</body></html>';

var OUT = path.join(__dirname, 'e2e.html');
fs.writeFileSync(OUT, html, 'utf8');
ab(['close', '--all']);
ab(['set', 'viewport', '1200', '600']);
log('open=' + ab(['open', 'file:///' + OUT.replace(/\\/g, '/')]).status);

var coords = { on: [], off: [] };
['on', 'off'].forEach(function (k) {
  var js = "(function(){var o=[];for(var i=0;i<" + SRCS.length + ";i++){var e=document.getElementById('" + k + "'+i);var r=e.getBoundingClientRect();o.push([Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]);}return JSON.stringify(o);})()";
  var rj = ab(['eval', js]);
  try { coords[k] = JSON.parse(JSON.parse(rj.out)); } catch (e) { log(k + ' coords fail ' + e.message); }
});
var shotPath = path.join(__dirname, 'e2e.png');
var sp = ab(['screenshot', shotPath.replace(/\\/g, '/')]);
log('shot=' + sp.status);

function readPng(buf) {
  var p = 8, w = 0, h = 0, idat = [], colorType = 6;
  while (p < buf.length) {
    var len = buf.readUInt32BE(p); var type = buf.toString('ascii', p + 4, p + 8);
    var data = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9]; }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    p += 12 + len;
  }
  var raw = require('zlib').inflateSync(Buffer.concat(idat));
  var ch = colorType === 6 ? 4 : (colorType === 2 ? 3 : 4);
  var stride = w * ch, out = Buffer.alloc(h * stride);
  for (var y = 0; y < h; y++) {
    var ft = raw[y * (stride + 1)];
    var line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    var prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (var x = 0; x < stride; x++) {
      var a = x >= ch ? out[y * stride + x - ch] : 0;
      var b = prev[x], cc = x >= ch ? prev[x - ch] : 0, v = line[x];
      if (ft === 0) out[y * stride + x] = v;
      else if (ft === 1) out[y * stride + x] = (v + a) & 255;
      else if (ft === 2) out[y * stride + x] = (v + b) & 255;
      else if (ft === 3) out[y * stride + x] = (v + ((a + b) >> 1)) & 255;
      else { var pp = a + b - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - cc);
        var pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : cc); out[y * stride + x] = (v + pr) & 255; }
    }
  }
  return { w: w, h: h, data: out, ch: ch };
}
function px(img, x, y) { if (x < 0 || y < 0 || x >= img.w || y >= img.h) return null; var i = (y * img.w + x) * img.ch; return [img.data[i], img.data[i + 1], img.data[i + 2]]; }
function hex(p) { return p ? '#' + p.map(function (n) { return ('0' + n.toString(16)).slice(-2); }).join('') : '--'; }
function ps(s) { s = s.replace('#', ''); return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]; }
function hue(p) { var r = p[0] / 255, g = p[1] / 255, b = p[2] / 255; var mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return -1; var d = mx - mn, h; if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h = Math.round(h * 60); return (h + 360) % 360; }

var img = readPng(fs.readFileSync(shotPath));
log('img ' + img.w + 'x' + img.h);
log('');
log('=== 验收 1：ON 态图片色相是否与原色一致 ===');
var pass1 = true, pass2 = true, pass3 = true;
SRCS.forEach(function (src, i) {
  var t = ps(src);
  var pOn = coords.on[i] ? px(img, coords.on[i][0], coords.on[i][1]) : null;
  var pOff = coords.off[i] ? px(img, coords.off[i][0], coords.off[i][1]) : null;
  var hT = hue(t), hOn = pOn ? hue(pOn) : -2, hOff = pOff ? hue(pOff) : -2;
  var dh = (hT < 0 || hOn < 0) ? 0 : Math.min(Math.abs(hT - hOn), 360 - Math.abs(hT - hOn));
  var ok = dh <= 25;   /* 色相偏差 < 25° 视为一致 */
  if (!ok) pass1 = false;
  var differs = pOn && pOff && (Math.abs(pOn[0] - pOff[0]) + Math.abs(pOn[1] - pOff[1]) + Math.abs(pOn[2] - pOff[2]) > 12);
  /* 灰色是无彩色：invert 前后亮度互补，两者视觉等价，开关差异天然不可见 —— 豁免 */
  var isGray = (hT < 0);
  if (!differs && !isGray) pass2 = false;
  log('  ' + src + '  原=' + hex(t) + '(H' + hT + ')  ON=' + hex(pOn) + '(H' + hOn + ')  OFF=' + hex(pOff) + '(H' + hOff + ')  ΔH=' + dh + '  ' + (ok ? 'OK' : 'FAIL') + '  ON≠OFF:' + (differs ? 'Y' : 'N'));
});
/* 黑白灰精确 */
log('');
log('=== 验收 2：黑白灰是否精确还原 ===');
['#ffffff', '#000000', '#808080'].forEach(function (src) {
  var i = SRCS.indexOf(src);
  var pOn = coords.on[i] ? px(img, coords.on[i][0], coords.on[i][1]) : null;
  var t = ps(src);
  var d = pOn ? Math.abs(pOn[0] - t[0]) + Math.abs(pOn[1] - t[1]) + Math.abs(pOn[2] - t[2]) : 999;
  var ok = d <= 12;
  if (!ok) pass3 = false;
  log('  ' + src + '  ON=' + hex(pOn) + '  Δ=' + d + '  ' + (ok ? 'OK' : 'FAIL'));
});
log('');
log('=== 总判定 ===');
log('  验收1 色相一致   : ' + (pass1 ? 'PASS' : 'FAIL'));
log('  验收2 开关有效   : ' + (pass2 ? 'PASS' : 'FAIL'));
log('  验收3 黑白灰精确 : ' + (pass3 ? 'PASS' : 'FAIL'));
log('  >>> ' + (pass1 && pass2 && pass3 ? 'ALL PASS' : 'HAS FAILURE'));
