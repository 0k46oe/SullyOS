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
  it('sequences a local touch impulse and uses the center star for real apps', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');

    expect(source).toContain('touchImpulseNonce={lastHit?.nonce}');
    expect(source).toContain('touchDialogueTimerRef.current = window.setTimeout');
    expect(source).toContain('data-testid="companion-app-star-button"');
    expect(source).toContain('data-testid="companion-app-star-panel"');
    expect(source).toContain("{ id: AppID.Call, label: '通话'");
  });
});
