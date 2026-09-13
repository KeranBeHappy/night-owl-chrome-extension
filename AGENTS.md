# AGENTS.md — Night Owl 夜鹰

本文件写给在本仓库工作的 AI 编码助手（与人）。内容基于本项目实际情况，不是模板。

## 项目概览

- **是什么**：Chrome / Edge / Firefox 115+ 的全站夜间模式扩展（Manifest V3），纯 CSS `filter` 方案，不改站点样式。
- **形态**：纯静态目录，**没有构建步骤、没有 package.json、没有 npm 依赖**。`加载已解压的扩展程序` 即装即用。
- **隐私红线**：不申请网络请求类权限、扩展自身不发任何网络请求、数据不出本机。任何改动都不得破坏这一点（例如引入 CDN 脚本、远程字体、遥测）。
- **双端兼容**：后台带双路加载（原生 SW + 事件页回退）；lib 模块同时挂 `globalThis.NW.*` 和 `module.exports`，因此能被 node 直接 `require`。

## 常用命令

```bash
node tools/check.js     # 唯一的测试/自检入口，改完必须跑且必须全绿
node tools/build_cities.js   # 仅当城市库需要重建时（离线，平时不跑）
python tools/make_icons.py   # 仅当图标需要重新生成时
```

没有 `npm run dev` / `npm test` / lint 配置。验证手段 = `tools/check.js` + 手动加载扩展实测。

## 代码风格（用户明确要求，必须遵守）

- 2 空格缩进，不用 Tab
- 单引号，不用双引号（字符串含引号等必要场景除外）
- 语句末尾加分号
- 每行不超过 100 字符
- **函数上方必须有 JSDoc 注释，注释用中文**；复杂逻辑加行内中文注释
- 可能出错的代码用 try-catch 包裹，记录详细错误，向用户呈现友好提示
- **遇到不确定的先向用户提问，得到答复后再动手**；不要擅自扩大改动范围

## 架构与数据流

```
config.js（schema + normalize）  ←  一切配置读写的唯一入口
   ├── sun.js     昼夜判定 / 下一次切换点 / 徽标唯一出口 badgeState（NOAA 算法，纯本地）
   ├── matcher.js 黑白名单三态与匹配
   ├── filter.js  滤镜串构造（渲染与预览共用）
   └── store.js   popup/options 直连 chrome.storage.local + 发信号闹钟
background.js（SW）：排程 alarms、徽标、右键菜单、快捷键、广播
content.js：页面渲染引擎（防白闪：sessionStorage 缓存 + 异步校准）
popup / options：UI 面板
```

通信通道（**重要，不要改回去**）：只有两条，都是本地的。
1. `chrome.storage.local` —— 配置的真相来源。popup / 设置页直写（`src/lib/store.js`），
   后台的 `storage.onChanged` 接力：刷徽标、重排闹钟、广播到所有标签页（`content.js` 自己也监听）。
2. `chrome.alarms` —— 唤醒与定时中枢。UI 落盘后再发一个**信号闹钟**：把整份 config 编码进
   alarm name（`'nw{' + JSON.stringify(config)`），后台收到即采信、**不回读 storage**
   （本机回读有"写一拍滞后"）。前缀在 `store.js` 与 `background.js` 各有一份，`check.js` 有断言钉住。

`chrome.runtime.onMessage` **已整体删除**（本机 Chrome 152 上它根本注册不上，UI 也不再依赖，
留着就是死代码）。历史与证据见 `tools/check.js` 的 `[6]`/`[9]` 段。

## 关键不变量（改代码前先对照）

1. **`config.normalize` 是唯一合法化入口**。任何写入 storage 的配置必须先 normalize；
   任何读取都以 normalize 后的值为准。不要绕过它直接拼对象。
2. **手动模式是"临时覆盖"**：`config.mode` 为 `dark`/`light` 时由 `config.manualUntil`
   （毫秒时间戳）限时，到下一个自然切换点自动回 `auto`。三层兜底缺一不可：
   `sun.effectiveMode` 判定自愈 → `config.normalize` 读时清理 → `background.expireManual` 闹钟复位。
   手动切换一律用 `CFG.setManualMode(config, mode, SUN.nextSwitch(config).at)`。
