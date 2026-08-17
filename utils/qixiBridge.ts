import { APIConfig, CharacterProfile, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { QixiJourneyBeat } from './qixiReunion';
import { QixiMemoryBundle } from './qixiMemoryBundle';
import { safeFetchJson } from './safeApi';
import { parseQixiJsonObject } from './qixiJson';

export type QixiMagpieOwner = 'user' | 'char';

export interface QixiMagpie {
    id: string;
    evidenceId: string | null;
    name: string;
    memory: string;
    visualHint: string;
    owner: QixiMagpieOwner;
}

export type QixiBridgeNode = QixiMagpie;

export interface QixiFinalMagpie {
    name: string;
    line: string;
    visualHint: string;
}

export interface QixiBridgeBundle {
    source: 'generated' | 'fallback';
    userMagpies: QixiMagpie[];
    charMagpies: QixiMagpie[];
    finalMagpie: QixiFinalMagpie;
    /** Combined list retained for old replay/card readers. */
    nodes: QixiMagpie[];
}

const compact = (value: unknown, max: number): string => typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, max)
    : '';

const makeMagpie = (
    evidence: QixiMemoryBundle['evidence'][number],
    memoryBundle: QixiMemoryBundle,
    owner: QixiMagpieOwner,
    index: number,
): QixiMagpie => {
    const artifact = memoryBundle.artifacts.find(item => item.evidenceIds.includes(evidence.id));
    return {
        id: `${owner}-magpie-${index + 1}`,
        evidenceId: evidence.id,
        name: artifact?.label || evidence.object || `记忆 ${index + 1}`,
        memory: evidence.fact,
        visualHint: artifact?.kind || '一小段发光文字',
        owner,
    };
};

export function createQixiBridgeFallback(memoryBundle: QixiMemoryBundle, userName = 'User'): QixiBridgeBundle {
    const usable = memoryBundle.evidence.slice(0, 8);
    const userEvidence = usable.filter((_, index) => index % 2 === 0);
    const charEvidence = usable.filter((_, index) => index % 2 === 1);
    if (!charEvidence.length && userEvidence.length > 1) charEvidence.push(userEvidence.pop()!);
    const userMagpies = userEvidence.map((item, index) => makeMagpie(item, memoryBundle, 'user', index));
    const charMagpies = charEvidence.map((item, index) => makeMagpie(item, memoryBundle, 'char', index));
    return {
        source: 'fallback',
        userMagpies,
        charMagpies,
        finalMagpie: { name: userName, line: '一直在找的那个。', visualHint: '对岸最后亮起的名字' },
        nodes: [...userMagpies, ...charMagpies],
    };
}

export function normalizeQixiBridgeBundle(
    value: QixiBridgeBundle | undefined,
    memoryBundle: QixiMemoryBundle,
    userName: string,
): QixiBridgeBundle {
    if (value?.userMagpies?.length && value?.charMagpies?.length && value.finalMagpie) return value;
    const legacy = (value as any)?.nodes;
    if (Array.isArray(legacy) && legacy.length) {
        const migrated = legacy.map((node: any, index: number): QixiMagpie => ({
            id: compact(node.id, 40) || `legacy-magpie-${index + 1}`,
            evidenceId: compact(node.evidenceId, 32) || null,
            name: compact(node.name, 48) || compact(node.artifactLabel, 48) || `记忆 ${index + 1}`,
            memory: compact(node.memory, 120) || compact(node.memoryLine, 120),
            visualHint: compact(node.visualHint, 48) || compact(node.artifactLabel, 48) || '发光文字',
            owner: index % 2 === 0 ? 'user' : 'char',
        }));
        const userMagpies = migrated.filter(item => item.owner === 'user');
        const charMagpies = migrated.filter(item => item.owner === 'char');
        return {
            source: value?.source || 'fallback',
            userMagpies: userMagpies.length ? userMagpies : migrated.slice(0, 1),
            charMagpies: charMagpies.length ? charMagpies : migrated.slice(1, 2),
            finalMagpie: { name: userName, line: '这次不会认错。', visualHint: '对岸最后亮起的名字' },
            nodes: migrated,
        };
    }
    return createQixiBridgeFallback(memoryBundle, userName);
}

