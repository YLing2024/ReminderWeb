# ReminderWeb M6 需求书：后端服务（Node.js + SQLite）+ 前端改为以服务器为准

> 背景：当前是纯前端 SPA，数据只存浏览器 IndexedDB，导致同一网址在不同设备上是两份数据。
> 现在改为：**后端保存唯一真数据，前端只做展示与离线缓存**；后端随后（M7）再与 WebDAV 互通，
> 以兼容安卓版（安卓端走 WebDAV 备份包）。
>
> 本文件自包含：执行者无需任何对话上下文即可实现。

## 1. 目标架构

```
浏览器(React SPA) ⇄ 后端(Node.js + SQLite) ⇄ WebDAV(任意服务器) ⇄ 安卓版 Reminder
```

- 后端是唯一真数据源；前端 IndexedDB 降级为**只读离线缓存**。
- 后端支持两种认证：`builtin`（自带账号密码，开源用户默认）与 `sso`（网关注入 `X-Auth-User`，本人部署）。
- 本里程碑只做「后端 + 数据 API + 前端改为以服务器为准（含离线缓存与本地模式兜底）」；
  **WebDAV 互通留到 M7，SSO 接线与线上切换留到 M8**（但认证模式开关要在 M6 就实现好）。

## 2. 运行时与技术约束（重要）

- 目标运行时：**Node.js ≥ 24**（生产固定 v24.19.0，路径 `/root/.nvm/versions/node/v24.19.0/bin/node`）。
- **零运行时依赖**：只用内置模块 ——
  - `node:sqlite`（`DatabaseSync`）做存储；
  - `node:crypto`（`scryptSync` / `randomBytes` / `timingSafeEqual`）做口令与令牌；
  - `node:http` 写 HTTP 服务与极简路由（不使用 express/koa 等）；
  - `node:test` 写服务端测试；
  - 全局 `fetch` 留 M7 调 WebDAV 用。
- 后端用 **TypeScript 源码直接运行**（Node 24 内置类型擦除，与仓库现有 `blog` 项目一致）：
  启动命令 `node server/src/index.ts`；因此**禁止使用 enum / namespace / 参数属性等不可擦除语法**，
  并在 `server/tsconfig.json` 打开 `erasableSyntaxOnly`。类型检查用 `tsc --noEmit`（不产出 JS）。
- 新增脚本：`npm run dev:server`、`npm run start`（= `node server/src/index.ts`）、`npm run typecheck:server`。
- `package.json` 的 `dependencies` 必须保持为空（`devDependencies` 也不得为后端新增；现有前端依赖不动）。

## 3. 目录与文件

```
server/
  src/index.ts        启动：读环境变量 → 建库 → 起 HTTP → 优雅退出
  src/config.ts       环境变量解析与校验（含默认值、非法值直接启动失败并打印原因）
  src/db.ts           SQLite 打开/迁移（PRAGMA journal_mode=WAL、foreign_keys、busy_timeout）
  src/auth.ts         builtin 口令校验、会话令牌、sso 头解析、中间件
  src/data.ts         业务：读取、条目级合并（updatedAt + 墓碑）、写入
  src/serialize.ts    ReminderItem/TagItem/settings 的校验与归一化（复用前端 `src/types/reminder.ts` 的形状约定）
  src/http.ts         极简路由、JSON 解析（含体积上限）、统一错误体、静态文件服务
  src/routes/*.ts     auth / data / health 路由
  test/*.test.ts      node:test 测试
  tsconfig.json
server/data/           运行时数据目录（默认 ./server/data，含 reminder.db）—— 必须 gitignore
.env.example           所有环境变量与说明（提交进仓库，不得含真实值）
```

- 前端静态产物由后端直接服务（`dist/`，不依赖外链）；找不到的文件回退 `index.html`（SPA）。
- 生产上用 systemd 单服务 + nginx 反代，后端默认只监听 `127.0.0.1`。

