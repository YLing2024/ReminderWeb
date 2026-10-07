# ReminderWeb 需求书

> 本文件是**唯一权威规格**。执行体看不到本需求之外任何对话；本文件自包含，遇到与仓库现实冲突时以仓库现实为准，直接实现、不提问。

---

## 0. 交付物

- 仓库：`ReminderWeb`（已在 `github.com/YLing2024/ReminderWeb`，本地 `/root/proj/ReminderWeb`）。
- 目标：把安卓应用 **Reminder**（纪念日 / 倒数日管理）做成**响应式 Web 应用**：视觉风格一致、行为语义一致、**数据与安卓版双向互通**。
- 许可：**GPL-3.0**（上游为 GPL-3.0 衍生，仓库内 `LICENSE` 已就位，不得更换、不得删除）。

## 1. 上游参照（只读，别改）

上游仓库已克隆到本机：**`/tmp/Reminder-ref`**（`github.com/ybhgl/Reminder` 的 main 快照，Kotlin + Jetpack Compose，Material 3）。
截图基准：**`/tmp/ref-shots/*.jpg`**（`home / edit / settings / custom / share / tag / search / backup`）。

- 你**可以只读**上面的 Kotlin 源码与截图目录，用来对齐视觉与计算语义（截图可用系统看图工具打开）。
- 你**不允许写入**这两个目录之外的任何路径（见 §11 铁律）。
- 语义与视觉必须"照着复刻"，但**用 TypeScript 重新实现**：不要整段翻译 Kotlin，也不要拷贝其代码文本。

关键参照文件（计算与数据的真源）：

| 关注点 | 上游文件 |
| --- | --- |
| 数据模型 / 备份结构 | `app/src/main/java/com/ybhgl/reminder/data/ReminderItem.kt`、`TagItem.kt` |
| 天数、目标日、周期、区间语义 | `.../util/CalendarUtil.kt`（`calculateNextTargetDate`、`calculateCurrentPeriodStart`、`calculateNextKeyDate`、`resolveIntervalStage`、农历格式化） |
| 生日（农历/生肖/星座/年龄） | `.../util/BirthdayCalculator.kt` |
| 排序 | `.../util/ReminderSortHelper.kt` |
| 备份归档格式 | `.../util/BackupArchiveManager.kt`、`BackupEncryptor.kt`、`data/BackupDataBuilder.kt` |
| 主题与观感设置 | `.../data/ThemePreferences.kt`、`ViewModePreferences.kt`、`ui/theme/*.kt` |
| 各屏实现（结构/文案/交互） | `.../ui/**`：`list/`、`add/`、`detail/`、`tag/`、`settings/`、`share/`、`calculator/` |

## 2. 技术选型（钉死，不要替换）

- 构建：**Vite** + **React 19** + **TypeScript（strict）**，包管理 `npm`。
- 路由：`react-router-dom`（`BrowserRouter`）。
- 状态：`zustand`（不引 Redux/MobX）。
- 持久化：**IndexedDB**（`idb-keyval`）：结构化数据 + 图片 Blob；启动时载入内存。
- 农历：`lunar-javascript`（6tail，MIT；与安卓端 `tyme4kt` 同源生态）。
- 主题色生成：`@material/material-color-utilities`（种子色 → 完整 M3 明暗色板，对齐安卓端动态取色）。
- 打包/解压：`fflate`（备份 zip 读写）。
- PWA：`vite-plugin-pwa`。
- 样式：**CSS 变量 + CSS Modules**（不引 Tailwind / MUI / antd / styled-components）。
- 测试：`vitest`（计算规则、备份往返必须有单测）。
- 图标：**内联 SVG 组件**或自托管图标字体（不许运行时依赖外部 CDN）。
- 禁止：任何后端服务、数据库、账号体系；本应用是**纯静态、本地优先**的 SPA。

## 3. 数据模型（与安卓 JSON 字段名逐字对齐）

