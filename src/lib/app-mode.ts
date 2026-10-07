/**
 * 运行模式判定（M10 §1）：服务器模式 / 客户端模式（纯前端）。
 *
 * 优先级从高到低：
 *   1. 运行期配置：静态根下的 `config.json`（`{ "mode": "server" | "client" }`，可选）；
 *   2. 构建期环境变量 `VITE_APP_MODE`（`server` / `client` / `auto`，默认 `auto`）；
 *   3. `auto`：探测 `GET /api/health`，通则服务器模式，不通则客户端模式。
 *
 * 特别约定：显式构建为 `client` 时视为「纯前端」硬保证，**不再读取 config.json、
 * 不探测 /api**，确保客户端模式一条 /api 请求都不发。
 */
import { probeHealth, type HealthInfo } from './api';

export type AppMode = 'server' | 'client' | 'auto';
export type ResolvedMode = 'server' | 'client';
export type ModeSource = 'config' | 'env' | 'probe';

export interface ModeDetection {
  mode: ResolvedMode;
  source: ModeSource;
  /** 探测模式下命中的健康信息；其余为 null。 */
  health: HealthInfo | null;
}

export interface DetectDeps {
  /** 注入 fetch（测试用）。 */
  fetchImpl?: typeof fetch;
  /** 覆盖构建期模式，默认读 `import.meta.env.VITE_APP_MODE`。 */
  envMode?: AppMode;
  /** 覆盖 config.json 地址，默认静态根下的 `/config.json`。 */
  configUrl?: string;
  /** 覆盖健康探测（测试用）。 */
  probe?: () => Promise<HealthInfo | null>;
}

/** 解析构建期模式；未知值一律回落 `auto`。纯函数。 */
export function parseEnvMode(raw: unknown): AppMode {
  if (raw === 'server' || raw === 'client') return raw;
  return 'auto';
}

/** 解析 config.json 内容；缺字段 / 非法值返回 null（取不到就跳过）。纯函数。 */
export function parseConfigMode(raw: unknown): ResolvedMode | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const mode = (raw as Record<string, unknown>).mode;
  if (mode === 'server' || mode === 'client') return mode;
  return null;
}

/** 纯函数：按优先级合并来源（config > env > 探测）。 */
export function resolveAppMode(input: {
  fileMode: ResolvedMode | null;
  envMode: AppMode;
  health: HealthInfo | null;
}): ResolvedMode {
  if (input.fileMode !== null) return input.fileMode;
  if (input.envMode === 'server' || input.envMode === 'client') return input.envMode;
  return input.health === null ? 'client' : 'server';
}

function configUrl(): string {
  const base = (import.meta.env.BASE_URL as string | undefined) ?? '/';
  return `${base.endsWith('/') ? base : `${base}/`}config.json`;
}

/** 读取静态根下的 config.json；缺失 / 非法一律返回 null，不抛出。 */
export async function loadConfigMode(deps: { fetchImpl?: typeof fetch; configUrl?: string } = {}): Promise<ResolvedMode | null> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  if (typeof fetchImpl !== 'function') return null;
  try {
    const response = await fetchImpl(deps.configUrl ?? configUrl(), { cache: 'no-store' });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    return parseConfigMode(data);
  } catch {
    return null;
  }
}

/**
 * 运行期判定当前模式。
 * 显式 `client`：不发任何请求；其余情况先读 config.json，再按 env / 探测回落。
 */
export async function detectAppMode(deps: DetectDeps = {}): Promise<ModeDetection> {
  const envMode = deps.envMode ?? parseEnvMode(import.meta.env.VITE_APP_MODE);
  if (envMode === 'client') return { mode: 'client', source: 'env', health: null };

  const fileMode = await loadConfigMode({ fetchImpl: deps.fetchImpl, configUrl: deps.configUrl });
  if (fileMode !== null) return { mode: fileMode, source: 'config', health: null };
  if (envMode === 'server') return { mode: 'server', source: 'env', health: null };

  const health = deps.probe !== undefined
    ? await deps.probe()
    : await probeHealth(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl });
  return { mode: health === null ? 'client' : 'server', source: 'probe', health };
}
