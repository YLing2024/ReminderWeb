# PROJECT_MEMORY

纪念日 / 倒数日管理，本地优先，数据与安卓版双向互通。前端 React + Vite 纯静态 SPA；
可选 Node 后端（`node:http` + `node:sqlite`，无 express/koa）。**不新增第三方运行时依赖。**

## 目录

- `src/` 前端：`lib/`（api、webdav、cloud-backup、android-shape 共享形状）、`components/`、`store/`。
- `server/src/` 后端：`http.ts` 路由分发、`db.ts`（meta 表等）、`config.ts`（环境变量）、
  `server-settings.ts`（服务器级持久化设置）、`sync.ts`（WebDAV 同步引擎）、`webdav.ts`（客户端）、
  `backup-format.ts`（与安卓互通的包形状）、`routes/`。
- `server/test/` `node --test`；`src/**/*.test.tsx` vitest。
- `docs/` 需求文档本地留存（`REQUIREMENTS*.md` 已被 .gitignore，禁止 `git add -f`）。

## 运行模式

- **客户端（纯静态）**：数据在浏览器（IndexedDB）；WebDAV 请求一律经本应用后端 `/api/webdav` 转发。
- **服务器**：数据在 SQLite，所有设备一致；WebDAV 由后端 `SyncEngine` 直接访问。

## 铁律 / 红线

- 备份包（导出 / 上传 metadata.json）**绝不含** `webDavServer/webDavUsername/webDavPassword/webDavPath`
  （M12 §2）。`backup-format.buildBackupData` 显式保证；现有测试守护。
- WebDAV 凭据绝不进日志、绝不进错误信息；客户端模式转发凭据只用于本次请求。
- 源码不硬编码私有域名 / 公网 IP / 凭据；示例用 `dav.example.com`、`127.0.0.1`。
- 禁止 `git push` / 建分支 / `rebase` / `reset --hard` / `merge`；小步多次 commit。

## 服务器级设置（`server/src/server-settings.ts`）

一个 `ServerSettings` 对象统一持久化到 SQLite `meta` 表，**库值 > 环境变量 > 内置默认**；
首次读取时按 env 落库（`readServerSettings`），改完立即生效，无需重启。

字段与库键：

| 字段 | 库键 | 默认 / 范围 |
| --- | --- | --- |
| relayAllowPrivate | `relayAllowPrivate` | env `WEBDAV_RELAY_ALLOW_PRIVATE`，默认关 |
| webdavEnabled | `syncConfig.enabled` | env `WEBDAV_ENABLED` |
| webdavUrl | `webdav.url` | env `WEBDAV_URL` |
| webdavUsername | `webdav.username` | env `WEBDAV_USERNAME` |
| webdavPassword | `webdav.password` | env `WEBDAV_PASSWORD`（只进库，绝不回传） |
| webdavIntervalMinutes | `syncConfig.intervalMinutes` | 1–1440 |
| webdavKeep | `syncConfig.keep` | 1–1000 |

- 自动同步开关 / 间隔 / 保留份数复用旧 `sync-config` 的库键，避免两个真值来源。
- `sync-config.ts` 现为**兼容视图**：旧 `/api/sync/config` 与 `SyncEngine.updateConfig` 仍用
  白名单 5/10/30/60、保留 1–50 的校验语义。
- 口令：PUT 时缺省 / 空串 = 不改动；`WEBDAV_PASSWORD_CLEAR`（`"__clear__"`）= 清空。
- GET / PUT `/api/webdav/config` 返回 `webdavPasswordSet` 布尔，**绝不回传明文**。
- 写设置会写审计 `action=webdav_config_update`，`detail` 只记变更字段名与 `passwordChanged`。

## WebDAV 同步引擎（`server/src/sync.ts`）

- 动作前用 `current()` 重读设置，凭据即时生效；设置改动经路由调用 `reloadSettings()` 重排定时器。
- 一次周期：PROPFIND → 比对 marker 决定是否下载 → 解密解包 → 条目级 `mergeData` →
  有变化或 pending 才上传 → 按 keep 只清理**本服务上传过**的旧包（绝不碰安卓备份）。
- 手动操作（立即同步 / 立即备份 / 恢复 / 删除）不受自动同步开关限制。
- `index.ts` 始终创建引擎（可从页面首次开启 WebDAV），关闭时不排期。

## 主要接口

- `GET/PUT /api/webdav/config`：服务器级 WebDAV 设置（需登录）。
- `GET/PUT /api/sync/config`：兼容视图（开关 / 间隔 / 份数）。
- `GET /api/sync/status`、`POST /api/sync/now|upload`、`GET /api/sync/files`、
  `POST /api/sync/restore`、`DELETE /api/sync/files/:name`。
- `GET/PUT /api/data`、`PUT /api/data/replace`、`/api/images/*`、`/api/auth/*`、`/api/health`、`/api/version`。
- `/api/webdav/*`（转发）：客户端模式经服务器访问 WebDAV，受 `relayAllowPrivate` SSRF 开关约束。

## 测试 / 命令

- `npm test`（vitest）、`npm run test:server`（node --test）、
  `npm run typecheck`（`tsc -b` + 后端 `tsc --noEmit`）、`npm run build`。
- 服务器改动的关键测试：`server/test/webdav-config.test.ts`（优先级 / 首次落库 / 部分更新 /
  口令留空不改 / 不明文 / 非法 400 中文 / 审计）、`sync-management.test.ts`（备份无凭据四字段）。

## 环境变量（后端，节选）

`HOST`(默认 127.0.0.1)、`PORT`(默认 18940)、`DATA_DIR`、`AUTH_MODE`(builtin/sso/none)、
`AUTH_USER`、`AUTH_PASSWORD`、`SERVE_STATIC`、`LOG_LEVEL`、`ALLOWED_ORIGINS`、`COOKIE_SAMESITE`、
`TRUST_PROXY`；WebDAV：`WEBDAV_ENABLED/URL/USERNAME/PASSWORD/INTERVAL_MINUTES/KEEP/ENCRYPT/
DEBOUNCE_SECONDS/TIMEOUT_SECONDS/RELAY_ALLOW_PRIVATE`（**均降为首次默认值，之后以库为准**）。

## 本次变更（M13：服务器模式 WebDAV 可编辑）

1. `server-settings.ts` 新增统一 `ServerSettings`（含 `serverSettingsView` / `parseWebdavConfigPatch` /
   `applyWebdavConfigPatch`），字段级中文校验与口令哨兵。
2. `sync.ts` 动作前重读设置 + `reloadSettings()`；`webDav()` 由设置构造客户端配置。
3. `routes/webdav-config.ts` GET/PUT 扩展字段并写审计；`routes/sync.ts` 适配兼容视图。
4. 前端 `ServerWebDavPanel` 加可编辑区（URL / 用户名 / 口令 / 开关 / 间隔 / 份数）+「保存设置」，
   口令复用 `PasswordField`（占位「已设置，留空表示不修改」），失败展示后端中文错误。
5. 测试与实测：单元 + 临时实例（端口 18941）+ 临时库 + 本地假 WebDAV，断言上传用新地址与新凭据、
   审计无口令明文。

## 注意

- `docs/` 需求文档不进库；改完更新本文件（≤200 行 / 12 KB）。
- 备份 / 恢复、安卓互通、跨域白名单等历史约束见 README 与对应测试，改动不要放松。