## 4. 环境变量（`.env.example` 里逐条注释）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址。**当 `AUTH_MODE=sso` 时必须保持回环地址**，否则启动失败并说明原因（防止伪造 `X-Auth-User` 绕过网关） |
| `PORT` | `18940` | 监听端口 |
| `DATA_DIR` | `./server/data` | 数据目录（SQLite 与附件都放这里） |
| `AUTH_MODE` | `builtin` | `builtin` / `sso` / `none`。`none` 仅供本机开发：非回环地址 + 非本机开发环境下必须拒绝启动 |
| `AUTH_USER` | `admin` | builtin 用户名 |
| `AUTH_PASSWORD` | 空 | builtin 初始口令；首次启动时用它建立（scrypt 加盐哈希后入库），**明文不入库、不落日志**；留空且库里还没有口令时，启动时生成一次性随机口令打印到 stdout **仅一次** |
| `SESSION_TTL_DAYS` | `30` | 会话有效期 |
| `LOGIN_RATE_LIMIT` | `5` | 每 IP 每 10 分钟允许的登录失败次数 |
| `TRUST_PROXY` | `1` | 是否信任 `X-Forwarded-For`（取真实 IP 用于限流） |
| `SERVE_STATIC` | `1` | 是否由后端服务 `dist/`（纯 API 部署可关） |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `WEBDAV_*` | 空 | M7 用，M6 先只在 `.env.example` 中列出并注明"暂未启用" |

启动时打印：监听地址、认证模式、数据目录、是否服务静态文件；**绝不打印任何口令与会话令牌**。

## 5. 认证

### 5.1 `AUTH_MODE=builtin`（默认）

- `POST /api/auth/login`，体 `{username, password}`：
  - 用 `scrypt`（`N=16384, r=8, p=1`，16 字节随机盐，32 字节派生）比对；
  - 失败：`401 {error:"invalid_credentials"}`，且计入每 IP 限流（超过 `LOGIN_RATE_LIMIT` 返回 `429`）；
  - 成功：签发 32 字节随机会话令牌，写入 `sessions` 表（token 存 **SHA-256 摘要**，不存明文），
    下发 `Set-Cookie: __Host-rw_session=<token>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=<TTL>`；
  - 用户名或口令为空 → `400`。响应不区分"用户不存在"与"口令错误"。
- `POST /api/auth/logout`：删除会话，清 Cookie（`Max-Age=0`）。
- `GET /api/auth/me`：`200 {username}` 或 `401`。
- 受保护路由：读 Cookie → 查表 → 校验未过期；过期即删并 `401`。

### 5.2 `AUTH_MODE=sso`

- 只读请求头 `X-Auth-User`（网关注入，见仓库既有约定）；缺失或空 → `401 {error:"unauthorized"}`。
- 不使用 Cookie，不需要登录页；用户名即为 `X-Auth-User` 的值。
- 启动时若 `HOST` 不是回环地址 → 拒绝启动（提示"SSO 模式必须只在回环地址监听，由网关转发"）。

### 5.3 `AUTH_MODE=none`

- 仅本机开发；每个请求视为用户 `dev`。启动时打印醒目警告。非回环地址 + `NODE_ENV=production` 时拒绝启动。

### 5.4 通用

- 所有 `/api/*`（除 `/api/health` 与 `/api/auth/login`）都要求已认证，否则 `401 {error:"unauthorized"}`。
- 口令、派生哈希、会话令牌、Cookie 值**不得**出现在任何日志或错误响应里。
- 登录失败响应加固定小延迟（≥150ms）以防用户枚举。

## 6. 数据模型与 API

### 6.1 表

```sql
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);      -- revision、schema_version
CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tags      (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings  (k TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions  (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users     (username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit     (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
```

- `payload` 存该条目的完整 JSON（形状与前端 `ReminderItem` / `TagItem` 一致，见 `src/types/reminder.ts`）。
- **删除用墓碑**（`deleted=1` + `updated_at`），否则"某设备删掉的会被别的设备同步回来"。
- `revision`：每次成功写入自增，放在 `meta`。

### 6.2 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | `200 {ok:true, revision, authMode}`（无需认证，不含任何敏感信息） |
| `GET` | `/api/data` | `200 {revision, reminders, tags, settings, tombstones}`；只返回未删除条目，墓碑单独列出（`[{id, updatedAt}]`） |
| `PUT` | `/api/data` | 体 `{baseRevision, reminders, tags, settings, tombstones}` → **服务端逐条合并**后落库，返回 `{revision, ...合并后的完整数据}` |
| `GET` | `/api/version` | `200 {server, schemaVersion}`（用于前端提示版本） |

- 合并规则（`src/data.ts` 里实现为**纯函数**，可单测）：
  - 提醒/标签按 `id` 对齐；两侧同 id 时取 `updatedAt` 大者；相同 `updatedAt` 时以服务端现状为准（保证幂等）；
  - 墓碑优先级高于普通条目（`updatedAt` 相同则墓碑胜出）；
  - 客户端传来的无效条目（缺 `id`/`updatedAt`、类型不符）**丢弃**并计入响应的 `rejected` 计数；
  - 合并后再把客户端**没提到的**服务端条目原样保留（不做隐式删除）。
