import { describe, expect, it } from 'vitest';
import { hashPin, isValidPin, verifyPin } from './pin';

describe('isValidPin', () => {
  it('接受 4–6 位数字', () => {
    expect(isValidPin('1234')).toBe(true);
    expect(isValidPin('123456')).toBe(true);
  });

  it('拒绝过短、过长与非数字', () => {
    expect(isValidPin('123')).toBe(false);
    expect(isValidPin('1234567')).toBe(false);
    expect(isValidPin('12a4')).toBe(false);
    expect(isValidPin('')).toBe(false);
  });
});

describe('hashPin / verifyPin', () => {
  it('摘要稳定且为 64 位十六进制', async () => {
    const hash = await hashPin('1234');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashPin('1234')).toBe(hash);
  });

  it('不同 PIN 摘要不同', async () => {
    expect(await hashPin('1234')).not.toBe(await hashPin('1235'));
  });

  it('verifyPin 仅在匹配时为真', async () => {
    const hash = await hashPin('987654');
    expect(await verifyPin('987654', hash)).toBe(true);
    expect(await verifyPin('000000', hash)).toBe(false);
  });
});
