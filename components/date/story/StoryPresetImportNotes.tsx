import React from 'react';

export default function StoryPresetImportNotes({ notes }: { notes?: string[] }) {
    if (!notes?.length) return null;
    return <details className='mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-6 text-amber-800'>
        <summary className='cursor-pointer font-semibold'>酒馆预设兼容说明 · 使用前请查看</summary>
        <ul className='mt-2 list-disc space-y-2 pl-4'>{notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
    </details>;
}
