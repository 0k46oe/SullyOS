import JSZip from 'jszip';
import type { CharacterProfile } from '../types';
import { DB } from './db';
import { live2DRuntimeCacheAssetId } from './avatarModelStore';

export type Live2DAvatarConfig = Extract<NonNullable<CharacterProfile['videoAvatar']>, { format: 'live2d' }>;
export type Live2DAction = Live2DAvatarConfig['actions'][number];
export type Live2DActionPermission = Live2DAction['permission'];

const isIdleOnlyMotion = (action: Live2DAction): boolean => (
  action.kind === 'motion'
  && (action.group === 'Idle' || (action.tags.length > 0 && action.tags.every(tag => tag === 'idle')))
);

/**
 * One-time compatibility upgrade for models imported before automatic action
 * onboarding. Only previously-unclassified built-in files are promoted: a
 * user's explicit "manual" choice on a tagged/custom action is preserved.
 */
export const upgradeLive2DAutoPermissions = (config: Live2DAvatarConfig): Live2DAvatarConfig => {
  if (config.actionPolicyVersion === 2) return config;
  const actions = config.actions.map(action => {
    const autoEligible = action.permission === 'manual'
      && action.tags.length === 0
      && action.source !== 'custom'
      && action.kind !== 'params'
      && !action.resetExpression
      && !isIdleOnlyMotion(action);
    return autoEligible ? { ...action, permission: 'ai' as const } : action;
  });
  return { ...config, actionPolicyVersion: 2, actions };
};

type Model3Json = {
  Version?: number;
  FileReferences?: {
    Moc?: string;
    Textures?: string[];
    Physics?: string;
    Pose?: string;
    DisplayInfo?: string;
    UserData?: string;
    Motions?: Record<string, Array<{ File?: string; Sound?: string; Name?: string }>>;
    Expressions?: Array<{ Name?: string; File?: string }>;
  };
  Groups?: Array<{ Name?: string; Ids?: string[] }>;
};

type VTubeJson = {
  FileReferences?: {
    Model?: string;
    IdleAnimation?: string;
    IdleAnimationWhenTrackingLost?: string;
  };
  SavedModelPosition?: {
    Position?: { x?: number; y?: number };
    Scale?: { x?: number; y?: number };
  };
  Hotkeys?: Array<{
    Name?: string;
    Action?: string;
    File?: string;
    Folder?: string;
    IsActive?: boolean;
    Triggers?: { Trigger1?: string; Trigger2?: string; Trigger3?: string };
  }>;
};

type PackageEntry = { path: string; blob: Blob };
type ParsedPackage = {
  modelPath: string;
  modelName: string;
  actions: Live2DAction[];
  lipSyncParameterIds: string[];
  framing?: Live2DAvatarConfig['framing'];
};

export type Live2DImportProgress = (stage: string) => void;

const normalizePath = (value: string): string => {
  const path = value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  const parts = path.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '..')) throw new Error(`Live2D 包含不安全的路径：${value}`);
  return parts.join('/');
};

const dirname = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash + 1);
};

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const modelRelativePath = (modelPath: string, fullPath: string): string => {
  const base = dirname(modelPath);
  return base && fullPath.startsWith(base) ? fullPath.slice(base.length) : fullPath;
};

