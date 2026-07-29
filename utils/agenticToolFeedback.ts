/**
 * 工具跑完之后跟模型说什么 —— 前台和 worker 共用这一份。
 *
 * 背景：工具本体早就抽成共用叶子了（agenticTools.ts），**编排没有**。前台的编排全在
 * applyAssistantPostProcessing.ts 里，那份文件绑死浏览器依赖（IndexedDB / 日记 / 小红书
 * 客户端），worker 打不进去，于是 worker 自己重写了一遍——重写的时候只写了「怎么跑循环」，
 * 没写「跑完跟模型说什么」。结果两边行为分叉：
 *
 *   前台：把结果包成一条 user 消息，明说「现在请结合这些细节回答」「不要再输出
 *         [[SEARCH:...]] 了」——所以它从来不打转。
 *   worker：把结果 JSON.stringify 一下就丢回去，零引导。模型看不出「这一步已经做完了」，
 *         提示词里但凡有一句常驻的「先去查 X」，它每轮都会照做，直接跑满上限。
 *
 * 跑满上限的代价不是「少查一次」：超限抛 AGENTIC_LOOP_EXCEEDED，任务不出清，下一分钟的
 * cron 把整条从头再跑一遍，反复烧 LLM。实测有过从 12:45 拖到 13:11 才收场的。
 *
 * 这份模块就是把「跑完说什么」也变成共用的一份。它只管措辞和「别重复」的规则，不碰
 * 具体工具怎么跑，所以两边各自的循环形态（前台是流水线、worker 是真循环）都能用。
 */

import { MCP_FIRE_NAME_PREFIX } from './mcpFireCore';

/**
 * 一次工具调用的指纹：工具名 + 规范化后的参数。
 *
 * 参数按 key 排序后序列化，`{a:1,b:2}` 和 `{b:2,a:1}` 算同一次调用——模型两轮之间
 * 重新拼参数时字段顺序常常会变，不规范化的话同一个查询会被当成两次不同的。
 */
export const toolCallFingerprint = (name: string, args: unknown): string => {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, normalize(v)]),
      );
    }
    return value;
  };
  return `${name}:${JSON.stringify(normalize(args ?? {}))}`;
};

/** 本次 fire 里已经调用过的一次工具。 */
export interface ToolCallRecord {
  name: string;
  fingerprint: string;
}

/** 工具名 → 给模型看的说法。认不出来的直接用原名，不编。 */
const TOOL_LABELS: Record<string, string> = {
  recall: '调取某个月的记忆',
  web_search: '联网搜索',
  notion_read_diary: '翻日记（Notion）',
  feishu_read_diary: '翻日记（飞书）',
  read_note: '翻对方的笔记',
  xhs_search: '在小红书搜索',
  xhs_browse: '刷小红书首页',
  xhs_my_profile: '打开自己的小红书',
  xhs_detail: '点开一条小红书笔记',
};

/**
 * 工具名 → 塞进「你__，拿回了下面这些」这句话里的说法。
 *
 * 用户自配的 MCP 工具不在上表里，名字还带着路由用的 mcp__ 前缀。直接回填原名会拼出
 * 「你mcp__get_secret，拿回了…」——句子读不通，内部前缀也漏进了模型能看见的散文里
 * （模型照着学，回头就往正文里写 mcp__ 开头的假调用）。所以这类名字剥掉前缀、
 * 补成完整的动宾短语。内置工具都在表里，走不到这两条分支。
 */
export const describeTool = (name: string): string => {
  const label = TOOL_LABELS[name];
  if (label) return label;
  if (name.startsWith(MCP_FIRE_NAME_PREFIX)) {
    return `调用「${name.slice(MCP_FIRE_NAME_PREFIX.length)}」`;
  }
  return name;
};

/**
 * 工具结果 → 回喂给模型的那段话。
 *
 * 结构照抄前台那套（`[系统: 做了什么]` + 结果 + `[系统: 接下来干嘛]`），关键是最后那段
 * 收尾：把本次已经用过的工具点名列出来，并且说死「同样的调用不要再来一遍」。裸 JSON 里
 * 没有任何东西在告诉模型「这一步结束了」，这段话就是。
 */
export const buildToolResultMessage = (opts: {
  name: string;
  /** dispatchAgenticTool 的返回值，原样序列化给模型看。 */
  result: unknown;
  /** 本次 fire 到目前为止调过的全部工具（含这一次）。 */
  history: ToolCallRecord[];
}): string => {
  const { name, result, history } = opts;
  const used = [...new Set(history.map((r) => describeTool(r.name)))];
  return [
    `[系统: 你${describeTool(name)}，拿回了下面这些]`,
    JSON.stringify(result),
    '',
    `[系统: 本次已经用过的工具：${used.join('、')}。结果都在上面了，同样的调用不要再来一遍。`,
    '接下来只有两条路：直接把要发的消息写出来，或者用一个还没用过的工具。',
    '别把工具调用当成回答——用户等的是你说的话。]',
  ].join('\n');
};

/**
 * 同一个调用又来了一次时回给模型的话（不真跑工具）。
 *
 * 光靠上面那段提示是软约束，模型不听就还是会转满上限、把任务拖进「不出清 → 下一分钟整条
 * 重跑」的循环。这条是硬的：同名同参第二次直接打回，一次网络请求都不发。它只拦**完全
 * 一样**的调用，换个月份、换个关键词都照常放行，多轮能力一点不减。
 */
export const buildDuplicateToolMessage = (name: string): string => [
  `[系统: 你刚刚已经${describeTool(name)}过一次了，参数完全相同，结果就在上面。]`,
  '[系统: 这一次没有再去查。别再重复同样的调用了——现在把要发的消息写出来，',
  '或者换一个还没用过的工具。]',
].join('\n');
