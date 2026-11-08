import React, { useSyncExternalStore } from 'react';
import { useOS } from '../context/OSContext';
import { AppID } from '../types';
import { dateLaunch } from '../utils/dateLaunch';
import { meetingGeneration } from '../utils/meetingGeneration';

export default function MeetingBroadcast() {
    const jobs = useSyncExternalStore(meetingGeneration.subscribe, meetingGeneration.getSnapshot, meetingGeneration.getSnapshot);
    const { activeApp, openApp } = useOS();
    if (activeApp === AppID.Date || jobs.length === 0) return null;
    const job = jobs[0];
    return <div className="fixed left-1/2 z-[999] -translate-x-1/2" style={{ top: 'calc(var(--safe-top) + 44px)' }}>
        <button type="button" onClick={() => { dateLaunch.request({ surface: job.surface }); openApp(AppID.Date); }} className="rounded-full border border-emerald-200/30 bg-slate-900/90 px-4 py-2 text-xs text-white shadow-lg">
            {job.label} {job.surface === 'story' ? '正在续写' : '正在回应'}{jobs.length > 1 ? ` · 共 ${jobs.length} 项` : '…'}
        </button>
    </div>;
}