const finiteOr = (value: unknown, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const resolveModelReference = (modelPath: string, reference: string): string => {
  const base = dirname(modelPath).split('/').filter(Boolean);
  for (const part of reference.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') base.pop();
    else base.push(part);
  }
  return normalizePath(base.join('/'));
};

const actionTagRules: Array<[string, RegExp]> = [
  ['happy', /happy|smile|joy|laugh|grin|star|tail|开心|高兴|微笑|笑|星星|尾巴/i],
  ['sad', /sad|cry|gloom|tear|upset|伤心|难过|哭|失落|脸黑/i],
  ['angry', /angry|anger|mad|rage|生气|愤怒|气恼/i],
  ['surprised', /surpris|shock|wow|sweat|惊讶|震惊|吃惊|汗/i],
  ['shy', /shy|blush|bashful|love|heart|cat.?ear|害羞|脸红|爱心|猫耳/i],
  ['wave', /wave|hello|greet|hand|挥手|招呼|你好/i],
  ['nod', /nod|agree|yes|点头|同意/i],
  ['shake', /shake|disagree|no|摇头|拒绝/i],
  ['tilt', /tilt|question|confus|歪头|疑问|困惑/i],
  ['explain', /explain|present|talk|speak|chat|microphone|介绍|解释|说话|麦克风/i],
  ['idle', /idle|standby|breath|待机|呼吸/i],
  ['idle', /循环|loop/i],
];

export const inferLive2DActionTags = (...parts: Array<string | undefined>): string[] => {
  const text = parts.filter(Boolean).join(' ');
  return actionTagRules.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
};

const discoverActionParameterIds = async (
  action: Live2DAction,
  entries: Map<string, Blob>,
  modelPath: string,
): Promise<string[]> => {
  if (action.kind === 'params') {
    return [...new Set((action.params || []).map(param => param.id).filter(Boolean))];
  }
  if (!action.file) return action.parameterIds || [];
  try {
    const blob = entries.get(resolveModelReference(modelPath, action.file));
    // Motion/expression JSON should be tiny. Refuse unexpectedly large files so
    // metadata discovery can never stall model loading.
    if (!blob || blob.size > 8 * 1024 * 1024) return action.parameterIds || [];
    const parsed = JSON.parse(await blob.text()) as {
      Curves?: Array<{ Target?: string; Id?: string }>;
      Parameters?: Array<{ Id?: string }>;
    };
    const ids = action.kind === 'motion'
      ? (parsed.Curves || []).filter(curve => curve.Target === 'Parameter').map(curve => curve.Id)
      : (parsed.Parameters || []).map(parameter => parameter.Id);
    return [...new Set(ids.filter((id): id is string => typeof id === 'string' && Boolean(id)))];
  } catch {
    return action.parameterIds || [];
  }
};

const collectReferencedFiles = (model: Model3Json): string[] => {
  const refs = model.FileReferences || {};
  const files = [refs.Moc, ...(refs.Textures || []), refs.Physics, refs.Pose, refs.DisplayInfo, refs.UserData];
  Object.values(refs.Motions || {}).forEach(items => items.forEach(item => files.push(item.File, item.Sound)));
  (refs.Expressions || []).forEach(item => files.push(item.File));
  return files.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
};

const parsePackage = async (entries: PackageEntry[]): Promise<ParsedPackage> => {
  const byPath = new Map(entries.map(entry => [normalizePath(entry.path), entry.blob]));
  const modelPaths = [...byPath.keys()].filter(path => path.toLowerCase().endsWith('.model3.json'));
  if (!modelPaths.length) throw new Error('没有找到 *.model3.json；请选择完整的 Live2D Cubism 3/4/5 模型文件夹或 ZIP。');
  if (modelPaths.length > 1) throw new Error(`包里发现 ${modelPaths.length} 个 model3.json，请一次只导入一个 Live2D 模型。`);

  const modelPath = modelPaths[0];
  let model: Model3Json;
  try {
    model = JSON.parse(await byPath.get(modelPath)!.text()) as Model3Json;
  } catch {
    throw new Error(`${basename(modelPath)} 不是有效的 JSON。`);
  }
  const refs = model.FileReferences;
  if (!refs?.Moc || !Array.isArray(refs.Textures) || !refs.Textures.length) {
    throw new Error('model3.json 缺少 FileReferences.Moc 或 Textures，无法作为 Cubism 模型加载。');
  }

  let vtubePath = '';
  let vtube: VTubeJson | undefined;
  for (const path of [...byPath.keys()].filter(item => item.toLowerCase().endsWith('.vtube.json'))) {
    try {
      const candidate = JSON.parse(await byPath.get(path)!.text()) as VTubeJson;
      const targetModel = candidate.FileReferences?.Model;
      if (!targetModel || resolveModelReference(path, targetModel) === modelPath) {
        vtubePath = path;
        vtube = candidate;
        break;
      }
    } catch {
      // A malformed optional VTube Studio settings file must not block Cubism import.
    }
  }

  const vtubeReferencedFiles = [
    vtube?.FileReferences?.IdleAnimation,
    vtube?.FileReferences?.IdleAnimationWhenTrackingLost,
    ...(vtube?.Hotkeys || []).map(hotkey => hotkey.File),
  ].filter((item): item is string => Boolean(item));
  const missing = [
    ...collectReferencedFiles(model).map(file => resolveModelReference(modelPath, file)),
    ...vtubeReferencedFiles.map(file => resolveModelReference(vtubePath || modelPath, file)),
  ]
    .filter(path => !byPath.has(path));
  if (missing.length) {
    throw new Error(`模型引用的文件不完整：${missing.slice(0, 3).map(basename).join('、')}${missing.length > 3 ? ` 等 ${missing.length} 个` : ''}`);
  }

  const actions: Live2DAction[] = [];
  const expressionByPath = new Map<string, Live2DAction>();
  const motionByPath = new Map<string, Live2DAction>();
  let expressionIndex = 0;
  const addExpression = (
    name: string,
    file: string,
    source: NonNullable<Live2DAction['source']>,
    hotkey?: string,
  ): Live2DAction => {
    const resolvedPath = resolveModelReference(modelPath, file);
    const existing = expressionByPath.get(resolvedPath);
    if (existing) {
      if (source === 'vtube') {
        existing.name = name || existing.name;
        existing.expressionId = name || existing.expressionId;
        existing.hotkey = hotkey || existing.hotkey;
        existing.source = source;
        existing.tags = inferLive2DActionTags(existing.name, existing.file);
        existing.permission = 'ai';
      }
      return existing;
    }
    const actionName = name || basename(file).replace(/\.exp3\.json$/i, '');
    const tags = inferLive2DActionTags(actionName, file);
    const action: Live2DAction = {
      id: `expression-${expressionIndex++}`,
      kind: 'expression',
      name: actionName,
      expressionId: actionName,
      file,
      hotkey,
      source,
      tags,
      permission: 'ai',
    };
    actions.push(action);
    expressionByPath.set(resolvedPath, action);
    return action;
  };

  for (const expression of refs.Expressions || []) {
    if (!expression.File) continue;
    addExpression(expression.Name || '', expression.File, 'model3');
  }

  let motionIndex = 0;
  const motionCounts = new Map<string, number>();
  const addMotion = (
    name: string,
    file: string,
    group: string,
    source: NonNullable<Live2DAction['source']>,
    declaredIndex?: number,
  ): Live2DAction => {
    const resolvedPath = resolveModelReference(modelPath, file);
    const existing = motionByPath.get(resolvedPath);
    if (existing) return existing;
    const index = declaredIndex ?? motionCounts.get(group) ?? 0;
    motionCounts.set(group, Math.max(motionCounts.get(group) ?? 0, index + 1));
    const actionName = name || `${group} ${index + 1}`;
    const tags = inferLive2DActionTags(group, actionName, file);
    const action: Live2DAction = {
      id: `motion-${motionIndex++}`,
      kind: 'motion',
      name: actionName,
      group,
      index,
      file,
      source,
      tags,
      // Idle already runs automatically in the engine. Keeping it out of the
      // director list avoids wasting a cue slot without asking the user.
      permission: group === 'Idle' || (tags.length > 0 && tags.every(tag => tag === 'idle')) ? 'manual' : 'ai',
    };
    actions.push(action);
    motionByPath.set(resolvedPath, action);
    return action;
  };

  for (const [group, motions] of Object.entries(refs.Motions || {})) {
    motions.forEach((motion, index) => {
      if (!motion.File) return;
      addMotion(motion.Name || '', motion.File, group, 'model3', index);
    });
  }

  const hotkeyText = (hotkey: NonNullable<VTubeJson['Hotkeys']>[number]): string | undefined => {
    const keys = [hotkey.Triggers?.Trigger1, hotkey.Triggers?.Trigger2, hotkey.Triggers?.Trigger3].filter(Boolean);
    return keys.length ? keys.join('+') : undefined;
  };
  for (const hotkey of vtube?.Hotkeys || []) {
    if (hotkey.IsActive === false) continue;
    const key = hotkeyText(hotkey);
    if (hotkey.Action === 'ToggleExpression' && hotkey.File) {
      const fullPath = resolveModelReference(vtubePath, hotkey.File);
      addExpression(hotkey.Name || '', modelRelativePath(modelPath, fullPath), 'vtube', key);
    } else if (hotkey.Action === 'RemoveAllExpressions') {
      actions.push({
        id: `expression-reset-${expressionIndex++}`,
        kind: 'expression',
        name: hotkey.Name || '清除全部表情',
        file: '',
        expressionId: '__reset__',
        hotkey: key,
        source: 'vtube',
        resetExpression: true,
        tags: ['neutral', 'idle'],
        permission: 'manual',
      });
    }
  }

  const idleFile = vtube?.FileReferences?.IdleAnimation;
  if (idleFile) {
    const fullPath = resolveModelReference(vtubePath, idleFile);
    addMotion('待机循环', modelRelativePath(modelPath, fullPath), 'Idle', 'vtube');
  }

  const modelDirectory = dirname(modelPath);
  const modelFiles = [...byPath.keys()].filter(path => !modelDirectory || path.startsWith(modelDirectory));
  for (const path of modelFiles.filter(item => item.toLowerCase().endsWith('.exp3.json'))) {
    const file = modelRelativePath(modelPath, path);
    addExpression(basename(file).replace(/\.exp3\.json$/i, ''), file, 'discovered');
  }
  for (const path of modelFiles.filter(item => item.toLowerCase().endsWith('.motion3.json'))) {
    const file = modelRelativePath(modelPath, path);
    const name = basename(file).replace(/\.motion3\.json$/i, '');
    const group = /idle|standby|loop|循环|待机/i.test(name) ? 'Idle' : 'Imported';
    addMotion(name, file, group, 'discovered');
  }

  const lipSyncParameterIds = (model.Groups || [])
    .filter(group => group.Name?.toLowerCase() === 'lipsync')
    .flatMap(group => group.Ids || [])
    .filter(Boolean);

  await Promise.all(actions.map(async action => {
    const parameterIds = await discoverActionParameterIds(action, byPath, modelPath);
    if (parameterIds.length) action.parameterIds = parameterIds;
  }));

  return {
    modelPath,
    modelName: basename(modelPath).replace(/\.model3\.json$/i, ''),
    actions,
    lipSyncParameterIds: lipSyncParameterIds.length ? [...new Set(lipSyncParameterIds)] : ['ParamMouthOpenY'],
    ...(vtube?.SavedModelPosition ? {
      framing: {
        scale: clamp(finiteOr(vtube.SavedModelPosition.Scale?.x, 1), 0.5, 6),
        offsetX: clamp(finiteOr(vtube.SavedModelPosition.Position?.x, 0) / 200, -1.4, 1.4),
        offsetY: clamp(-finiteOr(vtube.SavedModelPosition.Position?.y, 0) / 200, -3.2, 3.2),
      },
    } : {}),
  };
};

/** Pure inspection hook used by import UI and regression tests. */
export const inspectLive2DPackage = (entries: Array<{ path: string; blob: Blob }>) => parsePackage(entries);

const makeAssetId = (): string => {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `video-avatar-live2d-${id}`;
};

const createConfig = async (
  blob: Blob,
  entries: PackageEntry[],
  fileName: string,
  parsed?: ParsedPackage,
): Promise<Live2DAvatarConfig> => {
  const inspected = parsed || await parsePackage(entries);
  const assetId = makeAssetId();
  await DB.putBlobAsset(assetId, blob);
  return {
    version: 1,
    format: 'live2d',
    assetId,
    fileName: fileName || inspected.modelName,
    modelPath: inspected.modelPath,
    byteLength: blob.size,
    fileCount: entries.length,
    importedAt: Date.now(),
    runtimePackageEncoding: 'store-v1',
    actionPolicyVersion: 2,
    framing: inspected.framing || { scale: 1, offsetX: 0, offsetY: 0 },
    lipSyncParameterIds: inspected.lipSyncParameterIds,
    actions: inspected.actions,
  };
};

const fileRelativePath = (file: File): string => (
  (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
);

export const saveLive2DModelFromFiles = async (
  files: File[],
  onProgress?: Live2DImportProgress,
): Promise<Live2DAvatarConfig> => {
  const sourceFiles = files.filter(file => file.size > 0 && !/(^|\/)\.DS_Store$/i.test(fileRelativePath(file)));
  if (!sourceFiles.length) throw new Error('选择的文件夹是空的。');
  const entries = sourceFiles.map(file => ({ path: normalizePath(fileRelativePath(file)), blob: file }));
  onProgress?.(`正在扫描 ${entries.length} 个文件和 VTube Studio 热键…`);
  const parsed = await parsePackage(entries);
  onProgress?.(`已找到 ${parsed.actions.length} 个表情/动作；正在整理本地模型包…`);
  // PNG/JPEG/moc are already compressed. Re-deflating a large 8K texture can
  // freeze the UI for tens of seconds without meaningfully reducing its size.
  const packageBlob = await buildStoredLive2DPackage(entries);
  const rootName = parsed.modelPath.includes('/') ? parsed.modelPath.split('/')[0] : parsed.modelName;
  onProgress?.('正在写入本地模型库，请保持页面打开…');
  return createConfig(packageBlob, entries, rootName, parsed);
};

export const saveLive2DModelFromZip = async (
  file: File,
  onProgress?: Live2DImportProgress,
): Promise<Live2DAvatarConfig> => {
  let zip: JSZip;
  try {
    onProgress?.(`正在读取 ${file.name}，大纹理首次导入可能需要 10–30 秒…`);
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error('ZIP 无法读取；请确认它没有加密且内容没有损坏。');
  }
  const sourceEntries = Object.values(zip.files).filter(entry => (
    !entry.dir && !/(^|\/)__MACOSX\//i.test(entry.name) && !/(^|\/)\.DS_Store$/i.test(entry.name)
  ));
  let loaded = 0;
  const entries = await Promise.all(sourceEntries.map(async entry => {
    const blob = await entry.async('blob');
    loaded += 1;
    if (loaded === sourceEntries.length || loaded % 6 === 0) onProgress?.(`正在解包模型文件 ${loaded}/${sourceEntries.length}…`);
    return { path: normalizePath(entry.name), blob };
  }));
  onProgress?.('正在解析 model3、未登记文件与 VTube Studio 热键…');
  const parsed = await parsePackage(entries);
  onProgress?.(`已找到 ${parsed.actions.length} 个表情/动作；正在建立免解压运行缓存…`);
  const packageBlob = await buildStoredLive2DPackage(entries);
  onProgress?.('运行缓存已建立，正在写入本地模型库…');
  return createConfig(packageBlob, entries, file.name.replace(/\.zip$/i, ''), parsed);
};

const mimeForPath = (path: string): string => {
  if (/\.png$/i.test(path)) return 'image/png';
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg';
  if (/\.webp$/i.test(path)) return 'image/webp';
  if (/\.json$/i.test(path)) return 'application/json';
  if (/\.wav$/i.test(path)) return 'audio/wav';
  if (/\.mp3$/i.test(path)) return 'audio/mpeg';
  if (/\.ogg$/i.test(path)) return 'audio/ogg';
  return 'application/octet-stream';
};

/** Restores the stored package into browser Files with the original relative paths. */
export const loadLive2DModelFiles = async (config: Live2DAvatarConfig): Promise<File[]> => {
  const packageBlob = await DB.getBlobAsset(config.assetId);
  if (!packageBlob) throw new Error('Live2D 模型文件已丢失，请重新导入。');
  const zip = await JSZip.loadAsync(packageBlob);
  const files: File[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const path = normalizePath(entry.name);
    const file = new File([await entry.async('blob')], basename(path), { type: mimeForPath(path) });
    Object.defineProperty(file, 'webkitRelativePath', { configurable: true, value: path });
    files.push(file);
  }
  return files;
};

const blobToDataUrl = (blob: Blob, mimeType: string): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(reader.error || new Error('贴图读取失败'));
  // blob.type 缺失或是 octet-stream 时强制换上推断出的 MIME——Pixi 靠 data URL
  // 的 MIME 挑解析器，octet-stream 会直接 [Loader.load] Failed to load。
  const needsRetype = !blob.type || blob.type === 'application/octet-stream';
  reader.readAsDataURL(needsRetype ? blob.slice(0, blob.size, mimeType) : blob);
});

