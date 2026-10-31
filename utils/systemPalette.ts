import type { OSTheme } from '../types';
export type InterfaceStyle = 'claude-paper' | 'monochrome' | 'legacy';
export function resolveSystemPalette(theme: Pick<OSTheme, 'interfaceStyle' | 'interfaceColorMode' | 'darkMode'>, systemDark = false) {
    const style = theme.interfaceStyle === 'monochrome' || theme.interfaceStyle === 'legacy' ? theme.interfaceStyle : 'claude-paper';
    const dark = theme.interfaceColorMode === 'system' ? systemDark : theme.interfaceColorMode === 'dark' || (theme.interfaceColorMode === undefined && theme.darkMode);
    return { style, dark };
}
