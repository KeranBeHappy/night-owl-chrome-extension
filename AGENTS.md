# AGENTS.md — Night Owl 夜鹰

本文件写给在本仓库工作的 AI 编码助手（与人）。内容基于本项目实际情况，不是模板。

## 项目概览

- **是什么**：Chrome / Edge / Firefox 115+ 的全站夜间模式扩展（Manifest V3），纯 CSS `filter` 方案，不改站点样式。
- **形态**：纯静态目录，**没有构建步骤、没有 package.json、没有 npm 依赖**。`加载已解压的扩展程序` 即装即用。
- **隐私红线**：不申请网络请求类权限、扩展自身不发任何网络请求、数据不出本机。任何改动都不得破坏这一点（例如引入 CDN 脚本、远程字体、遥测）。
- **双端兼容**：后台带双路加载（原生 SW + 事件页回退）；lib 模块同时挂 `globalThis.NW.*` 和 `module.exports`，因此能被 node 直接 `require`。

## 常用命令与自检

```bash
node tools/check.js          # 唯一的测试/自检入口：任何改动都要跑，必须全绿
node tools/build_cities.js   # 仅当城市库需要重建时（离线，平时不跑）
python tools/make_icons.py   # 仅当图标需要重新生成时
```

没有 `npm run dev` / `npm test` / lint 配置。验证手段 = `node tools/check.js` + 手动加载扩展实测。
段落地图（加断言时对号入座）：

- `[1]`–`[4]` JSON / 语法 / lib 加载 / 城市库
- `[5]` `[5b]` 站点三态 / 手动模式自动恢复
- `[6]` background 监听器注册与隔离（**总数 8** 的那套断言）
- `[7]` i18n key 一致性（两库 key 集合 + 占位符）
- `[8]` 广播 + 徽标（异步断言队列）
- `[9]` storage 直写通道：真跑 popup DOM 夹具（读 / 写 / 徽标同帧 / 信号闹钟 / 门控 / 换肤）
- `[10]` preserveMedia 滤镜数学
- `[11]` content.js 抗回退（stale 消息不得回退页面）
- `[12]` 面板换肤 CSS 变量齐全性（两套主题）

## 沟通约定（用户明确要求，必须遵守）

- **【硬规则】每次接到任务，先提问把"具体改动点"钉精确，得到答复后再动手。**
  不要凭自己的理解直接改代码（哪怕看起来很明显）。三条细则（用户已逐条确认）：
  - **形式**：先复述一遍自己的理解（**改什么 / 不改什么**），再给 2~4 个**带说明的选项**
    让用户点选；等答复后才动手。
  - **范围**：**除"纯只读查询"外都要先问** —— 改代码 / 改文档 / 跑命令 / 撤销操作前都问；
    只读的"这功能在哪实现""解释一下这段"直接答。
  - **粒度**：**动手前一次性问完**（含边界、期望的可见效果、怎么验证），之后连续做完，
    中间不再打断用户（除非遇到真正的岔路）。
    缘由：2026-09-13 一轮"受限页徽标"需求因理解偏差返工三轮、最后全部撤回 ——
    **方向性理解偏差比实现错误贵得多**。
- 遇到不确定的先向用户提问，不要擅自扩大改动范围。
- 改完直接汇报结果，不要问"要不要提交/推送"，报告类文件也不要追问是否入库（用户会在需要时主动开口）。
- **更新本文件或 `.codebuddy/memory/` 后，必须做一次例行审查**（用户 2026-09-13 要求，"同步"与"审查"一起做）：
  审查对象 = 本文件、`.codebuddy/memory/MEMORY.md`、`~/.codebuddy/MYAGENTS.md`、日更日志 `YYYY-MM-DD.md`，
  四件事：
  1. **提取**：把"换项目也成立"的通用内容补进 `~/.codebuddy/MYAGENTS.md`（跨语言 / 跨项目通用的
     **协作方式、代码习惯、排障方法论**库，全局一份、不进仓库；收录标准 = "换个语言、换个项目还成立吗"）。
     项目专属内容（架构、接口、平台怪癖、命令）留在本文件，不要写进去。
  2. **精简**：合并重复条目、压缩冗长表述（**结论与"为什么"必须保留**）。
  3. **删过时**：已撤回的实现、失效结论、过时的状态描述、被推翻的旧方案。
  4. **优化文案**：把啰嗦 / 含糊的条目改写成直白、可执行的说法。
  ⚠️ **其中 2 / 3 / 4 涉及删改，必须先列出待删 / 待改清单（文件 + 条目 + 理由）等用户确认后再动手。**

