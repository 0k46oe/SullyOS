import type { CharacterProfile, CompanionAvatarConfig } from '../types';

export type VideoAvatarConfig = NonNullable<CharacterProfile['videoAvatar']>;
export type UploadedCompanionOutfit = NonNullable<CompanionAvatarConfig['imageWardrobe']>[number];

const uniqueModels = (models: Array<VideoAvatarConfig | undefined>): VideoAvatarConfig[] => {
  const seen = new Set<string>();
  return models.filter((model): model is VideoAvatarConfig => {
    if (!model?.assetId || seen.has(model.assetId)) return false;
    seen.add(model.assetId);
    return true;
  });
};

export const listCompanionModelOutfits = (character?: CharacterProfile | null): VideoAvatarConfig[] => {
  const active = character?.videoAvatar;
  if (!active) return [];
  return uniqueModels([active, ...(character?.videoAvatarWardrobe || [])])
    .filter(model => model.format === active.format);
};

export const addCompanionModelOutfit = (
  character: CharacterProfile,
  model: VideoAvatarConfig,
): Pick<CharacterProfile, 'videoAvatar' | 'videoAvatarWardrobe'> => {
  const active = character.videoAvatar;
  if (active && active.format !== model.format) {
    throw new Error(`衣橱只能加入同类型模型：当前是 ${active.format.toUpperCase()}。`);
  }
  const pool = uniqueModels([active, ...(character.videoAvatarWardrobe || []), model]);
  return {
    videoAvatar: model,
    videoAvatarWardrobe: pool.filter(item => item.assetId !== model.assetId),
  };
};

export const selectCompanionModelOutfit = (
  character: CharacterProfile,
  assetId: string,
): Pick<CharacterProfile, 'videoAvatar' | 'videoAvatarWardrobe'> | null => {
  const active = character.videoAvatar;
  if (!active) return null;
  const pool = listCompanionModelOutfits(character);
  const selected = pool.find(model => model.assetId === assetId && model.format === active.format);
  if (!selected) return null;
  return {
    videoAvatar: selected,
    videoAvatarWardrobe: pool.filter(model => model.assetId !== selected.assetId),
  };
};

const activeUploadedOutfit = (config?: CompanionAvatarConfig): UploadedCompanionOutfit | undefined => (
  config?.imageRef ? {
    id: config.imageRef,
    imageRef: config.imageRef,
    fileName: config.fileName,
    mimeType: config.mimeType,
    importedAt: config.importedAt,
  } : undefined
);

export const listUploadedCompanionOutfits = (
  config?: CompanionAvatarConfig,
): UploadedCompanionOutfit[] => {
  const seen = new Set<string>();
  return [activeUploadedOutfit(config), ...(config?.imageWardrobe || [])]
    .filter((item): item is UploadedCompanionOutfit => {
      if (!item?.imageRef || seen.has(item.imageRef)) return false;
      seen.add(item.imageRef);
      return true;
    });
};

export const addUploadedCompanionOutfit = (
  config: CompanionAvatarConfig | undefined,
  outfit: UploadedCompanionOutfit,
): CompanionAvatarConfig => {
  const items = listUploadedCompanionOutfits(config);
  if (!items.some(item => item.imageRef === outfit.imageRef)) items.push(outfit);
  return {
    version: 1,
    ...config,
    source: 'upload',
    imageRef: outfit.imageRef,
    fileName: outfit.fileName,
    mimeType: outfit.mimeType,
    importedAt: outfit.importedAt,
    imageWardrobe: items,
  };
};

export const selectUploadedCompanionOutfit = (
  config: CompanionAvatarConfig | undefined,
  imageRef: string,
): CompanionAvatarConfig | null => {
  const items = listUploadedCompanionOutfits(config);
  const selected = items.find(item => item.imageRef === imageRef);
  if (!selected) return null;
  return {
    version: 1,
    ...config,
    source: 'upload',
    imageRef: selected.imageRef,
    fileName: selected.fileName,
    mimeType: selected.mimeType,
    importedAt: selected.importedAt,
    imageWardrobe: items,
  };
};
