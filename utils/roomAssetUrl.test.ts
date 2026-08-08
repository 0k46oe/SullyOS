import { describe, expect, it } from 'vitest';
import { rewriteLegacyRoomAssetUrl, rewriteLegacyRoomAssetsInCharacter } from './roomAssetUrl';

const PAGE = 'https://qegj567-cloud.github.io/SullyOS/';
const BASE = '/SullyOS/';

describe('legacy built-in room asset migration', () => {
    it('moves old Capacitor localhost room assets onto the current GitHub Pages base', () => {
        expect(rewriteLegacyRoomAssetUrl(
            'https://localhost/room-templates/blue-minimal/assets/item-03.png',
            PAGE,
            BASE,
        )).toBe('https://qegj567-cloud.github.io/SullyOS/room-templates/blue-minimal/assets/item-03.png');
    });

    it('also repairs old paths that already contained a repository prefix', () => {
        expect(rewriteLegacyRoomAssetUrl(
            'https://localhost/SullyOS/room-templates/forest-cottage/assets/wall.png',
            PAGE,
            BASE,
        )).toBe('https://qegj567-cloud.github.io/SullyOS/room-templates/forest-cottage/assets/wall.png');
    });

    it('does not touch custom localhost images or remote/data/blob assets', () => {
        const keep = [
            'https://localhost/my-own-furniture.png',
            'https://cdn.example.com/item.png',
            'data:image/png;base64,abc',
            'blobref:abc',
        ];
        for (const value of keep) {
            expect(rewriteLegacyRoomAssetUrl(value, PAGE, BASE)).toBe(value);
        }
    });

    it('repairs walls, floors, and furniture without changing unrelated character data', () => {
        const original: any = {
            id: 'c1',
            name: 'Noir',
            roomConfig: {
                wallImage: 'https://localhost/room-templates/blue-minimal/assets/wall.png',
                floorImage: 'https://localhost/room-templates/blue-minimal/assets/floor.png',
                items: [
                    { id: 'i1', image: 'https://localhost/room-templates/blue-minimal/assets/item-01.png' },
                    { id: 'i2', image: 'https://cdn.example.com/custom.png' },
                ],
            },
        };

        const result = rewriteLegacyRoomAssetsInCharacter(original, PAGE, BASE);
        expect(result.changed).toBe(true);
        expect(result.character.roomConfig?.wallImage).toContain('/SullyOS/room-templates/');
        expect(result.character.roomConfig?.floorImage).toContain('/SullyOS/room-templates/');
        expect(result.character.roomConfig?.items[0].image).toContain('/SullyOS/room-templates/');
        expect(result.character.roomConfig?.items[1].image).toBe('https://cdn.example.com/custom.png');
        expect(result.character.name).toBe('Noir');
    });
});
