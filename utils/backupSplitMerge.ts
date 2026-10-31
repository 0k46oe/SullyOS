/** Split backups own different fields. Empty image placeholders in text archives
 * are not deletion instructions; media archives never roll text/history back. */
export type BackupMode = 'full' | 'text_only' | 'media_only';
export function backupMode(data: any): BackupMode {
    const mode = data.backupMode ?? data.collaborationBackupMode;
    return mode === 'text_only' || mode === 'media_only' ? mode : 'full';
}
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Blob);
const identity = (v: any) => v && typeof v === 'object' ? v.id ?? v._libraryId ?? v.key ?? v.uuid : undefined;
const mediaString = (v: any, key = '') => typeof v === 'string' && (
    /^(?:data:(?:image|audio|font)|blobref:|blob:|assets\/)/.test(v)
    || (/^(?:https?:|\/)/.test(v) && /avatar|image|sprite|background|wallpaper|cover|thumbnail|font|^(?:src|url)$/i.test(key))
);

/** The incoming text tree controls text, ordering and membership. Match media by
 * stable identity, never by array position when either side has record IDs. */
export function mergeTextMedia(current: any, incoming: any, key = ''): any {
    if ((incoming === '' || incoming == null) && mediaString(current, key)) return current;
    if (Array.isArray(incoming)) {
        const old = Array.isArray(current) ? current : [];
        const keyed = old.some(v => identity(v) !== undefined) || incoming.some(v => identity(v) !== undefined);
        const byId = new Map(old.filter(v => identity(v) !== undefined).map(v => [identity(v), v]));
        return incoming.map((v, i) => mergeTextMedia(keyed ? byId.get(identity(v)) : old[i], v, key));
    }
    if (object(incoming)) {
        const result: any = { ...incoming };
        for (const k of Object.keys(incoming)) result[k] = mergeTextMedia(current?.[k], incoming[k], k);
        for (const k of Object.keys(current || {})) {
            if (!(k in incoming) && mediaString(current[k], k)) result[k] = current[k];
        }
        if (mediaString(result.cameraSnapshotRef)) result.cameraSnapshotExpired = false;
        return result;
    }
    return incoming;
}

/** Media-only patches existing records. Unrelated strings, flags, prompts,
 * dates, balances, and array membership stay with the text archive. */
export function mergeMediaOnly(current: any, incoming: any, key = ''): any {
    if (mediaString(incoming, key) || incoming instanceof Blob) return incoming;
    if (Array.isArray(incoming)) {
        if (!Array.isArray(current)) return current;
        const keyed = current.some(v => identity(v) !== undefined) || incoming.some(v => identity(v) !== undefined);
        const byId = new Map(incoming.filter(v => identity(v) !== undefined).map(v => [identity(v), v]));
        return current.map((v, i) => mergeMediaOnly(v, keyed ? byId.get(identity(v)) : incoming[i], key));
    }
    if (object(incoming)) {
        const result: any = object(current) ? { ...current } : {};
        for (const k of Object.keys(incoming)) {
            const value = mergeMediaOnly(current?.[k], incoming[k], k);
            if (value !== undefined) result[k] = value;
        }
        if (mediaString(result.cameraSnapshotRef)) result.cameraSnapshotExpired = false;
        return Object.keys(result).length ? result : current;
    }
    return current;
}

export function mergeSplitAsset(current: any, incoming: any, mode: BackupMode): any {
    let old = current?.data, next = incoming.data, json = false;
    if (typeof next === 'string' && /^[\[{]/.test(next)) {
        try { next = JSON.parse(next); json = true; } catch { /* plain text */ }
        if (json && typeof old === 'string') {
            try { old = JSON.parse(old); } catch { old = undefined; }
        }
    }
    const merged = mode === 'text_only' ? mergeTextMedia(old, next) : current ? mergeMediaOnly(old, next) : projectMedia(next);
    if (merged === undefined) return undefined;
    return { ...current, ...(mode === 'text_only' ? incoming : { id: incoming.id }), data: json ? JSON.stringify(merged) : merged };
}

export function projectMedia(value: any, key = ''): any {
    if (mediaString(value, key) || value instanceof Blob) return value;
    if (Array.isArray(value)) return value.map(item => {
        const projected = projectMedia(item, key);
        return object(projected) && identity(item) !== undefined ? { ...projected, id: identity(item) } : projected;
    });
    if (object(value)) {
        const entries = Object.entries(value).map(([k, v]) => [k, projectMedia(v, k)]).filter(([, v]) => v !== undefined);
        return entries.length ? Object.fromEntries(entries) : undefined;
    }
}

/** Appearance library records own CSS, source permissions and stable IDs too. */
export function isAppearanceAsset(id: string): boolean {
    return /^(?:decoration_|appearance_preset_|icon_|widget_|deco_|beauty_source_|beauty_binding_|voice_|companion_voice_|companion-(?:startup|touch)-voice:)/.test(id)
        || ['wallpaper', 'lock_wallpaper', 'custom_font_data', 'chrome_css_presets', 'chat_decoration_presets_v1'].includes(id);
}

export const CHARACTER_MEDIA_FIELDS = [
    'avatar', 'companionAvatar', 'companionTouchSettings', 'sprites', 'dateSkinSets', 'activeSkinSetId',
    'customDateSprites', 'spriteConfig', 'chatBackground', 'dateBackground',
    'bubbleStyle', 'chatAppearance', 'chatFineTune', 'chromeCustomCss', 'chatDecorationCssIsolated',
    'chatSound', 'chatSoundBound', 'thinkingChainStyle', 'thinkingChainCustomColors', 'thinkingChainCustomCss',
] as const;
export const PENDING_CHARACTER_MEDIA = 'sully_split_character_media_v1';

export function preserveCharacterMedia(current: any, incoming: any): any {
    const merged = mergeTextMedia(current, incoming);
    if (current) for (const key of CHARACTER_MEDIA_FIELDS) {
        if (Object.hasOwn(current, key)) merged[key] = current[key];
    }
    return merged;
}

/** Apply to old split archives as well. Full backups retain their replace rules. */
export function stripSplitMetadata(data: Record<string, any>): void {
    const mode = backupMode(data);
    if (mode === 'text_only') {
        for (const key of ['theme', 'customIcons', 'appearancePresets', 'customThemes', 'savedEmojis', 'emojiCategories',
            'galleryImages', 'savedJournalStickers', 'roomCustomAssets', 'desktopSkinLocal', 'storyTheaterAppearance', 'gotchiAccentHue']) delete data[key];
    } else if (mode === 'media_only') {
        // These sections in older media backups contain complete text records.
        for (const key of ['characters', 'characterGroups', 'dailySchedules', 'pixelHomeLayouts']) delete data[key];
        for (const key of ['bankState', 'bankDollhouse']) if (data[key]) data[key] = projectMedia(data[key]);
        if (data.socialAppData) { delete data.socialAppData.charHandles; delete data.socialAppData.userId; }
    }
}
