import type { Category, FaceLandmarker, FaceLandmarkerResult } from '@mediapipe/tasks-vision';

export type UserCameraEmotion = 'neutral' | 'happy' | 'surprised' | 'sad' | 'angry' | 'disgusted' | 'tired';

export interface UserCameraEmotionResult {
  emotion: UserCameraEmotion;
  label: string;
  confidence: number;
}

const EMOTION_LABELS: Record<UserCameraEmotion, string> = {
  neutral: '平静',
  happy: '开心',
  surprised: '惊讶',
  sad: '低落',
  angry: '不悦',
  disgusted: '嫌弃',
  tired: '疲惫',
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const average = (...values: number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const score = (shapes: ReadonlyMap<string, number>, name: string): number => clamp01(shapes.get(name) || 0);

export const blendshapeCategoriesToMap = (categories: readonly Pick<Category, 'categoryName' | 'score'>[]): Map<string, number> => {
  const values = new Map<string, number>();
  categories.forEach(category => {
    const name = String(category.categoryName || '').trim();
    if (!name) return;
    values.set(name, Math.max(values.get(name) || 0, clamp01(Number(category.score))));
  });
  return values;
};

/**
 * Conservative blendshape-to-emotion calibration. It intentionally prefers
 * neutral over a low-confidence guess: this signal is context, not a diagnosis.
 */
export const classifyUserCameraBlendshapes = (shapes: ReadonlyMap<string, number>): UserCameraEmotionResult => {
  const smile = average(score(shapes, 'mouthSmileLeft'), score(shapes, 'mouthSmileRight'));
  const frown = average(score(shapes, 'mouthFrownLeft'), score(shapes, 'mouthFrownRight'));
  const browDown = average(score(shapes, 'browDownLeft'), score(shapes, 'browDownRight'));
  const eyeWide = average(score(shapes, 'eyeWideLeft'), score(shapes, 'eyeWideRight'));
  const eyeClosed = average(score(shapes, 'eyeBlinkLeft'), score(shapes, 'eyeBlinkRight'));
  const cheekSquint = average(score(shapes, 'cheekSquintLeft'), score(shapes, 'cheekSquintRight'));
  const noseSneer = average(score(shapes, 'noseSneerLeft'), score(shapes, 'noseSneerRight'));
  const mouthPress = average(score(shapes, 'mouthPressLeft'), score(shapes, 'mouthPressRight'));
  const mouthUpper = average(score(shapes, 'mouthUpperUpLeft'), score(shapes, 'mouthUpperUpRight'));
  const jawOpen = score(shapes, 'jawOpen');
  const browInnerUp = score(shapes, 'browInnerUp');

  const candidates: Array<{ emotion: Exclude<UserCameraEmotion, 'neutral'>; value: number }> = [
    { emotion: 'happy', value: smile * 0.72 + cheekSquint * 0.28 },
    { emotion: 'surprised', value: jawOpen * 0.42 + eyeWide * 0.36 + browInnerUp * 0.22 - smile * 0.18 },
    { emotion: 'sad', value: frown * 0.58 + browInnerUp * 0.30 + mouthPress * 0.12 },
    { emotion: 'angry', value: browDown * 0.56 + mouthPress * 0.26 + noseSneer * 0.18 },
    { emotion: 'disgusted', value: noseSneer * 0.52 + mouthUpper * 0.30 + browDown * 0.18 },
    { emotion: 'tired', value: eyeClosed * 0.72 + mouthPress * 0.16 + (1 - eyeWide) * 0.12 },
  ].map(item => ({ ...item, value: clamp01(item.value) }));
  candidates.sort((a, b) => b.value - a.value);
  const winner = candidates[0];
  const runnerUp = candidates[1]?.value || 0;
  const decisive = winner.value >= 0.42 && winner.value - runnerUp >= 0.045;
  const emotion: UserCameraEmotion = decisive ? winner.emotion : 'neutral';
  const confidence = emotion === 'neutral'
    ? clamp01(0.58 + (0.42 - winner.value) * 0.5)
    : clamp01(0.5 + winner.value * 0.42 + Math.max(0, winner.value - runnerUp) * 0.18);
  return { emotion, label: EMOTION_LABELS[emotion], confidence };
};

const resolvePublicAsset = (path: string): string => {
  const base = String(import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
  return `${base}${path.replace(/^\//, '')}`;
};

let landmarkerPromise: Promise<FaceLandmarker> | null = null;
let activeLandmarker: FaceLandmarker | null = null;
let lastVideoTimestamp = 0;
let detectorGeneration = 0;

const createLandmarker = async (): Promise<FaceLandmarker> => {
  const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(resolvePublicAsset('mediapipe/wasm'));
  const sharedOptions = {
    baseOptions: { modelAssetPath: resolvePublicAsset('mediapipe/models/face_landmarker.task') },
    runningMode: 'VIDEO' as const,
    numFaces: 1,
    minFaceDetectionConfidence: 0.55,
    minFacePresenceConfidence: 0.55,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  };
  try {
    return await FaceLandmarker.createFromOptions(fileset, {
      ...sharedOptions,
      baseOptions: { ...sharedOptions.baseOptions, delegate: 'GPU' },
    });
  } catch (gpuError) {
    console.warn('[camera-emotion] GPU delegate unavailable; using CPU:', gpuError);
    return FaceLandmarker.createFromOptions(fileset, sharedOptions);
  }
};

export const preloadUserCameraEmotionDetector = async (): Promise<void> => {
  if (!landmarkerPromise) {
    const generation = detectorGeneration;
    landmarkerPromise = createLandmarker()
      .then(landmarker => {
        if (generation !== detectorGeneration) {
          try { landmarker.close(); } catch { /* released while loading */ }
          throw new Error('本地识别已取消');
        }
        activeLandmarker = landmarker;
        return landmarker;
      })
      .catch(error => {
        if (generation === detectorGeneration) {
          landmarkerPromise = null;
          activeLandmarker = null;
        }
        throw error;
      });
  }
  await landmarkerPromise;
};

const detectFrame = (landmarker: FaceLandmarker, video: HTMLVideoElement): FaceLandmarkerResult => {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  lastVideoTimestamp = Math.max(lastVideoTimestamp + 1, now);
  return landmarker.detectForVideo(video, lastVideoTimestamp);
};

const delay = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

/** Samples three frames to avoid treating a single blink as a lasting emotion. */
export const detectUserCameraEmotion = async (video: HTMLVideoElement): Promise<UserCameraEmotionResult | null> => {
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return null;
  await preloadUserCameraEmotionDetector();
  const landmarker = await landmarkerPromise;
  if (!landmarker) return null;
  const aggregate = new Map<string, number[]>();
  for (let index = 0; index < 3; index += 1) {
    if (index) await delay(70);
    const result = detectFrame(landmarker, video);
    const categories = result.faceBlendshapes?.[0]?.categories;
    if (!categories?.length) continue;
    const frame = blendshapeCategoriesToMap(categories);
    frame.forEach((value, name) => aggregate.set(name, [...(aggregate.get(name) || []), value]));
  }
  if (!aggregate.size) return null;
  return classifyUserCameraBlendshapes(new Map(
    [...aggregate].map(([name, values]) => [name, average(...values)]),
  ));
};

export const buildUserCameraEmotionPrompt = (result: UserCameraEmotionResult): string => `【当前轮次的本地摄像头非语言信息】
用户主动开启了摄像头。本地面部识别在用户发送消息前检测到：${result.label}（内部标签 ${result.emotion}，置信度 ${Math.round(result.confidence * 100)}%）。
这只是可能有误差的即时非语言线索，不是用户明确陈述，也不是医学或心理判断。结合用户文字自然回应；若文字语义与识别冲突，以文字为准。不要向用户解释识别系统、置信度或本段提示。`;

export const releaseUserCameraEmotionDetector = (): void => {
  detectorGeneration += 1;
  try { activeLandmarker?.close(); } catch { /* best-effort WASM cleanup */ }
  activeLandmarker = null;
  landmarkerPromise = null;
  lastVideoTimestamp = 0;
};
