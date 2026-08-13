import { describe, expect, it } from 'vitest';
import { parseAndroidUpdateManifest } from './androidAppUpdate';

const validManifest = {
  schemaVersion: 1,
  versionCode: 30402,
  versionName: '3.4.2',
  apkUrl: 'https://github.com/example/app/releases/download/v3.4.2/app.apk',
  sha256: 'a'.repeat(64),
  sizeBytes: 37_000_000,
  releaseNotes: ['修复更新按钮', '', 123],
};

describe('parseAndroidUpdateManifest', () => {
  it('accepts and normalizes a valid manifest', () => {
    expect(parseAndroidUpdateManifest(validManifest)).toMatchObject({
      versionCode: 30402,
      versionName: '3.4.2',
      sha256: 'a'.repeat(64),
      releaseNotes: ['修复更新按钮'],
    });
  });

  it.each([
    ['bad schema', { ...validManifest, schemaVersion: 2 }],
    ['bad version', { ...validManifest, versionCode: 0 }],
    ['insecure url', { ...validManifest, apkUrl: 'http://example.com/app.apk' }],
    ['bad digest', { ...validManifest, sha256: 'nope' }],
    ['bad size', { ...validManifest, sizeBytes: -1 }],
  ])('rejects %s', (_name, manifest) => {
    expect(() => parseAndroidUpdateManifest(manifest)).toThrow();
  });
});
