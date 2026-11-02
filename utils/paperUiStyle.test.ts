// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { applyPaperUiStyle, isSagePaperTheme } from './paperUiStyle';
import { paperStyle } from './paperStyle';

afterEach(() => { delete document.documentElement.dataset.paperUiStyle; });

describe('optional warm paper palette', () => {
  it('leaves old saves and explicit original style unchanged', () => {
    expect(isSagePaperTheme({})).toBe(false);
    expect(isSagePaperTheme({ skin: 'default', desktopVariant: 'paper' })).toBe(false);
    expect(isSagePaperTheme({ paperUiStyle: 'original' })).toBe(false);
  });
  it('activates for paper, including a customized wallpaper or theme hue', () => {
    expect(isSagePaperTheme({ paperUiStyle: 'sage-cream' })).toBe(true);
    expect(isSagePaperTheme({ skin: 'default', desktopVariant: 'paper', paperUiStyle: 'sage-cream' })).toBe(true);
  });
  it.each(['animalcrossing', 'mobilegame', 'tamagotchi', 'companion', 'homely'] as const)('does not recolor the %s skin', skin => {
    expect(isSagePaperTheme({ skin, paperUiStyle: 'sage-cream' })).toBe(false);
  });
  it('cleans up when switching to original, nostalgia, and another skin', () => {
    const root = document.documentElement;
    const theme = { skin: 'default', desktopVariant: 'paper', paperUiStyle: 'sage-cream' } as const;
    for (const off of [{ ...theme, paperUiStyle: 'original' } as const, { ...theme, desktopVariant: 'nostalgia' } as const, { ...theme, skin: 'homely' } as const]) {
      applyPaperUiStyle(root, theme);
      expect(root.dataset.paperUiStyle).toBe('sage-cream');
      applyPaperUiStyle(root, off);
      expect(root.hasAttribute('data-paper-ui-style')).toBe(false);
      applyPaperUiStyle(root, theme);
      expect(theme.paperUiStyle).toBe('sage-cream');
    }
  });
});

describe('memory UI inline color adapter', () => {
  it('preserves layout, does not mutate the source, and retains original fallbacks', () => {
    const source = { color: '#7c3aed', background: '#faf5ff', padding: 16, opacity: .7 };
    const adapted = paperStyle(source);
    expect(source).toEqual({ color: '#7c3aed', background: '#faf5ff', padding: 16, opacity: .7 });
    expect(adapted).toEqual({ color: 'var(--sp-green-ink, #7c3aed)', background: 'var(--sp-green-soft, #faf5ff)', padding: 16, opacity: .7 });
  });
  it('maps assembled gradients, borders and alpha colors', () => {
    const style = paperStyle({ background: 'linear-gradient(135deg, #a78bfa, #7c3aed)', border: '1px solid #7c3aed33', boxShadow: '0 2px 4px rgba(167,139,250,0.22)', color: '#fff' });
    expect(style.background).toBe('linear-gradient(135deg, var(--sp-green-soft, #a78bfa), var(--sp-green-soft, #7c3aed))');
    expect(style.border).toBe('1px solid rgba(var(--sp-green-ink-rgb, 124, 58, 237), 0.2)');
    expect(style.boxShadow).toContain('rgba(var(--sp-green-ink-rgb, 167, 139, 250), 0.22)');
    expect(style.color).toBe('var(--sp-green-ink, #fff)');
  });
  it('keeps gradient heading text dark enough and preserves true error colors', () => {
    expect(paperStyle({ background: 'linear-gradient(#7c3aed, #db2777)', WebkitBackgroundClip: 'text' }).background).toContain('--sp-green-ink');
    expect(paperStyle({ color: '#dc2626', background: '#fef2f2' })).toEqual({ color: '#dc2626', background: '#fef2f2' });
  });
  it('does not touch user media, URLs or non-color strings', () => {
    const style = { background: 'url("/image.svg#7c3aed")', fontFamily: '#7c3aed', transform: 'translateX(4px)' };
    expect(paperStyle(style)).toEqual(style);
  });
});