- 请求体上限 2 MiB，超出 `413`；JSON 解析失败 `400`。
- `baseRevision` 与服务端不一致**不报错**（仍走逐条合并），但响应里带上 `serverRevisionBefore` 便于排查。

## 7. 前端改造

- 新增 `src/lib/api.ts`：`fetch` 封装（`credentials:'same-origin'`、15s 超时、统一错误类型与中文文案映射，风格与现有 `webdav.ts` 一致）。
- 存储层改为两个驱动，界面上明确显示当前模式：
  - **服务器模式**（`/api/health` 可达）：以服务器为准；本地 IndexedDB 只作**只读缓存**（键 `reminderweb:cache`，含 `revision`）；写操作先 POST 到服务器，成功后更新缓存。
  - **本地模式**（无后端 / 配置为本地）：行为与现在完全一致（纯 IndexedDB），界面上标注「本地模式」。
  - 判据：构建期 `VITE_API_BASE`（空 = 同源 `/api`）+ 运行期探测 `/api/health`；探测失败**不报错**，回落本地模式。
- 离线与失效：写操作失败时给出中文提示（不丢用户输入，允许重试）；`401` 时
  - `builtin`：弹出内置登录界面（用户名 + 口令，含显示/隐藏切换）；
  - `sso`：跳转 `/_auth/login?next=<当前路径>`（沿用仓库既有网关约定）。
- 多标签/多设备一致性：`visibilitychange` 与每 30 秒拉一次 `/api/data`（若 `revision` 未变则不重渲染）。
- 首次使用：本机有旧数据而服务器为空 → 明确提示「把本机数据上传到服务器」（一键 PUT）；服务器有数据而本机是旧缓存 → 以服务器为准并提示。
- 应用锁、备份导出/导入、PWA、主题等既有能力**全部保留**；应用锁仍只作用于本机界面（不替代服务器认证）。
- 设置里新增「服务器」分组：显示当前模式、服务器时间/版本、`revision`、「立即同步」按钮；`builtin` 模式下提供「退出登录」。

## 8. 测试

- 服务端（`node:test`，直接测纯逻辑与 HTTP 层）：
  - 口令 scrypt 往返、错误口令、`timingSafeEqual` 用法；
  - 会话：签发/校验/过期/登出后失效；Cookie 属性字符串正确；
  - 限流：连续失败达到阈值后 `429`；
  - `sso` 模式：缺头 `401`、带头 `200`；`HOST` 非回环时报错；
  - 合并纯函数：新增/更新/删除（墓碑）/同 `updatedAt` 幂等/无效条目丢弃/客户端未提及的条目保留；
  - API：未认证 `401`、`PUT` 后 `GET` 一致、`revision` 递增、超大体积 `413`、坏 JSON `400`；
  - 静态服务：`/` 返回 `index.html`、深链回退、不泄露 `server/` 与 `.env`。
- 前端：`api.ts` 的单测（mock fetch，覆盖 401/409/超时/网络错误与本地模式回落）；存储层两驱动的一致性测试。
- **现有 184 个前端测试必须继续全绿**；`npm run build`、`npm run lint` 零告警。

## 9. 文档与隐私

- `README.md` 增加「部署（后端模式）」一节：环境变量表、启动命令、systemd 与 nginx 反代要点、
  `builtin` 与 `sso` 两种认证如何选、数据目录与备份方式；并把「与安卓版的差异」表里关于存储的描述更新为"服务器为准（M7 起与 WebDAV 互通）"。
- 仓库内**不得**出现真实域名、公网 IP、真实口令、私钥；示例一律 `example.com` / `dav.example.com` / `changeme`。
- `server/data/`、`*.db`、`*.db-wal`、`*.db-shm`、`.env` 必须进 `.gitignore`。

## 10. 铁律（务必遵守）

1. 每完成一个逻辑单元就 `git commit` 一次，conventional commits，小步多次。
2. **禁止** `git push`、`git checkout -b`、`rebase`、`reset --hard`、`merge`；就在当前 `main` 分支往前走。
3. **禁止** `systemctl` / `service` / `kill` / `pkill` / `fuser -k`；**禁止**操作仓库目录之外的任何路径。
4. 所有命令都要带 `timeout`。
5. `dependencies` 保持为空；不得为后端引入任何第三方包。
6. 交付前必须运行并通过：`npm run build`、`npm test`、`npm run lint`、`npm run typecheck:server`，
   并在 `AUTH_MODE=builtin` 下用 `node server/src/index.ts` 真实起一次服务、用 `curl` 跑通
   登录 → PUT → GET → 登出 全流程（把真实命令与输出摘要写在交付说明里）。
