import type { OSTheme } from '../types';

type PaperTheme = Pick<OSTheme, 'skin' | 'desktopVariant' | 'paperUiStyle'>;

/** Opt in only on the paper desktop; keep the preference when visiting other skins. */
export function isSagePaperTheme(theme: PaperTheme): boolean {
  return (!theme.skin || theme.skin === 'default')
    && theme.desktopVariant !== 'nostalgia'
    && theme.paperUiStyle === 'sage-cream';
}

export function applyPaperUiStyle(root: HTMLElement, theme: PaperTheme): void {
  if (isSagePaperTheme(theme)) root.dataset.paperUiStyle = 'sage-cream';
  else delete root.dataset.paperUiStyle;
}
