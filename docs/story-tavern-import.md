# 剧情中的酒馆开场白与预设

## 使用入口

1. 在神经链接导入酒馆 PNG / JSON 角色卡。
2. 进入「见面 → 剧情」，新增剧情并选择参与角色。
3. 保持「虚构剧场」，在「谁先落笔」选择「酒馆开场白」，选择主开场白或备选开场白。
4. 在「装载剧情预设」右侧上传酒馆 Chat Completion 预设 JSON，查看兼容说明。也可从剧情首页的预设库导入。
5. 保存并进入后，开场白直接作为第一条故事正文出现；从下一句接戏即可。

开场白保存为当前剧情的快照，`{{user}}` 使用当前面具名，`{{char}}` 使用开场白所属角色名。不会调用模型，也不写入角色正常聊天记录。剧情条目、第一楼和已处理回执在同一个 IndexedDB 事务保存；并发、重新进入和重试不会重复插入，删除第一楼后也不会自动恢复。已有正文或归档不会被补入新的开场白。长按正文可按既有功能编辑。

## 预设转换

- 接受糯米机原生预设和酒馆 **Chat Completion** 的 `prompts` / `prompt_order` 格式。选择 `character_id: 100001` 的默认顺序；没有该项时只接受唯一非空顺序，存在歧义时报错。
- 保留顺序、开关、消息角色、助手预填充和受支持的生成参数；未列入顺序的提示词保留为关闭状态。缺失的剧情连接位明确补入并写入说明，原文件明确关闭的连接位保持关闭。
- 角色描述与性格槽合并使用一份糯米机角色上下文。卡片场景和示例已在角色世界观与核心指令中，不按酒馆槽分别拆分或独立关闭；剧情 scenario 槽仍负责本剧情简介、归档与召回。这个转换不保证逐项等价。
- 支持普通提示词 `injection_position: 1` 的聊天深度和 `injection_order`，包含本轮输入，0 在输入之后、助手预填之前；超长深度钳到历史开头。同深度按 order 升序，同 order 按酒馆的 assistant / user / system 角色顺序。制作器的专业版可调整。占位符使用深度位置时导入报错，要求先改回相对位置。
- 支持 `temperature`、`top_p`、`frequency_penalty`、`presence_penalty`、`openai_max_tokens`，沿原生预设上下限归一化。不导入模型、API 地址、请求头、凭据、脚本或扩展设置。
- 仅替换 `{{user}}`、`{{char}}`、`{{group}}`。变量、条件、正则、脚本、工具调用与其他酒馆宏不执行或模拟；正文保留供手工调整。有专属 generation trigger 的提示词和未知占位符停用，并在说明中列出。Text Completion / instruct 配置不属于此入口。
- 转换说明在剧情配置页和预设制作器持续可见，保存和导出统一为糯米机原生格式，保留深度字段与说明。

格式依据 SillyTavern 官方 `public/scripts/PromptManager.js`、`public/scripts/openai.js` 和 `default/content/presets/openai/Default.json`，实现仅转换上述子集。

针对性验证：`utils/tavernPreset.test.ts`、`utils/storyTheaterOpening.test.ts`，以及既有剧情预设、回复和时间线测试。
