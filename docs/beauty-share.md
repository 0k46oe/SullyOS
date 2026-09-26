# 美化分享码

提供私有投稿、人工审核和凭码领取，不提供公开作品列表、搜索、评论或关注。

## 入口和使用流程

- 主要入口在外观 App 独立的「美化分享」标签，按外观预设 / 聊天装扮分类选择本机已保存预设；聊天装扮「预设」也保留快捷入口。
- 选中预设即可预览，不需要先登录。预览使用示例布局和示例文字，不读取角色或真实聊天、不应用到本机。CSS 在独立 Shadow DOM 内展示，宿主强制尺寸和绘制隔离，内容只来自转义后的示例模板，不插入脚本；复杂皮肤与样式不保证与实际桌面完全一致。
- 已发布作品可在「我的提交 → 分享预览图」生成带预览、美化名、署名、使用权限和分享码的 PNG。使用当前已审核版本，更新待审期间仍展示旧版；图片不嵌入预设文件，只引导凭码领取。图片在设备上生成，不上传新的图片到 R2。复杂 CSS 与跨域图片可能受浏览器导出能力限制。
- 「导出分享码」选择当前聊天装扮、保存的预设或上传导出的 JSON / ZIP / PNG 分享原图。外观先保存当前设置为预设再选择。
- 首次投稿设置密码，服务生成作者码。当前浏览器保存会话；更换浏览器用作者码 + 密码恢复。作者码和公开分享码是不同凭据；服务器只保存密码派生值，不保存明文密码。
- 说明含美化名、署名、发放平台（可多选）、联系说明、二改/二次传播许可、当前导出应用版本、Bug 反馈偏好和作者留言。平台用于告诉使用者去哪里找作者 Repo；本服务不会向 QQ 或 DC 发消息。
- 提交后在「我的提交」刷新状态。通过后生成稳定的 `S-…` 分享码；退回显示管理员说明。没有自动推送通知。
- 更新必须重新审核。在审核和退回期间，分享码继续指向上一份已通过文件。重复/过期更新返回冲突，用户刷新后重试。
- 作者可立即删除；分享码和所有私有下载接口马上失效。已下载的副本无法收回。
- 领取先查看作者规范并确认。外观通道领取后先存入对应本地预设列表，再询问「是否立即应用」：外观预设应用后返回桌面；聊天装扮选择角色后应用整套预设并进入该角色聊天，不影响其他角色。可选择暂不应用，之后从预设列表使用。从聊天装扮快捷入口领取则继续走原来的分项确认。

## 服务和数据

### 私密 Repo 与本机邀请

- 分享码来源保存在本机 `beauty_source_*` 资产中，外观绑定导入后的预设 ID，聊天装扮绑定规范化包的 SHA-256；不向美化包附加账号、聊天或使用记录。只有应用成功后才开始记录，领取但未应用不计时。
- 首版按应用后经过 **72 小时以上**计算，不累计屏幕点亮时长。记录存在 `sully-beauty-usage-v1`；切换主题、重置或手动改动对应外观字段会停止该轮计时。再次应用可重新开始。角色资料、消息内容不参与统计。
- 邀请只在解锁后的桌面空闲时出现，避开已有公告、备份和对话框；同一分享码仅主动提醒一次，全局每天最多一份。可关闭提醒，在「外观 → 美化分享 → 给美化作者写 Repo」手动打开当前使用作品的表单。历史版本已应用但没有记录来源的预设不会补算时间。
- 用户可以自行按作者填写的平台和联系说明寻找作者，或提交署名及最多 1200 字反馈。同意人工转达前不能提交。首版不收图片、聊天、角色名或联系方式；署名为用户自行填写，不作真实身份认证。
- `POST /api/repos` 校验曾审核通过的作品版本、格式和明确同意。每 IP 每天 5 次、每本机随机标识每天 3 次、全站每天 1000 次；请求幂等键由 pepper、本机随机标识和请求 ID 派生，不存原始设备标识。限流与幂等标识用于防重复，不是硬件设备认证。
- `beauty_repos`（迁移 `0002_private_repos.sql`）只允许管理员查询和更新状态。没有公共 Repo 列表，也没有作者直接读取接口。作品后续更新不会改变旧 Repo 对应的作者说明快照。
- 后台「私密 Repo」可按状态、作品名、美化码和作者码筛选，每页 12 份；可预览并导出单份 PNG，或勾选同一作者最多 3 份生成合集卡。图片在管理员浏览器生成，不外发、不额外存入 R2。管理员手动用 QQ 发给作者后，再标记「已转达」；可归档或恢复待转达。导出不会自动改变状态。
- 普通用户的「我的提交」和管理员作品队列也统一为每页 12 份，显示总数、上一页／下一页。处理最后一页的最后一项时自动回到有效页；按更新时间和 ID 稳定排序。