文件 `src/types/reminder.ts`。字段名即备份 JSON 的 key，**大小写与拼写不得改动**。

```ts
export type ReminderType = 'ANNUAL' | 'COUNT_UP' | 'BIRTHDAY';
export type RepeatUnit = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
export type ReminderMethod = 'APP_NOTIFICATION' | 'SYSTEM_CALENDAR' | 'BOTH';

export interface NotificationTime { daysBefore: number; time: string; } // time: "HH:mm:ss"
export interface ReminderNotificationConfig {
  isEnabled: boolean; useAppNotification: boolean; useSystemCalendar: boolean;
  isContinuous: boolean; includeStartDay: boolean; notificationTimes: NotificationTime[];
}
export interface RepeatInfo { interval: number; unit: RepeatUnit; endDate: string | null; } // "YYYY-MM-DD"

export interface ReminderItem {
  id: number; title: string; date: string; endDate: string | null;
  type: ReminderType; isLunar: boolean; tag: string; isPinned: boolean;
  repeatInfo: RepeatInfo | null; notificationConfig: ReminderNotificationConfig;
  notes: string; isCustomized: boolean;
  customHeaderColor: string; customFont: string;
  cardBackgroundType: string;            // "DEFAULT" | "IMAGE" | "COLOR"
  cardBackgroundColor: string; cardBackgroundImagePath: string;
  cardBackgroundBlurRadius: number; cardBackgroundGlassEnabled: boolean;
  cardBackgroundGlassFrosted: boolean; cardBackgroundGlassDensity: number;
  cardBackgroundTextColor: string;       // "" | "WHITE" | "BLACK"
  customFontEffect: string;              // "AUTO" | "SOLID" | "MIXED"
  customFontColor: string; customFontOpacity: number; customFontBlur: number;
  customFontWeight: number; customFontShadowEnabled: boolean; customFontStrokeEnabled: boolean;
  customFontStrokeColor: string;
}
```
（安卓结构体里还有一批「液态玻璃/光栅玻璃」几何参数，纯属 AGSL 着色器效果 → 见 §8，**Web 端不实现**，但导入备份时必须**原样保留**这些字段，导出时原值写回，避免来回丢数据。）

```ts
export interface TagItem { id: number; name: string; color: string; sortOrder: number; } // color: "#2196F3"

export interface BackupData {
  reminders: ReminderItem[]; tags: TagItem[] | null;
  themeOption: 'SYSTEM' | 'LIGHT' | 'DARK' | null; pureBlackEnabled: boolean | null;
  cardColoringEnabled: boolean | null; defaultPage: 'COUNTDOWN' | 'COUNTUP' | 'BIRTHDAY' | null;
  viewMode: string | null; backupReminderEnabled: boolean | null;
  webDavServer: string | null; webDavUsername: string | null; webDavPassword: string | null; webDavPath: string | null;
  dynamicColorEnabled: boolean | null;
  themeColorPalette: 'BLUE'|'GREEN'|'YELLOW'|'ORANGE'|'PURPLE'|'PINK'|'CYAN'|'MONOCHROME' | null;
  customColorSeed: number | null; scrollBehavior: string | null; homeCategoryEnabled: boolean | null;
  cardBackgroundImages: Record<string, string> | null; // 文件名 -> base64
}
```

存放约定：结构化数据一份 JSON 存 IndexedDB（key `reminderweb:data`），图片按**文件名**存 IndexedDB（key `reminderweb:image:<name>`）——与安卓 zip 内 `images/<name>` 的引用关系保持一致，保证互导不会丢图。

## 4. 计算语义（必须与安卓一致，逐条写单测）

以 §1 的上游文件为准，**不得凭直觉简化**。至少要覆盖：

