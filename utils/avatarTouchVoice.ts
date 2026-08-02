import type {
  APIConfig,
  CharacterProfile,
  CompanionTouchReaction,
} from '../types';
import { DB } from './db';
import { synthesizeSpeechDetailed } from './ttsRouter';
import type { AvatarTouchReactionPack, AvatarTouchZone } from './avatarTouch';

export interface AvatarTouchVoiceGenerationResult {
  reactions: AvatarTouchReactionPack;
  generated: number;
  total: number;
  failures: Array<{ zone: AvatarTouchZone; reactionId: string; message: string }>;
}

const VOICE_CONCURRENCY = 2;

const voiceAssetId = (characterId: string, zone: AvatarTouchZone, index: number): string => (
  `companion-touch-voice:${encodeURIComponent(characterId)}:${zone}:${index}`
);

export const collectAvatarTouchVoiceAssetIds = (
  reactions?: AvatarTouchReactionPack | null,
): Set<string> => {
  const ids = new Set<string>();
  Object.values(reactions || {}).forEach(items => {
    items?.forEach(item => {
      if (item.voiceAssetId) ids.add(item.voiceAssetId);
    });
  });
  return ids;
};

export const cleanupAvatarTouchVoiceAssets = async (
  previous?: AvatarTouchReactionPack | null,
  keepIds: Set<string> = new Set(),
): Promise<void> => {
  const staleIds = [...collectAvatarTouchVoiceAssetIds(previous)].filter(id => !keepIds.has(id));
  await Promise.all(staleIds.map(id => DB.deleteBlobAsset(id).catch(error => {
    console.warn('[companion] stale touch voice cleanup skipped:', error);
  })));
};

export const generateAvatarTouchVoicePack = async (options: {
  reactions: AvatarTouchReactionPack;
  character: CharacterProfile;
  apiConfig: APIConfig;
  onProgress?: (completed: number, total: number) => void;
}): Promise<AvatarTouchVoiceGenerationResult> => {
  const cloned: AvatarTouchReactionPack = {};
  const tasks: Array<{
    zone: AvatarTouchZone;
    index: number;
    reaction: CompanionTouchReaction;
  }> = [];

  (Object.entries(options.reactions) as Array<[AvatarTouchZone, CompanionTouchReaction[] | undefined]>)
    .forEach(([zone, items]) => {
      if (!items?.length) return;
      cloned[zone] = items.map((reaction, index) => {
        const next = { ...reaction };
        tasks.push({ zone, index, reaction: next });
        return next;
      });
    });

  let cursor = 0;
  let completed = 0;
  let generated = 0;
  const failures: AvatarTouchVoiceGenerationResult['failures'] = [];
  const runWorker = async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      let playableUrl = '';
      try {
        const result = await synthesizeSpeechDetailed(
          task.reaction.text,
          options.character,
          options.apiConfig,
          { emotion: task.reaction.performance?.emotion },
        );
        playableUrl = result.url;
        if (!result.blob) throw new Error('语音服务未返回可持久保存的音频');
        const assetId = voiceAssetId(options.character.id, task.zone, task.index);
        await DB.putBlobAsset(assetId, result.blob);
        task.reaction.voiceAssetId = assetId;
        task.reaction.voiceMimeType = result.blob.type || 'audio/mpeg';
        generated += 1;
      } catch (error) {
        delete task.reaction.voiceAssetId;
        delete task.reaction.voiceMimeType;
        failures.push({
          zone: task.zone,
          reactionId: task.reaction.id,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (playableUrl.startsWith('blob:')) URL.revokeObjectURL(playableUrl);
        completed += 1;
        options.onProgress?.(completed, tasks.length);
      }
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(VOICE_CONCURRENCY, Math.max(1, tasks.length)) },
    () => runWorker(),
  ));

  return {
    reactions: cloned,
    generated,
    total: tasks.length,
    failures,
  };
};

export const createAvatarTouchVoiceUrl = async (
  reaction: Pick<CompanionTouchReaction, 'voiceAssetId'>,
): Promise<string | null> => {
  if (!reaction.voiceAssetId) return null;
  const blob = await DB.getBlobAsset(reaction.voiceAssetId);
  return blob ? URL.createObjectURL(blob) : null;
};