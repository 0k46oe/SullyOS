# 角色默认对话 API

## 本地普通私聊：Anthropic 原生接口

设置和角色独立 API 的「接口格式」可选 OpenAI 兼容或 Anthropic 原生 Messages。协议随预设、角色配置和备份保存；旧配置缺省为 OpenAI，不会因全局选择 Anthropic 而改变旧角色独立配置的协议。URL / Key / Model / 协议整体选择。

Anthropic 支持浏览器内的普通私聊（含文字、图片、连续对话、重新生成），可通过「流式输出」开关选择流式或非流式。默认不发送温度参数，界面明确显示「模型默认」；开启「自定义温度」后可设置 0～1、步长 0.01，并发送所选 `temperature`，包含 0。`anthropicCustomTemperature` 开关随全局、预设、角色配置和备份保存；旧原生预设缺省为模型默认，不继承上一套 API 的自定义开关。角色或 App 独立端点也不继承全局的自定义开关。模型若拒绝温度参数，直接报告原始错误，用户可关闭自定义温度；不会自动重试或静默换模型。OpenAI 原有温度范围 0～2 保持不变。开关在 Anthropic 接口字段中直接显示。URL 支持服务根地址、`/v1` 和完整 `/v1/messages`；鉴权使用 `x-api-key` 和 `anthropic-version`。接口须允许浏览器跨域请求。模型列表按同一协议获取，列表不可用时仍可手动填模型。

`utils/dialogueTransport.ts` 只在本地私聊请求边界转换 system/history 和响应，复用既有提示词、取消和后处理；不改 Worker、其他 App、专用视觉或语音请求。`utils/anthropicStream.ts` 解析原生 Messages SSE：实时回传文字增量，按索引拼接工具参数并合并 usage，收到 `message_stop` 后停止读取。HTTP 200 内的错误事件、损坏事件和提前断流均报错，不把半条回复当成功，也不自动重发付费请求。接口返回整包 JSON 时兼容非流式响应；关闭流式开关后不触发文字预览。

选择原生协议的私聊不进入 OpenAI 云端即时聊天。支持视觉的模型可以使用同一套 Anthropic API 直接接收图片，再选择流式或非流式回复，不强制配置独立识图。当前与选定上下文中的历史图片、多图和混合图文都会保留。网络出口先还原 `blobref:` 本机引用，再将 data URL 拆为原生 `image` 块的 `base64` / `media_type` / `data`，HTTP(S) 外链转换为 `url` 图片源；支持 PNG、JPEG、GIF、WebP，不转发 OpenAI 的 `detail`。丢失的本机图片、损坏的 base64 或不支持的图片格式在发送前明确报错，不静默删图或改用其他模型。外链须能被接口服务读取，图片大小、数量和模型视觉能力以所选服务限制为准。

已经显式开启的独立识图仍按原规则先转换为文字描述，再交给聊天模型；想让主模型直接看图时，关闭独立识图即可，不会自动替用户切换该设置。自动注入的本地工具有协议转换以免阻断普通聊天，但工具玩法不在本次验收范围。

### 原生思考与提示词缓存

角色原有的「思考过程展示／心象」开关同时控制原生思考请求：通过既有 `shouldSendThinkingParams` 门禁后发送 `thinking: { type: 'enabled', budget_tokens: 4000 }`，最大输出沿用 8000。工具模式原有门禁保持不变，不根据模型后缀私自打开思考。开启原生思考时省略 `temperature`，避免与自定义采样冲突。接口须支持此思考格式；报错不会自动改参数、改模型或重发。每次使用当前选择的完整模型 ID，包含 `【反重力】` 等前缀及 `-thinking` 等后缀，不硬编码用户示例，不追加或去掉后缀。

非流式的 `thinking` 块转换为既有 `reasoning_content`，流式的 `thinking_delta` 通过 `onReasoningDelta` 实时显示，完成后保存到原来的 `metadata.thinkingChain`。只展示服务实际返回的思考内容或摘要；服务不返回时不会编造，也不能解密 `redacted_thinking`。签名分片只用于当前请求中的工具衔接，不显示为正文或保存到聊天气泡。停止、断流和报错沿用原有回复取消规则。

「提示词缓存」默认开启，可在全局、角色独立 API 和原生预设中关闭；字段为 `anthropicPromptCache`，随配置、预设快切和系统备份保存。独立端点未配置时使用自身默认值，不继承另一端点的关闭状态。请求保留独立 system 文字块，只在 `chatRequestPayload` 生成的**首条稳定 system 前缀**末块放置 `cache_control: { type: 'ephemeral' }`；后续时间、召回和实时状态在断点之后，不纳入这个缓存前缀。不添加用户聊天历史缓存断点，也不缓存到本机替代服务端缓存。

首次通常写入；相同前缀达到模型所需最小长度、在有效期内再次请求且中转／上游支持时，才可能读取。修改人设、世界书、工具或其他断点之前的内容会使前缀变化。标记不会保证命中，关闭后不发送缓存标记，不支持标记的中转可关闭。不自动重发付费请求，也不伪造命中量。

设置 → API 调用记录接入本地原生 Messages 请求，按接口实际返回的 `cache_creation_input_tokens` / `cache_read_input_tokens` 显示「缓存写入 Token／缓存读取 Token」；未报告时不展示该项，明确报告 0 时展示 0。原生输入总量 = `input_tokens` + 缓存写入 + 缓存读取，输出单列，总量只相加一次。流式合并起始和末尾 usage 后记账，OpenAI 的已有统计保持其原有口径。参数契约核对了 Anthropic 官方 SDK 的 Messages 类型声明；未使用真实 Key 调用服务，也未验证任何中转的实际计费或命中。

新增 `utils/anthropicThinkingCache.test.ts` 和 `utils/anthropicChatThinking.test.ts`，并扩展真实聊天 hook 的流式回归：覆盖模型全名、请求参数、温度冲突、文字／图片、流式／非流式思考展示与保存、缓存前缀稳定性、参数关闭与配置保存、真实 usage 读写记账，以及拒绝请求不重试。测试使用模拟网络；服务端真实缓存命中仍须在用户部署中观察。

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
