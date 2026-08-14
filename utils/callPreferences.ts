export interface CallPreferences {
  characterInitiative: boolean;
  voiceAutoPlay: boolean;
}

export const CALL_PREFERENCES_KEY = 'sully-call-preferences-v1';
export const CALL_UPDATE_ANNOUNCEMENT_KEY = 'sully-call-update-audio-2026-08-v1';

export const DEFAULT_CALL_PREFERENCES: CallPreferences = {
  characterInitiative: true,
  voiceAutoPlay: true,
};

export const parseCallPreferences = (raw: string | null | undefined): CallPreferences => {
  if (!raw) return { ...DEFAULT_CALL_PREFERENCES };
  try {
    const parsed = JSON.parse(raw) as Partial<CallPreferences> | null;
    return {
      characterInitiative: parsed?.characterInitiative !== false,
      voiceAutoPlay: parsed?.voiceAutoPlay !== false,
    };
  } catch {
    return { ...DEFAULT_CALL_PREFERENCES };
  }
};

export const loadCallPreferences = (): CallPreferences => {
  try {
    return parseCallPreferences(localStorage.getItem(CALL_PREFERENCES_KEY));
  } catch {
    return { ...DEFAULT_CALL_PREFERENCES };
  }
};

export const saveCallPreferences = (preferences: CallPreferences): void => {
  try {
    localStorage.setItem(CALL_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Safari private mode and embedded WebViews may reject localStorage writes.
  }
};

export const shouldShowCallUpdateAnnouncement = (): boolean => {
  try {
    return localStorage.getItem(CALL_UPDATE_ANNOUNCEMENT_KEY) !== 'seen';
  } catch {
    return true;
  }
};

export const markCallUpdateAnnouncementSeen = (): void => {
  try {
    localStorage.setItem(CALL_UPDATE_ANNOUNCEMENT_KEY, 'seen');
  } catch {
    // If storage is unavailable, showing the notice again is safer than hiding it forever.
  }
};
