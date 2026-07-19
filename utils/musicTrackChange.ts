export const MUSIC_TRACK_CHANGED_EVENT = 'music-track-changed';

export interface MusicTrackInfo {
    id: number;
    name: string;
    artists: string;
}

export interface MusicTrackChangeDetail {
    charIds: string[];
    previousSong: MusicTrackInfo;
    currentSong: MusicTrackInfo;
}

export function createMusicTrackChangeDetail(
    previousSong: MusicTrackInfo | null,
    currentSong: MusicTrackInfo | null,
    listeningCharIds: string[],
): MusicTrackChangeDetail | null {
    if (!previousSong || !currentSong || previousSong.id === currentSong.id || listeningCharIds.length === 0) {
        return null;
    }

    return {
        charIds: [...listeningCharIds],
        previousSong: {
            id: previousSong.id,
            name: previousSong.name,
            artists: previousSong.artists,
        },
        currentSong: {
            id: currentSong.id,
            name: currentSong.name,
            artists: currentSong.artists,
        },
    };
}

export function buildMusicTrackChangeHint(detail: MusicTrackChangeDetail, userName: string): string {
    const previous = `《${detail.previousSong.name}》 - ${detail.previousSong.artists}`;
    const current = `《${detail.currentSong.name}》 - ${detail.currentSong.artists}`;
    return `[系统提示（非${userName}发言）：你刚才正在和${userName}一起听 ${previous}，现在播放器已经切换到 ${current}。上一首歌的“一起听”状态已经结束；请根据新歌和此刻的气氛，重新判断你是否想继续陪${userName}一起听。想继续时可以自然回应并使用 [[MUSIC_ACTION:join]]；不想继续时不要使用该指令，也不要为了触发卡片而勉强加入。不要提及你收到了系统提示。]`;
}
