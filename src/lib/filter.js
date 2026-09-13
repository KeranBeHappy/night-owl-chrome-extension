/* Night Owl — 滤镜构造（content script 与设置页共用）
 *
 * ══ 核心约束：父级只用"可逆算子"，媒体才能被完整还原 ═════════════════════════
 *
 * CSS 滤镜作用在祖先元素（html）上，**没有**把某个子树"摘出去"的 API，
 * 所以"图片不被反色"只能靠给媒体再套一层**逆运算**抵消父级。这要求父级每个算子都能精确反向：
 *
 *   可反向（可用）：invert(1) / hue-rotate(±deg) / brightness / contrast / saturate
 *   不可反向（禁用）：sepia、grayscale —— 信息已丢，CSS 里没有任何算子能还原
 *
 * 两条硬规矩（改滤镜前必读）：
 *   1) **色温不用 sepia**，改用 hue-rotate + saturate 组合（可精确反向）。
 *      代价：色相偏移染不了白/灰（hue-rotate 对灰色无效），观感不如 sepia"棕黄"，
 *      换来的是图片完全不受色温影响 —— 用户 2026-09-13 拍板的取舍。
 *   2) **灰度不用 grayscale**，改用 saturate(1-g)：两者在 CSS 里是同一个色矩阵
 *      （grayscale(g) ≡ saturate(1-g)），但 saturate 可反向 → 图片不会被一起抽掉颜色。
 *
 * 媒体侧（buildMedia）= 父级整条链的逆（按严格相反的顺序排列），再乘一个固定压暗系数
 * —— 用户要求："图片与白天一致，但比白天略暗一档"。
 *
 * 历史教训（2026-09-11）：旧父级 = invert(0.92) hue180 saturate(0.9) sepia(0.075)
 * 四重不可逆叠加，实测 8 源色平均色差 Δ=154，图片呈暗红 —— 怎么补偿都救不回来。
 * ══════════════════════════════════════════════════════════════════════════
 */
