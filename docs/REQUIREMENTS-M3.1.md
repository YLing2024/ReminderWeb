# ReminderWeb M3.1 修正单（拿真安卓备份端到端验收时发现的缺陷）

> 复现方式（负责人已实测）：云安卓装官方 Reminder v3.4.0 → 建 1 条提醒 → 备份与恢复 → 开「备份数据加密」→ 导出为文件 → 得到 `reminder-backup-20261007-084428.zip`（464 字节，AES 加密）→ 在 Web 版 `/backup` 选择该文件 → 覆盖恢复。
> 结果：恢复阶段成功（提示「已恢复 1 条提醒、0 个标签、0 张图片」），但**首页随即白屏**，控制台 `Uncaught Error: 非法日期字符串：undefined`。

## A. 导入必须补齐缺省字段（真 bug，最高优先级）

**根因**：安卓端 `kotlinx.serialization` 默认**不序列化等于默认值的字段**（`encodeDefaults = false`），所以真实备份里的条目只有非默认字段。实测那条只有 7 个 key：

```json
{"id":1,"title":"...","date":"2026-10-07","type":"ANNUAL","isLunar":false,"tag":"","isPinned":false}
```

缺 `notes`、`notificationConfig`、`endDate`、`repeatInfo`、`cardBackgroundType`、`customFontEffect`、`customFontWeight`、`customHeaderColor`、`customFont`、`cardBackgroundColor`、`cardBackgroundImagePath`、`cardBackgroundBlurRadius`、`cardBackgroundGlassEnabled`、`cardBackgroundGlassFrosted`、`cardBackgroundGlassDensity`、`cardBackgroundTextColor`、`customFontColor`、`customFontOpacity`、`customFontBlur`、`customFontShadowEnabled`、`customFontStrokeEnabled`、`customFontStrokeColor`、`isCustomized` 等。

**要求**：
1. 导入时（以及在 IndexedDB 读取旧数据时）对每条提醒做**完整归一化**：缺字段一律补成需求书 §3 的默认值（`endDate`/`repeatInfo` → `null`；`notificationConfig` → 默认对象；数值 → 文档默认值；字符串 → `""`；布尔 → `false`；`type` 缺省 → `ANNUAL`）。
2. 标签同理（缺 `color` → `#2196F3`，缺 `sortOrder` → 0）；`settings` 已在做合并，保持。
3. **日期解析不得抛异常**：`parseLocalDate`/日期相关工具遇到 `undefined`/`null`/非法串时返回安全值或抛出可被捕获的业务错误，**绝不让异常冒泡导致整页白屏**。
4. 归一化必须是纯函数并写单测：喂上面那条 7 字段的最小对象 → 得到的对象与「全字段默认值 + 该 7 个字段」深比较相等；再用它渲染首页不得抛错。

## B. 加一层错误边界（防白屏）

任何路由级渲染异常都要落到**友好错误页**（说明发生了什么 + 「返回首页」+ 「导出当前数据」按钮），不得出现纯白屏。组件级用 React error boundary；未捕获的 promise 异常也要有兜底提示。

## C. 默认色板对齐上游

云安卓全新安装的官方版**默认是蓝色系**（`AppColorPalette` 默认 `BLUE`），而 Web 版默认给了紫色 ✗。把 `themeColorPalette` 默认值改为 `BLUE`，`DEFAULT_SETTINGS` 与首启动表现一并核对。

## D. 端到端回归（必须自己跑一遍再交付）

1. 导入随本文件提供的真实安卓加密备份（`/tmp/android-backup.zip`，**只读引用，别复制进仓库**）→ 恢复成功且首页正常渲染该条，无控制台异常。
2. 同一份文件走「明文导出 → 再导入」往返 → 字段逐个相同。
3. 手动构造缺字段/坏包（缺 `metadata.json`、非 zip、空文件）→ 均有友好报错，不白屏、不破坏已有数据。

## 铁律（同需求书 §11）

小步多次 `git commit`（conventional commits）；禁止 `git push`、建分支、`rebase`/`reset --hard`/`merge`；禁止 `systemctl`/`kill`/`pkill`；只写 `/root/proj/ReminderWeb/**`（可只读 `/tmp/Reminder-ref`、`ref-shots`、`android-backup.zip`）；命令带 `timeout`；不出现真实域名/IP/密钥。完成后运行 `npm run build`、`npm test`、`npm run lint` 并给出真实输出摘要。
