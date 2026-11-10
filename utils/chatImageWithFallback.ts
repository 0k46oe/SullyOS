import type { CharacterProfile, ImageGenerationConfig } from '../types';
import { generateChatImage, ImageGenerationFailure } from './chatImageGeneration';
import { saveImageTextCard } from './chatImageTextCard';

export async function generateImageWithFallback(char: CharacterProfile, prompt: string, options: { config: ImageGenerationConfig; signal?: AbortSignal; presetId?: string }) {
    try {
        return { imageRef: await generateChatImage(char, prompt, options), failed: false };
    } catch (error) {
        options.signal?.throwIfAborted();
        if (!(error instanceof ImageGenerationFailure)) throw error;
        const imageRef = await saveImageTextCard(prompt);
        options.signal?.throwIfAborted();
        return { imageRef, failed: true, error: error.message };
    }
}
