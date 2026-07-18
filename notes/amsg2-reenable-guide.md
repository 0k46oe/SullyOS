# 主动消息 2.0（amsg2）单用户模式速查

> 什么时候读这份：改「主动消息 2.0」（角色到点自动发消息、App 关着也能收）相关代码时，照这份快速上手。
> 更新时间：2026-07-17。下面是 `dev` 上的代码现状。

## 一句话现状

amsg2 = 定时主动消息。运行模型是**单用户 + 自带 worker + 自带 DB**：每个用户自己部署一个 Cloudflare Worker（自带 D1 数据库 + Cron Trigger），SullyOS 前端只填「Worker 地址 + 共享密钥」就能用，跟 Instant Push 一个套路。没有多租户、没有 tenant token、没有 Netlify Functions 后端。

AI 模式任务（自动/提示词）走「满血」链路：前端平时把带时间槽位的完整 prompt
模板（fire_pack）同步到 worker 的 client_state 表，到点由 worker 现场填槽生成——
上下文是用户最后一次聊天时的状态，而不是排程那一刻的。worker 读不到 fire_pack
（老任务/没同步过）时自动回退用排程时冻结的 completePrompt。设计详见
[`amsg-fullbg-state-design.md`](./amsg-fullbg-state-design.md)。

满血链路带**服务端工具循环**（v2）：LLM 输出里的数据标签（RECALL / SEARCH /
READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS_*）由 worker 就地执行后回填继续生成
（默认 5 轮 / 240s，客户端全程不用在线）；副作用标签（POKE / TRANSFER / 写日记 /
MUSIC_ACTION / XHS 互动等）结构化成 directives 挂最后一条 push 的 metadata，客户端
收到时重放。classifier 与 instant push 共用同一份（`worker/instant-push/src/classifier.ts`）；
最终正文的分段也与 instant / 客户端气泡共用同一份（`utils/sanitize.ts` 的
`sanitizeIntoSegments`：按换行切，`[[...]]` / `[html]` 等标签块保持原子不被句读劈碎），
push 的 `notification.body` 带净化文本给系统横幅，`message` 保留原始标签给客户端渲染。
工具凭据与 recall 数据由前端随 fire_pack 同批上云（tool_pack / tool_config），
没同步或凭据缺失时工具以正常失败回给 LLM 圆场，不断链。
超 200KB 的大值（胖角色的 fire_pack）由 worker 存储层透明分块
（amsg-server 2.6.0-next.4+），前端整条直传、读回自动拼好；单个坏条目只拒自己
不连坐同批。worker 版本落后时前端用 `GET /capabilities` 探测，设置页亮
「重新粘贴部署」提示，不静默降级。

## 前端接入点

| 部件 | 文件 | 说明 |
|------|------|------|
| 发请求层 | `utils/activeMsgClient.ts` | 包 `@rei-standard/amsg-client` 的 `ReiClient`，构造用 `baseUrl=workerUrl` + `serverToken`。对外方法：`getGlobalConfig` / `getPushStatus` / `ensurePushSubscription` / `connect` / `listTasks` / `cancelTask` / `scheduleCharacterTask` |
| 全局配置 Modal | `components/settings/ActiveMsgGlobalSettingsModal.tsx` | 「部署 Worker」引导（复制代码 + CF Dashboard 链接 + env 清单 + Master Key 生成）+ 填 Worker 地址 + 共享密钥 + 「连接」+ 「开启推送」。挂在 `apps/Settings.tsx`（Instant Push 那节旁边） |
| 角色级调度 Modal | `components/chat/ActiveMsg2SettingsModal.tsx` | 每个角色配「固定/自动/提示词」× 「一次/每天/每周」。入口在聊天加号面板「主动消息 2.0」按钮（闹钟图标） |
| fire_pack 模板 | `utils/amsgFirePack.ts` | 满血链路的 prompt 模板 + 时间槽位渲染，前端兜底与 worker 填槽共用同一份（时间文案单份维护，有回归测试钉住） |
| tool_pack / tool_config | `utils/amsgToolPack.ts` | 服务端工具循环的数据形状：每角色的月度总结 / XHS 开关（tool_pack）+ 全局工具凭据 / 代理地址（tool_config），构建与 parse 前端 worker 共用 |
| 状态同步层 | `utils/amsgStateSync.ts` | 每轮聊完（useChatAI 轮末）打脏标记，去抖 15s / 切后台立即，把 fire_pack + tool_pack + tool_config 批量 `putClientState` 上云 |
| 工具实现（共用叶子） | `utils/agenticTools.ts` + `utils/realtimeFetchCore.ts` + `utils/xhsMcpClient.ts` | 九个数据工具的执行体。agenticTools 是 dispatch 入口（前端二轮 LLM / instant 续跑 / amsg worker 三处共用）；搜索 / Notion / 飞书的纯 fetch 核心在 realtimeFetchCore（realtimeContext 的 Manager 委托它）。**这几份是环境无关叶子，别往里加浏览器依赖**——`pnpm build:workers` 会打进 amsg worker bundle |
| Worker 入口（本仓打包） | `worker/amsg/src/index.ts` + `worker/amsg/src/agentic.ts` | index 配 hooks（onBeforeFire 填槽 + 装工具上下文、executeToolCalls 就地执行）；agentic 是决策纯逻辑（classifier 分类、旁白 / 副作用跨轮累积、finish payload 组装，有单测）。`pnpm build:workers` 产 `worker/amsg/worker.bundle.js` + `public/amsg-worker.bundle.js`（Modal「复制 Worker 代码」读后者） |
| 本地存储 | `utils/activeMsgStore.ts` | `ActiveMsg2GlobalConfig` 存 IndexedDB；收发消息的 inbox/outbound/reasoning 存储与 Instant Push 共用 |
| 类型 | `types.ts` | `ActiveMsg2GlobalConfig` = `{ userId, workerUrl, serverToken?, initializedAt?, updatedAt? }` |
| npm 依赖 | `@rei-standard/amsg-client`（2.9.0-next.4，含 serverToken + getVapidPublicKey + getCapabilities）、`amsg-shared` / `amsg-instant` / `amsg-sw`（latest）、`@rei-standard/amsg-server`（2.6.0-next.4，devDep，含 ctx.scratch + 存储层大值分块 + /capabilities） | amsg-server 只用于打 worker bundle，不进前端运行时 |

