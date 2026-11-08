import { describe, expect, it, vi } from 'vitest';
import { meetingGeneration } from './meetingGeneration';

describe('meeting generation', () => {
    it('tracks independent jobs, prevents duplicates, and notifies on completion', () => {
        const listener = vi.fn();
        const unsubscribe = meetingGeneration.subscribe(listener);
        const finish = meetingGeneration.begin({ key: 'date:c:e', label: 'A', surface: 'companion' });
        const finishStory = meetingGeneration.begin({ key: 'story:s', label: 'S', surface: 'story' });
        expect(meetingGeneration.begin({ key: 'date:c:e', label: 'A', surface: 'companion' })).toBeNull();
        expect(meetingGeneration.getSnapshot()).toHaveLength(2);
        finish?.();
        finish?.();
        expect(meetingGeneration.getSnapshot().map(job => job.key)).toEqual(['story:s']);
        finishStory?.();
        expect(meetingGeneration.getSnapshot()).toEqual([]);
        expect(listener).toHaveBeenCalledTimes(4);
        unsubscribe();
    });
});