1. **倒数日（ANNUAL）**：目标日；今天 = 「今天」；未来 = 「还有 N 天」；过去（非重复）= 「已过 N 天」。
2. **正数日（COUNT_UP）**：从起始日累计，标签形如「第 N 天」（含/不含当天以上游实现为准）。
3. **生日（BIRTHDAY）**：下一次生日（公历与农历两种口径）、生成年龄、生肖、星座；农历生日要按农历月日匹配到今年/明年；2 月 29 日、农历闰月等边界要有测试。
4. **区间事件**（`endDate` 非空，仅倒数日）：**结束日当天仍属"进行中"，次日才算"已过"**。
5. **重复**（`repeatInfo`）：按 `interval × unit` 推进，`endDate` 截止；计算"当前周期起点"与"下一次目标日"要与上游一致。
6. **`resolveIntervalStage` 的等价物**：返回（阶段标签, 天数, 对应日期），首页卡片顶部小标题用的就是它（如「还有」「今天」「已过」「第」）。
7. **排序**：置顶优先 → 分组内以上游 `ReminderSortHelper` 的规则排序（未到期在前、按日期等）。
8. 全部计算函数都要支持**注入"今天"**（不要直接读系统时钟），否则无法测试。

## 5. 功能清单（逐屏，可验收）

### 5.1 首页
- 顶栏：**手写体「Reminder」字标**（自托管开源手写体，SIL OFL，例如 Great Vibes / Dancing Script；拿不到字体文件时退化为衬线斜体）+ 右侧「搜索」「设置」图标按钮；顶栏无背景色块，浮在页面底色上。
- **分组区**：胶囊行（大圆角、浅色调填充）；左侧 36px 圆形图标徽章（置顶=粉色图钉 / 标签=该标签颜色 / 无标签=灰色），中间分组名（加粗），右侧**数目胶囊**（浅紫底 + 紫色数字）+ 展开/收起箭头。分组包含：置顶、各标签（按 `sortOrder`）、无标签。
- **卡片网格**：手机 2 列，宽屏自动增列（见 §6）。每张卡片 = 顶部色带（高约 44px，颜色取标签色，白色小字 =「分组名 + 阶段标签」，如「置顶 还有」「事件 生日就是」）+ 卡片主体（超大数字 + 右侧小号「天」；自定义背景/字体效果生效）+ 底部日期带（`YYYY-MM-DD 星期X`，居中、小号）。整卡大圆角 + 轻阴影。
- 右下 FAB「+」新增；左下 FAB 切换**卡片 / 列表**两种布局。
- **底部导航**：倒数日 / 正数日 / 生日（可被设置里的「首页分类显示」关闭 → 改为全部混排一页）；**滚动时自动收起**（`ScrollBehaviorMode`）。
- 空状态：居中插画式提示 + 「新增提醒」按钮。
- 支持长按/右键卡片 → 置顶、编辑、删除的快捷菜单。

### 5.2 新增 / 编辑
按截图顺序与样式：标题输入框 → 日期（浮标标签，支持**公历 / 农历**切换与今天快捷）→ 置顶开关 → 类型单选（倒数日 / 正数日 / 生日）→ 个性化开关（带副标题「定制卡片颜色、字体和背景」）→ 标签输入（可新建）→ 重复（右侧显示当前值，点开选 `interval + unit + endDate`）→ 提醒设置（右侧显示「未开启」或 N 条；点开：启用开关、提前 N 天 + 时刻、多条、连续提醒、包含当天）→ 备注（点开多行输入）。区间事件（`endDate`）在倒数日下可选。顶栏：返回箭头 + 标题（新增提醒 / 编辑提醒）+ 保存图标。

### 5.3 详情
大卡片（与首页同款观感，尺寸更大）+ 点击卡片**翻面**查看备注 + 顶栏操作：编辑、置顶、删除（二次确认）、分享成图片。

### 5.4 搜索
搜索框（标题 / 备注 / 标签，即时过滤）+ 高级筛选（类型、标签、时间范围）+ 结果用列表布局展示，空结果有提示。

### 5.5 标签管理
列表：色点 + 名称 + 条目数；新增、改名、改色（取色盘 + 自定义 hex）、删除（二次确认，提示该标签下事件会变为「无标签」）、上下移动调整 `sortOrder`。

