import { describe, expect, it } from 'vitest';
import {
    JOURNAL_APPEARANCE_PRESETS,
    JOURNAL_CSS_SCOPE_HINT,
    JOURNAL_CSS_SCOPE_REGEX,
    flattenJournalAppearance,
    resolveJournalAppearanceCss,
    resolveJournalPreset,
} from './journalAppearance';
import { validateScopedCss } from './scopedCss';

describe('journalAppearance', () => {
    it('ships several scoped presets and keeps the original preset unchanged', () => {
        expect(JOURNAL_APPEARANCE_PRESETS.map(preset => preset.id)).toEqual([
            'original',
            'letterpress',
            'sakura',
            'forest',
            'midnight',
        ]);
        expect(resolveJournalPreset('original').css).toBe('');

        for (const preset of JOURNAL_APPEARANCE_PRESETS) {
            const validation = validateScopedCss(
                preset.css,
                JOURNAL_CSS_SCOPE_REGEX,
                JOURNAL_CSS_SCOPE_HINT,
            );
            expect(validation.errors, preset.name).toEqual([]);
        }
    });

    it('places custom CSS after the selected preset so users can override it', () => {
        const customCss = '.sully-journal-paper{border-radius:2px!important;}';
        const css = resolveJournalAppearanceCss({ preset: 'sakura', customCss });

        expect(css).toContain('.sully-journal-root');
        expect(css.endsWith(customCss)).toBe(true);
    });

    it('rejects CSS that would escape into another app', () => {
        const validation = validateScopedCss(
            '.sully-chat-root{display:none}',
            JOURNAL_CSS_SCOPE_REGEX,
            JOURNAL_CSS_SCOPE_HINT,
        );

        expect(validation.isValid).toBe(false);
    });

    it('flattens a preset and overrides into standalone CSS', () => {
        const override = '.sully-journal-paper{opacity:.9}';
        const standalone = flattenJournalAppearance({ preset: 'forest', customCss: override });

        expect(standalone.preset).toBe('original');
        expect(standalone.customCss).toContain('.sully-journal-calendar-hero');
        expect(standalone.customCss?.endsWith(override)).toBe(true);
        expect(resolveJournalAppearanceCss(standalone)).toBe(standalone.customCss);
    });
});
