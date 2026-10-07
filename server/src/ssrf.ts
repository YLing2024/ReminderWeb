/**
 * SSRF 防护（M11 §3.1）：默认拒绝指向回环 / 内网 / 链路本地 / 云元数据地址的目标。
 *
 * 通过环境变量 `WEBDAV_RELAY_ALLOW_PRIVATE=1` 显式放开（自建内网 WebDAV 场景）。
 * 只做静态主机名 / 字面量 IP 判定，不做 DNS 解析（Node 的 fetch 自行解析，
 * 因此 DNS rebinding 不在本模块覆盖范围内，见 README 说明）。
 */

export interface TargetCheck {
  ok: boolean;
  /** 不可用原因（中文，可直接展示）。 */
  reason?: string;
}

/** 云元数据 / 特殊用途主机名黑名单。 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

/** 解析 IPv4 字面量；非 IPv4 返回 null。 */
export function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out.push(value);
  }
  return out;
}

/** 是否为应被拒绝的 IPv4（回环 / 私网 / 链路本地 / 元数据等）。 */
export function isBlockedIpv4(ip: number[]): boolean {
  const [a, b, c] = ip as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10/8, 127/8
  if (a === 169 && b === 254) return true; // 链路本地 + 169.254.169.254 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 运营商级 NAT 100.64/10
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试网
  if (a >= 224) return true; // 组播 / 保留 / 广播
  return false;
}

/** 是否为应被拒绝的 IPv6 / IPv4 映射地址。纯字面量判断。 */
export function isBlockedIpv6(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === '::1' || value === '::') return true;
  // IPv4 映射写法 ::ffff:127.0.0.1
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped !== null && mapped[1] !== undefined) {
    const ip = parseIpv4(mapped[1]);
    return ip === null ? true : isBlockedIpv4(ip);
  }
  if (value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) {
    return true; // fe80::/10 链路本地
  }
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // fc00::/7 ULA（含 AWS IMDSv2 fd00:ec2::254）
  if (value.startsWith('ff')) return true; // 组播
  return false;
}

/**
 * 校验目标地址是否允许转发。
 * - 只允许 `http` / `https`；
 * - 字面量 IP 与已知元数据主机名默认拒绝；
 * - `allowPrivate=true` 时跳过私网判定。
 */
export function checkRelayTarget(rawUrl: string, allowPrivate: boolean): TargetCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: '目标地址格式不正确' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: '目标地址只支持 http 或 https' };
  }
  if (allowPrivate) return { ok: true };

  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === '') return { ok: false, reason: '目标地址缺少主机名' };
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    return { ok: false, reason: '目标地址指向本机 / 元数据服务，默认禁止' };
  }
  const ipv4 = parseIpv4(host);
  if (ipv4 !== null) {
    return isBlockedIpv4(ipv4)
      ? { ok: false, reason: '目标地址指向回环 / 内网 / 链路本地地址，默认禁止' }
      : { ok: true };
  }
  if (host.includes(':')) {
    return isBlockedIpv6(host)
      ? { ok: false, reason: '目标地址指向回环 / 内网 / 链路本地地址，默认禁止' }
      : { ok: true };
  }
  return { ok: true };
}

/** 读环境变量：是否显式放开私网目标。 */
export function relayAllowsPrivate(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.WEBDAV_RELAY_ALLOW_PRIVATE;
  if (raw === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}
