# 角色默认对话 API

## 本地普通私聊：Anthropic 原生接口

设置和角色独立 API 的「接口格式」可选 OpenAI 兼容或 Anthropic 原生 Messages。协议随预设、角色配置和备份保存；旧配置缺省为 OpenAI，不会因全局选择 Anthropic 而改变旧角色独立配置的协议。URL / Key / Model / 协议整体选择。

Anthropic 支持浏览器内的普通私聊（含文字、图片、连续对话、重新生成），可通过「流式输出」开关选择流式或非流式，使用模型默认采样参数。开关在 Anthropic 接口字段中直接显示，随预设及角色配置保存。URL 支持服务根地址、`/v1` 和完整 `/v1/messages`；鉴权使用 `x-api-key` 和 `anthropic-version`。接口须允许浏览器跨域请求。模型列表按同一协议获取，列表不可用时仍可手动填模型。

`utils/dialogueTransport.ts` 只在本地私聊请求边界转换 system/history 和响应，复用既有提示词、取消和后处理；不改 Worker、其他 App、专用视觉或语音请求。`utils/anthropicStream.ts` 解析原生 Messages SSE：实时回传文字增量，按索引拼接工具参数并合并 usage，收到 `message_stop` 后停止读取。HTTP 200 内的错误事件、损坏事件和提前断流均报错，不把半条回复当成功，也不自动重发付费请求。接口返回整包 JSON 时兼容非流式响应；关闭流式开关后不触发文字预览。

选择原生协议的私聊不进入 OpenAI 云端即时聊天。支持视觉的模型可以使用同一套 Anthropic API 直接接收图片，再选择流式或非流式回复，不强制配置独立识图。当前与选定上下文中的历史图片、多图和混合图文都会保留。网络出口先还原 `blobref:` 本机引用，再将 data URL 拆为原生 `image` 块的 `base64` / `media_type` / `data`，HTTP(S) 外链转换为 `url` 图片源；支持 PNG、JPEG、GIF、WebP，不转发 OpenAI 的 `detail`。丢失的本机图片、损坏的 base64 或不支持的图片格式在发送前明确报错，不静默删图或改用其他模型。外链须能被接口服务读取，图片大小、数量和模型视觉能力以所选服务限制为准。

已经显式开启的独立识图仍按原规则先转换为文字描述，再交给聊天模型；想让主模型直接看图时，关闭独立识图即可，不会自动替用户切换该设置。自动注入的本地工具有协议转换以免阻断普通聊天，但工具玩法和原生思考不在本次支持与验收范围。

`utils/anthropicChatImages.test.ts` 通过真实 `useChatAI` 与请求边界验证同一原生 API 的本机、内嵌、外链、历史与当前图片，覆盖流式开 / 关以及可选独立识图。`utils/dialogueTransport.test.ts` 验证图片格式、丢图、损坏内容、取消和旧 OpenAI 图文请求；`utils/anthropicChatStreaming.test.ts` 同时验证带图和文字请求的增量显示、完成、流内报错及手动停止。均使用虚构凭据和网络替身，不调用付费模型。

建议全局保留原 OpenAI 兼容配置，在角色独立 API 或悬浮球「当前聊天角色」范围选用原生预设；这样其他尚未适配的 App 和后台任务仍可使用原有接口。

神经链接 → 设定 → 角色语音音色下方的「独立 API」。未设置时显示当前全局地址的主机名和模型；设置后显示角色自己的配置，并可恢复跟随设置。

角色弹窗复用设置页的 `DialogueApiFields`、`ModelPicker` 和 `ApiPresetGroups`。API 预设库共用，分组在设置中新建或编辑预设时填写。选预设、选模型和编辑字段都只改变草稿；外层「确定」才写入角色，取消不保存。配置保存为快照，修改或删除预设不会暗中改变角色。设置的 API 区显示所有使用独立配置的角色。

## 选择规则与当前接入范围

`utils/characterApi.ts` 的 `resolveDialogueApi(globalApi, character?, appApi?)` 是单角色回复的统一入口：

**App 明确指定的 API → 角色 dialogueApi → 全局 API。**

| 调用 | 行为 |
| --- | --- |
| 私聊，含重新生成 | 使用角色默认；当轮明确传入的覆盖优先 |
| 3D 家园角色回复 | 使用角色默认；识图与情绪评估保持专用配置，JSON 动作回复仍一次性解析 |
| 见面开场、回复、重新生成 | 使用实际参与本次请求的角色；切角色的开场显式传新角色 |
| 电话 / 视频电话主回复 | 使用角色默认；语音合成、视频动作导演仍用原配置 |
| 群聊逐人调用 | 每个成员单独解析，单个成员失败不影响后续成员 |
| 群聊统一生成、TRPG 等整场统筹 | 不传角色、不受角色默认 API 影响 |
| 彼方角色活动、SAR 单角色推演 | 彼方 App 独立 API 优先，否则跟随角色和全局 |
| SAR 身份铸造 | 系统任务，使用彼方 App / 全局配置 |
| 主动消息 2.0、云端即时聊天 | 与该角色对话配置一致 |
| 情绪、记忆、识图、TTS 等专用任务 | 保持各自原有的配置与回退规则 |

其他尚未接入的玩法保持原配置。新增入口先区分「单角色独立回复」「整场 / 多人生成」「专用处理」，不要因为请求含有人设或选中了某个角色就套角色 API。彼方历史数据中的 `vrState.api` 不再作为隐式覆盖来源；用户可见的彼方 API 入口只有 App 配置。

URL / Key / Model 整套选择，禁止逐字段从不同配置补齐。空 Key 保留为空，交给原调用链的无 Key 兼容或校验处理；配置不完整和请求失败都不会触发静默换模型。流式与温度可以使用所选配置，未设置则继承全局参数；不能把整个全局 `apiConfig` 替换成角色对象，它还包含语音、识图等其他用途的配置。

## 存储与云端

- `CharacterProfile.dialogueApi` 只保存文本模型相关字段，随个人系统备份保存。角色卡导出 / 导入均由 `stripSensitiveCardFields` 剥离，不能泄漏 Key 或覆盖收卡人的本地配置。
- 角色变更落库后触发现有 `syncAmsgLlmCredentials` 队列；传入新的配置快照，避免连续修改同一角色时被正在运行的同步清掉欠账。新 Worker 更新凭据行，旧 Worker 更新存量任务，沿用失败重试。
- `char:<id>/chat` 根据角色当前配置计算。`instant` 仍由本地当轮请求终值提供，情绪 / 记忆凭据不受角色对话 API 影响。
- 预设分组保存在 `ApiPreset.group`，缺省为未分组，改组不改变预设内容。

## 验证

`utils/characterApiPersistence.test.ts` 覆盖完整 ZIP 与纯文字游标分片 ZIP：清空角色库后重新导入，经过角色默认值和上下文迁移，再由真实 `useChatAI` 构造请求，断言地址、鉴权、模型、温度和流式参数；同时验证当轮覆盖、切回全局和预设分组保留。网络发送处使用测试替身，不调用外部模型。

`pnpm vitest run utils/characterApi.test.ts utils/characterApiPanel.test.ts utils/amsgLlmCredentials.test.ts utils/amsgStateSync.test.ts utils/apiPresetSwitch.test.ts utils/apiPresetSwitch.wiring.test.ts utils/characterCard.test.ts`

本地可视验收页：`/test/fixtures/character-api.html`。点击「加载演示配置」只写入该预览站点的虚构配置，不调用真实模型。可验证预设分组、保存 / 取消、跟随全局、跨页名单和窄屏布局。
