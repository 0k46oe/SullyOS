export interface MeetingGeneration {
    key: string;
    label: string;
    surface: 'companion' | 'story';
}

let snapshot: readonly MeetingGeneration[] = [];
const listeners = new Set<() => void>();
const publish = () => listeners.forEach(listener => listener());

export const meetingGeneration = {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    begin(job: MeetingGeneration): (() => void) | null {
        if (snapshot.some(item => item.key === job.key)) return null;
        snapshot = [...snapshot, job];
        publish();
        let finished = false;
        return () => {
            if (finished) return;
            finished = true;
            snapshot = snapshot.filter(item => item !== job);
            publish();
        };
    },
};
