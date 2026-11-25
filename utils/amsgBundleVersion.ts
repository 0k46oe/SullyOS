// 主动消息 2.0 后端 bundle（worker/amsg）代码版本的唯一出处。
//
// worker bundle（worker/amsg/src/index.ts → GET /config-check 的 workerVersion）和
// SullyOS 前端的默认兼容性检查都从这里 import。设置页可以单独对照已发布的 Worker 版本。
//
// 什么时候改：worker/amsg/src/* 有了「用户不更新就用不上 / 会出错」的改动时。
// 纯注释、纯重构不用动。格式 YYYY-MM-DD，同一天发第二版就加 .2/.3 后缀；
// 前端用 compareBundleVersions 比新旧：Worker 比 App 旧才催更新；Worker 比 App 新
// （App 缓存的是旧构建，还没刷新）就请用户刷新页面。
//
// 跟另外两个版本号分清楚：
//   - utils/amsgWorkerVersion.ts 比的是**上游库** @rei-standard/amsg-server 的 semver；
//   - utils/buildInfo.ts 的 APP_VERSION 是整个 SullyOS App 的版本。
//   这里管的只有一样：用户自己那台 Worker 上跑的这份 bundle 是哪天的。
export const AMSG_BUNDLE_VERSION = '2026-11-08';

// 设置页显示的发布版本，不改变本仓库的 bundle 或兼容性门槛。
export const AMSG_WORKER_RELEASE_VERSION = '2026-11-24';

const BUNDLE_VERSION_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?$/;

/** Compare dated worker bundle versions; invalid formats return null. */
export const compareBundleVersions = (a: string, b: string): number | null => {
    const left = BUNDLE_VERSION_PATTERN.exec(a);
    const right = BUNDLE_VERSION_PATTERN.exec(b);
    if (!left || !right) return null;
    if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
    return Number(left[2] ?? 0) - Number(right[2] ?? 0);
};