(function () {
  'use strict';

  var root = (typeof module !== 'undefined' && module.exports)
    ? module.exports
    : (typeof globalThis !== 'undefined' ? globalThis : window);

  /* 媒体选择器：会被"逆运算还原"的元素。
   * svg 只取内嵌位图那种（svg:has(image)，常见于头像/立绘容器）—— 单色线框图标必须
   * 继续跟随页面反色，否则在深色按钮/工具栏上会变成黑图标看不见；彩色矢量图标可由
   * 使用者手动加 data-nw-preserve（本选择器已含该属性）。
   * 背景图（CSS background-image）不在此列：反向滤镜会连带把该元素的文字一起反向，
   * 无法只作用于背景层。 */
  var MEDIA_SELECTOR = 'img, video, canvas, iframe, embed, object, svg:has(image), [data-nw-preserve]';

  /* 媒体默认压暗系数：除这一档压暗外，其余全部还原成白天原样。
   * 实际值来自 config.advanced.mediaDim（整数百分比 60–100，设置页「高级·媒体亮度」
   * 可调，随导出/导入走）；本常量只是缺省兜底（用户 2026-09-13 定 0.92）。 */
  var MEDIA_DIM = 0.92;

  function clamp(n, a, b) {
    n = Number(n);
    if (!isFinite(n)) return a;
    return Math.min(b, Math.max(a, n));
  }

  function preserveOn(cfg) {
    cfg = cfg || root.NW.config;
    return !!(cfg && cfg.advanced && cfg.advanced.preserveMedia);
  }

  /* 色温算子：sepia 不可反向，改用「色相偏移 + 轻微饱和」。
   * |t|=100 → 15deg / ×1.08；暖 = 负角（偏红黄），冷 = 正角（偏青蓝）。 */
  function tempOps(t) {
    t = clamp(t, -100, 100);
    return {
      deg: Math.round(Math.abs(t) * 0.15) * (t >= 0 ? -1 : 1),
      sat: 1 + Math.abs(t) / 100 * 0.08
    };
  }

  /* 用户饱和度 × 灰度：grayscale(g) ≡ saturate(1-g)，合并成一个**可反向**的 saturate */
  function saturateFactor(theme) {
    var s = clamp(theme.saturation, 0, 150) / 100;
    var g = clamp(theme.grayscale, 0, 100) / 100;
    return s * (1 - g);
  }

  /* 媒体亮度系数（0.60–1.00）：来自 config.advanced.mediaDim；
   * 配置缺失 / 非法（旧版本配置、未知调用方）时退回 MEDIA_DIM。 */
  function mediaDimFactor(cfg) {
    cfg = cfg || root.NW.config;
    var v = cfg && cfg.advanced ? Number(cfg.advanced.mediaDim) : NaN;
    if (!isFinite(v)) v = MEDIA_DIM * 100;
    return clamp(v, 60, 100) / 100;
  }

  /* 页面滤镜。算子顺序固定：invert → hue-rotate → brightness → contrast → saturate → 色温。
   * preserveMedia 开启 → invert 固定 1（可逆，媒体才能还原）；
   * 关闭 → 用用户设定的 invert 强度（观感优先，无需还原）。
   * ⚠️ buildMedia 里的逆运算顺序必须与此处**严格相反**，改这里就要同步改那里。 */
  function build(theme, cfg) {
    var inv = clamp(theme.invert, 60, 100) / 100;
    var parts = [];
    parts.push('invert(' + (preserveOn(cfg) ? 1 : inv) + ')');
    parts.push('hue-rotate(180deg)');

    var b = clamp(theme.brightness, 40, 150) / 100;
    var c = clamp(theme.contrast, 50, 150) / 100;
    var sat = saturateFactor(theme);
    if (b !== 1) parts.push('brightness(' + b.toFixed(3) + ')');
    if (c !== 1) parts.push('contrast(' + c.toFixed(3) + ')');
    if (sat !== 1) parts.push('saturate(' + sat.toFixed(3) + ')');

    var t = tempOps(theme.temperature);
    if (t.deg) parts.push('hue-rotate(' + t.deg + 'deg)');
    if (t.sat !== 1) parts.push('saturate(' + t.sat.toFixed(3) + ')');
    return parts.join(' ');
  }

  /* 媒体逆运算。父级 = I ∘ H ∘ B ∘ C ∘ S ∘ T1 ∘ T2（应用顺序，见 build），
   * 逆 = 反序取逆：T2⁻¹ → T1⁻¹ → S⁻¹ → C⁻¹ → B⁻¹ → H⁻¹ → I⁻¹，全部使用同一套 CSS 算子，
   * 因此父子可以精确抵消（只剩 CSS 色域裁剪带来的极小残差）。
   *
   * 最前面那个 brightness(MEDIA_DIM) 是用户要的"固定压暗"：
   * 它作用在**原色**上，父级链走完后又变回"比白天暗一档"，与滑杆设置无关。 */
  function buildMedia(theme, cfg) {
    if (!preserveOn(cfg)) return 'none';

    var b = clamp(theme.brightness, 40, 150) / 100;
    var c = clamp(theme.contrast, 50, 150) / 100;
    var sat = saturateFactor(theme);
    var t = tempOps(theme.temperature);

    var parts = ['brightness(' + mediaDimFactor(cfg).toFixed(3) + ')'];
    if (t.sat !== 1) parts.push('saturate(' + (1 / t.sat).toFixed(3) + ')');
    if (t.deg) parts.push('hue-rotate(' + (-t.deg) + 'deg)');
    if (sat !== 1) parts.push('saturate(' + (1 / sat).toFixed(3) + ')');
    if (c !== 1) parts.push('contrast(' + (1 / c).toFixed(3) + ')');
    if (b !== 1) parts.push('brightness(' + (1 / b).toFixed(3) + ')');
    parts.push('hue-rotate(180deg)');
    parts.push('invert(1)');
    return parts.join(' ');
  }

  var api = {
    MEDIA_SELECTOR: MEDIA_SELECTOR,
    MEDIA_DIM: MEDIA_DIM,
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
