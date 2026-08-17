Original prompt: 先继续优化都市人生 simsapp：去掉 pics 里的丑像素家具/房屋贴图，改成自己画的像素图；并把“吃瓜”从单纯调用 API 引导 char 行动，升级为随机触发“角色剧情”或“主线剧情”，主线剧情要有明显标题和附件栏，附件可包含图片、道具、证据、同人文等。

2026-03-19
- Removed the hardcoded building PNG override in `utils/tinyTownTiles.ts` so LifeSim now uses generated pixel-style town tiles instead of `pics` house textures.
- Added story attachment types, world-drama prompt helpers, fallback attachment generation, and `materializeStoryAttachments` so main-plot events can drop image/item/evidence/fanfic payloads.
- Added `apps/lifesim/StoryAttachments.tsx` for compact attachment cards plus a modal detail viewer.
- Wired `apps/LifeSimApp.tsx` so `吃瓜` now randomly branches into either normal char-driven drama or a no-char main-plot event from `主线编剧室`.
- Seeded replay actions correctly for the new branch and moved `runCharTurns` above the user action handlers to avoid referencing it before initialization.
- Added a no-API fallback for char turns so the sim no longer gets stuck when external model settings are empty; chars will still produce lightweight “围观” replay entries.
- Updated the drama feed and replay overlay to surface main-plot badges, headlines, and attachment shelves.
- `npm run build` passes after the LifeSim changes.
- Automated Playwright validation is currently blocked because `C:\Users\tiaotiao\.codex\skills\develop-web-game\scripts\web_game_playwright_client.js` cannot resolve the `playwright` package in this environment.
- Added drama filters (`全部 / 角色 / 主线 / 系统`) and changed the normal drama log to keep the full scrollable history instead of truncating to 50.
- Added a LifeSim settings panel for selecting which external characters are allowed to participate in the sim.
- Added long-press NPC editing so residents can be edited in-place for this run (name / gender / personality / bio / backstory).
- Replaced the browser-native reset confirm with a custom retro dialog that can either reset directly or generate a LifeSim ending summary card before resetting.
- Added a new `lifesim_reset_card` score-card payload and wired it through chat rendering plus readable archive/context formatting in Chat / Character / chat prompt history.
- Text attachments like fanfic/evidence now surface the original text as the primary reading area in the attachment modal.
- Adjusted `apps/lifesim/DramaFeed.tsx` so main-plot actions also remain visible in the left-hand dynamic stream under `全部 / 主线`, instead of being excluded from `drama.log`.
- Restyled the LifeSim reset summary card in `components/chat/MessageItem.tsx` to look more like the game's retro pseudo-window UI (sharper borders, title bar, grid texture, status bar).
- `npm run build` still passes after the latest DramaFeed + chat-card styling changes.
- Automated browser validation is still blocked locally because `require('playwright')` fails with `MODULE_NOT_FOUND`.

2026-08-17 — Qixi visual retheme
- Current request: rebuild the Qixi entry screen to match the supplied celestial poster reference, then retheme the in-game surfaces using the supplied deep-purple / lavender / blush-gold fantasy palette.
- Constraints: preserve the existing Qixi memory-generation and smart-context behavior; visual/layout changes only unless a UI integration fix is required.
- Visual thesis: a full-screen storybook night poster with deep plum space, lavender mist, cream moonlight, and restrained blush-gold ornament.
- Planned validation: Qixi entry at mobile and desktop sizes, then fake chat and first interlayer screens; inspect screenshots, render_game_to_text, and console errors.

- Removed LifeSim's autonomous NPC interaction step from the main turn flow, so only user-triggered actions and char/main-plot API turns advance the story now.
- Added LifeSim-specific independent API settings with global preset loading and a Gemini Flash recommendation, and persisted them on the LifeSim state so city resets do not wipe the app-specific config.
- Reworked `apps/lifesim/DramaFeed.tsx` again so `主线历史` appears above the current main-plot detail view, while keeping the archive separate from the general drama stream.
- Tightened LifeSim scroll behavior across the main panel, settings panel, action panel, and attachment viewer by hiding scrollbars and blocking horizontal overflow except for the attachment strip itself.
- `npm run build` passes after the latest LifeSim logic + layout + settings changes.

TODO
- If local browser testing is possible, verify both `吃瓜 -> 角色剧情` and `吃瓜 -> 主线剧情` paths and inspect attachment modal behavior.
- Install or provide `playwright` if automated screenshot-based UI validation is needed later.