- Worker：`worker/beauty-share/src/index.ts`，服务 `sullyos-beauty-share`。
- D1：`sullyos-beauty-share`，维护作者、会话、投稿版本、审核指针及额度；迁移位于 `worker/beauty-share/migrations`。
- R2：`sullyos-beauty-share-private`，不得打开公开访问或绑定公开存储域名。所有下载经 Worker 校验已审核指针或作者/管理员身份。
- 正式服务域名：`https://beauty.friedsully.com`；管理界面：`https://beauty.friedsully.com/admin/`。域名已在 Cloudflare Dashboard 绑定，也记录于 Wrangler routes。地址不是安全边界，所有管理员 API 独立鉴权。页面只渲染文本，不注入投稿 CSS/HTML，也不自动加载投稿里的素材地址。
- 客户端默认服务地址在 `utils/beautyShareClient.ts`，自部署可用构建环境变量 `VITE_BEAUTY_SHARE_URL` 覆盖。不能在前端配置中放管理员密码、Cloudflare Token 或 Worker secrets。
- 作者会话在本地 `sully-beauty-author-session-v1`，常用说明在 `sully-beauty-author-defaults-v1`。这些不写入预设包。作者会话 30 天，管理员会话 8 小时；服务端仅保存会话 token 的 SHA-256。
- 密码用 PBKDF2-SHA256、独立随机盐和服务端 pepper。不要无意轮换 `AUTH_PEPPER`，否则已有密码无法验证。忘记作者密码暂不提供自助重置；管理员也看不到原密码。

不进行服务端 AI 内容审核。服务仅做格式、大小、权限和频率约束。人工审核下载规范化的 JSON；是否通过由管理员决定。

## 首次部署

1. 创建私有 R2 桶和 D1 数据库，修改 `wrangler.jsonc` 里的账号与资源绑定。
2. `pnpm dlx wrangler d1 migrations apply sullyos-beauty-share --remote --config worker/beauty-share/wrangler.jsonc`。
3. `pnpm dlx wrangler deploy --config worker/beauty-share/wrangler.jsonc`。全新部署首次需将 `UPLOADS_ENABLED` 设为 `false`；当前账号已初始化管理员并开放投稿。配置含自定义域名，CLI 后续管理路由需对应 zone / routes 权限。
4. 通过 Wrangler secret 设置 `AUTH_PEPPER`（随机至少 32 字符）与 `BOOTSTRAP_HASH`（随机一次性初始化 token 的 SHA-256）。密钥文件使用被 Git 忽略的 `.dev.vars.*`，不得提交。
5. 本人访问 `/admin/#setup=<初始化token>` 设置账号和密码。页面立即移除 URL fragment；D1 唯一索引保证仅一个管理员。已有管理员后初始化接口拒绝再次建立。
6. 初始化完成后删除 `BOOTSTRAP_HASH` secret；将 `UPLOADS_ENABLED` 改为 `true` 并重新部署。发布应用客户端是单独步骤。

## 额度和清理

默认单文件 20 MiB、每作者最多 50 份活跃作品、每小时 6 次上传、每 IP 每天 3 次注册。全站每天接受上传 256 MiB，总保留文件计数上限 8 GiB，可在 Worker vars 调整。失败请求也可能消耗频率和当天上传额度，防止反复失败绕过限制。

这些是业务限制，不是 Cloudflare 账单封顶。Worker 请求与 D1/R2 操作仍计入各自用量。公开下载不经过公开桶，不缓存可撤销的包；需要关注下载量和调用量。投稿入口可用 `UPLOADS_ENABLED=false` 暂停，已通过作品仍可领取。

数据库事务维护版本和分享指针。下载附带 revision，作者发布新版后，旧详情发起的下载返回 409，需重新查看规范。删除先撤销数据库可见性，再清理文件；清理失败由每日 Cron 重试。过期会话、频率窗口和被替换的历史文件同样由 Cron 清理。

R2 与 D1 没有跨服务事务。一般写入失败会立即清理对象并归还容量，但 Worker 在对象写入后被强制终止，可能留下没有版本记录的对象和占用计数。出现容量与版本统计不一致时，维护人员应对照 `revisions.blob_key` 核对桶，确认孤立对象后再清理；不可盲目重置 `limits` 中的 `storage`。这不会让未审核内容公开。

## 验证

- `pnpm vitest run utils/beautyUsage.test.ts utils/beautyPreview.test.ts utils/beautyShare.test.ts utils/chatDecoration.test.ts`：提醒计时、停用和去重、Repo 同意与字段白名单、预览模板转义、分享格式、ZIP 解压实际大小限制、聊天导入验证。
- `pnpm exec tsc --noEmit`；`pnpm build`。
- 本地 D1 迁移后，设置 `.dev.vars` 的测试 `AUTH_PEPPER` 与 `BOOTSTRAP_HASH=SHA256('local-bootstrap-test-only')`，运行 `pnpm dlx wrangler dev --config worker/beauty-share/wrangler.jsonc --port 8793 --var UPLOADS_ENABLED:true`。
- 在**全新本地数据库**上运行 `node scripts/test-beauty-share.mjs`：59 项 HTTP 检查，覆盖账户恢复、未审私有性、越权、审核并发、更新保留已发布版本、删除撤销、私密 Repo 权限与幂等。默认 localhost:8793，环境变量 `BEAUTY_TEST_PORT=8794` 可改为另一隔离本地实例，不允许切到生产环境。
