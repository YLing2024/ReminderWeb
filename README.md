# ReminderWeb

把安卓应用 **Reminder**（纪念日 / 倒数日管理）做成响应式 Web 应用：视觉风格一致、行为语义一致、**数据与安卓版双向互通**。

- 两种运行方式：默认**本地模式**（纯静态，数据存浏览器 IndexedDB，无账号无后端）；也可配套仓库自带的 **Node.js + SQLite 后端**（推荐），由服务器保存唯一真数据，多设备一致。
- 与安卓版共用备份格式（zip + AES/CBC 加密），可互相导入导出。
- 许可：**GPL-3.0**。

## 功能

- 首页：置顶 / 标签分组、卡片与列表两种布局、超大天数、区间事件阶段标签、三档响应式布局。
- 新增 / 编辑：公历 / 农历日期、倒数日 / 正数日 / 生日、重复、区间事件、提醒设置、备注。
- 详情：卡片翻面看备注、生日年龄 / 生肖 / 星座、分享成图片。
- 搜索、标签管理、日期计算器、设置（主题 / 纯黑 / 种子色 / 视图 / 滚动收起 / 提醒 / 数据 / 安全 / 关于）。
- 备份与恢复：导出 / 导入安卓互通 zip，可选「加密（兼容安卓）」。
- WebDAV 云备份：把同一份备份包上传到自己的 WebDAV 服务器，可列出、恢复、自动备份并保留份数。
- 分享成图片：Canvas 绘制同款卡片，导出 PNG / 复制到剪贴板。
- PWA：离线可用、可安装；页面打开时到点提醒，Service Worker 兜底。
- 提醒方式支持导出 `.ics`；应用锁密码（任意字符，本地 PBKDF2 加盐存储，可显示/隐藏，支持旧 PIN 自动升级）。
- 计算语义与安卓端一致，并有单元测试覆盖。

## 与安卓版的差异

| 安卓能力 | Web 版处理 |
| --- | --- |
| 桌面小组件（3 种尺寸） | 不做（浏览器无此能力） |
| 小米超级岛 / 实时提醒通知样式 | 不做 |
| 写入系统日历 | 改为**导出 .ics** 文件 |
| 指纹 / 人脸解锁 | 改为**应用锁密码**（任意字符，本地 PBKDF2 加盐存储） |
| 禁止截屏录屏 | 不做 |
| 系统壁纸动态取色 | 改为「跟随种子色」 |
| 应用内检查更新 | 改为「关于页显示版本 + 仓库链接」 |
| 液态玻璃 / 光栅玻璃 / 折射参数 | 不实现视觉效果，但**备份字段原样保留** |
| 后台精确唤醒提醒 | 页面打开时用 Notification API；另提供 Service Worker 周期检查（能力受限时明确提示） |
| 本地数据库 | 可选后端（Node.js + SQLite）为**唯一真数据源**；前端 IndexedDB 降级为只读离线缓存（M7 起后端与 WebDAV 互通）。未部署后端时回落本地模式，界面上会明确标注 |
| WebDAV 云备份 | **已支持**：纯前端 `fetch` 实现（PROPFIND / MKCOL / PUT / GET / DELETE + Basic 认证），产物与本地导出逐字节一致。需服务器允许跨站访问（CORS），或改用与本页面同源的地址 |

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

# 后端（可选）：直接运行 TypeScript（Node ≥ 24），无需编译
npm run dev:server      # 开发：node --watch server/src/index.ts
npm start               # 生产：node server/src/index.ts

# 后端类型检查 / node:test 测试
npm run typecheck:server
npm run test:server
```

部署：`npm run build` 后把 `dist/` 作为静态站点托管即可。应用使用 `BrowserRouter`，
需将未知路径回退到 `index.html`（例如 Nginx 的 `try_files $uri /index.html;`）。
Service Worker 与 manifest 在构建时自动生成。若启用内置后端，后端会在构建产物存在时
直接服务 `dist/`，无需额外静态托管（见下一节）。

## 部署（后端模式）

后端零运行时依赖：只用 Node 内置模块（`node:sqlite` / `node:crypto` / `node:http`），
源码即 TypeScript，由 Node ≥ 24 直接运行（`node server/src/index.ts`），无需构建。
前端构建期可用 `VITE_API_BASE` 指定后端地址（留空 = 与页面同源 `/api`）。

### 环境变量

复制 `.env.example` 为 `.env` 并按需修改（示例值均为占位符，切勿使用真实凭据）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址。`AUTH_MODE=sso` 时必须保持回环，否则拒绝启动 |
| `PORT` | `18940` | 监听端口 |
| `DATA_DIR` | `./server/data` | 数据目录（SQLite 数据库 `reminder.db`） |
| `AUTH_MODE` | `builtin` | `builtin` / `sso` / `none` |
| `AUTH_USER` | `admin` | builtin 用户名 |
| `AUTH_PASSWORD` | 空 | builtin 初始口令；首次启动时建立，明文不入库、不落日志。留空且库中无口令时生成一次性随机口令并只打印一次 |
| `SESSION_TTL_DAYS` | `30` | 会话有效期（天） |
| `LOGIN_RATE_LIMIT` | `5` | 每 IP 每 10 分钟允许的登录失败次数 |
| `TRUST_PROXY` | `1` | 是否信任 `X-Forwarded-For`（取真实 IP 做限流） |
| `SERVE_STATIC` | `1` | 是否由后端服务 `dist/`（纯 API 部署可关） |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `VITE_API_BASE` | 空 | 前端构建期的后端地址前缀；空 = 同源 `/api` |

`WEBDAV_*` 为 M7 预留，M6 暂未启用。

### 启动

```bash
npm install
npm run build            # 生成 dist/
AUTH_MODE=builtin AUTH_PASSWORD=changeme npm start
# 启动日志会打印监听地址、认证模式、数据目录与静态目录（绝不打印口令/令牌）
```

### systemd（示例）

```ini
[Unit]
Description=ReminderWeb backend
After=network.target

