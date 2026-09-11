# Night Owl 夜鹰

为 Chrome 打造的全站夜间模式扩展（Manifest V3）。所有功能均在浏览器本地运行，无账号、无服务器、数据不出本机。界面支持中 / 英双语（跟随浏览器语言）。

## 功能

- **全站夜间模式**：CSS 滤镜反色，图片 / 视频 / 画布自动还原色彩
- **自动切换**：两种时间表
  - 跟随日出日落：填入经纬度（纯本地天文算法，不需要联网），支持自定义偏移；极昼极夜自动降级为固定时段
  - 固定时段：例如 19:00 – 07:00
- **定位辅助**：点「获取我的位置」自动填经纬度，并回显最近城市（内置 3300 城精简库，本地匹配，不联网反查）
- **手动切换**：popup 一键切换 自动 / 黑夜 / 白天
- **外观调节**：暗度、亮度、对比度、饱和度、色温（-100 冷 ↔ +100 暖）、黑白程度，设置页带实时预览
- **黑白名单**（黑名单 = 要变暗，白名单 = 不变暗）
  - **白名单**：这些网址保持原色，优先级最高
  - **黑名单**：这些网址强制变暗，即使当前是白天时段
  - 都没进：跟随全局 自动 / 黑夜 / 白天
  - 支持 `*.example.com` 子域名通配与路径前缀；两个名单互斥，加一边会自动从另一边摘除
  - 设置页分两个独立区域，上半部分是已加入的网址（一行一个，可单独移除），下半部分输入框回车或点「确定」即录入
- **右键菜单**：网页或工具栏图标上右键，按状态显示「加入白名单」或「移出白名单」
  - 加入 → 网址进白名单，当前页面立刻从黑夜切回白天
  - 移出 → 网址出白名单，恢复到全局该有的状态（夜间时段就立刻变暗）
- **快捷键**：`Alt+Shift+D` 切换昼夜；站点加入 / 移出白名单可在 `chrome://extensions/shortcuts` 自行绑定
- **配置导入导出**：JSON 文件，带 schema 版本校验，可迁移到其他电脑

## 安装（开发者模式）

1. 打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录（`night-owl`）

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存设置到本地 |
| `tabs` | 向已打开的标签页同步状态 |
| `scripting` | 注入夜间模式样式 |
| `alarms` | 按时间表触发昼夜切换 |
| `contextMenus` | 右键菜单开关当前站点 |
| `geolocation` | 一键填入所在位置的经纬度（仅设置页主动点击时触发） |
| `<all_urls>` | 对所有网站生效所必需 |

不申请 cookies、不申请网络请求类权限，扩展本身不发出任何网络请求。
定位只用浏览器给的经纬度，城市名由内置的本地城市库匹配得出，不会把坐标发给任何服务器。

## 兼容性

- **Chrome / Edge / Brave / Opera**：MV3 Service Worker，原生路径
- **Firefox 115+**：同一份包可直接加载（`browser_specific_settings` 已声明）
- 后台脚本带双路加载：`importScripts` 可用时走原生 Service Worker；
  若浏览器原生注册失败（`Service worker registration failed. Status code: 15`），
  自动退化为事件页（MV2 风格持久后台），不再反复弹报错

### 通信通道（重要，不要改回去）

popup 与设置页**不依赖** `chrome.runtime.onMessage`。

原因：在某些 Chrome 构建上，Service Worker 里的 `runtime.onMessage`
会注册失败（可在 `Secure Preferences` → `serviceworkerevents` 里实证：
该集合里没有 `runtime.onMessage`），而 `chrome://extensions` 不报任何错。
一旦如此，所有"发消息给后台"的操作都会石沉大海 —— 表现就是
**面板里的改动关掉再打开又变回原样**。

因此面板直接读写 `chrome.storage.local`（`src/lib/store.js`），
`storage.onChanged` 在后台承接"变更 → 广播到所有标签页"的职责。
`sendMessage` 只保留为"顺手通知后台刷新角标"的尽力而为通道，
失败不影响任何功能，也不会弹错误提示。

改动这一层前请先读 `src/lib/store.js` 顶部注释与 `tools/check.js` 的 `[9]` 段。

## 已知边界（filter 方案的固有特性）

- 地图、在线设计工具、PDF 查看器等依赖精确颜色的页面效果差，请用黑名单处理
- 页面使用 `position: fixed` 的吸顶导航在部分站点可能表现异常，可在「高级」中切换滤镜应用范围，或加入黑名单
- 反色强度低于 100% 时图片会有轻微发灰，已做对比度补偿，若仍介意可调回 100%

## 目录结构

```
night-owl/
├── manifest.json          # MV3 清单
├── _locales/              # en / zh_CN 文案
├── icons/                 # 16 / 48 / 128 图标
├── src/
│   ├── background.js      # Service Worker：排程、快捷键、徽标、右键菜单
│   ├── content.js         # 页面渲染引擎（防白闪：sessionStorage 缓存 + 异步校准）
│   ├── inject.css         # 静态样式通道（运行时样式由 content.js 生成）
│   ├── lib/
│   │   ├── config.js      # 配置 schema、默认值、归一化校验
│   │   ├── sun.js         # NOAA 日出日落算法（纯本地计算）
│   │   ├── matcher.js     # 黑白名单规则解析与匹配
│   │   ├── filter.js      # 滤镜构造（渲染与预览共用）
│   │   ├── store.js       # popup/options 直连 storage 的通道（不依赖 onMessage）
│   │   ├── cities.data.js # 内置 3300 城精简库（自动生成，仅设置页加载）
│   │   └── cities.js      # 经纬度 → 最近城市（本地最近邻匹配）
│   ├── popup/             # 工具栏弹窗
│   └── options/           # 设置页
└── tools/                 # 图标生成、城市库构建与自检脚本
    ├── make_icons.py      # 生成 16/48/128 图标
    ├── build_cities.js    # 从 GeoNames 构建城市库（离线跑一次）
    └── check.js           # 一键自检：语法 / 加载 / 城市 / 切换语义 / 通道 / i18n
```

改完代码后跑一次自检：

```bash
node tools/check.js
```

自检共 9 段，其中两段专门守住"面板改了不生效"这类问题：

- `[8] broadcast`：任何主动操作都必须真的广播到标签页
- `[9] storage 直写通道`：在**模拟 `runtime.onMessage` 完全不可用**的环境下，
  用最小 DOM 夹具真跑一遍 popup，断言读得到、写得进、不误报错误

lib 模块同时兼容两种挂载方式：扩展里挂到 `globalThis.NW.*`，
node 下平铺到 `module.exports`，因此自检脚本和构建脚本可以直接 `require`。
