# ElevenLabs 角色语音

Eleven v4 是 TTS（文字合成声音），不是 STT。电话的语音输入目前仍用浏览器 SpeechRecognition / Capacitor 系统插件，没有接入 ElevenLabs Scribe。

## 配置与默认行为

在「设置 → 其他 API」保存 ElevenLabs Key、选择 ElevenLabs 语音引擎和模型，再到「角色 → 语音」保存该角色的 Voice ID。聊天语音条、电话、见面和试听共用适配器。

- 新配置默认 `eleven_v4`，也可选择 `eleven_v4_turbo`。
- 旧配置已有明确模型时保留原选择，不强制迁移或自动切换服务商。
- v4 / Turbo 请求只发送 `stability` 和 `similarity_boost`，稳定度使用连续的 0–1 数值，不套 v3 的三档取整。
- 数值语速、Style、Speaker Boost 和 SSML 不受 v4 支持，不发送；旧参数保留给其他模型，设置与角色页会说明。
- 模型报错、权限不足、额度不足时直接提示错误，不偷偷重试旧模型。
- 官方 v4 单次上限 10000 字符；超限明确报错，不截断正文。本地没有给 Turbo 猜一个固定上限，限制以官方接口返回为准。

## 现有语音流程里的能力

| 能力 | 接入方式 |
| --- | --- |
| 情绪、音色质感、声音动作 | 保留开放式英文 `[Audio Tags]`，不使用 v3 的小白名单 |
| 音效与特殊演出 | 保留 `[door slams]`、`[applause]`、`[sings]` 等标签与自由描述，按场景生成 |
| 节奏、长短停顿、组合标签 | 保留标签、标点和原始换行，不压成单行、不合并长短停顿 |
| 发音控制 | 正文里的 `/IPA/` 原样传递 |
| 多语言与粤语 | 保留现有语种选择，放行 v4 / Turbo 的粤语；`yue` 不是 ISO 639-1，不传入 `language_code`，用粤语台词决定发音 |
| 见面语音 | 标签放在台词引号内部，TTS 保留；立绘 `[emotion]` 和语音 `[v:xxx]` 仍独立 |
| 字幕与收藏 | 字幕剥离演出指令；见面收藏沿用带标签的脚本生成音频，展示原台词 |
| 原生、开发环境、静态部署 | 原生直连、同源 `/api/elevenlabs/tts`、中心 Worker 三条路径共用请求体 |
| 本地音频缓存 | 仍保存完整 MP3 Blob；缓存键包含模型与实际请求参数，v4 和 Turbo 不混用 |

默认表演提示覆盖以上能力，使用多少标签由台词和场景决定。用户自己的语音指南优先，不覆盖其文字；旧指南若禁止方括号，可在设置中清空以恢复 v4 默认指南。

## 现有流程的限制

这次接入现有的单角色语音流程，没有把 ElevenLabs 所有 API 做成新产品入口：

- 使用 HTTP `/v1/text-to-speech/{voice_id}/stream`，前端仍收齐 Blob 才播放，没有 WebSocket 文本流输入或边生成边播。Turbo 的推理速度不等于当前播放器的首声延迟。
- 多说话人整段合成需要 Text to Dialogue API；现有角色分别发声，没有新增混合多角色音轨编辑器。
- 没有启用字符时间戳字幕、请求 ID 上下文拼接、发音词典管理、seed 或输出格式选择；当前输出仍为 `mp3_44100_128`。
- 克隆音色使用已有 Voice ID，不新增声音克隆上传或训练入口。Professional Voice Clone 是否已在账号上可用，以 ElevenLabs 音色状态和权限为准。
- v4 跨语言默认使用目标语言的自然发音，可能改变参考音色原先的外语口音；标签的执行效果也取决于所选音色。

## 维护入口

- `utils/elevenLabsModels.ts`：默认模型、选择项和能力判断的唯一来源。
- `utils/elevenLabsTts.ts`：表演指南、文本清洗、请求参数、传输与缓存。
- `utils/ttsProvider.ts`：给提示词使用的当前模型同步。
- `utils/ttsRouter.ts`：服务商分发、粤语门禁、字幕清洗。
- `utils/dateVoiceText.ts` / `components/date/DateSession.tsx`：见面台词提取、播放、字幕和收藏。
- `utils/datePrompts.ts`：保持 VN 格式的 v4 语音指导。

官方参考：[v4 模型说明](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4)、[Audio Tags 与 IPA](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices)、[HTTP 合成接口](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)、[模型列表](https://elevenlabs.io/docs/overview/models)。
