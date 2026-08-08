const ROOT_STATE_KEY = '__sullyosTwaBackRoot';
const GUARD_STATE_KEY = '__sullyosTwaBackGuard';

type StateRecord = Record<string, unknown>;

export interface TwaNavigationContextInput {
  isNativePlatform: boolean;
  referrer: string;
  matchesDisplayMode: (mode: 'fullscreen' | 'standalone') => boolean;
}

export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export interface TwaBackNavigationOptions {
  history: HistoryLike;
  getCurrentUrl: () => string;
  subscribeToPopState: (listener: (state: unknown) => void) => () => void;
  onBack: () => void;
}

const copyState = (state: unknown): StateRecord => {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {};
  return { ...(state as StateRecord) };
};
const makeRootState = (state: unknown): StateRecord => {
  const next = copyState(state);
  delete next[GUARD_STATE_KEY];
  next[ROOT_STATE_KEY] = true;
  return next;
};

const makeGuardState = (state: unknown): StateRecord => {
  const next = copyState(state);
  delete next[ROOT_STATE_KEY];
  next[GUARD_STATE_KEY] = true;
  return next;
};

export const isTwaNavigationContext = ({
  isNativePlatform,
  referrer,
  matchesDisplayMode,
}: TwaNavigationContextInput): boolean => {
  if (isNativePlatform) return false;
  if (referrer.startsWith('android-app://')) return true;
  return matchesDisplayMode('fullscreen') || matchesDisplayMode('standalone');
};

/**
 * Adds a same-URL sentinel entry so Android/Chrome back gestures produce a
 * popstate event instead of closing the TWA task. Only the sentinel's root
 * entry is handled; history entries owned by feature screens keep working.
 */
export const installTwaBackNavigation = ({
  history,
  getCurrentUrl,
  subscribeToPopState,
  onBack,
}: TwaBackNavigationOptions): (() => void) => {
  const currentState = copyState(history.state);
  const alreadyGuarded = currentState[GUARD_STATE_KEY] === true;

  if (!alreadyGuarded) {
    const isRoot = currentState[ROOT_STATE_KEY] === true;
    if (!isRoot) {
      history.replaceState(makeRootState(currentState), '', getCurrentUrl());
    }
    history.pushState(makeGuardState(currentState), '', getCurrentUrl());
  }

  return subscribeToPopState((state) => {
    const poppedState = copyState(state);
    if (poppedState[ROOT_STATE_KEY] !== true) return;

    try {
      onBack();
    } finally {
      // Re-arm synchronously. At the SullyOS launcher onBack is intentionally
      // a no-op, so a stray gesture cannot close the whole installed app.
      history.pushState(makeGuardState(poppedState), '', getCurrentUrl());
    }
  });
};