## 送达层与 Instant Push 共用（收消息侧白送）

worker 推的 web push → Service Worker（`worker/sw-keep-alive.ts`）收 → 写 IndexedDB → `utils/activeMsgRuntime.ts` 落库上屏。这条链和 Instant Push 共用，处理的就是 `ActiveMsg2InboxMessage`（metadata 标 `activeMsg2`）。amsg2 后端按标准 web push 格式推出来，前端收消息侧一行不用改。

## 鉴权与请求头

- 配了 `serverToken` → 每次请求带 `X-Client-Token`；worker 端配了 `AMSG_SERVER_TOKEN` 就**全部端点强制校验**（缺/错回 401，all-or-nothing）。
- 业务端点还带 `X-User-Id` + 加密头（`X-Payload-Encrypted` / `X-Encryption-Version` / `X-Response-Encrypted`）。加密走 client 的 `_encrypt/_decrypt`，key 由 `client.init()`（GET /get-user-key）派生。

## Worker 侧（用户自己部署）

- **主线部署方式 = Dashboard 粘贴**（学 Instant Push，用户不碰终端）：设置 Modal「部署 Worker」点「复制 Worker 代码」拿到 `public/amsg-worker.bundle.js` 全文，去 CF 后台建空 Worker → Edit code 粘贴覆盖 → Deploy。amsg-server 2.6.0-next.2 起全 Web Crypto，bundle 零 node 内置依赖，**不需要 `nodejs_compat` flag**。
- 备选 CLI 方式（wrangler）：`~/Documents/GitHub/amsg-worker/`（不在本仓，含 DEPLOY.md）。上游源码/示例：ReiStandard `packages/rei-standard-amsg/server/examples/cloudflare-single-user/`。
- 端点：`POST /init-tenant`（幂等建表，前端「连接」按钮会打它，用户不用手动执行 schema.sql）、`GET /get-user-key`、`POST /schedule-message`、`GET /messages`、`PUT /update-message?id=`、`DELETE /cancel-message?id=`、`GET /vapid-public-key`、`GET /capabilities`（特性探测：`{ serverVersion, features }`，老部署无此路由 404，前端归一成 null 后亮「重新部署」提示）。定时投递由 Cron Trigger 直接跑 `scheduled()`，无 send-notifications 端点。
- 部署要配：D1 binding 名 `DB`（空库即可，建表交给「连接」）、cron `* * * * *`、env `AMSG_MASTER_KEY`(32B hex，Modal 里可一键生成) + `VAPID_EMAIL/PUBLIC_KEY/PRIVATE_KEY`（必须和「推送凭据 (VAPID)」面板同一对，见下节）+ 可选 `AMSG_SERVER_TOKEN`。
- **跨源必须配 CORS**：本仓入口默认 `cors: { origin: '*' }`，想收紧自行改成站点域名。没配 CORS 时浏览器 preflight 被 worker 404。
- 定时推送 TTL 默认 4 周。

## VAPID 公钥

前端订阅时 `applicationServerKey` 必须是**这个 worker 自己**签推送用的公钥，否则推不动会 403。所以 `ensurePushSubscription` 运行时从 worker 拉公钥，不再用 build-time env。

- 用 `client.getVapidPublicKey()`（amsg-client 2.9.0-next.1 新增）→ `GET {workerUrl}/vapid-public-key`，带 X-Client-Token，返回 `publicKey` 字符串。worker 未配 VAPID 时返回 503 `VAPID_NOT_CONFIGURED`。
- worker 侧端点在 amsg-server 2.6.0-next.1+；部署时 worker env 要有 `VAPID_PUBLIC_KEY`，且和签推送用的是同一对密钥。
- **worker env 的 VAPID 必须填「推送凭据 (VAPID)」面板里那对**（`utils/pushVapid.ts` 共享存储，与 Instant Push / Proactive Push 同一对）：一个 origin 只有一个浏览器 push 订阅，`ensurePushSubscription` 有现成订阅就直接复用，amsg worker 用别的密钥对签推送会 403。

## 联调防坑

- `@rei-standard/amsg-*` 源仓改完 `link:../ReiStandard` 联调时，**提交前 grep `pnpm-lock.yaml` 别让 `ReiStandard` 写进去**，否则 Netlify frozen install 失败。
- `amsg-shared` / `amsg-instant` / `amsg-sw` 的 npm `next` tag 是老的低版本，别误 `@next` 升（会降级）。要 next 的只有 `amsg-client`。