/** 按文件头魔数嗅探真实图片类型；扩展名千奇百怪的模型包全靠它兜底。 */
export const sniffImageMime = async (blob: Blob): Promise<string | null> => {
  try {
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    return null;
  } catch {
    return null;
  }
};

interface Live2DRuntimePackage {
  entries: Map<string, Blob>;
  textureDataUrls: Map<string, Promise<string>>;
  source: 'stored-package' | 'persistent-cache' | 'legacy-zip';
  unpackMs: number;
}

// Settings preview and the call stage normally open the same asset back to
// back. Keep one decompressed package in memory so the 8K texture and moc are
// not inflated from ZIP twice. A single-entry LRU bounds the extra memory when
// the user switches characters.
const live2DRuntimePackageCache = new Map<string, Promise<Live2DRuntimePackage>>();

export type Live2DLoadProgress = (stage: string) => void;

const nowMs = (): number => globalThis.performance?.now?.() ?? Date.now();
const prettyMs = (value: number): string => value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;

const getLive2DRuntimePackage = async (
  config: Live2DAvatarConfig,
  onProgress?: Live2DLoadProgress,
): Promise<{ runtimePackage: Live2DRuntimePackage; memoryHit: boolean; waitMs: number }> => {
  const startedAt = nowMs();
  const assetId = config.assetId;
  const cached = live2DRuntimePackageCache.get(assetId);
  if (cached) {
    live2DRuntimePackageCache.delete(assetId);
    live2DRuntimePackageCache.set(assetId, cached);
    onProgress?.('正在从内存缓存恢复模型…');
    return {
      runtimePackage: await cached,
      memoryHit: true,
      waitMs: nowMs() - startedAt,
    };
  }

  const pending = (async () => {
    let packageBlob: Blob | null = null;
    let source: Live2DRuntimePackage['source'];
    if (config.runtimePackageEncoding === 'store-v1') {
      onProgress?.('正在读取免解压模型包…');
      packageBlob = await DB.getBlobAsset(assetId);
      source = 'stored-package';
    } else {
      const persistentCacheId = live2DRuntimeCacheAssetId(assetId);
      packageBlob = await DB.getBlobAsset(persistentCacheId);
      if (packageBlob) {
        onProgress?.('正在读取持久化运行缓存…');
        source = 'persistent-cache';
      } else {
        onProgress?.('首次优化旧模型：正在解包并建立运行缓存…');
        packageBlob = await DB.getBlobAsset(assetId);
        source = 'legacy-zip';
      }
    }
    if (!packageBlob) throw new Error('Live2D 模型文件已丢失，请重新导入。');
    const unpackStartedAt = nowMs();
    const zip = await JSZip.loadAsync(packageBlob);
    const files = Object.values(zip.files).filter(entry => !entry.dir);
    const pairs = await Promise.all(files.map(async entry => (
      [normalizePath(entry.name), await entry.async('blob')] as const
    )));
    const runtimePackage: Live2DRuntimePackage = {
      entries: new Map(pairs),
      textureDataUrls: new Map<string, Promise<string>>(),
      source,
      unpackMs: nowMs() - unpackStartedAt,
    };

    // Existing users keep the original portable ZIP, while a derived STORE archive
    // is written once beside it. It is a disposable cache, so backup/restore can
    // omit it and rebuild naturally.
    if (source === 'legacy-zip') {
      const cacheEntries = pairs.map(([path, blob]) => ({ path, blob }));
      void buildStoredLive2DPackage(cacheEntries)
        .then(blob => DB.putBlobAsset(live2DRuntimeCacheAssetId(assetId), blob))
        .then(() => console.info('[live2d] persistent STORE cache created', { assetId, files: pairs.length }))
        .catch(error => console.warn('[live2d] persistent cache write skipped:', error));
    }
    return runtimePackage;
  })().catch(error => {
    live2DRuntimePackageCache.delete(assetId);
    throw error;
  });

  live2DRuntimePackageCache.set(assetId, pending);
  while (live2DRuntimePackageCache.size > 1) {
    const oldest = live2DRuntimePackageCache.keys().next().value as string | undefined;
    if (!oldest || oldest === assetId) break;
    live2DRuntimePackageCache.delete(oldest);
  }
  return {
    runtimePackage: await pending,
    memoryHit: false,
    waitMs: nowMs() - startedAt,
  };
};

