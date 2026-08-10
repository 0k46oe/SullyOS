import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CallApp runtime references', () => {
  it('uses the exported avatar prompt builder and no missing high-quality builder', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');

    expect(source).not.toContain('buildHighQualityAvatarPerformancePrompt');
    expect(source).toContain('buildAvatarPerformancePrompt(allowedModelActions)');
    expect(source).toContain("selectedChar?.videoCallPerformanceQuality === 'high'");
  });

  it('keeps the master call-runtime bridges present beside the custom video stage', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');

    expect(source).toContain("import { getPendingReplyText } from '../utils/pendingReply'");
    expect(source).toContain("import { markAmsgStateDirty } from '../utils/amsgStateSync'");
    expect(source).toContain("const [memoryPalaceStatus, setMemoryPalaceStatus] = useState('')");
    expect(source).toContain('const retryBubble = latestBubble?.role === \'user\'');
    expect(source.match(/markCallTurnDirty\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('routes every memory-palace trigger through the defined call hook', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');

    expect(source).not.toContain('runMemoryPalacePostHook');
    expect(source).toContain('const runCallMemoryPalaceHook = (char: CharacterProfile) =>');
    expect(source.match(/runCallMemoryPalaceHook\(selectedChar\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('offers game-like video layouts and a collapsible immersive subtitle', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');

    for (const id of ['stage', 'story', 'mini']) {
      expect(source).toContain(`id: '${id}'`);
    }
    expect(source).toContain('data-testid="video-call-layout-picker"');
    expect(source).toContain('data-testid="video-call-subtitle"');
    expect(source).toContain('data-testid={callMode === \'video\' ? \'video-call-compact-controls\' : undefined}');
    expect(source).toContain("videoCallLayout === 'stage' ? 'flex-1 min-h-0' : 'shrink-0'");
    expect(source).toContain("? 'min-h-[260px]'");
    expect(source).toContain("callMode === 'video' ? 'h-10 w-10'");
    expect(source).toContain("videoCallLayout === 'stage'");
    expect(source).toContain('setVideoTranscriptExpanded(true)');
  });

  it('keeps the character picker visible before optional video settings', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    expect(source).toContain('data-testid="call-character-picker"');
    expect(source).toContain('min-h-[5rem] max-h-[15rem]');
    expect(source).toContain('h-full overflow-y-auto overscroll-contain');
    expect(source).toContain('data-testid="video-call-advanced-settings"');
    expect(source).toContain('模型画质、导入与动作排练');
  });

  it('schedules opening and closing performance beats against the real audio duration', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    expect(source).toContain('expandAvatarPerformanceCueBeats(cues, durationMs)');
    expect(source).toContain('applyPerformanceDirection(beat.direction)');
  });

  it('keeps lip sync and performance running when call audio is unavailable', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    expect(source).toContain('const playSilentAvatarSpeech = (');
    expect(source).toContain("if (callMode === 'video') playSilentAvatarSpeech(assistantText, turnPerformanceCues)");
    expect(source).toContain('playSilentAvatarSpeech(rerolled, rerollReply.performanceCues)');
    expect(source).toContain('playSilentAvatarSpeech(reply.text, reply.performanceCues)');
    expect(source).toContain("playSilentAvatarSpeech('', cues, estimatedDurationMs)");
  });

  it('shows precise touch targets without blurring the feedback copy', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    const feedbackSource = readFileSync(path.resolve(__dirname, '../components/call/AvatarTouchFeedback.tsx'), 'utf8');
    expect(source).toContain('label: avatarTouchTargetLabel(hit)');
    expect(source).toContain('...(part ? { part } : {})');
    expect(feedbackSource).not.toContain('filter: blur');
    expect(feedbackSource).not.toMatch(/sully-touch-float-copy[\s\S]*?scale\(/);
  });

  it('keeps the built-in Sully model lightweight by default', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');

    expect(source).toContain('data-testid="builtin-sully-quality-picker"');
    expect(source).toContain("value: 'balanced' as const");
    expect(source).toContain("value: 'hd' as const");
    expect(source).toContain('maxFps={30}');
  });

  it('keeps all four user-camera modes isolated and opt-in', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    const pickerSource = readFileSync(path.resolve(__dirname, '../components/call/UserCameraModePicker.tsx'), 'utf8');

    for (const mode of ['off', 'fake', 'emotion', 'snapshot']) {
      expect(pickerSource).toContain(`id: '${mode}'`);
    }
    expect(source).toContain("includeUserCameraContext");
    expect(source).toContain("userCameraMode === 'emotion'");
    expect(source).toContain('await captureUserCameraEmotionContext()');
    expect(source).toContain("userCameraMode === 'snapshot'");
    expect(source).toContain('captureUserCameraSnapshotContext()');
    expect(source).toContain('attachSnapshotToLatestUserMessage(messages, userCameraSnapshot)');
    expect(source).toContain('userCameraSnapshot ? 0 : 2');
    expect(source).toContain('isVisionInputUnsupportedError(error)');
    expect(source).toContain('await requestAssistantReply(input, userDbId, pendingTouchesForTurn, true)');
    expect(source).toContain('data-testid="user-camera-emotion-readout"');
    expect(source).toContain("const [userCameraMode, setUserCameraMode] = useState<UserCameraMode>('off')");
    expect(source).toContain('这张图只用于画面，不会发送给角色');
    expect(source).toContain("userCameraStreamRef.current?.getTracks().forEach(track => track.stop())");
  });

  it('guides model import, framing, wardrobe and camera privacy before the first video call', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    const guideSource = readFileSync(path.resolve(__dirname, '../components/call/CallSetupGuide.tsx'), 'utf8');

    expect(source).toContain("const CALL_SETUP_GUIDE_KEY = 'sully-call-setup-guide-v2'");
    expect(source).toContain("openCallSetupGuide(selectedChar?.videoAvatar ? 'camera' : 'model')");
    expect(source).toContain('beginSelectedCall(setupCameraMode)');
    expect(source).toContain('onChooseFakeImage={() => chooseFakeUserCameraImage(false)}');
    expect(guideSource).toContain('data-testid="call-setup-guide"');
    expect(guideSource).toContain('校准构图与真·衣橱');
    expect(guideSource).toContain('下次打开仍从关闭开始');
    expect(guideSource).toContain('本地情绪只注入');
    expect(guideSource).toContain('静态机位永远不随消息发送');
  });

  it('requires explicit acknowledgement before saving a VRM test import', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    const warningSource = readFileSync(path.resolve(__dirname, '../components/call/VRoidBetaWarning.tsx'), 'utf8');

    expect(source).toContain('setPendingVRoidImport({ file, characterId: character.id, projectFile: false })');
    expect(source).toContain('const confirmVRoidImport = async () =>');
    expect(warningSource).toContain('并不是本次版本的开发重点');
    expect(warningSource).toContain('可能存在各种 Bug');
  });
});
