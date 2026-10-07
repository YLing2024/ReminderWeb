/**
 * 应用锁 PIN：4–6 位数字，仅存 SHA-256 摘要，不落明文。
 * crypto.subtle 仅在安全上下文可用（本地开发与 HTTPS 部署均可）。
 */

export function isValidPin(pin: string): boolean {
  return /^\d{4,6}$/.test(pin);
}

export async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(`reminderweb-pin:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return (await hashPin(pin)) === hash;
}
