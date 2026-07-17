# 主动消息 2.0（amsg2）单用户模式速查

> 什么时候读这份：改「主动消息 2.0」（角色到点自动发消息、App 关着也能收）相关代码时，照这份快速上手。
> 更新时间：2026-07-17。下面是 `dev` 上的代码现状。

## 一句话现状

amsg2 = 定时主动消息。运行模型是**单用户 + 自带 worker + 自带 DB**：每个用户自己部署一个 Cloudflare Worker（自带 D1 数据库 + Cron Trigger），SullyOS 前端只填「Worker 地址 + 共享密钥」就能用，跟 Instant Push 一个套路。没有多租户、没有 tenant token、没有 Netlify Functions 后端。

## 前端接入点

| 部件 | 文件 | 说明 |
|------|------|------|
| 发请求层 | `utils/activeMsgClient.ts` | 包 `@rei-standard/amsg-client` 的 `ReiClient`，构造用 `baseUrl=workerUrl` + `serverToken`。对外方法：`getGlobalConfig` / `getPushStatus` / `ensurePushSubscription` / `connect` / `listTasks` / `cancelTask` / `scheduleCharacterTask` |
| 全局配置 Modal | `components/settings/ActiveMsgGlobalSettingsModal.tsx` | 「部署 Worker」引导（复制代码 + CF Dashboard 链接 + env 清单 + Master Key 生成）+ 填 Worker 地址 + 共享密钥 + 「连接」+ 「开启推送」。挂在 `apps/Settings.tsx`（Instant Push 那节旁边） |
| 角色级调度 Modal | `components/chat/ActiveMsg2SettingsModal.tsx` | 每个角色配「固定/自动/提示词」× 「一次/每天/每周」。挂在聊天菜单，未变动 |
| Worker 入口（本仓打包） | `worker/amsg/src/index.ts` | 薄入口包 `@rei-standard/amsg-server/cloudflare`；`pnpm build:workers` 产 `worker/amsg/worker.bundle.js` + `public/amsg-worker.bundle.js`（Modal「复制 Worker 代码」读后者） |
| 本地存储 | `utils/activeMsgStore.ts` | `ActiveMsg2GlobalConfig` 存 IndexedDB；收发消息的 inbox/outbound/reasoning 存储与 Instant Push 共用 |
| 类型 | `types.ts` | `ActiveMsg2GlobalConfig` = `{ userId, workerUrl, serverToken?, initializedAt?, updatedAt? }` |
| npm 依赖 | `@rei-standard/amsg-client`（2.9.0-next.1，含 serverToken + getVapidPublicKey）、`amsg-shared` / `amsg-instant` / `amsg-sw`（latest）、`@rei-standard/amsg-server`（2.6.0-next.2，devDep） | amsg-server 只用于打 worker bundle，不进前端运行时 |

## 送达层与 Instant Push 共用（收消息侧白送）

worker 推的 web push → Service Worker（`worker/sw-keep-alive.ts`）收 → 写 IndexedDB → `utils/activeMsgRuntime.ts` 落库上屏。这条链和 Instant Push 共用，处理的就是 `ActiveMsg2InboxMessage`（metadata 标 `activeMsg2`）。amsg2 后端按标准 web push 格式推出来，前端收消息侧一行不用改。

## 鉴权与请求头

- 配了 `serverToken` → 每次请求带 `X-Client-Token`；worker 端配了 `AMSG_SERVER_TOKEN` 就**全部端点强制校验**（缺/错回 401，all-or-nothing）。
- 业务端点还带 `X-User-Id` + 加密头（`X-Payload-Encrypted` / `X-Encryption-Version` / `X-Response-Encrypted`）。加密走 client 的 `_encrypt/_decrypt`，key 由 `client.init()`（GET /get-user-key）派生。

## Worker 侧（用户自己部署）

- **主线部署方式 = Dashboard 粘贴**（学 Instant Push，用户不碰终端）：设置 Modal「部署 Worker」点「复制 Worker 代码」拿到 `public/amsg-worker.bundle.js` 全文，去 CF 后台建空 Worker → Edit code 粘贴覆盖 → Deploy。amsg-server 2.6.0-next.2 起全 Web Crypto，bundle 零 node 内置依赖，**不需要 `nodejs_compat` flag**。
- 备选 CLI 方式（wrangler）：`~/Documents/GitHub/amsg-worker/`（不在本仓，含 DEPLOY.md）。上游源码/示例：ReiStandard `packages/rei-standard-amsg/server/examples/cloudflare-single-user/`。
- 端点：`POST /init-tenant`（幂等建表，前端「连接」按钮会打它，用户不用手动执行 schema.sql）、`GET /get-user-key`、`POST /schedule-message`、`GET /messages`、`PUT /update-message?id=`、`DELETE /cancel-message?id=`、`GET /vapid-public-key`。定时投递由 Cron Trigger 直接跑 `scheduled()`，无 send-notifications 端点。
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