export function parseQixiBridge(raw: string, memoryBundle: QixiMemoryBundle, userName = 'User'): QixiBridgeBundle | null {
    const parsed = parseQixiJsonObject(raw, ['userMagpies', 'charMagpies']);
    if (!parsed || !Array.isArray(parsed.userMagpies) || !Array.isArray(parsed.charMagpies)) return null;
    const evidenceIds = new Set(memoryBundle.evidence.map(item => item.id));
    const parseSide = (items: any[], owner: QixiMagpieOwner): QixiMagpie[] => {
        const seen = new Set<string>();
        return items.slice(0, 6).map((item, index): QixiMagpie => ({
            id: `${owner}-magpie-${index + 1}`,
            evidenceId: compact(item?.evidenceId, 32) || null,
            name: compact(item?.name, 48),
            memory: compact(item?.memory, 120),
            visualHint: compact(item?.visualHint, 48),
            owner,
        })).filter(item => {
            if (!item.evidenceId || !evidenceIds.has(item.evidenceId) || seen.has(item.evidenceId)) return false;
            if (!item.name || item.memory.length < 4 || !item.visualHint) return false;
            seen.add(item.evidenceId);
            return true;
        });
    };
    const userMagpies = parseSide(parsed.userMagpies, 'user');
    const charMagpies = parseSide(parsed.charMagpies, 'char');
    if (!userMagpies.length || !charMagpies.length) return null;
    const rawFinalMagpie = parsed.finalMagpie && typeof parsed.finalMagpie === 'object' && !Array.isArray(parsed.finalMagpie)
        ? parsed.finalMagpie as Record<string, unknown>
        : null;
    const finalLine = compact(rawFinalMagpie?.line, 80);
    if (!finalLine) return null;
    return {
        source: 'generated',
        userMagpies,
        charMagpies,
        finalMagpie: {
            name: userName,
            line: finalLine,
            visualHint: compact(rawFinalMagpie?.visualHint, 48) || '从对岸飞来的名字',
        },
        nodes: [...userMagpies, ...charMagpies],
    };
}

export function buildQixiBridgePrompt(memoryBundle: QixiMemoryBundle, journey: QixiJourneyBeat[], userName: string): string {
    const evidence = memoryBundle.evidence.map(item => `${item.id}｜${item.object}｜${item.fact}`).join('\n');
    const visited = journey.map(item => `${item.sceneName}｜共享内容：${item.sharedObject}｜Char 的另一层操作：${item.charAction}`).join('\n');
    return `### 七夕活动 Part 2：生成记忆鹊

这是探索结束后、最终见到 Char 之前的最后一段互动。记忆本身不是桥；User 或 Char 想起一段真实记忆时，那段记忆会唤来一只鹊。鹊飞过星河留下像针线一样细的轨迹，双方从两岸共同把路织到中央。

只使用 Part 1 已经召回并验证的 evidence，不重新发明事实：
${evidence || '（没有可用真实证据）'}

本轮会经过的地点：
${visited}

为两岸分别选择若干记忆：
- userMagpies：优先选择 User 会由此想到 Char 的记忆。
- charMagpies：优先选择 Char 会由此想到 User 的记忆。
- 两侧可以引用同一 evidence，但观察角度必须不同；同一侧不得重复 evidenceId。
- 数量根据有效记忆动态决定，宁可少而准确，不得为了画面丰富伪造。
- name 极短，优先物件、称呼、时间、地点或短语。
- memory 像两个人自己会认出来的私人标签，不写档案摘要，不把转述伪装成原话。
- visualHint 只抽象颜色、文字、光或剪影，不新增共同经历。

最后一只鹊必须从 Char 一岸飞来。finalMagpie.name 固定为“${userName}”；line 是 Char 终于辨认出 User 的一句极短反应，必须符合当前角色，不得机械套用示例。

禁止在任何字段解释“思念就是鹊桥”“记忆让我们相见”等中心思想。动画会自己表达。

只输出 JSON：
{
  "userMagpies": [
    { "evidenceId": "e1", "name": "记忆名称", "memory": "一句极短真实记忆", "visualHint": "极短视觉意象" }
  ],
  "charMagpies": [
    { "evidenceId": "e2", "name": "记忆名称", "memory": "一句极短真实记忆", "visualHint": "极短视觉意象" }
  ],
  "finalMagpie": {
    "name": "${userName}",
    "line": "Char 对 User 的极短辨认反应",
    "visualHint": "从对岸飞来的名字"
  }
}`;
}

export async function prepareQixiBridge(
    char: CharacterProfile,
    user: UserProfile,
    apiConfig: APIConfig,
    memoryBundle: QixiMemoryBundle,
    journey: QixiJourneyBeat[],
): Promise<QixiBridgeBundle> {
    if (!apiConfig.baseUrl || !apiConfig.apiKey || !apiConfig.model) throw new Error('Part 2 无法生成：请先配置可用的模型 API。');
    if (!memoryBundle.evidence.length) throw new Error('Part 2 无法生成：Part 1 没有留下可验证的真实记忆。');
    const contextChar = { ...char, memoryPalaceInjection: '', roomPlatesInjection: '' };
    const context = ContextBuilder.buildCoreContext(contextChar, user, true);
    const data = await safeFetchJson(
        `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [
                    { role: 'system', content: context },
                    { role: 'user', content: buildQixiBridgePrompt(memoryBundle, journey, user.name) },
                ],
                temperature: 0.5,
                stream: false,
            }),
        },
        0,
        50000,
        { appId: 'special-moments', charId: char.id, purpose: 'qixi-bridge-part2-v2' },
    );
    const content = data?.choices?.[0]?.message?.content;
    const parsed = typeof content === 'string' ? parseQixiBridge(content, memoryBundle, user.name) : null;
    if (!parsed) throw new Error('Part 2 返回的数据无法生成真实记忆鹊，请手动重新生成。');
    return parsed;
}
