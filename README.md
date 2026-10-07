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
- WebDAV 云备份：后端（可选）与 WebDAV 服务器**双向同步**——把与安卓版一致的备份包推上去，也把安卓端写的新包拉回来逐条合并。
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
| WebDAV 云备份 | **服务端与 WebDAV 双向同步**（安卓端仍走 WebDAV 备份包，两边数据互通）。凭据只存服务端环境变量，前端只显示只读状态与「立即同步」 |

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

后端零运行时依赖：只用 Node 内置模块（`node:sqlite` / `node:crypto` / `node:zlib` / `node:http`），
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
| `WEBDAV_ENABLED` | `0` | 是否启用 WebDAV 双向同步；关闭时 `/api/sync/status` 返回 `{enabled:false}` |
| `WEBDAV_URL` | 空 | WebDAV 目录地址（结尾斜杠自动补齐）。启用但留空会拒绝启动 |
| `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` | 空 | Basic 凭据；只从环境变量读取，绝不返回前端、绝不写日志 |
| `WEBDAV_INTERVAL_MINUTES` | `10` | 定时轮询远端间隔（分钟，下限 1） |
| `WEBDAV_DEBOUNCE_SECONDS` | `60` | 本机数据变动后的延迟上传（合并节流） |
| `WEBDAV_ENCRYPT` | `1` | 上传的包是否加密（与安卓端「备份数据加密」一致） |
| `WEBDAV_KEEP` | `10` | 仅保留最近 N 份**由本服务上传**的备份 |
| `WEBDAV_TIMEOUT_SECONDS` | `20` | 单次 HTTP 请求超时（秒） |

`WEBDAV_*` 详见下文「WebDAV 双向同步（与安卓版共用同一目录）」。

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

### WebDAV 双向同步（与安卓版共用同一目录）

后端可直接与 WebDAV 服务器双向同步，备份包格式与安卓版完全一致，**同一个目录可同时被安卓版与本服务使用**：

- 开启：`.env` 设置 `WEBDAV_ENABLED=1` 与 `WEBDAV_URL`（如 `https://dav.example.com/reminder/`），
  以及 `WEBDAV_USERNAME` / `WEBDAV_PASSWORD`。凭据只存在于服务端环境变量，不返回前端、不写日志。
- 每个周期（`WEBDAV_INTERVAL_MINUTES`）：`PROPFIND` 取最新备份（与上次已处理的比对 etag / 修改时间，
  未变则跳过下载）→ 下载 → 解密解包 → 与库内数据逐条合并（`updatedAt` + 墓碑）→ 有变化才落库并 revision++ → 上传一份新包。
- 本机数据变更后按 `WEBDAV_DEBOUNCE_SECONDS` 合并节流上传，避免每次变动都写远端；同步任务在进程内串行。
- 加密开关 `WEBDAV_ENCRYPT`：`1` 时用上游 AES-256-CBC 口径加密（与安卓端「备份数据加密」互通，两种都能读）。
- 保留与清理 `WEBDAV_KEEP`：只清理**由本服务上传**的旧包，绝不删除安卓端写入的历史备份。
- 状态与手动触发：设置页「WebDAV 云备份」为只读状态 + 「立即同步」；
  接口 `GET /api/sync/status`、`POST /api/sync/now`（同一时刻重复调用返回 409）。
  状态响应只含是否启用、地址、上次同步/上传时间、上次结果与远端本应用备份列表，**不含凭据**。
- 失败不致命：任何异常都只记录脱敏日志与状态、下个周期继续；连续失败按指数退避（上限 4× 轮询间隔）。

## 备份格式（与安卓互通）

- `.zip`，内含 `metadata.json`（字段名与安卓 `BackupData` 逐字对齐）与 `images/<文件名>`
  （文件名与 `cardBackgroundImagePath` 一致），可选 `fonts/`。
- 加密包：整包 `AES/CBC/PKCS5Padding`，密钥 = `SHA-256(seed)`、`seed[i] = obfuscated[i] XOR 90`；
  密文布局 `[16 字节 IV][密文]`。Web 端用 `crypto.subtle`（`AES-CBC`）实现同口径加解密。
- 备份文件名：`reminder-backup-YYYYMMDD-HHmmss.zip`。
- 未知字段（如液态玻璃参数）导入导出原样保留，不丢数据。
- 同一目录可同时被**安卓版**与**本服务**使用：安卓端写入的备份包会被拉回逐条合并，本服务上传的包安卓端也能直接恢复。

### WebDAV 云备份（可选）

云备份现已由**服务端**接管：在 `.env` 配置 `WEBDAV_*`（见上文「WebDAV 双向同步」），
浏览器不再保存服务器地址与凭据；设置页只显示同步状态、远端备份列表与「立即同步」。
旧的浏览器内凭据会在读取时自动清除，并提示已迁移到服务器端配置。
「导出为文件 / 从文件恢复」仍为本地手动路径，与云端互不影响。

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
