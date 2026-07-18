/**
 * amsg2 client_state 大值分块 — 回归测试。
 *
 * 钉住的行为：
 *  1. 装得下单条 → 原样直传（root = json、零 chunks），与历史行为字节级一致；
 *  2. 超限 → 切块后每块 utf8 字节都在服务端 200KB 限内，拼回 === 原文（零损失）；
 *  3. 切点不劈代理对（emoji 不产生孤立 surrogate，防 D1/编码层把它换成 U+FFFD）；
 *  4. 缺块 → null（调用方走冻结提示词/无工具数据兜底）；
 *  5. 老单条形态经 reassemble 原样透传；chunk meta 根条目喂给 parseFirePack →
 *     null（老 worker 兼容：读到新格式自动落兜底，链不断）。
 */

import { describe, expect, it } from 'vitest';
import {
  AMSG_STATE_CHUNK_UNITS,
  AMSG_STATE_VALUE_SAFE_BYTES,
  amsgStateChunkKey,
  buildChunkedStateEntries,
  reassembleStateValue,
  splitStateValue,
  utf8ByteLength,
} from './amsgStateChunks';
import { parseFirePack } from './amsgFirePack';

const reassembleFromList = (root: string, chunks: string[]) =>
  reassembleStateValue(root, (i) => chunks[i]);

describe('splitStateValue / reassembleStateValue', () => {
  it('装得下单条 → 原样直传，零 chunks（历史行为不变）', () => {
    const json = JSON.stringify({ v: 1, template: 'hello' });
    const { root, chunks } = splitStateValue(json);
    expect(root).toBe(json);
    expect(chunks).toHaveLength(0);
    expect(reassembleFromList(root, chunks)).toBe(json);
  });

  it('超限中文大包 → 每块都在服务端限内，拼回 === 原文（一个字不丢）', () => {
    // 40 万个中文字 ≈ 1.2MB utf8，必然分块。
    const json = JSON.stringify({ v: 1, template: '记'.repeat(400_000) });
    const { root, chunks } = splitStateValue(json);
    expect(chunks.length).toBeGreaterThan(1);
    expect(root).not.toBe(json);
    for (const piece of chunks) {
      expect(utf8ByteLength(piece)).toBeLessThanOrEqual(AMSG_STATE_VALUE_SAFE_BYTES);
    }
    expect(utf8ByteLength(root)).toBeLessThanOrEqual(AMSG_STATE_VALUE_SAFE_BYTES);
    expect(reassembleFromList(root, chunks)).toBe(json);
  });

  it('切点不劈代理对：块边界落在 emoji 中间时后挪一位', () => {
    // 让第 AMSG_STATE_CHUNK_UNITS 个 code unit 恰好是 emoji 的低位代理：
    // 前面铺 AMSG_STATE_CHUNK_UNITS - 1 个单 unit 字符，接一个 😀（2 units）。
    const raw = 'x'.repeat(AMSG_STATE_CHUNK_UNITS - 1) + '😀' + '记'.repeat(80_000);
    const { root, chunks } = splitStateValue(raw);
    expect(chunks.length).toBeGreaterThan(1);
    for (const piece of chunks) {
      // 任何一块的首尾都不能是孤立代理。
      const first = piece.charCodeAt(0);
      const last = piece.charCodeAt(piece.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    expect(reassembleFromList(root, chunks)).toBe(raw);
  });

  it('缺块 → null（兜底冻结提示词），不吐半截数据', () => {
    const json = JSON.stringify({ v: 1, template: '记'.repeat(400_000) });
    const { root, chunks } = splitStateValue(json);
    expect(reassembleStateValue(root, (i) => (i === 1 ? undefined : chunks[i]))).toBeNull();
  });

  it('老单条形态 / 非 meta JSON → 原样透传', () => {
    expect(reassembleFromList('plain', [])).toBe('plain');
    expect(reassembleFromList('{"v":1}', [])).toBe('{"v":1}');
    // 形状像但字段不对的不当 meta 处理。
    expect(reassembleFromList('{"__chunked":2,"chunks":3}', [])).toBe('{"__chunked":2,"chunks":3}');
    expect(reassembleFromList('{"__chunked":1,"chunks":0}', [])).toBe('{"__chunked":1,"chunks":0}');
  });

  it('老 worker 兼容：chunk meta 根条目喂 parseFirePack → null（自动落兜底）', () => {
    const { root } = splitStateValue(JSON.stringify({ v: 1, template: '记'.repeat(400_000) }));
    expect(parseFirePack(root)).toBeNull();
  });
});

describe('buildChunkedStateEntries', () => {
  it('小值 → 单条，key 原名', () => {
    const entries = buildChunkedStateEntries('ns', 'fire_pack', '{"a":1}', 1234);
    expect(entries).toEqual([
      { namespace: 'ns', key: 'fire_pack', value: '{"a":1}', updatedAt: 1234 },
    ]);
  });

  it('大值 → 根 meta + <key>.N 子条目，同批同 updatedAt', () => {
    const json = '记'.repeat(200_000);
    const entries = buildChunkedStateEntries('ns', 'fire_pack', json, 1234);
    expect(entries.length).toBeGreaterThan(2);
    expect(entries[0].key).toBe('fire_pack');
    expect(entries[1].key).toBe(amsgStateChunkKey('fire_pack', 0));
    expect(entries[entries.length - 1].key).toBe(amsgStateChunkKey('fire_pack', entries.length - 2));
    for (const entry of entries) {
      expect(entry.namespace).toBe('ns');
      expect(entry.updatedAt).toBe(1234);
      expect(utf8ByteLength(entry.value)).toBeLessThanOrEqual(AMSG_STATE_VALUE_SAFE_BYTES);
    }
    // 拼回验证走同一条 worker 路径。
    const chunkValues = entries.slice(1).map((e) => e.value);
    expect(reassembleStateValue(entries[0].value, (i) => chunkValues[i])).toBe(json);
  });
});