const getRuntimeTextureDataUrl = (
  runtimePackage: Live2DRuntimePackage,
  path: string,
  blob: Blob,
): Promise<string> => {
  let dataUrlPromise = runtimePackage.textureDataUrls.get(path);
  if (!dataUrlPromise) {
    // Magic sniffing beats extensions: VTube Studio packages sometimes use
    // texture.bin or extensionless images.
    dataUrlPromise = sniffImageMime(blob)
      .then(sniffed => blobToDataUrl(blob, sniffed || mimeForPath(path)));
    runtimePackage.textureDataUrls.set(path, dataUrlPromise);
  }
  return dataUrlPromise;
};

export interface Live2DLoadTimings {
  cache: 'memory' | Live2DRuntimePackage['source'];
  packageMs: number;
  manifestMs: number;
  textureMs: number;
  totalMs: number;
}

/**
 * Warm the expensive persistent package read and texture → data URL conversion
 * while the user is still on the role picker. Cubism/Pixi model construction is
 * intentionally left to the visible canvas.
 */
export const prewarmLive2DModelSource = async (
  config: Live2DAvatarConfig,
  onProgress?: Live2DLoadProgress,
): Promise<Live2DLoadTimings> => {
  const totalStartedAt = nowMs();
  const packageResult = await getLive2DRuntimePackage(config, onProgress);
  const { runtimePackage } = packageResult;
  const manifestStartedAt = nowMs();
  const settingsBlob = runtimePackage.entries.get(config.modelPath);
  if (!settingsBlob) throw new Error('模型包内找不到 model3.json，请重新导入。');
  const settings = JSON.parse(await settingsBlob.text()) as Model3Json & Record<string, any>;
  const textureRefs = settings.FileReferences?.Textures || [];
  const manifestMs = nowMs() - manifestStartedAt;
  const textureStartedAt = nowMs();
  await Promise.all(textureRefs.map((reference: string) => {
    const path = resolveModelReference(config.modelPath, reference);
    const blob = runtimePackage.entries.get(path);
    if (!blob) throw new Error(`模型包缺少 ${reference}`);
    return getRuntimeTextureDataUrl(runtimePackage, path, blob);
  }));
  const textureMs = nowMs() - textureStartedAt;
  const timings: Live2DLoadTimings = {
    cache: packageResult.memoryHit ? 'memory' : runtimePackage.source,
    packageMs: packageResult.waitMs,
    manifestMs,
    textureMs,
    totalMs: nowMs() - totalStartedAt,
  };
  onProgress?.(`模型预热完成：包 ${prettyMs(timings.packageMs)}，贴图 ${prettyMs(textureMs)}`);
  console.info('[live2d] prewarm complete', { assetId: config.assetId, ...timings });
  return timings;
};