3. **站点开关是三态**：`matcher.siteMode/setSiteMode`，`follow | dark | light` 分别对应
   不落名单 / 黑名单 / 白名单。白名单优先级最高；三个状态互斥，切换时先清两边旧规则。
   旧的 `setSiteDark/toggleSiteDark` 保留为兼容层，内部委托三态。
4. **`config.enabled` 总开关只属于设置页**，popup 里没有总开关。
5. **徽标只有一个全局值**：黑夜 `ON`（绿），白天（含总开关关闭）`OFF`（灰），
   判定与颜色统一由 `SUN.badgeState(config)` 提供，三个写入方（popup / options / background）
   共用。**绝对不要写 per-tab 徽标**（`setBadgeText({tabId})`）：Chrome 没有"解除覆盖"的 API，
   一旦写了就得永远维护它 —— 历史上"受限页黄叹号"就是这么引出回读→兜底→被写空→
   徽标永久消失的一整条链，最后整套删除。受限页只在 popup 里提示"不支持"。
6. **用户主动改变昼夜/名单的每个路径都必须触发广播**：要么 `saveConfig(config, true)`，
   要么写 storage 靠 `storage.onChanged`。否则就是"面板改了页面不变"的老 bug。
7. **SW 无常驻状态**：动 `background.js` 里的 `config` 前必须先 `loadConfig()`；
   所有监听器经 `onEvent` 隔离注册，一个失败不能拖死其他监听器。
   **监听器总数恒为 8**（`tabs.onActivated` 是条件注册，与它兜底的 `onShown` 互斥）；
   增删监听器要同步 `background.js` 的 `report()` 与 `check.js` 的 `[6]` 段断言。
8. **content_scripts 的 js 列表在 `manifest.json` 里手工维护**：新增 lib 文件必须同步加进去，
   且顺序即依赖顺序；lib 文件必须同时兼容浏览器（挂 `NW.*`）与 node（`module.exports`）。
9. **面板换肤跟随"生效明暗"**：popup / 设置页用 `html.nw-light` + CSS 变量跟随
   `SUN.badgeState(config)`（与徽标同一个判定）—— 黑夜暗色（`:root` 默认），
   白天 / 总开关关闭亮色。**新增颜色一律走变量**（两套主题各定义一份），不要在规则里硬编码。
   popup 在脚本开头按 `localStorage['night-owl:theme']` 做"首帧上色"防闪；
   设置页会长时间开着，必须按 `SUN.nextSwitch().at` 排定时器（拿不到则 60s 兜底）自己换肤 ——
   自动模式的昼夜切换不会产生任何 storage 事件。

## 改动后的固定动作（按改动类型）

- **改了 popup / options 的 DOM**：必须同步 `tools/check.js` 的 `makePopupDom()`
  —— nodes 列表 + `querySelectorAll(sel)` 分支，否则 `[9]` 段静默走空、断言失效。
  在夹具里点按钮用 `node.click()`（自动带 `currentTarget`），不要用 `_h.click()`。
  popup 用到 `document.documentElement`（换肤）与 `localStorage`（首帧缓存），
  这两样夹具里都有对应桩，删掉就会让 `[9]` 段崩。
- **加了 i18n key**：必须同时加到 `_locales/en` 与 `_locales/zh_CN`（`[7]` 段校验两库
  key 集合一致与占位符）。HTML 里用 `data-i18n`，JS 里用 `msg('key', [args])`。
- **改了昼夜判定 / 名单语义 / 通道**：在 `tools/check.js` 对应段落补回归断言。
  修 bug 的同时加断言是本仓库的惯例。
- **任何改动**：跑 `node tools/check.js`，保持全绿再交付。

## 提交与边界

- 只在用户明确要求时才 commit；不要主动 commit、不要 amend、不要 force push。
- `.codebuddy/` 存放工作数据，**不要删除**。
- `tools/` 里的 `.txt`/`.out`/`.png` 是历史运行快照与生成物，不要当作源码去"整理"。
- 不引入新依赖、不加构建工具、不改目录结构，除非用户明确要求。

## 已知边界（filter 方案固有，报 bug 前先排除）

- 地图 / 在线设计工具 / PDF 查看器等依赖精确颜色的页面效果差 → 用黑名单处理。
- `position: fixed` 吸顶导航在部分站点异常 → 「高级」里切换滤镜应用范围，或加黑名单。
- 反色强度 < 100% 时图片轻微发灰（已做对比度补偿）。