[Service]
WorkingDirectory=/opt/reminderweb
EnvironmentFile=/opt/reminderweb/.env
ExecStart=/usr/bin/node server/src/index.ts
Restart=on-failure
User=reminderweb

[Install]
WantedBy=multi-user.target
```

### nginx 反向代理（示例）

后端只监听 `127.0.0.1:18940`，由 nginx 终止 TLS 并转发。
`__Host-rw_session` Cookie 要求 HTTPS，请务必通过 nginx 提供 HTTPS。

```nginx
server {
    listen 443 ssl;
    server_name reminder.example.com;

    location / {
        proxy_pass http://127.0.0.1:18940;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### builtin 与 sso 如何选

- **builtin（默认，开源用户）**：后端自带账号密码。首次启动用 `AUTH_PASSWORD` 建立，
  或留空让后端生成一次性随机口令（登录后在数据设置里改）。前端 401 时会弹出内置登录界面。
- **sso（本人部署）**：由前置网关完成登录并注入 `X-Auth-User` 头，后端只读该头，不使用 Cookie。
  此时 `HOST` 必须保持回环（`127.0.0.1` / `::1` / `localhost`），否则拒绝启动，防止伪造头绕过网关。
  前端 401 时跳转 `/_auth/login?next=<当前路径>`。
- **none**：仅本机开发，所有请求视为用户 `dev`；非回环 + `NODE_ENV=production` 时拒绝启动。

### 数据目录与备份

- SQLite 数据库与 WAL 文件位于 `DATA_DIR`（默认 `server/data/`，已在 `.gitignore` 中忽略）。
- 备份：停止服务后直接复制整个 `DATA_DIR` 即可；也可用 SQLite 的 `.backup` 命令做在线备份。
- 数据模型：`reminders` / `tags` 用条目级 `updatedAt` + 墓碑合并，`settings` 整体同步；
  应用锁、WebDAV 凭据、通知权限等**仅本机**设置不会上传服务器。

## 备份格式（与安卓互通）

- `.zip`，内含 `metadata.json`（字段名与安卓 `BackupData` 逐字对齐）与 `images/<文件名>`
  （文件名与 `cardBackgroundImagePath` 一致），可选 `fonts/`。
- 加密包：整包 `AES/CBC/PKCS5Padding`，密钥 = `SHA-256(seed)`、`seed[i] = obfuscated[i] XOR 90`；
  密文布局 `[16 字节 IV][密文]`。Web 端用 `crypto.subtle`（`AES-CBC`）实现同口径加解密。
- 备份文件名：`reminder-backup-YYYYMMDD-HHmmss.zip`。
- 未知字段（如液态玻璃参数）导入导出原样保留，不丢数据。

### WebDAV 云备份（可选）

- 在「设置 → WebDAV 云备份」填写服务器地址（如 `https://dav.example.com/dav/`，结尾斜杠可省略）、
  用户名与密码，先点「测试连接」验证地址与凭据。
- 「立即上传备份」把与「导出为文件」**完全相同**的 zip（是否加密沿用本地开关）上传到该目录；
  「从云端恢复」列出远端 `reminder-backup-*.zip` 供选择，恢复走与本地导入相同的解析与覆盖逻辑，
  覆盖前需二次确认。
- 自动备份：数据变动后延迟 60 秒合并上传一次；保留份数默认 10，上传成功后只保留最新的若干份，
  多出的最旧备份会被删除（只会删除本应用命名的备份）。
- 凭据只存本地 IndexedDB，不会写入任何导出备份，也不打印到日志。
- 浏览器直连远端 WebDAV 需要服务器允许跨域（CORS）；若不允许，请把备份地址换成与本页面同源的地址。

## 截图

| 首页（桌面） | 首页（手机） |
| --- | --- |
| ![首页（桌面）](docs/screenshots/home-desktop.png) | ![首页（手机）](docs/screenshots/home-mobile.png) |

| 新增 / 编辑 | 详情 |
| --- | --- |
| ![新增提醒](docs/screenshots/edit-desktop.png) | ![提醒详情](docs/screenshots/detail-desktop.png) |

| 平板 |
| --- |
| ![首页（平板）](docs/screenshots/home-tablet.png) |

| 备份与恢复 | WebDAV 云备份 | 应用锁 |
| --- | --- | --- |
| ![备份与恢复](docs/screenshots/backup-desktop.png) | ![WebDAV 云备份](docs/screenshots/settings-cloud-mobile.png) | ![应用锁](docs/screenshots/lock-screen.png) |

> 同一套界面在三种宽度下自适应：手机（底部导航 + 右侧抽屉「目录」，窄屏同样保留导航）、
> 平板与桌面（左侧导航，卡片网格 2 / 3 列）。截图为构建产物实机截图，
> 其中示例数据、`https://dav.example.com/dav/`、`davuser` 等均为占位内容。

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
