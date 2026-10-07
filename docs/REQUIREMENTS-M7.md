# ReminderWeb M7 需求书：后端与 WebDAV 双向同步（兼容安卓版备份包）

> 前置：M6 已完成后端（Node.js + SQLite，服务器为唯一真数据源）与前端改造。
> 本里程碑把 **WebDAV 互通**搬到**服务端**：后端把数据打成与安卓版完全一致的备份包推到 WebDAV，
> 也把 WebDAV 上（安卓端写的）更新拉回来逐条合并。凭据只存在于**服务端环境变量**，浏览器里不再保存 WebDAV 口令。
>
> 本文件自包含：执行者无需任何对话上下文。

## 0. 先修（M6 验收发现，必须在 M7 内一并完成）

### 0.1 安卓备份包的条目形状与内部形状不一致（会丢数据）

实测安卓版 v3.4.0 导出的 `metadata.json` 里，提醒条目**只有 7 个键**：

```
{ id, title, date, type, tag, isLunar, isPinned }     ← 没有 updatedAt / notes / repeatInfo 等
```

而内部形状（`src/types/reminder.ts`）是 `lunar` / `pinned` / `repeatInfo` / `notes` / 一堆卡片个性化字段，
合并又依赖 `updatedAt`。因此：

- **必须**把「安卓形状 ⇄ 内部形状」的映射抽成**一个共享的纯函数模块**（建议 `src/lib/android-shape.ts`），
  **前端与后端都导入同一份**（前端现有的导入逻辑若已实现，就改成调用它，不得保留两套）；
  - 字段映射：`isLunar → lunar`、`isPinned → pinned`，缺失字段按既有默认值补齐（与 `normalize.ts` 一致）；
  - `updatedAt` 缺失时**由调用方传入**：M7 用**备份文件的 `getlastmodified`** 作为该批条目的 `updatedAt`
    （同一次导入的条目用同一个值），保证合并可用且幂等；不得用 `Date.now()`（每次同步都会变，永远"有变化"）。
- 服务端的 `parseItemList` 要能接受这种缺省条目（`id` 必需；`updatedAt` 缺失由导入路径补，API 路径仍要求携带）。
- 测试：导入同一份安卓包两次 → 第二次**不得**产生新 revision 或新上传（幂等）；`isLunar/isPinned` 正确映射；
  缺省字段被补齐；中文标题与农历标记不丢。

### 0.2 缺失静态资源应 404，不应回退首页

实测 `GET /assets/不存在.js` 返回 200 + `index.html`。带扩展名的路径（`/assets/*.js|css|png…`）找不到时
应当返回 `404`，只有**无扩展名的前端路由**才回退 `index.html`（否则部署缺文件时会被静默掩盖）。补一条测试。

## 1. 数据流

```
浏览器 ⇄ 后端(唯一真数据源, SQLite) ⇄ WebDAV ⇄ 安卓版 Reminder
                     ↑
        打到 WebDAV 的包 = 安卓互通格式（zip: metadata.json + images/，可选加密）
```

## 2. 环境变量（`.env.example` 补全并注释；`WEBDAV_*` 由 M6 的占位改为启用）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WEBDAV_ENABLED` | `0` | 关闭时全部同步逻辑不启动，`/api/sync/status` 返回 `{enabled:false}` |
| `WEBDAV_URL` | 空 | 目录地址，例 `https://dav.example.com/reminder/`（结尾斜杠会自动补齐） |
| `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` | 空 | Basic 认证凭据；**只从环境变量读**，绝不返回给前端、绝不写日志 |
| `WEBDAV_INTERVAL_MINUTES` | `10` | 定时轮询远端（下限 1） |
| `WEBDAV_DEBOUNCE_SECONDS` | `60` | 本机数据变动后的延迟上传（合并节流） |
| `WEBDAV_ENCRYPT` | `1` | 上传的包是否加密（与安卓端「备份数据加密」一致，安卓两种都能读） |
| `WEBDAV_KEEP` | `10` | 仅保留最近 N 份**由本服务上传**的备份 |
| `WEBDAV_TIMEOUT_SECONDS` | `20` | 单次 HTTP 请求超时 |

启动时若 `WEBDAV_ENABLED=1` 但 `WEBDAV_URL` 为空 → 启动失败并说明原因。

## 3. 备份包格式（必须与前端既有实现、以及安卓版一致）

- 文件名：`reminder-backup-yyyyMMdd-HHmmss.zip`（**不得**改命名）。
- 内容：`metadata.json`（`BackupData` 形状，见 `src/types/reminder.ts`）+ 有图片时的 `images/`。
- 加密（`WEBDAV_ENCRYPT=1`）：AES-256-CBC + PKCS7，密钥 = `SHA-256(固定常量逐字节 XOR 90)`，
  密文布局 `[16 字节 IV][密文]`。常量与前端 `src/lib/*` 中的实现**必须逐字节一致**：
  在服务端测试里导入前端那份常量并断言相等（防止两边漂移）。
- 生成与解析都写为**纯函数**并单测：同数据两次打包，解出来后 `metadata.json` 深相等。

