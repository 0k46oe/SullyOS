import { describe, expect, it, vi } from 'vitest';
import {
  HistoryLike,
  installTwaBackNavigation,
  isTwaNavigationContext,
} from './twaBackNavigation';

const createHistory = (initialState: unknown = null) => {
  let state = initialState;
  const replaceState = vi.fn((next: unknown) => { state = next; });
  const pushState = vi.fn((next: unknown) => { state = next; });
  const history: HistoryLike = {
    get state() { return state; },
    replaceState,
    pushState,
  };
  return { history, pushState, replaceState };
};

describe('isTwaNavigationContext', () => {
  it('enables the bridge for a TWA referrer', () => {
    expect(isTwaNavigationContext({
      isNativePlatform: false,
      referrer: 'android-app://io.github.qegj567cloud.sullyos/',
      matchesDisplayMode: () => false,
    })).toBe(true);
  });

  it('enables the bridge for installed fullscreen and standalone modes', () => {
    expect(isTwaNavigationContext({
      isNativePlatform: false,
      referrer: '',
      matchesDisplayMode: (mode) => mode === 'fullscreen',
    })).toBe(true);
  });

  it('leaves normal browser tabs and Capacitor navigation untouched', () => {
    expect(isTwaNavigationContext({
      isNativePlatform: false,
      referrer: '',
      matchesDisplayMode: () => false,
    })).toBe(false);
    expect(isTwaNavigationContext({
      isNativePlatform: true,
      referrer: 'android-app://io.github.qegj567cloud.sullyos/',
      matchesDisplayMode: () => true,
    })).toBe(false);
  });
});
describe('installTwaBackNavigation', () => {
  it('creates one root and one guard entry, then routes root pops to onBack', () => {
    const { history, pushState, replaceState } = createHistory({ existing: 1 });
    const onBack = vi.fn();
    let popListener: ((state: unknown) => void) | undefined;

    installTwaBackNavigation({
      history,
      getCurrentUrl: () => 'https://example.test/SullyOS/',
      subscribeToPopState: (listener) => {
        popListener = listener;
        return vi.fn();
      },
      onBack,
    });

    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState.mock.calls[0][0]).toMatchObject({
      existing: 1,
      __sullyosTwaBackRoot: true,
    });
    expect(pushState).toHaveBeenCalledOnce();
    expect(pushState.mock.calls[0][0]).toMatchObject({
      existing: 1,
      __sullyosTwaBackGuard: true,
    });

    popListener?.({ unrelatedFeatureEntry: true });
    expect(onBack).not.toHaveBeenCalled();

    popListener?.({ __sullyosTwaBackRoot: true });
    expect(onBack).toHaveBeenCalledOnce();
    expect(pushState).toHaveBeenCalledTimes(2);
    expect(pushState.mock.calls[1][0]).toMatchObject({
      __sullyosTwaBackGuard: true,
    });
  });

  it('does not add duplicate sentinels after a remount', () => {
    const { history, pushState, replaceState } = createHistory({
      __sullyosTwaBackGuard: true,
    });

    installTwaBackNavigation({
      history,
      getCurrentUrl: () => 'https://example.test/SullyOS/',
      subscribeToPopState: () => vi.fn(),
      onBack: vi.fn(),
    });

    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
  });

  it('re-arms the guard even if an app-specific back handler throws', () => {
    const { history, pushState } = createHistory();
    let popListener: ((state: unknown) => void) | undefined;

    installTwaBackNavigation({
      history,
      getCurrentUrl: () => 'https://example.test/SullyOS/',
      subscribeToPopState: (listener) => {
        popListener = listener;
        return vi.fn();
      },
      onBack: () => { throw new Error('broken handler'); },
    });

    expect(() => popListener?.({ __sullyosTwaBackRoot: true })).toThrow('broken handler');
    expect(pushState).toHaveBeenCalledTimes(2);
  });
});
