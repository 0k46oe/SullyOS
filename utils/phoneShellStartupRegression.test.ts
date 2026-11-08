import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('does not reference the removed deployment notice during startup', () => {
    const shell = readFileSync(resolve(__dirname, '../components/PhoneShell.tsx'), 'utf8');
    expect(shell).not.toMatch(/\bdeploymentNotice\b/);
    expect(shell).not.toMatch(/\buseDeploymentNotice\b/);
});
