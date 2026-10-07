import { ensureLunar } from '../lib/lunar';

/**
 * vitest 全局测试准备：农历模块改为按需加载后，依赖农历的同步函数
 * 需要先确保模块就绪，否则 `lj()` 会抛错。
 */
await ensureLunar();
