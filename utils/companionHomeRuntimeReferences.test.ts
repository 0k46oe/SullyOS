import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CompanionHome touch request boundaries', () => {
  it('only requests a generated pack and rotates reactions locally on tap', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');

    expect(source).toContain('requestAvatarTouchReactionPack');
    expect(source).toContain('reactions[cursor % reactions.length]');
    expect(source).not.toContain('requestAvatarTouchReply');
    expect(source).not.toContain('DB.saveMessage');
  });
  it('pre-generates touch voice only when opted in and plays persisted audio without per-tap TTS', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const voiceSource = readFileSync(path.resolve(__dirname, './avatarTouchVoice.ts'), 'utf8');

    expect(source).toContain('data-testid="companion-touch-generate-voice"');
    expect(source).toContain('if (touchGenerateVoice)');
    expect(source).toContain('createAvatarTouchVoiceUrl(reaction)');
    expect(source).not.toContain('synthesizeSpeechDetailed(');
    expect(voiceSource).toContain('synthesizeSpeechDetailed(');
    expect(voiceSource).toContain('DB.putBlobAsset');
    expect(voiceSource).toContain('VOICE_CONCURRENCY = 2');
  });

  it('sequences a local touch impulse and uses the center star for real apps', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');

    expect(source).toContain('touchImpulseNonce={lastHit?.nonce}');
    expect(source).toContain('touchDialogueTimerRef.current = window.setTimeout');
    expect(source).toContain('data-testid="companion-app-star-button"');
    expect(source).toContain('data-testid="companion-app-star-panel"');
    expect(source).toContain("{ id: AppID.Call, label: '通话'");
  });
  it('renders an ornate flat action rail and clips only the dialogue background', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const dialogueStart = source.indexOf('data-testid="companion-dialogue"');
    const dialogueEnd = source.indexOf('手游底部主导航', dialogueStart);
    const dialogueSource = source.slice(dialogueStart, dialogueEnd);
    const dockStart = source.indexOf('data-testid="companion-ornate-dock"');
    const dockEnd = source.indexOf('布置模式', dockStart);
    const dockSource = source.slice(dockStart, dockEnd);

    expect(source).toContain('data-testid="companion-ornate-action-rail"');
    expect(source).toContain('data-visual-style="ornate-flat"');
    expect(source).toContain('viewBox="0 0 82 356"');
    expect(source).toContain('data-testid="companion-ornate-dock"');
    expect(source).not.toContain('companion-star-pulse');
    expect(dockSource).not.toContain('radial-gradient');
    expect(dockSource).not.toContain('boxShadow');
    expect(dockSource).toContain('grid h-full grid-cols-5 items-center');
    expect(dockSource).toContain('flex h-14 w-14 shrink-0 items-center justify-center rounded-full border');
    expect(dockSource).not.toContain('items-end gap-1');
    expect(dialogueSource).toContain('data-testid="companion-dialogue-surface"');
    expect(dialogueSource).toContain('pointer-events-none absolute inset-0 -z-10 border');
    expect(dialogueSource.indexOf('clipPath')).toBeLessThan(dialogueSource.indexOf('absolute -top-3'));
  });

  it('uses one medium HUD scale and surfaces real character context', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');

    expect(source).toContain('data-testid="companion-context-hud"');
    expect(source).toContain('data-testid="companion-hud-thought"');
    expect(source).toContain('data-testid="companion-hud-chat"');
    expect(source).toContain('data-testid="companion-hud-schedule"');
    expect(source).toContain('DB.getRecentMessagesByCharId');
    expect(source).toContain('getLastInnerState(character.id)');
    expect(source).toContain('getDailyScheduleForChar(character)');
    expect(source).toContain('data-ui-scale="medium"');
  });

  it('routes the three context tiles to distinct character destinations', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');

    expect(source).toContain('onClick={() => openApp(AppID.CheckPhone)} className="min-w-0 border-r');
    expect(source).toContain('onClick={() => openApp(AppID.Chat)} className="min-w-0 border-r');
    expect(source).toContain('data-testid="companion-hud-schedule"');
  });

  it('keeps one companion layout while exposing four backed-up frame languages', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const appearanceSource = readFileSync(path.resolve(__dirname, '../apps/Appearance.tsx'), 'utf8');
    const frameSource = readFileSync(path.resolve(__dirname, '../components/os/companionFrameStyles.ts'), 'utf8');
    const backupSource = readFileSync(path.resolve(__dirname, './desktopSkinBackup.ts'), 'utf8');

    expect(source).toContain('data-companion-frame={frameStyle}');
    expect(appearanceSource).toContain('data-testid="companion-frame-style-picker"');
    for (const id of ['tech', 'mobilegame', 'storycard', 'editorial']) {
      expect(frameSource).toContain(`id: '${id}'`);
    }
    expect(backupSource).toContain("'companion_frame_style_v1'");
  });

  it('keeps system settings on opaque neutral surfaces', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/Settings.tsx'), 'utf8');

    expect(source).toContain('bg-[#f3f4f8]');
    expect(source).toContain('bg-[#fffefe]');
    expect(source).not.toContain('bg-slate-50/50 flex flex-col');
  });

  it('runs only user-owned startup dialogue with a focused authored performance', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const startupSource = readFileSync(path.resolve(__dirname, './companionStartup.ts'), 'utf8');
    const tamagotchiSource = readFileSync(path.resolve(__dirname, '../components/os/TamagotchiHome.tsx'), 'utf8');

    expect(source).toContain('data-testid="companion-startup-enabled"');
    expect(source).toContain('data-testid="companion-startup-line"');
    expect(source).toContain('data-testid="companion-startup-precision"');
    expect(source).toContain('data-testid="companion-save-startup"');
    expect(source).toContain('requestCompanionStartupDraft');
    expect(source).toContain("label: '开机自启'");
    expect(source).not.toContain('period.lines');
    expect(source).not.toContain('greetPerformance');
    expect(startupSource).toContain('lockAutonomy: true');
    expect(startupSource).toContain('不要替桌面主题说话');
    expect(tamagotchiSource).not.toContain('POKE_FALLBACK');
  });
});