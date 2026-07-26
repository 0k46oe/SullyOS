/**
 * amsgToolPack — 满血 v2 服务端工具循环的云端状态数据形状（前端 / amsg worker 共用）
 *
 * fire_pack 解决「到点拿什么 prompt」，这里解决「到点跑工具要什么数据」：
 *   - tool_pack（每角色，namespace `amsg:char:<id>`）：recall 要读的月度总结、
 *     XHS 角色开关、日记查询要用的角色名。
 *   - tool_config（全局，namespace `amsg:global`）：搜索 / Notion / 飞书凭据、
 *     XHS MCP 配置、代理 worker 地址——即 agenticTools 各工具从 realtimeConfig
 *     里读的那个子集，多一分都不上云。
 *
 * 两份都由前端在 amsgStateSync 冲刷时与 fire_pack 同批 putClientState；worker 在
 * onBeforeFire 读出、parse 失败一律回退成「无工具数据」（工具会以 not_configured /
 * no_logs 的正常路径回给 LLM，不会炸 fire 链）。
 *
 * 环境无关叶子模块：不 import 任何带浏览器依赖的东西（会进 worker bundle）。
 */

import type { CharacterProfile, RealtimeConfig } from '../types';
import type { AgenticToolMemory, AgenticToolRealtimeConfig } from './agenticTools';
import { getProxyWorkerUrl } from './proxyWorker';

export const AMSG_TOOL_PACK_KEY = 'tool_pack';
export const AMSG_GLOBAL_NAMESPACE = 'amsg:global';
export const AMSG_TOOL_CONFIG_KEY = 'tool_config';

/** recall / 日记 / XHS 门控要用的角色侧数据（CharacterProfile 的极小子集）。 */
export interface AmsgToolPack {
  v: 1;
  charName: string;
  xhsEnabled: boolean;
  activeMemoryMonths: string[];
  memories: AgenticToolMemory[];
}

/**
 * 工具凭据与配置（RealtimeConfig 的工具子集 + 代理地址）。
 *
 * 凭据字段表直接继承 AgenticToolRealtimeConfig——那边是工具真正会读的字段，这边是把它们
 * 上云的载体，本来就该一模一样。抄成两份的话，agenticTools 多读一个字段而这边忘了加，
 * worker 到点就静默拿 undefined（编译期一声不吭），正是窄接口想消灭的那类失配。
 */
export interface AmsgToolConfig extends AgenticToolRealtimeConfig {
  v: 1;
  /** 搜索 / Notion / 飞书都经它转发；worker 端用 setProxyWorkerUrlOverride 注入。 */
  proxyWorkerUrl: string;
  /** 上云这份比工具侧多一个 cookie（lite 模式的登录态），并且两个开关字段是必填。 */
  xhsMcpConfig?: {
    enabled: boolean;
    serverUrl: string;
    cookie?: string;
    loggedInUserId?: string;
    loggedInNickname?: string;
    userXsecToken?: string;
  };
}

export const buildToolPack = (char: CharacterProfile): AmsgToolPack => ({
  v: 1,
  charName: char.name,
  xhsEnabled: !!char.xhsEnabled,
  activeMemoryMonths: char.activeMemoryMonths || [],
  // id 等工具用不到的字段不上云；runRecall 只读 date / mood / summary。
  memories: (char.memories || []).map((mem) => ({
    date: mem.date,
    summary: mem.summary,
    ...(mem.mood ? { mood: mem.mood } : {}),
  })),
});

export const buildToolConfig = (realtimeConfig: RealtimeConfig | undefined): AmsgToolConfig => {
  const rc = realtimeConfig;
  const xhs = rc?.xhsMcpConfig;
  return {
    v: 1,
    proxyWorkerUrl: getProxyWorkerUrl(),
    newsEnabled: !!rc?.newsEnabled,
    ...(rc?.newsApiKey ? { newsApiKey: rc.newsApiKey } : {}),
    notionEnabled: !!rc?.notionEnabled,
    ...(rc?.notionApiKey ? { notionApiKey: rc.notionApiKey } : {}),
    ...(rc?.notionDatabaseId ? { notionDatabaseId: rc.notionDatabaseId } : {}),
    ...(rc?.notionNotesDatabaseId ? { notionNotesDatabaseId: rc.notionNotesDatabaseId } : {}),
    feishuEnabled: !!rc?.feishuEnabled,
    ...(rc?.feishuAppId ? { feishuAppId: rc.feishuAppId } : {}),
    ...(rc?.feishuAppSecret ? { feishuAppSecret: rc.feishuAppSecret } : {}),
    ...(rc?.feishuBaseId ? { feishuBaseId: rc.feishuBaseId } : {}),
    ...(rc?.feishuTableId ? { feishuTableId: rc.feishuTableId } : {}),
    ...(xhs?.serverUrl
      ? {
          xhsMcpConfig: {
            enabled: !!xhs.enabled,
            serverUrl: xhs.serverUrl,
            ...(xhs.cookie ? { cookie: xhs.cookie } : {}),
            ...(xhs.loggedInUserId ? { loggedInUserId: xhs.loggedInUserId } : {}),
            ...(xhs.loggedInNickname ? { loggedInNickname: xhs.loggedInNickname } : {}),
            ...(xhs.userXsecToken ? { userXsecToken: xhs.userXsecToken } : {}),
          },
        }
      : {}),
  };
};

/** 云端 tool_pack 字符串 → 结构；形状不对返回 null（fire 链按无工具数据继续）。 */
export const parseToolPack = (value: string): AmsgToolPack | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      !parsed || typeof parsed !== 'object' ||
      parsed.v !== 1 ||
      typeof parsed.charName !== 'string' ||
      !Array.isArray(parsed.activeMemoryMonths) ||
      !Array.isArray(parsed.memories)
    ) {
      return null;
    }
    return parsed as AmsgToolPack;
  } catch {
    return null;
  }
};

/** 云端 tool_config 字符串 → 结构；形状不对返回 null。 */
export const parseToolConfig = (value: string): AmsgToolConfig | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      !parsed || typeof parsed !== 'object' ||
      parsed.v !== 1 ||
      typeof parsed.proxyWorkerUrl !== 'string'
    ) {
      return null;
    }
    return parsed as AmsgToolConfig;
  } catch {
    return null;
  }
};