2026-03-21
- Added a new global chat appearance setting, [0mchatAvatarMode[0m, so users can choose between grouped avatars and showing an avatar on every message.
- Rebuilt components/appearance/ChatAppearanceEditor.tsx into a clean modular version and updated the live preview so repeated-message avatar behavior is visible before applying.
- Wired the new avatar mode into pps/Chat.tsx and components/chat/MessageItem.tsx, including React.memo comparisons so appearance toggles reliably re-render existing messages.
- 
pm run build passes after the chat-avatar-frequency changes.
- Playwright validation is still blocked locally because the skill client cannot resolve the playwright package in this environment (ERR_MODULE_NOT_FOUND).

- Updated chat message grouping in pps/Chat.tsx so consecutive messages now split not only by sender role but also by a 30-minute time gap, preventing early messages from visually merging into much later ones on either side of the conversation.
- 
pm run build passes after the time-gap grouping fix.

2026-08-17 — Qixi visual retheme completed
- Rebuilt the Qixi entry screen as a full-screen celestial storybook poster with visible brand/exit, moon phases, oversized title, oval CTA, and status copy.
- Applied a cohesive deep-plum, lavender, blush, and cream-moonlight palette through fake chat, distortion, interlayer, exploration, core, touch, and ending screens without changing story or memory logic.
- Verified the desktop entry and the mobile cover → fake chat → distortion → interlayer entry → first exploration sequence with rendered screenshots; no console or page errors were reported.
- `utils/qixiMemoryBundle.test.ts` passes (2 tests) and the production build succeeds.

2026-08-17 — Qixi dual-layer story rewrite
- Original prompt for this rewrite: read `qixi_reworked (1).md`, expand the inadequate 2–5 memory-anchor design, and implement the approved Qixi rewrite list.
- Visual thesis: a deep-plum context interlayer where User and Char are represented by two restrained text colors, with one shared ritual object dominating each full-screen scene.
- Content plan: preserve the celestial entry/fake chat/rabbit door, then run seven evidence-backed dual-layer rituals, form the bridge, reveal Char for the first time, hold to touch, and return to ordinary chat.
- Interaction thesis: the other-layer color gradually appears; shared objects visibly move from the unseen side; seven traces converge into one bridge transition. Keep copy and controls sparse.
- Implementation order: v2 material schema and recall, v7 game state/scenes, reunion generation and portrait fallback, touch/return-to-chat, tests/build/Playwright screenshots.
- Do not fabricate memories to satisfy anchor counts. Rich context targets 12–18 evidence anchors (cap 24); sparse context degrades personalization instead.

TODO — Qixi rewrite
- Replace qixi memory bundle v1 and invalidate stale per-character cache.
- Replace fixed NPC nodes, early reveal copy, 5+3 hidden gate, fixed four-page core, finalEcho, long touch monologue, and repeated ending thesis.
- Preserve the existing full-screen art direction and deterministic `render_game_to_text` / `advanceTime` hooks.

2026-08-17 — Qixi v2 material layer
- Replaced the 2–5-anchor v1 bundle with evidence (target 12–18, cap 24), typed artifacts (cap 40), seven scene payloads, per-scene personalization flags, and context-signature cache invalidation.
- Expanded source gathering to 160 recent messages plus three focused memory-palace recalls covering difficult emotions, wishes/future, and daily objects/language.
- Added local per-scene fallback content so sparse/invalid model output does not invent memories or make the activity unplayable.
- Added parser tests for rich evidence retention, hard caps/provenance filtering, and sparse response rejection. All 3 assertions pass; Vitest then hits an environment-only EPERM writing `node_modules/.vite/vitest/results.json`.

2026-08-17 — Qixi dual-layer rewrite implemented and browser-verified
- Replaced the old exploration/core/final-echo structure with a v7 flow: celestial cover, fake chat, CSS white-rabbit door, interlayer entry, seven shared-object scenes, bridge, generated reunion, hold-to-touch, short ending, and return to ordinary chat.
- Each of the seven scenes now has its own dominant CSS/SVG object, User action, independently rendered other-layer action, reveal, and saved decision; the word-cloud scene requires three selections and supports separate User/Char colors.
- Added a separate final reunion generator with technical-language and coercive-promise filtering plus portrait priority `Live2D -> meeting sprite -> static avatar -> chibi/initial fallback`.
- The ending saves one deduplicated assistant chat message, marks the special-moment record complete, selects the character, opens Chat, and now auto-returns reliably even when the OS parent re-renders.
- Added image-load fallback, removed a visible `Char` placeholder from sparse-context copy, replaced the missing-glyph rabbit with a CSS silhouette, and made bridge line angles valid CSS variables.
- `utils/qixiMemoryBundle.test.ts` and `utils/qixiReunion.test.ts` pass together (5 tests) with Vitest `--no-cache`.
- Full desktop flow and mobile flow were exercised in the in-app Browser, including early-release feedback, sustained 1.25s touch, generated/fallback reunion, portrait loading, automatic chat return, and persisted return message.
- The standalone skill Playwright client remains unavailable because its local package import fails; in-app Browser validation was used as the supported fallback.
- Production build passes with 6,100 modules transformed when emitted to an isolated output directory; the temporary build output was removed afterward.
