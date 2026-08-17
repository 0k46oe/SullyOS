export type QixiEntryAttitude = 'explore' | 'shout' | 'stay';

/**
 * Enter the playable rooms without replacing the rest of the session. Part 2
 * and Part 3 may already have finished in the background, so their results must
 * survive this transition.
 */
export function enterQixiInterlayerState<T extends { stage: string }>(
    current: T,
    attitude: QixiEntryAttitude,
): T & { stage: 'scene'; attitude: QixiEntryAttitude } {
    return { ...current, stage: 'scene', attitude };
}

/**
 * The grape-arbor words are a turn exchange, not a multi-select form. A User
 * word is accepted only after the Char side has answered the previous pick.
 */
export function selectQixiWordTurn(
    selected: string[],
    charRevealed: number,
    artifactId: string,
    max = 3,
): string[] {
    if (selected.length >= max || selected.length !== charRevealed || selected.includes(artifactId)) return selected;
    return [...selected, artifactId];
}
