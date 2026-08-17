import React, { useCallback, useEffect, useRef, useState } from 'react';
import { attachAudioMirrorFallback } from '../../../utils/assetUrl';

export type QixiBGMGroup = 'fall' | 'explore' | 'otherSide' | 'bridge';

const QIXI_BGM_GROUPS: Record<QixiBGMGroup, string[]> = {
    fall: [
        'bgm/qixi/01/02_0_褪色客厅.mp3',
        'bgm/qixi/01/1_0_褪色客厅.mp3',
    ],
    explore: [
        'bgm/qixi/02/01_0_旧钟房间.mp3',
        'bgm/qixi/02/02_0_旧钟房间.mp3',
    ],
    otherSide: [
        'bgm/qixi/03/01_0_鹊桥月色.mp3',
        'bgm/qixi/03/02_0_月下双向.mp3',
        'bgm/qixi/03/03_0_月下双向.mp3',
    ],
    bridge: [
        'bgm/qixi/04/01_0_鹊桥释然.mp3',
        'bgm/qixi/04/02_0_鹊桥释然.mp3',
        'bgm/qixi/04/03_0_风铃之约.mp3',
    ],
};

const MUTED_KEY = 'sullyos_qixi_bgm_muted';
const TARGET_VOLUME = 0.32;
const FADE_MS = 1100;

export const qixiStageToBGMGroup = (stage: string, sceneIndex: number): QixiBGMGroup | null => {
    if (['fakeChat', 'distort', 'entry'].includes(stage)) return 'fall';
    if (stage === 'scene' || stage === 'sceneTransition') {
        if (sceneIndex <= 0) return 'fall';
        if (sceneIndex <= 3) return 'explore';
        return 'otherSide';
    }
    if (['bridgeLoading', 'bridge', 'bridgeCrossing', 'reunionLoading', 'reunion', 'touch', 'ending'].includes(stage)) return 'bridge';
    return null;
};

const pickOne = <T,>(items: T[]): T | undefined => items[Math.floor(Math.random() * items.length)];

export function useQixiBGM(stage: string, sceneIndex: number) {
    const group = qixiStageToBGMGroup(stage, sceneIndex);
    const [muted, setMuted] = useState(() => {
        try { return localStorage.getItem(MUTED_KEY) === '1'; } catch { return false; }
    });
    const audiosRef = useRef<Partial<Record<QixiBGMGroup, HTMLAudioElement>>>({});
    const cleanupRef = useRef<Array<() => void>>([]);
    const fadeTimersRef = useRef<Map<HTMLAudioElement, number>>(new Map());
    const mutedRef = useRef(muted);
    mutedRef.current = muted;

    const fade = useCallback((audio: HTMLAudioElement, target: number, duration = FADE_MS) => {
        const previous = fadeTimersRef.current.get(audio);
        if (previous) window.clearInterval(previous);
        const steps = 14;
        const start = audio.volume;
        let step = 0;
        const timer = window.setInterval(() => {
            step += 1;
            audio.volume = Math.max(0, Math.min(1, start + (target - start) * (step / steps)));
            if (step < steps) return;
            window.clearInterval(timer);
            fadeTimersRef.current.delete(audio);
            if (target === 0) audio.pause();
        }, duration / steps);
        fadeTimersRef.current.set(audio, timer);
    }, []);

    useEffect(() => {
        (Object.keys(QIXI_BGM_GROUPS) as QixiBGMGroup[]).forEach(key => {
            const path = pickOne(QIXI_BGM_GROUPS[key]);
            if (!path) return;
            const audio = new Audio();
            audio.loop = true;
            audio.preload = 'auto';
            audio.volume = 0;
            cleanupRef.current.push(attachAudioMirrorFallback(audio, path));
            audio.load();
            audiosRef.current[key] = audio;
        });
        return () => {
            fadeTimersRef.current.forEach(timer => window.clearInterval(timer));
            fadeTimersRef.current.clear();
            cleanupRef.current.forEach(cleanup => cleanup());
            cleanupRef.current = [];
            Object.values(audiosRef.current).forEach(audio => {
                if (!audio) return;
                audio.pause();
                audio.removeAttribute('src');
                audio.load();
            });
            audiosRef.current = {};
        };
    }, []);

    useEffect(() => {
        const targetVolume = mutedRef.current ? 0 : TARGET_VOLUME;
        let retry: (() => void) | undefined;
        const playCurrent = (audio: HTMLAudioElement) => {
            audio.play().then(() => fade(audio, targetVolume)).catch(error => {
                if (error?.name !== 'NotAllowedError') return;
                retry = () => {
                    audio.play().then(() => fade(audio, mutedRef.current ? 0 : TARGET_VOLUME)).catch(() => undefined);
                };
                document.addEventListener('pointerdown', retry, { once: true, passive: true });
                document.addEventListener('keydown', retry, { once: true });
            });
        };
        (Object.keys(audiosRef.current) as QixiBGMGroup[]).forEach(key => {
            const audio = audiosRef.current[key];
            if (!audio) return;
            if (key === group) {
                if (audio.paused) playCurrent(audio);
                else fade(audio, targetVolume);
            } else if (!audio.paused) fade(audio, 0);
        });
        return () => {
            if (!retry) return;
            document.removeEventListener('pointerdown', retry);
            document.removeEventListener('keydown', retry);
        };
    }, [fade, group]);

    useEffect(() => {
        try { localStorage.setItem(MUTED_KEY, muted ? '1' : '0'); } catch { /* optional */ }
        const current = group ? audiosRef.current[group] : undefined;
        if (!current) return;
        if (!muted && current.paused) current.play().catch(() => undefined);
        fade(current, muted ? 0 : TARGET_VOLUME, 450);
    }, [fade, group, muted]);

    return { group, muted, toggleMuted: useCallback(() => setMuted(value => !value), []) };
}

export const QixiBGMToggle: React.FC<{ muted: boolean; onToggle: () => void }> = ({ muted, onToggle }) => (
    <button type="button" className={`q7-bgm ${muted ? 'is-muted' : ''}`} onClick={onToggle} aria-label={muted ? '播放七夕背景音乐' : '静音七夕背景音乐'} title={muted ? '播放 BGM' : '静音 BGM'}>
        <i>{muted ? '×' : '♪'}</i><span>{muted ? 'BGM OFF' : 'BGM'}</span>
    </button>
);
