import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveAndroidViewportState } from './iosStandalone';

const source = readFileSync(fileURLToPath(new URL('./iosStandalone.ts', import.meta.url)), 'utf8');

const resolve = (overrides: Partial<Parameters<typeof resolveAndroidViewportState>[0]> = {}) =>
    resolveAndroidViewportState({
        stableHeight: 800,
        innerHeight: 800,
        viewportHeight: 800,
        viewportOffsetTop: 0,
        virtualKeyboardHeight: 0,
        textEntryFocused: false,
        ...overrides,
    });

describe('Android/TWA keyboard viewport', () => {
    it('keeps the full app height when no text field is focused', () => {
        expect(resolve()).toEqual({ appHeight: 800, stableHeight: 800, keyboardOpen: false });
    });

    it('follows visualViewport when Chrome overlays the keyboard', () => {
        expect(resolve({ viewportHeight: 490, textEntryFocused: true })).toMatchObject({
            appHeight: 490,
            keyboardOpen: true,
        });
    });

    it('handles devices that shrink both layout and visual viewports', () => {
        expect(resolve({ innerHeight: 500, viewportHeight: 500, textEntryFocused: true })).toMatchObject({
            appHeight: 500,
            keyboardOpen: true,
        });
    });

    it('uses VirtualKeyboard geometry when viewport metrics remain full-size', () => {
        expect(resolve({ virtualKeyboardHeight: 310, textEntryFocused: true })).toMatchObject({
            appHeight: 490,
            keyboardOpen: true,
        });
    });

    it('opts fullscreen TWA into VirtualKeyboard geometry reporting', () => {
        expect(source).toContain('virtualKeyboard.overlaysContent = true');
        expect(source).toContain("virtualKeyboard.addEventListener?.('geometrychange'");
    });

    it('does not mistake browser toolbar movement for a keyboard without focus', () => {
        expect(resolve({ viewportHeight: 690, viewportOffsetTop: 40 })).toMatchObject({
            appHeight: 800,
            keyboardOpen: false,
        });
    });
});
