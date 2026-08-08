import type { CharacterProfile } from '../types';
import { DB } from './db';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);
const BUILTIN_ROOM_ASSET_PATH = /(?:^|\/)room-templates\/(?:forest-cottage|blue-minimal)\/assets\/[^/?#]+$/i;

const runtimePageHref = (): string => {
    if (typeof window !== 'undefined') return window.location.href;
    return 'https://local.invalid/';
};

const runtimePublicBase = (): string => (import.meta as any).env?.BASE_URL || '/';

/**
 * Older Capacitor builds resolved bundled room-template images against
 * `https://localhost`. Those absolute URLs survive a backup, but are invalid
 * after the data is restored into the web app/TWA. Only known built-in room
 * assets are rewritten; arbitrary user localhost images are left untouched.
 */
export function rewriteLegacyRoomAssetUrl(
    value: string | undefined,
    pageHref: string = runtimePageHref(),
    publicBase: string = runtimePublicBase(),
): string | undefined {
    if (!value) return value;

    try {
        const parsed = new URL(value);
        if (!LOCAL_HOSTS.has(parsed.hostname) || !BUILTIN_ROOM_ASSET_PATH.test(parsed.pathname)) {
            return value;
        }

        const marker = '/room-templates/';
        const markerIndex = parsed.pathname.toLowerCase().lastIndexOf(marker);
        if (markerIndex < 0) return value;

        const relativeAssetPath = parsed.pathname.slice(markerIndex + 1);
        const appBase = new URL(publicBase, pageHref);
        return new URL(relativeAssetPath, appBase).href;
    } catch {
        return value;
    }
}

export function rewriteLegacyRoomAssetsInCharacter(
    character: CharacterProfile,
    pageHref?: string,
    publicBase?: string,
): { character: CharacterProfile; changed: boolean } {
    const room = character.roomConfig;
    if (!room) return { character, changed: false };

    const wallImage = rewriteLegacyRoomAssetUrl(room.wallImage, pageHref, publicBase);
    const floorImage = rewriteLegacyRoomAssetUrl(room.floorImage, pageHref, publicBase);
    let changed = wallImage !== room.wallImage || floorImage !== room.floorImage;

    const items = room.items.map(item => {
        const image = rewriteLegacyRoomAssetUrl(item.image, pageHref, publicBase);
        if (image === item.image) return item;
        changed = true;
        return { ...item, image: image || item.image };
    });

    if (!changed) return { character, changed: false };
    return {
        character: {
            ...character,
            roomConfig: {
                ...room,
                wallImage,
                floorImage,
                items,
            },
        },
        changed: true,
    };
}

/** Repair restored characters before OSContext reads them into React state. */
export async function migrateLegacyRoomTemplateAssets(): Promise<void> {
    try {
        const characters = await DB.getAllCharacters();
        for (const character of characters) {
            const migrated = rewriteLegacyRoomAssetsInCharacter(character);
            if (migrated.changed) await DB.saveCharacter(migrated.character);
        }
    } catch (error) {
        console.warn('[migrateLegacyRoomTemplateAssets] migration failed; will retry next launch', error);
    }
}
