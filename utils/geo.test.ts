import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { describeDevicePositionError, getCurrentPositionSmart } from './geo';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: vi.fn(() => false) } }));
vi.mock('@capacitor/geolocation', () => ({ Geolocation: { checkPermissions: vi.fn(), getCurrentPosition: vi.fn() } }));
const position = vi.fn();
beforeEach(() => {
    vi.clearAllMocks(); vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: position } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('preserves browser error codes but translates them without the raw message', async () => {
    position.mockImplementationOnce((_success, failure) => failure({ code: 1, message: 'RAW-SENSITIVE-DETAIL' }));
    let failure: unknown;
    try { await getCurrentPositionSmart({ quiet: true }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 1 });
    expect(describeDevicePositionError(failure)).toContain('没有定位权限');
    expect(describeDevicePositionError(failure)).not.toContain('RAW');
});
it('reports an unsupported environment separately', async () => {
    vi.stubGlobal('navigator', {});
    await expect(getCurrentPositionSmart()).rejects.toMatchObject({ code: 0 });
});
it('retains native-to-browser fallback with quiet mode and does not log a native error', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Geolocation.checkPermissions).mockResolvedValue({ location: 'granted', coarseLocation: 'granted' });
    vi.mocked(Geolocation.getCurrentPosition).mockRejectedValue(new Error('RAW-SENSITIVE-NATIVE-ERROR'));
    position.mockImplementationOnce(success => success({ coords: { latitude: 31, longitude: 121, accuracy: 10 } }));
    const warn = vi.spyOn(console, 'warn');
    await expect(getCurrentPositionSmart({ quiet: true })).resolves.toEqual({ latitude: 31, longitude: 121, accuracy: 10 });
    expect(warn).not.toHaveBeenCalled();
});
