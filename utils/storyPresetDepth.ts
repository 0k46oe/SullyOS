import type { StoryTheaterPresetDocument } from '../types';
import { replaceStoryMacros, type StoryApiMessage } from './storyTheater';

/** Anchor to actual history objects, excluding preset rules, prefill and worldbook messages. */
export function injectStoryPresetDepth(
    messages: StoryApiMessage[], document: StoryTheaterPresetDocument,
    history: StoryApiMessage[], userName: string, characterNames: string[],
): StoryApiMessage[] {
    const anchors = history.filter(message => messages.includes(message));
    const groups = new Map<number, Array<{ message: StoryApiMessage; depth: number; order: number; index: number }>>();
    document.prompts.forEach((prompt, index) => {
        if (!prompt.enabled || !prompt.injection || prompt.marker || prompt.section || !prompt.content.trim()) return;
        const depth = Math.max(0, Math.round(prompt.injection.depth));
        const anchor = anchors[Math.max(0, anchors.length - depth)];
        const insertionIndex = anchor ? messages.indexOf(anchor)
            : anchors.length ? messages.indexOf(anchors[anchors.length - 1]) + 1 : messages.length;
        const group = groups.get(insertionIndex) || [];
        group.push({ message: { role: prompt.role, content: replaceStoryMacros(prompt.content, userName, characterNames) }, depth, order: prompt.injection.order, index });
        groups.set(insertionIndex, group);
    });
    const result = [...messages];
    for (const [index, group] of [...groups].sort(([a], [b]) => b - a)) {
        const roleOrder = { assistant: 0, user: 1, system: 2 };
        group.sort((a, b) => b.depth - a.depth || a.order - b.order || roleOrder[a.message.role] - roleOrder[b.message.role] || a.index - b.index);
        result.splice(index, 0, ...group.map(item => item.message));
    }
    return result;
}
