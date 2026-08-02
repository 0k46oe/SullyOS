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
});
