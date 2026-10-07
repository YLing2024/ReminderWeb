# ReminderWeb

把安卓应用 **Reminder**（纪念日 / 倒数日管理）做成响应式 Web 应用：视觉风格一致、行为语义一致、**数据与安卓版双向互通**。

- 纯静态、本地优先：无后端、无账号、无数据库；数据存浏览器 IndexedDB。
- 与安卓版共用备份格式（zip + AES/CBC 加密），可互相导入导出。
- 许可：**GPL-3.0**。

## 功能

- 首页：置顶 / 标签分组、卡片与列表两种布局、超大天数、区间事件阶段标签、三档响应式布局。
- 新增 / 编辑：公历 / 农历日期、倒数日 / 正数日 / 生日、重复、区间事件、提醒设置、备注。
- 详情：卡片翻面看备注、生日年龄 / 生肖 / 星座、分享成图片。
- 搜索、标签管理、日期计算器、设置（主题 / 纯黑 / 种子色 / 视图 / 滚动收起 / 提醒 / 数据 / 安全 / 关于）。
- 备份与恢复：导出 / 导入安卓互通 zip，可选「加密（兼容安卓）」。
- 分享成图片：Canvas 绘制同款卡片，导出 PNG / 复制到剪贴板。
- PWA：离线可用、可安装；页面打开时到点提醒，Service Worker 兜底。
- 提醒方式支持导出 `.ics`；应用锁（PIN 码）。
- 计算语义与安卓端一致，并有单元测试覆盖。

## 与安卓版的差异

| 安卓能力 | Web 版处理 |
| --- | --- |
| 桌面小组件（3 种尺寸） | 不做（浏览器无此能力） |
| 小米超级岛 / 实时提醒通知样式 | 不做 |
| 写入系统日历 | 改为**导出 .ics** 文件 |
| 指纹 / 人脸解锁 | 改为 PIN 码应用锁（后续可扩展 WebAuthn） |
| 禁止截屏录屏 | 不做 |
| 系统壁纸动态取色 | 改为「跟随种子色」 |
| 应用内检查更新 | 改为「关于页显示版本 + 仓库链接」 |
| 液态玻璃 / 光栅玻璃 / 折射参数 | 不实现视觉效果，但**备份字段原样保留** |
| 后台精确唤醒提醒 | 页面打开时用 Notification API；另提供 Service Worker 周期检查（能力受限时明确提示） |
| WebDAV 云备份 | 不做（仅本地导出 / 导入） |

## 技术栈

Vite + React 19 + TypeScript（strict）、react-router-dom、zustand、idb-keyval（IndexedDB）、
lunar-javascript（农历，按需加载）、@material/material-color-utilities（M3 动态取色）、
fflate（备份 zip）、vite-plugin-pwa（离线 / 可安装）、vitest（测试）、CSS 变量 + CSS Modules。

## 开发 / 构建 / 部署

```bash
# 安装依赖
npm install

# 本地开发（默认 127.0.0.1:5173）
npm run dev

# 类型检查 + 生产构建，产物在 dist/
npm run build

# 本地预览构建产物
npm run preview

# 代码检查 / 单元测试
npm run lint
npm test
```

部署：`npm run build` 后把 `dist/` 作为静态站点托管即可。应用使用 `BrowserRouter`，
需将未知路径回退到 `index.html`（例如 Nginx 的 `try_files $uri /index.html;`）。
Service Worker 与 manifest 在构建时自动生成。

## 备份格式（与安卓互通）

- `.zip`，内含 `metadata.json`（字段名与安卓 `BackupData` 逐字对齐）与 `images/<文件名>`
  （文件名与 `cardBackgroundImagePath` 一致），可选 `fonts/`。
- 加密包：整包 `AES/CBC/PKCS5Padding`，密钥 = `SHA-256(seed)`、`seed[i] = obfuscated[i] XOR 90`；
  密文布局 `[16 字节 IV][密文]`。Web 端用 `crypto.subtle`（`AES-CBC`）实现同口径加解密。
- 备份文件名：`reminder-backup-YYYYMMDD-HHmmss.zip`。
- 未知字段（如液态玻璃参数）导入导出原样保留，不丢数据。

## 截图

> 截图位（构建产物实机截图，待补充）。可放入 `docs/screenshots/` 并以
> `![首页](docs/screenshots/home.png)` 形式引用。

| 首页 | 新增 / 编辑 | 详情 | 设置 |
| --- | --- | --- | --- |
| _待补充_ | _待补充_ | _待补充_ | _待补充_ |

## 许可

本项目以 **GPL-3.0** 发布，见 [LICENSE](LICENSE)。上游 Reminder 亦为 GPL-3.0，
因此本衍生作品沿用同一许可。

## 致谢

- [ybhgl/Reminder](https://github.com/ybhgl/Reminder)：本项目的直接上游（Kotlin + Jetpack Compose），
  数据模型、计算语义、备份格式与视觉均以其为参照。
- [lentikr/Reminder](https://github.com/lentikr/Reminder)：上游思路的另一实现，一并致谢。
- 运行依赖：React / React Router / Zustand（MIT）、lunar-javascript（MIT）、
  @material/material-color-utilities（Apache-2.0）、fflate（MIT）、idb-keyval（MIT）。
- 字体：Dancing Script（SIL OFL 1.1，自托管子集）。

## 仓库

- 源码：<https://github.com/YLing2024/ReminderWeb>

> 示例中的域名（如 `reminder.example.com`）均为占位符，不代表真实服务。
