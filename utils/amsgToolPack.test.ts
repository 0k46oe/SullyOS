/**
 * amsgToolPack 回归测试：构建 ↔ 解析往返、坏数据回退 null（worker 端 fire 链
 * 依赖「parse 失败 = 无工具数据继续跑」这个契约，别让它变成抛错）。
 */

import { describe, expect, it } from 'vitest';
import {
  buildToolConfig,
  buildToolPack,
  parseToolConfig,
  parseToolPack,
} from './amsgToolPack';
import type { CharacterProfile, RealtimeConfig } from '../types';

describe('buildToolPack / parseToolPack', () => {
  it('构建后 JSON 往返还原，memories 只留 date/summary/mood', () => {
    const char = {
      id: 'c1',
      name: '小鹿',
      xhsEnabled: true,
      activeMemoryMonths: ['2026-06'],
      memories: [
        { id: 'm1', date: '2026-06-12', summary: '一起看了落日', mood: 'happy' },
        { id: 'm2', date: '2026-05-01', summary: '吵了一小架' },
      ],
    } as unknown as CharacterProfile;

    const pack = buildToolPack(char);
    const parsed = parseToolPack(JSON.stringify(pack));

    expect(parsed).toEqual({
      v: 1,
      charName: '小鹿',
      xhsEnabled: true,
      activeMemoryMonths: ['2026-06'],
      memories: [
        { date: '2026-06-12', summary: '一起看了落日', mood: 'happy' },
        { date: '2026-05-01', summary: '吵了一小架' },
      ],
    });
    expect(JSON.stringify(pack)).not.toContain('"id"');
  });

  it('缺字段的角色（老档案）也能出合法 pack', () => {
    const pack = buildToolPack({ id: 'c2', name: '阿绫' } as unknown as CharacterProfile);
    expect(parseToolPack(JSON.stringify(pack))).toEqual({
      v: 1,
      charName: '阿绫',
      xhsEnabled: false,
      activeMemoryMonths: [],
      memories: [],
    });
  });

  it('坏数据一律 null：非 JSON / 形状不对 / 版本不认识', () => {
    expect(parseToolPack('not json')).toBeNull();
    expect(parseToolPack('{"v":1}')).toBeNull();
    expect(parseToolPack(JSON.stringify({ v: 2, charName: 'x', activeMemoryMonths: [], memories: [] }))).toBeNull();
  });
});

describe('buildToolConfig / parseToolConfig', () => {
  it('只收工具子集字段，空值不写键', () => {
    const rc = {
      newsEnabled: true,
      newsApiKey: 'brave-key',
      notionEnabled: true,
      notionApiKey: 'ntn-key',
      notionDatabaseId: 'db1',
      feishuEnabled: false,
      xhsMcpConfig: { enabled: true, serverUrl: 'https://xhs.example.com/api', cookie: 'ck' },
      // 非工具字段不应被带上云
      weatherEnabled: true,
      weatherCity: '上海',
    } as unknown as RealtimeConfig;

    const config = buildToolConfig(rc);
    const parsed = parseToolConfig(JSON.stringify(config));

    expect(parsed?.newsApiKey).toBe('brave-key');
    expect(parsed?.notionDatabaseId).toBe('db1');
    expect(parsed?.xhsMcpConfig).toEqual({ enabled: true, serverUrl: 'https://xhs.example.com/api', cookie: 'ck' });
    expect(typeof parsed?.proxyWorkerUrl).toBe('string');
    expect(parsed?.proxyWorkerUrl).toMatch(/^https?:\/\//);
    expect(JSON.stringify(config)).not.toContain('weather');
    // 未配置的可选键不写（省 payload，也避免 undefined 序列化怪态）
    expect('feishuAppId' in config).toBe(false);
  });

  it('无 realtimeConfig 时出全禁用配置（而不是抛错）', () => {
    const config = buildToolConfig(undefined);
    expect(config.newsEnabled).toBe(false);
    expect(config.notionEnabled).toBe(false);
    expect(config.feishuEnabled).toBe(false);
    expect(config.xhsMcpConfig).toBeUndefined();
  });

  it('坏数据一律 null', () => {
    expect(parseToolConfig('not json')).toBeNull();
    expect(parseToolConfig('{"v":1}')).toBeNull();
  });
});
