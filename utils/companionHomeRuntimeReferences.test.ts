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
});