/**
 * Pixi's texture parser cannot infer an image extension from a bare `blob:` URL.
 * Build a settings object whose textures use MIME-bearing data URLs, while the
 * larger moc/physics/motion resources keep revocable blob URLs.
 */
export const loadLive2DModelSource = async (
  config: Live2DAvatarConfig,
  onProgress?: Live2DLoadProgress,
): Promise<{
  settings: Record<string, any>;
  textureUrls: string[];
  actionParameterIds: Record<string, string[]>;
  timings: Live2DLoadTimings;
  cleanup: () => void;
}> => {
  const totalStartedAt = nowMs();
  const packageResult = await getLive2DRuntimePackage(config, onProgress);
  const runtimePackage = packageResult.runtimePackage;
  const entries = runtimePackage.entries;
  const manifestStartedAt = nowMs();
  const settingsBlob = entries.get(config.modelPath);
  if (!settingsBlob) throw new Error('模型包内找不到 model3.json，请重新导入。');
  const settings = JSON.parse(await settingsBlob.text()) as Model3Json & Record<string, any>;
  const refs = settings.FileReferences;
  if (!refs) throw new Error('model3.json 缺少 FileReferences。');
  const parameterEntries = await Promise.all(config.actions.map(async action => (
    [action.id, await discoverActionParameterIds(action, entries, config.modelPath)] as const
  )));
  const actionParameterIds = Object.fromEntries(parameterEntries.filter(([, ids]) => ids.length));
  const manifestMs = nowMs() - manifestStartedAt;

  // model3.json often omits VTube Studio hotkey expressions and idle motions.
  // Rehydrate every discovered/approved definition into the runtime settings so
  // the Cubism managers can actually play what the importer found.
  refs.Expressions ||= [];
  refs.Motions ||= {};
  for (const action of config.actions) {
    if (action.kind === 'expression' && action.file && !action.resetExpression) {
      const actionPath = resolveModelReference(config.modelPath, action.file);
      const existing = refs.Expressions.find(item => item.File && resolveModelReference(config.modelPath, item.File) === actionPath);
      if (existing) existing.Name = action.expressionId || action.name;
      else refs.Expressions.push({ Name: action.expressionId || action.name, File: action.file });
    }
    if (action.kind === 'motion' && action.file) {
      const group = action.group || 'Imported';
      const motions = refs.Motions[group] ||= [];
      const actionPath = resolveModelReference(config.modelPath, action.file);
      if (!motions.some(item => item.File && resolveModelReference(config.modelPath, item.File) === actionPath)) {
        motions.push({ Name: action.name, File: action.file });
      }
    }
  }

  const objectUrls: string[] = [];
  const objectUrlCache = new Map<string, string>();
  const textureUrlCache = new Map<string, string>();
  const resolveBlob = (reference: string): { path: string; blob: Blob } => {
    const path = resolveModelReference(config.modelPath, reference);
    const blob = entries.get(path);
    if (!blob) throw new Error(`模型包缺少 ${reference}`);
    return { path, blob };
  };
  const toObjectUrl = (reference?: string): string | undefined => {
    if (!reference) return undefined;
    const { path, blob } = resolveBlob(reference);
    const cached = objectUrlCache.get(path);
    if (cached) return cached;
    const url = URL.createObjectURL(blob);
    objectUrlCache.set(path, url);
    objectUrls.push(url);
    return url;
  };
  const toTextureUrl = async (reference: string): Promise<string> => {
    const { path, blob } = resolveBlob(reference);
    const cached = textureUrlCache.get(path);
    if (cached) return cached;
    const url = await getRuntimeTextureDataUrl(runtimePackage, path, blob);
    if (!url) throw new Error(`贴图 ${reference} 读取为空，文件可能已损坏。`);
    textureUrlCache.set(path, url);
    return url;
  };

  try {
    refs.Moc = toObjectUrl(refs.Moc);
    const textureStartedAt = nowMs();
    refs.Textures = await Promise.all((refs.Textures || []).map(texture => toTextureUrl(texture)));
    const textureMs = nowMs() - textureStartedAt;
    refs.Physics = toObjectUrl(refs.Physics);
    refs.Pose = toObjectUrl(refs.Pose);
    refs.DisplayInfo = toObjectUrl(refs.DisplayInfo);
    refs.UserData = toObjectUrl(refs.UserData);
    for (const motions of Object.values(refs.Motions || {})) {
      for (const motion of motions) {
        motion.File = toObjectUrl(motion.File);
        motion.Sound = toObjectUrl(motion.Sound);
      }
    }
    for (const expression of refs.Expressions || []) expression.File = toObjectUrl(expression.File);
    settings.url = 'live2d-package/model.model3.json';
    const timings: Live2DLoadTimings = {
      cache: packageResult.memoryHit ? 'memory' : runtimePackage.source,
      packageMs: packageResult.waitMs,
      manifestMs,
      textureMs,
      totalMs: nowMs() - totalStartedAt,
    };
    onProgress?.(`缓存就绪：模型包 ${prettyMs(timings.packageMs)}，贴图 ${prettyMs(textureMs)}`);
    console.info('[live2d] model source ready', {
      assetId: config.assetId,
      ...timings,
      archiveUnpackMs: runtimePackage.unpackMs,
    });
    return {
      settings,
      textureUrls: [...textureUrlCache.values()],
      actionParameterIds,
      timings,
      cleanup: () => objectUrls.splice(0).forEach(url => URL.revokeObjectURL(url)),
    };
  } catch (error) {
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    throw error;
  }
};