### 5.6 设置（分组卡样式：分组小标题 + 细分隔线 + tonal 圆角分组卡）
- **外观**：主题三态分段控件（自动 / 浅色 / 深色）；纯黑模式（副标题「深色模式下对 AMOLED 屏幕更省电」）；卡片着色；动态取色（Web 端说明：改为「跟随种子色」，因浏览器取不到系统壁纸）；**种子色**：8 个预置圆色点（蓝色 / 绿色 / 黄色 / 橙色 / 紫色 / 粉色 / 青色 / 单色，选中打勾）+ 自定义取色（`customColorSeed`）。
- **首页**：首页分类显示（开关，副标题同上游文案）、默认起始页面（倒数日 / 正数日 / 生日）、视图模式、滚动收起策略。
- **提醒**：通知开关（Web Notification 权限申请引导）、默认提前天数、提醒方式（应用内通知；「系统日历」在 Web 端替换为 **导出 .ics**）。
- **数据**：备份与恢复入口、上次备份时间 + 备份提醒（「已 N 天未备份」）、清空数据（二次确认，输入确认词）。
- **安全**：应用锁（PIN 码 4–6 位，开启后离开页面再回来需解锁）。
- **关于**：版本号、开源许可（列出上游 Reminder、lentikr/Reminder、lunar-javascript、material-color-utilities、fflate、Vite/React 的许可）、前往仓库链接。

### 5.7 日期计算器
保留上游的计算器页（两个日期相差多少天 / 目标日推算 / 农历换算）。

### 5.8 分享成图片
用 Canvas 绘制与卡片**完全同款**的图像（含自定义背景图 / 颜色、字体颜色与效果），导出 PNG（下载 + 可复制到剪贴板）；宽高比与上游卡片一致的方形输出。

### 5.9 备份与恢复（重点，见 §7）

## 6. 视觉规范与响应式

### 6.1 设计令牌（`src/styles/tokens.css`）
- 主色：M3 基线紫 `#6750A4`（浅色主题 primary）；深色主题按 M3 基线深色色板；种子色变化时整板由 `material-color-utilities` 重新生成，**所有颜色只允许通过 `--md-sys-color-*` 变量使用**，不许散落硬编码色值。
- 页面底色：浅色 `#F7F5FA` 附近（略带紫调）；分组卡 / 胶囊填充 = 主色的低透明度叠层（对比截图）。
- 圆角：卡片 20–24px、分组胶囊行 20px、分组卡 24px、输入框 8px、按钮 pill。
- 阴影：卡片 `0 1px 2px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.06)`（克制，别重）。
- 字号：卡片数字 `clamp(40px, 16vw, 64px)` 级超大 + 字重 700；卡片顶部/底部小字 12–13px；分组名 17px/600；页面标题 22–26px；设置项标题 17px、副标题 13px 灰。
- 间距：页面左右 16px（宽屏 24px），区块间 20–24px。

### 6.2 断点（三档，均须真正可用）
| 宽度 | 导航 | 卡片网格 | 其它 |
| --- | --- | --- | --- |
| `< 600px` | 底部导航（滚动收起） | 2 列 | FAB 右下 / 左下；弹层全屏或底部抽屉 |
| `600–1024px` | 左侧**导航轨**（图标） | 3 列 | 内容居中，最大宽 900px |
| `> 1024px` | 左侧**侧栏**（图标 + 文字） | 4–5 列自适应 | 内容最大宽 1200px 居中；hover 态、右键菜单 |

- 窄屏**绝不隐藏导航**；卡片尺寸随列宽自适应、数字不溢出、超长标题省略。
- 触摸与鼠标都要能操作：可点尺寸 ≥ 44px，长按 = 右键菜单，弹层在手机上从底部升起。

## 7. 备份与安卓互通（硬指标）

