// utils/memoryPalace/roomPlateCore.test.ts
// 门牌整理上云带来的那个时间差：提示词是拿**提交那一刻**的快照拼的，LLM 说的 `U0`
// 指的是快照里的第 0 条；结果几分钟后才回来，这中间门牌可能已经被别的路径动过
// （手动回填就在本地跑）。不重新对准标签就直接合并，`U0` 会指到另一条认知上，
// 两条认知的来历（firstLearnedAt / sourceCount）被悄悄接错——而且界面上完全看不出来。
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { mergePlateEntries, remapBasedOnLabels } from './roomPlateCore';
import type { PlateEntry } from './types';

const entry = (id: string, text: string, extra: Partial<PlateEntry> = {}): PlateEntry => ({
  id,
  text,
  firstLearnedAt: 1_000,
  updatedAt: 1_000,
  sourceCount: 1,
  ...extra,
});

describe('remapBasedOnLabels — 把 basedOn 从「提交时的标签」改写成「现在的标签」', () => {
  it('门牌没动过时是恒等变换', () => {
    const current = [entry('pe_a', 'A'), entry('pe_b', 'B')];
    const items = [{ room: 'user_room', text: 'A+', basedOn: 'U1' }];
    expect(remapBasedOnLabels('user_room', items, ['pe_a', 'pe_b'], current))
      .toEqual([{ room: 'user_room', text: 'A+', basedOn: 'U1' }]);
  });

  it('提交后前面插了一条 → 标签跟着后移，指的还是同一条认知', () => {
    // 提交时：[pe_a, pe_b]，LLM 说 U1 = pe_b
    // 回来时：[pe_new, pe_a, pe_b]，pe_b 现在排第 2
    const current = [entry('pe_new', 'N'), entry('pe_a', 'A'), entry('pe_b', 'B')];
    const items = [{ room: 'user_room', text: 'B+', basedOn: 'U1' }];
    expect(remapBasedOnLabels('user_room', items, ['pe_a', 'pe_b'], current)[0].basedOn).toBe('U2');
  });

  it('快照那条已经被淘汰 → basedOn 抹成 null（当新条目收，别错认成另一条）', () => {
    const current = [entry('pe_c', 'C')];
    const items = [{ room: 'user_room', text: 'B+', basedOn: 'U1' }];
    expect(remapBasedOnLabels('user_room', items, ['pe_a', 'pe_b'], current)[0].basedOn).toBeNull();
  });

  it('标签越界 / 前缀不对 / 不是数字 → 一律抹成 null', () => {
    const current = [entry('pe_a', 'A')];
    const ids = ['pe_a'];
    const bad = [
      { room: 'user_room', text: 'x', basedOn: 'U9' },
      { room: 'user_room', text: 'x', basedOn: 'B0' },
      { room: 'user_room', text: 'x', basedOn: 'Uabc' },
    ];
    for (const item of bad) {
      expect(remapBasedOnLabels('user_room', [item], ids, current)[0].basedOn).toBeNull();
    }
  });

  it('没带 basedOn 的原样穿过去', () => {
    const items = [{ room: 'user_room', text: 'x' }, { room: 'user_room', text: 'y', basedOn: null }];
    expect(remapBasedOnLabels('user_room', items, ['pe_a'], [entry('pe_a', 'A')])).toEqual(items);
  });

  // 这条是整件事的意义所在：不重映射会怎样。
  it('回归守卫：不重映射就会把来历接到另一条认知上', () => {
    // 提交时快照：[pe_home（住家里）, pe_job（在读研）]，LLM 要更新 U0「住家里」
    const snapshotIds = ['pe_home', 'pe_job'];
    const items = [{ room: 'user_room', text: '小明搬去和同学合租', basedOn: 'U0' }];
    // 结果回来时 pe_home 已经排到第 1（前面插进来一条别的）
    const current = [
      entry('pe_new', '小明养了只猫', { firstLearnedAt: 9_000, sourceCount: 1 }),
      entry('pe_home', '小明住家里', { firstLearnedAt: 100, sourceCount: 5 }),
      entry('pe_job', '小明在读研', { firstLearnedAt: 200, sourceCount: 3 }),
    ];

    // 不重映射：U0 落到 pe_new 上 —— 「养猫」那条的来历被「搬家」这条继承走了
    const wrong = mergePlateEntries('user_room', current, items, 20_000);
    expect(wrong[0].id).toBe('pe_new');
    expect(wrong[0].firstLearnedAt).toBe(9_000);

    // 重映射之后：落在 pe_home 上，继承的是「住家里」那条的来历
    const right = mergePlateEntries(
      'user_room', current, remapBasedOnLabels('user_room', items, snapshotIds, current), 20_000,
    );
    expect(right[0].id).toBe('pe_home');
    expect(right[0].firstLearnedAt).toBe(100);
    expect(right[0].sourceCount).toBe(6);
  });
});

describe('叶子纪律', () => {
    // 这三份都会被 pnpm build:workers 打进 amsg worker bundle。import 到带浏览器依赖的
    // 模块（db / safeApi / context / activeMsgClient…）就会在 worker 里炸，而且要等真机
    // 跑到那一步才发现。靠源码扫描当场拦住：白名单里的三个自己也是零依赖叶子。
    const ALLOWED = new Set([
        './types', './jsonUtils', './roomPlateCore',
        './memoryPalace/types', './memoryPalace/roomPlateCore',
    ]);

    it.each([
        ['门牌提示词与合并', './roomPlateCore.ts'],
        ['门牌上云契约', '../amsgPlateJob.ts'],
        ['后台任务通用约定', '../amsgTaskKinds.ts'],
    ])('%s 保持环境无关', (_label, rel) => {
        const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
        const specifiers = [...src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
        expect(specifiers.filter((s) => !ALLOWED.has(s))).toEqual([]);
        // 动态引入同理，运行期才炸更难查
        expect(src.match(/\bimport\s*\(/g) ?? []).toEqual([]);
    });
});