export const findLive2DActionsForPerformance = (
  config: Live2DAvatarConfig,
  performance: { emotion?: string; gesture?: string; modelAction?: string },
): Live2DAction[] => {
  const allowed = config.actions.filter(action => action.permission === 'ai');
  if (performance.modelAction) {
    const explicit = allowed.find(action => action.id === performance.modelAction);
    if (explicit) return [explicit];
  }
  const wanted = new Set([performance.emotion, performance.gesture].filter(Boolean));
  const matches = allowed.filter(action => action.tags.some(tag => wanted.has(tag)));
  const expression = matches.find(action => action.kind === 'expression');
  const motion = matches.find(action => action.kind === 'motion');
  return [expression, motion].filter((action): action is Live2DAction => Boolean(action));
};

/** Build an uncompressed runtime archive so future loads only read entries. */
export const buildStoredLive2DPackage = async (entries: PackageEntry[]): Promise<Blob> => {
  const zip = new JSZip();
  await Promise.all(entries.map(async entry => {
    zip.file(entry.path, await entry.blob.arrayBuffer(), { compression: 'STORE' });
  }));
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
};

export interface Live2DPerformanceMix {
  expression?: Live2DAction;
  motions: Live2DAction[];
  params: Live2DAction[];
}

/**
 * Builds the conservative multi-layer plan used only by high-quality calls.
 * Expressions use Cubism's single expression manager, parameter presets are
 * composited by our envelope, and motion files run together only when their
 * declared parameter curves prove they do not compete with each other.
 */