## 代码风格（用户明确要求，必须遵守）

- 2 空格缩进不用 Tab；单引号（字符串含引号等必要场景除外）；语句末尾加分号；每行不超过 100 字符。
- **函数上方必须有中文 JSDoc 注释**；复杂逻辑加中文行内注释，注释写"为什么"（尤其反直觉的写法）。
- 可能出错的代码用 try-catch 包裹：详细错误进控制台，给用户看的必须是友好提示。

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
4. **`config.enabled` 总开关只属于设置页**，popup 里没有总开关。**popup 控件可用性只有一个出口
   `controlsState()`**（`masterOff` / `unsupported` / `disabled`）：渲染与所有 handler 守卫都只查它，
   不要再各写一套条件（历史上滑杆漏了总开关、站点三态漏了"本页不支持"）。"为什么用不了"同样只有
   一个出口 `#noticeBlock`（按原因显示 1~2 行，两种原因同时成立就显示两行）；控件不可用时状态行留空。
5. **徽标只有一个全局值**：黑夜 `ON`（绿），白天（含总开关关闭）`OFF`（灰），判定与颜色统一由
   `SUN.badgeState(config)` 提供，三个写入方（popup / options / background）共用。
   **绝对不要写 per-tab 徽标**（`setBadgeText({tabId})`）：Chrome 的 per-tab 覆盖与全局断开、
   **没有"解除覆盖"的 API**，写了就得永远维护，而且写空一次那个标签页的徽标就永久消失
   （历史事故："ON/OFF 不主动显示、点开 popup 才出现"）。受限页只在 popup 里提示"不支持"。
6. **用户主动改变昼夜/名单的每个路径都必须触发广播**：要么 `saveConfig(config, true)`，
   要么写 storage 靠 `storage.onChanged`。否则就是"面板改了页面不变"的老 bug。
7. **SW 无常驻状态**：动 `background.js` 里的 `config` 前必须先 `loadConfig()`；
   所有监听器经 `onEvent` 隔离注册，一个失败不能拖死其他监听器。
   **监听器总数恒为 8**（`tabs.onActivated` 是条件注册，与它兜底的 `onShown` 互斥）；
   增删监听器要同步 `background.js` 的 `report()` 与 `check.js` 的 `[6]` 段断言。
8. **content_scripts 的 js 列表在 `manifest.json` 里手工维护**：新增 lib 文件必须同步加进去，
   且顺序即依赖顺序；lib 文件必须同时兼容浏览器（挂 `NW.*`）与 node（`module.exports`）。
9. **面板换肤跟随"生效明暗"**：popup / 设置页用 `html.nw-light` + CSS 变量跟随
   `SUN.badgeState(config)`（与徽标同一个判定）—— 黑夜暗色（`:root` 默认），白天 / 总开关关闭亮色。
   **新增颜色一律走变量、两套主题各定义一份**（`check.js` `[12]` 静态校验会抓漏），不许硬编码。
   popup 在脚本开头按 `localStorage['night-owl:theme']` 做"首帧上色"防闪；设置页会长时间开着，
   必须按 `SUN.nextSwitch().at` 排定时器（拿不到则 60s 兜底）自己换肤 —— 自动模式的昼夜切换
   不会产生任何 storage 事件。

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

## 提交与边界

- 只在用户明确要求时才 commit；不要主动 commit、不要 amend、不要 force push。
- `.codebuddy/` 存放工作数据，**不要删除**。
- `tools/` 里的 `.txt`/`.out`/`.png` 是历史运行快照与生成物，不要当作源码去"整理"。
- 不引入新依赖、不加构建工具、不改目录结构，除非用户明确要求。

## 已知边界（filter 方案固有，报 bug 前先排除）

- 地图 / 在线设计工具 / PDF 查看器等依赖精确颜色的页面效果差 → 用黑名单处理。
- `position: fixed` 吸顶导航在部分站点异常 → 「高级」里切换滤镜应用范围，或加黑名单。
- 图片 / 视频保真：父级滤镜**只允许用可反向算子**（invert / hue-rotate / brightness / contrast / saturate）；
  `sepia`（色温）与 `grayscale`（灰度）不可反向，用了就会让媒体"怎么补偿都不对"
  —— 所以色温改用 hue-rotate + saturate、灰度折进 saturate(1-g)，媒体侧做逆运算 +
  「媒体亮度」压暗（`advanced.mediaDim`，整数百分比 60–100、默认 92，设置页「高级」滑杆可调，
  仅在 preserveMedia 开启时生效并联动置灰，随配置导出/导入；`check.js` `[10]` 段有断言钉住）。