### 7.1 归档格式（与安卓一致）
- `.zip`，内含 **`metadata.json`**（`BackupData` 结构）+ **`images/`**（被引用的卡背景图片，文件名与 `cardBackgroundImagePath` 一致）+ `fonts/`（可选）。
- **加密包**：整个 zip 再做 AES：`ALGORITHM = AES/CBC/PKCS5Padding`，密钥 = `SHA-256(seedBytes)`，`seedBytes[i] = obfuscated[i] XOR 90`，`obfuscated` 为上游 `util/BackupEncryptor.kt` 里的 40 字节常量（**照抄该常量，保证能解开安卓端加密备份**）；密文布局 = `[16 字节 IV][密文]`（无分隔符、无 Base64）。
- Web 用 `crypto.subtle`（`AES-CBC`）实现同样的加解密；导出时提供「加密（兼容安卓）」开关。

### 7.2 必须全部通过
1. 导入安卓的**未加密** `.zip` → 条目、标签、主题设置、图片全部正确还原。
2. 导入安卓的**加密** `.zip` → 同上。
3. Web 导出 `.zip` → 结构被安卓接受（`metadata.json` 字段名与类型一致、图片在 `images/` 下）。
4. 导出后**再导入**（往返）→ 条目数、字段逐个相同（单测断言深比较，只允许 `id` 因重新分配而不同时给出映射说明）。
5. 未知字段（如液态玻璃参数）导入→导出**不丢失**。
6. 备份文件名形如 `Reminder_Backup_YYYYMMDD_HHMMSS.zip`（与上游一致，具体以上游实现为准）。
7. 坏包 / 缺 `metadata.json` → 友好报错，不白屏、不写坏数据。

## 8. 与安卓版的差异（README 里必须写明，不要尝试硬做）

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

## 9. 质量要求

- TypeScript strict，`npm run build` 零错误；`npm run lint` 零 error；`npm test` 全绿。
- 计算规则与备份往返的单测是**硬要求**（至少 40 个断言）。
- 无 `any` 滥用的关键路径；无 `console.log` 残留在生产代码。
- 首屏 ≤ 200KB gzip（不含字体与图标子集），Lighthouse 性能 ≥ 90（本地构建产物自测，可离线）。
- 全部界面文案中文，语气克制，不用 emoji（上游界面本身有 emoji 图标的地方用 SVG 图标替代）。

## 10. 分期（按顺序做，每期结束都能跑）

- **M1**：工程骨架 + 数据层（IndexedDB + store）+ 计算语义 + 首页 + 新增/编辑 + 详情 + 单测。
- **M2**：搜索 + 标签管理 + 设置全量（主题/纯黑/种子色/视图模式/滚动收起）+ 日期计算器。
- **M3**：备份导入导出（§7 全部）+ 分享成图片 + PWA（离线 + 可安装）+ 通知 + PIN 锁 + README。

## 11. 铁律（违反即返工）

1. **每完成一个逻辑单元就 `git commit` 一次**，用 conventional commits（`feat:`/`fix:`/`test:`/`docs:`/`chore:`），小步多次。
2. **禁止 `git push`**、禁止 `git checkout -b` 建分支、禁止 `rebase` / `reset --hard` / `merge`；就在当前 `main` 往前走。
3. **禁止 `systemctl` / `service` / `kill` / `pkill` / `fuser -k`**（不要碰系统服务与别人的进程）。
4. 只允许写入 `/root/proj/ReminderWeb/**`；**只读** `/tmp/Reminder-ref/**` 与 `/tmp/ref-shots/**`；其它路径一律不碰。
5. 所有命令都带 `timeout`；不要起长驻进程（不要 `npm run dev` 常开）。
6. 仓库内**不得出现真实私有域名、公网 IP、密钥、个人邮箱**；示例一律用 `reminder.example.com`、`127.0.0.1`。
7. 不新增需求外的功能与页面；不引入需求外的重型依赖。
8. 交付时输出：改动清单、提交列表、`npm run build` / `npm test` / `npm run lint` 的**真实输出摘要**、以及尚存限制（不许编造输出）。
