/**
 * M11 §3.2 连接方式自动选择逻辑。
 */
import { describe, expect, it } from 'vitest';
import {
  parseTransportPreference,
  resolveWebDavTransport,
  transportExplanation,
  transportPreferenceLabel,
} from './webdav-transport';

describe('parseTransportPreference', () => {
  it('只认 proxy / direct，其余回落 auto', () => {
    expect(parseTransportPreference('proxy')).toBe('proxy');
    expect(parseTransportPreference('direct')).toBe('direct');
    expect(parseTransportPreference('auto')).toBe('auto');
    expect(parseTransportPreference(undefined)).toBe('auto');
    expect(parseTransportPreference('nope')).toBe('auto');
  });
});

describe('resolveWebDavTransport 自动选择', () => {
  it('auto：后端可达走同源代理，不可达走直连', () => {
    expect(resolveWebDavTransport('auto', true)).toBe('proxy');
    expect(resolveWebDavTransport('auto', false)).toBe('direct');
  });

  it('显式选择原样生效', () => {
    expect(resolveWebDavTransport('proxy', false)).toBe('proxy');
    expect(resolveWebDavTransport('direct', true)).toBe('direct');
  });
});

describe('展示文案', () => {
  it('说明与实际方式对应，且给人话提示', () => {
    expect(transportExplanation('proxy')).toContain('经本应用服务器转发');
    expect(transportExplanation('direct')).toContain('浏览器直连');
    expect(transportPreferenceLabel('auto')).toContain('自动');
    expect(transportPreferenceLabel('proxy')).toBe('同源代理');
    expect(transportPreferenceLabel('direct')).toBe('直连');
  });
});