export const buildLive2DPerformanceMix = (
  config: Live2DAvatarConfig,
  performance: {
    emotion?: string;
    gesture?: string;
    modelAction?: string;
    modelActions?: string[];
  },
  runtimeParameterIds: Record<string, string[]> = {},
): Live2DPerformanceMix => {
  const allowed = config.actions.filter(action => action.permission === 'ai');
  const allowedById = new Map(allowed.map(action => [action.id, action]));
  const requestedIds = [...new Set([
    ...(performance.modelActions || []),
    performance.modelAction,
  ].filter((id): id is string => Boolean(id)))].slice(0, 3);
  const explicit = requestedIds
    .map(id => allowedById.get(id))
    .filter((action): action is Live2DAction => Boolean(action));
  const wanted = new Set([performance.emotion, performance.gesture].filter(Boolean));
  const matches = allowed.filter(action => action.tags.some(tag => wanted.has(tag)));
  const unique = (actions: Live2DAction[]): Live2DAction[] => (
    [...new Map(actions.map(action => [action.id, action])).values()]
  );

  const expression = explicit.find(action => action.kind === 'expression')
    || matches.find(action => action.kind === 'expression' && action.tags.includes(performance.emotion || ''))
    || matches.find(action => action.kind === 'expression');

  const params = unique([
    ...explicit.filter(action => action.kind === 'params'),
    ...matches.filter(action => action.kind === 'params' && action.tags.includes(performance.emotion || '')),
    ...matches.filter(action => action.kind === 'params' && action.tags.includes(performance.gesture || '')),
  ]).slice(0, 2);

  const motionCandidates = unique([
    ...explicit.filter(action => action.kind === 'motion'),
    ...matches.filter(action => action.kind === 'motion' && action.tags.includes(performance.gesture || '')),
    ...matches.filter(action => action.kind === 'motion' && action.tags.includes(performance.emotion || '')),
    ...matches.filter(action => action.kind === 'motion'),
  ]);
  const motions: Live2DAction[] = [];
  for (const candidate of motionCandidates) {
    if (motions.length >= 2) break;
    if (!motions.length) {
      motions.push(candidate);
      continue;
    }
    const candidateIds = new Set(candidate.parameterIds || runtimeParameterIds[candidate.id] || []);
    if (!candidateIds.size) continue;
    const disjoint = motions.every(active => {
      if (active.group && candidate.group && active.group === candidate.group) return false;
      const activeIds = active.parameterIds || runtimeParameterIds[active.id] || [];
      return activeIds.length > 0 && activeIds.every(id => !candidateIds.has(id));
    });
    if (disjoint) motions.push(candidate);
  }

  return { expression, motions, params };
};