## 4. 同步语义

- 一次同步周期：
  1. `PROPFIND` 目录（`Depth: 1`）取 `reminder-backup-*.zip` 列表与 `getlastmodified`；
  2. 选**最新**的一份（若与上次已处理的一致，则跳过下载：用 `etag`/`getlastmodified` + 文件名记在 `meta` 表里）；
  3. 下载 → 解密 → 解 zip → 解析 `metadata.json`；
  4. 与库内数据走**同一份条目级合并纯函数**（M6 的 `mergeData`，按 `updatedAt` + 墓碑），
     得到合并结果与 `changed` 标记；
  5. 若合并带来变化 → 落库 + `revision++`；**无论是否有变化**，若距上次上传超过 `WEBDAV_DEBOUNCE_SECONDS`
     或本次有变化 → 上传一份新包（避免"每 10 分钟都传一份一模一样的东西"）；
  6. 按 `WEBDAV_KEEP` 清理**本服务上传过的**旧包（从 `meta` 里记录的名单中删；**绝不删不是自己传的文件**，
     以免误删安卓端的历史备份）。
- 本机数据变更（任一次 `PUT /api/data` 或合并后落库）→ 触发一次 `WEBDAV_DEBOUNCE_SECONDS` 的延迟上传（合并窗口内的多次变更只传一次）。
- 单实例假设：同步任务在进程内串行（同一时刻只允许一个同步周期），避免自相覆盖。
- 失败处理：任何异常都**不致命** —— 记日志（脱敏）、把结果写进状态表、下个周期继续；连续失败指数退避（上限 `WEBDAV_INTERVAL_MINUTES` 的 4 倍）。

## 5. 接口与界面

- `GET /api/sync/status`（需认证）→
  `{enabled, url, lastSyncAt, lastUploadAt, lastResult: 'ok'|'error', lastError: <脱敏后的中文短句>, pendingChanges, remoteFiles: [{name, modifiedAt}]}`
  —— **不得**包含用户名/口令/服务器上的其它文件信息。
- `POST /api/sync/now`（需认证）→ 立即执行一次同步周期，返回与上面同构的状态；同一时刻重复调用返回 `409`。
- 前端「WebDAV 云备份」分组改为**只读状态 + 操作**：
  - 不再显示服务器地址/用户名/口令输入框（凭据在服务端）；
  - 显示：是否启用、上次同步时间、上次结果（失败原因用中文）、远端备份列表（时间倒序）、「立即同步」按钮、同步进行中的 pending 态；
  - 旧版本存在浏览器里的 `webdavServer/webdavUsername/webdavPassword` 字段：读取时**清除**（迁移函数 + 测试），
    界面上给一句「凭据已迁移到服务器端配置」的提示（文案克制，无技术黑话）。
- 「导出为文件 / 从文件恢复」保持可用（本地手动路径，与云端互不影响）。

## 6. 测试（`node:test`）

- WebDAV 客户端纯逻辑（stub `fetch`）：URL 规范化、Basic 头（含中文口令）、PROPFIND 解析（空目录/无关文件/非 zip/无命名空间前缀）、
  401/403/404/405/超时/网络错误 → 中文文案映射、`PUT`/`GET`/`DELETE` 方法正确。
- 同步周期：用**内存假 WebDAV 服务**跑端到端 —— 空远端（应上传一份）→ 远端出现安卓写的新包（应拉回并合并）→
  远端无变化（**不应**重复上传）→ 远端包损坏（记错误但服务继续可用）→ 清理只删自己传的文件（远端别的文件必须还在）。
- 加密互通：断言服务端密钥常量与前端常量逐字节一致；断言服务端产出的包能被前端既有解密函数解开（导入前端纯函数做交叉测试），
  反之亦然。
- 既有前端 184+ 测试与 M6 服务端测试必须继续全绿；`npm run build`、`npm run lint`、`npm run typecheck:server` 零告警。

## 7. 文档

- `README.md`：
  - 「部署（后端模式）」补 WebDAV 同步一节：环境变量、与安卓版如何共用同一个 WebDAV 目录、加密开关、保留份数与清理策略；
  - 「与安卓版的差异」表里云备份那行改为：**服务端与 WebDAV 双向同步（安卓端仍走 WebDAV 备份包，两边数据互通）**；
  - 「备份格式（与安卓互通）」补一句：同一目录可同时被安卓版与本服务使用。

## 8. 铁律（务必遵守）

1. 每完成一个逻辑单元就 `git commit` 一次，conventional commits，小步多次。
2. **禁止** `git push`、建分支、`rebase`、`reset --hard`、`merge`；就在 `main` 往前走。
3. **禁止** `systemctl` / `service` / `kill` / `pkill`；**禁止**操作仓库目录之外的任何路径。
4. 命令一律带 `timeout`。
5. 不引入任何第三方依赖（后端继续零依赖）。
6. 真实 WebDAV 凭据只能从环境变量读；仓库、日志、响应、测试夹具里**不得**出现真实地址与凭据（测试用 `https://dav.example.com/reminder/`）。
