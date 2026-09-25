# 美化分享码

提供私有投稿、人工审核和凭码领取，不提供公开作品列表、搜索、评论或关注。

## 入口和使用流程

- 聊天装扮「预设」以及外观「预设」中的「美化分享码」。
- 「导出分享码」选择当前聊天装扮、保存的预设或上传导出的 JSON / ZIP / PNG 分享原图。外观先保存当前设置为预设再选择。
- 首次投稿设置密码，服务生成作者码。当前浏览器保存会话；更换浏览器用作者码 + 密码恢复。作者码和公开分享码是不同凭据；服务器只保存密码派生值，不保存明文密码。
- 说明含美化名、署名、发放平台（可多选）、联系说明、二改/二次传播许可、当前导出应用版本、Bug 反馈偏好和作者留言。平台用于告诉使用者去哪里找作者 Repo；本服务不会向 QQ 或 DC 发消息。
- 提交后在「我的提交」刷新状态。通过后生成稳定的 `S-…` 分享码；退回显示管理员说明。没有自动推送通知。
- 更新必须重新审核。在审核和退回期间，分享码继续指向上一份已通过文件。重复/过期更新返回冲突，用户刷新后重试。
- 作者可立即删除；分享码和所有私有下载接口马上失效。已下载的副本无法收回。
- 领取先查看作者规范并确认。聊天装扮继续走原来的分项确认；外观存入本地预设列表，不自动应用。

## 服务和数据

- Worker：`worker/beauty-share/src/index.ts`，服务 `sullyos-beauty-share`。
- D1：`sullyos-beauty-share`，维护作者、会话、投稿版本、审核指针及额度；迁移位于 `worker/beauty-share/migrations`。
- R2：`sullyos-beauty-share-private`，不得打开公开访问或绑定公开存储域名。所有下载经 Worker 校验已审核指针或作者/管理员身份。
- 管理界面：`https://sullyos-beauty-share.qegj567.workers.dev/admin/`。地址不是安全边界，所有管理员 API 独立鉴权。页面只渲染文本，不注入投稿 CSS/HTML，也不自动加载投稿里的素材地址。
- 客户端默认服务地址在 `utils/beautyShareClient.ts`，自部署可用构建环境变量 `VITE_BEAUTY_SHARE_URL` 覆盖。不能在前端配置中放管理员密码、Cloudflare Token 或 Worker secrets。
- 作者会话在本地 `sully-beauty-author-session-v1`，常用说明在 `sully-beauty-author-defaults-v1`。这些不写入预设包。作者会话 30 天，管理员会话 8 小时；服务端仅保存会话 token 的 SHA-256。
- 密码用 PBKDF2-SHA256、独立随机盐和服务端 pepper。不要无意轮换 `AUTH_PEPPER`，否则已有密码无法验证。忘记作者密码暂不提供自助重置；管理员也看不到原密码。

不进行服务端 AI 内容审核。服务仅做格式、大小、权限和频率约束。人工审核下载规范化的 JSON；是否通过由管理员决定。

## 首次部署

1. 创建私有 R2 桶和 D1 数据库，修改 `wrangler.jsonc` 里的账号与资源绑定。
2. `pnpm dlx wrangler d1 migrations apply sullyos-beauty-share --remote --config worker/beauty-share/wrangler.jsonc`。
3. `pnpm dlx wrangler deploy --config worker/beauty-share/wrangler.jsonc`。首次保持 `UPLOADS_ENABLED=false`。
4. 通过 Wrangler secret 设置 `AUTH_PEPPER`（随机至少 32 字符）与 `BOOTSTRAP_HASH`（随机一次性初始化 token 的 SHA-256）。密钥文件使用被 Git 忽略的 `.dev.vars.*`，不得提交。
5. 本人访问 `/admin/#setup=<初始化token>` 设置账号和密码。页面立即移除 URL fragment；D1 唯一索引保证仅一个管理员。已有管理员后初始化接口拒绝再次建立。
6. 初始化完成后删除 `BOOTSTRAP_HASH` secret；将 `UPLOADS_ENABLED` 改为 `true` 并重新部署。发布应用客户端是单独步骤。

## 额度和清理

默认单文件 20 MiB、每作者最多 50 份活跃作品、每小时 6 次上传、每 IP 每天 3 次注册。全站每天接受上传 256 MiB，总保留文件计数上限 8 GiB，可在 Worker vars 调整。失败请求也可能消耗频率和当天上传额度，防止反复失败绕过限制。

这些是业务限制，不是 Cloudflare 账单封顶。Worker 请求与 D1/R2 操作仍计入各自用量。公开下载不经过公开桶，不缓存可撤销的包；需要关注下载量和调用量。投稿入口可用 `UPLOADS_ENABLED=false` 暂停，已通过作品仍可领取。

数据库事务维护版本和分享指针。下载附带 revision，作者发布新版后，旧详情发起的下载返回 409，需重新查看规范。删除先撤销数据库可见性，再清理文件；清理失败由每日 Cron 重试。过期会话、频率窗口和被替换的历史文件同样由 Cron 清理。

R2 与 D1 没有跨服务事务。一般写入失败会立即清理对象并归还容量，但 Worker 在对象写入后被强制终止，可能留下没有版本记录的对象和占用计数。出现容量与版本统计不一致时，维护人员应对照 `revisions.blob_key` 核对桶，确认孤立对象后再清理；不可盲目重置 `limits` 中的 `storage`。这不会让未审核内容公开。

## 验证

- `pnpm vitest run utils/beautyShare.test.ts utils/chatDecoration.test.ts`：分享格式、错误类型、ZIP 解压实际大小限制、聊天导入验证。
- `pnpm exec tsc --noEmit`；`pnpm build`。
- 本地 D1 迁移后，设置 `.dev.vars` 的测试 `AUTH_PEPPER` 与 `BOOTSTRAP_HASH=SHA256('local-bootstrap-test-only')`，运行 `pnpm dlx wrangler dev --config worker/beauty-share/wrangler.jsonc --port 8793 --var UPLOADS_ENABLED:true`。
- 在**全新本地数据库**上运行 `node scripts/test-beauty-share.mjs`：42 项 HTTP 检查，覆盖账户恢复、未审私有性、越权、审核并发、更新保留已发布版本与删除撤销。脚本地址固定 localhost，不允许切到生产环境。
