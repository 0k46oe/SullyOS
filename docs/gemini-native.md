# Gemini 原生接口与隐式缓存

设置 → API 接口、角色独立 API、API 预设的接口类型均可选择「Gemini 原生」。填官方根地址 `https://generativelanguage.googleapis.com`、`/v1beta`、`/v1beta/models` 或完整 `.../models/<model>:generateContent` 地址，以及 Key 和实际模型 ID。支持 `/v1` 与自定义路径前缀；中转必须提供 Gemini 原生协议和浏览器 CORS。不会根据官方域名自动切换协议，也不预填未经验证的模型别名。

支持 **Gemini Developer API 的 API Key 鉴权**，可按站点选择 `x-goog-api-key`、Bearer、URL `?key=` 或自动尝试。自动模式只在 HTTP 401/403 时依次尝试，每种方式最多一次。旧配置和缺少认证字段的预设默认使用 `x-goog-api-key`。不读取 service account 文件，不签发或刷新 OAuth token，不直接支持 Vertex AI；如需连接 Vertex AI，请使用能完成上游鉴权并提供 Gemini 原生协议的已认证代理。

## 请求与上下文

- `utils/llmEndpoint.ts` 将配置规范为 `/v1beta/models`（或用户指定的 `/v1/models`）。这个地址同时表达后台加密三字段凭据的协议，无需新增凭据字段。
- `utils/anthropicApi.ts` 的共享 `fetchLlm` 将 Gemini 请求交给 `utils/geminiApi.ts`，覆盖 safeApi、OSContext、连接测试、模型列表和 Worker SDK 内部出口。按请求选择协议，不注册全局凭据。
- 发送 `POST /models/<model>:generateContent`，流式使用 `:streamGenerateContent?alt=sse`。所选认证方式只在对应的一个请求位置传 Key；模型列表、普通生成和流式生成共用同一策略。不会发送 OAI 的 prompt_cache_key、stream_options 或 Anthropic cache_control。
- 模型列表按 nextPageToken 拉取；明确提供能力列表时只保留支持 generateContent 的模型，中转未提供能力列表时保留有名称的模型（具体能否生成由中转决定）。模型 ID 可以带 models/ 前缀，发送时去掉一层。
- 开头连续的 system/developer 按原文、原顺序放入首条 user Content 的 parts，不添加或改写稳定提示词；历史中途和尾部动态提醒保持原位置，以 system-reminder 上下文块表达。当前未能从可访问的官方资料确认 systemInstruction 的隐式缓存语义，因此不使用该字段，也不据此保证命中率。此映射让稳定设定处于 user 内容中，而非独立 systemInstruction。
- 支持文本、base64 图片及带 MIME 类型的 Gemini 可用文件 URI、函数工具、工具结果、JSON 输出意图和 JSON schema。文件 URI 是否可读取由上游决定；不在客户端下载外部图片。未知内容块明确报错。
- 将原生响应 parts 保存在 gemini_content，工具续答原样带回 thoughtSignature 与内容顺序。签名不伪造、不丢弃；本地工具循环与真实 amsg SDK 使用同一转换器。
- 思考展示开启时请求 includeThoughts，让模型使用自身的默认思考预算。显示服务实际返回的摘要，不制造思考内容，也不把模型名改成兼容渠道别名。
- SSE 按 UTF-8 分片增量解析；完成前继续读取末尾 usage。流内错误、内容拦截、缺少 finishReason 的截断均向上报错，取消传给上游。不自动重发付费请求。

## 缓存与用量

此接口使用服务端隐式缓存，不创建或引用显式 cachedContents，不设置缓存有效期。相同的稳定前缀、相近的请求间隔有利于复用，实际门槛和命中由模型与服务商决定；切换原生协议本身不保证提高命中率。协议转换层不会自行重复请求；HTTP 状态重试沿用 safeApi 的共享策略。

调用记录读取 usageMetadata.cachedContentTokenCount；未返回则保持未报告，服务返回 0 才显示 0。promptTokenCount 已包含缓存输入，不重复累加；输出统计包含 candidatesTokenCount 与 thoughtsTokenCount，总量优先采用 totalTokenCount。

全局设置、角色独立 API 和预设编辑器的连接测试共用 testDialogueConnection → createDialogueFetch → fetchLlm → toGeminiRequest，与聊天使用同一转换路径；沿用所选模型、流式、温度及最大输出 token（未设置时为 8000），不固定为 5 token。测试只发送 Hi，不应用或保存草稿，也不附加角色当轮思考展示或工具。凭据仅进入请求头，本地配置字段不进入原生请求。

## 主动消息 2.0

Worker 初始化的统一 fetch 转换器同时支持 Gemini。/config-check 返回 geminiNative: true；前台按探测过的 Worker 地址保存能力位。旧 Worker 未确认支持时阻止提交 Gemini 任务或凭据，并限时复查能力。能力位不从备份恢复，不跨 Worker 地址复用。发布前同步生成 worker/amsg/worker.bundle.js 和 public/amsg-worker.bundle.js；用户 Worker 更新到对应版本后后台原生请求才可用。

## 验证与资料

协议和集成测试覆盖端点归一化、配置/预设/角色保存、图文、原位置提醒、工具签名续答、JSON、分页模型列表、分片流式、末尾缓存用量、截断/错误/取消、真实 amsg SDK。使用模拟服务响应，无真实账户生成或账单命中验证。

官方协议参考：[generateContent 与流式](https://ai.google.dev/api/generate-content)、[函数调用与思考签名](https://ai.google.dev/gemini-api/docs/function-calling)、[上下文缓存](https://ai.google.dev/gemini-api/docs/caching)。
