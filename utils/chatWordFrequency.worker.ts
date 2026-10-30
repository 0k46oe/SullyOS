import { countChatWords, type WordFrequencyInput, type WordFrequencyOptions } from './chatWordFrequency';

self.onmessage = (event: MessageEvent<{ inputs: WordFrequencyInput[]; options: WordFrequencyOptions }>) => {
    try {
        self.postMessage({ result: countChatWords(event.data.inputs, event.data.options) });
    } catch (error) {
        self.postMessage({ error: error instanceof Error ? error.message : '本地词频统计失败' });
    }
};
