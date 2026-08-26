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

    it('gives every non-original preset its own layout language instead of a shared recolored shell', () => {
        const themed = JOURNAL_APPEARANCE_PRESETS.filter(preset => preset.id !== 'original');
        expect(new Set(themed.map(preset => preset.layout)).size).toBe(themed.length);

        for (const preset of themed) {
            expect(preset.css, preset.name).toContain(`.sully-journal-theme-${preset.id}`);
            expect(preset.css, preset.name).toContain('.sully-journal-notebook-grid');
            expect(preset.css, preset.name).toContain('.sully-journal-calendar-list');
            expect(preset.css, preset.name).toContain('.sully-journal-spread');
            expect(preset.css, preset.name).toContain('@media(max-width:719px)');
        }

        expect(resolveJournalPreset('letterpress').css).toContain('.sully-journal-post-route');
        expect(resolveJournalPreset('sakura').css).toContain('.sully-journal-celestial-map');
        expect(resolveJournalPreset('forest').css).toContain('.sully-journal-field-rings');
        expect(resolveJournalPreset('midnight').css).toContain('.sully-journal-memory-circuit');

        expect(resolveJournalPreset('letterpress').css).toContain('grid-template-columns:repeat(auto-fit,minmax(220px,1fr))');
        expect(resolveJournalPreset('sakura').css).toContain('.sully-journal-notebook:first-child{grid-column:1/-1');
        expect(resolveJournalPreset('forest').css).toContain('grid-template-columns:1fr!important');
        expect(resolveJournalPreset('midnight').css).toContain('grid-template-columns:repeat(3,minmax(0,1fr))');
    });

    it('places custom CSS after the selected preset so users can override it', () => {
        const customCss = '.sully-journal-paper{border-radius:2px!important;}';
        const css = resolveJournalAppearanceCss({ preset: 'sakura', customCss });

        expect(css).toContain('.sully-journal-theme-sakura');
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
