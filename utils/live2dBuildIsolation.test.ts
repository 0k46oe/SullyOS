import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Live2D production chunk isolation', () => {
  const viteConfig = readFileSync(path.resolve(__dirname, '../vite.config.ts'), 'utf8');

  it('keeps the Cubism adapter out of the Pixi chunk eagerly used by the desktop theme', () => {
    const engineRule = "if (id.includes('untitled-pixi-live2d-engine'))";
    const pixiRule = "if (id.includes('@pixi/')";

    expect(viteConfig).toContain(engineRule);
    expect(viteConfig).toContain("return 'vendor-live2d-engine'");
    expect(viteConfig).toContain(pixiRule);
    expect(viteConfig.indexOf(engineRule)).toBeLessThan(viteConfig.indexOf(pixiRule));
    expect(viteConfig).not.toContain("id.includes('untitled-pixi-live2d-engine') || id.includes('@pixi/')");
  });
});
