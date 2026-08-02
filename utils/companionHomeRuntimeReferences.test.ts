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
    expect(dialogueSource).toContain('data-testid="companion-dialogue-surface"');
    expect(dialogueSource).toContain('pointer-events-none absolute inset-0 -z-10 border');
    expect(dialogueSource.indexOf('clipPath')).toBeLessThan(dialogueSource.indexOf('absolute -top-3'));
  });
});
