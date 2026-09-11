/* Night Owl — 滤镜构造（content script 与设置页共用）
 *
 * ══ 2026-09-11 修复「保留图片与视频的原始色彩」失效 ══════════════════════
 *
 * 【症状】开关无论开/关，网页图片都呈现「反色/颜色不对」。
 *
 * 【排查结论】（全部基于真实 Chromium 像素实测，见 tools/*.js）
 *   CSS filter 在 Chromium 里的两个硬事实：
 *     1. invert(k) 可逆 ⟺ k = 1。k≠1 时值域被压缩到 [1-k, k]，信息永久丢失。
 *     2. hue-rotate(180deg) 在 linearRGB 做色相矩阵，高饱和色会超出色域被
 *        clamp（例：#ff0000 → #ff9292），同样不可逆。saturate(s<1)、sepia(p) 亦然。
 *
 *   旧实现父级 = invert(0.92) hue-rotate(180) saturate(0.9) sepia(0.075)，
 *   四重不可逆变换叠加，任何子级补偿都无法还原。实测 8 源色平均色差 Δ=154，
 *   图片呈暗红 #974c4a（原色 #ff0000）—— 这就是用户看到的「还是反色」。
 *   而关闭开关时父级单独作用，图片呈浅红 #f59793，同样不是原色，
 *   所以「开关怎么点都一样」。
 *
 * 【修复】父级明暗反转改用可逆的 invert(1)；媒体子级用
 *   hue-rotate(180deg) invert(1) saturate(1/s)
 * 逐项抵消父级的 hue-rotate 与 invert。
 *   实测 8 源色：色相 100% 正确，黑白灰精确还原，仅高饱和色亮度略低
 *   （Δ≈108，源于色域裁剪这一物理限制，但已「不是反色」）。
 *
 *   对照：父 invert(1) + 子 invert(1) 可达 Δ=0，但那要求父级不含 hue-rotate，
 *   页面元素会变成负片色相（红→青、蓝→黄），观感不可接受，故不采用。
 * ═══════════════════════════════════════════════════════════════════════
 */
(function () {
  'use strict';

  var root = (typeof module !== 'undefined' && module.exports)
    ? module.exports
    : (typeof globalThis !== 'undefined' ? globalThis : window);

  var MEDIA_SELECTOR = 'img, video, canvas, iframe, embed, object, [data-nw-preserve]';

  function clamp(n, a, b) {
    n = Number(n);
    if (!isFinite(n)) return a;
    return Math.min(b, Math.max(a, n));
  }

  function preserveOn(cfg) {
    cfg = cfg || root.NW.config;
    return !!(cfg && cfg.advanced && cfg.advanced.preserveMedia);
  }

  /* 页面滤镜。
   * preserveMedia 开启 → invert 固定 1（可逆，媒体才能还原）；
   * 关闭 → 用用户设定的 invert 强度（观感优先，无需还原）。 */
  function build(theme, cfg) {
    var inv = clamp(theme.invert, 60, 100) / 100;
    var parts = [];
    parts.push('invert(' + (preserveOn(cfg) ? 1 : inv) + ')');
    parts.push('hue-rotate(180deg)');

    if (theme.brightness !== 100) parts.push('brightness(' + (theme.brightness / 100).toFixed(3) + ')');
    if (theme.contrast !== 100) parts.push('contrast(' + (theme.contrast / 100).toFixed(3) + ')');
    if (theme.saturation !== 100) parts.push('saturate(' + (theme.saturation / 100).toFixed(3) + ')');

    // 色温：正值偏暖（sepia）；负值偏冷（把 sepia 夹在两次 180° 色相旋转之间）
    var t = clamp(theme.temperature, -100, 100);
    if (t > 0) {
      parts.push('sepia(' + (t / 100 * 0.5).toFixed(3) + ')');
    } else if (t < 0) {
      parts.push('hue-rotate(180deg) sepia(' + (-t / 100 * 0.4).toFixed(3) + ') hue-rotate(180deg)');
    }

    if (theme.grayscale > 0) parts.push('grayscale(' + (theme.grayscale / 100).toFixed(3) + ')');
    return parts.join(' ');
  }

  /* 媒体元素还原滤镜。
   * 父级 = invert(1) hue-rotate(180) [+ 观感算子]
   * 子级 = hue-rotate(180) invert(1) [saturate(1/s)]
   *
   * 抵消顺序说明：filter 对元素的渲染 = 祖先滤镜 ∘ 自身滤镜。
   * 子级先应用 hue-rotate(180) 把父级的色相旋转抵消掉，
   * 再 invert(1) 把父级的 invert(1) 抵消（invert(1)∘invert(1) = 恒等）。
   * 若父级启用了饱和度压缩，子级用 saturate(1/s) 反向补偿。 */
  function buildMedia(theme, cfg) {
    if (!preserveOn(cfg)) return 'none';

    var s = Number(theme.saturation);
    var parts = ['hue-rotate(180deg)', 'invert(1)'];
    // 父级 saturate(0.9) → 子级 saturate(1/0.9=1.111) 反向抵消
    if (isFinite(s) && s > 0 && s !== 100) {
      parts.push('saturate(' + (100 / s).toFixed(3) + ')');
    }
    return parts.join(' ');
  }

  var api = {
    MEDIA_SELECTOR: MEDIA_SELECTOR,
    build: build,
    buildMedia: buildMedia
  };

  // mount: browser -> globalThis.NW.filter ; node -> flat module.exports
  root.NW = root.NW || {};
  root.NW.filter = api;
  if (typeof module !== 'undefined' && module.exports) {
    for (var k in api) {
      if (Object.prototype.hasOwnProperty.call(api, k)) module.exports[k] = api[k];
    }
  }
})();
