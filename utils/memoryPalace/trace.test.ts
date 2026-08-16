import { beforeEach, describe, expect, it } from 'vitest';

import { injectMemoryPalace } from './pipeline';
import { RECALL_PIPELINE_VERSION, readRecallRuntimeSnapshot } from './trace';

describe('memory palace M0 trace', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('defaults every experimental feature flag to off', () => {
        const snapshot = readRecallRuntimeSnapshot();

        expect(snapshot.featureFlagsSnapshot).toEqual({
            recallRouter: false,
            interactionAdaptation: false,
            deepEngagement: false,
            epistemicState: false,
        });
        expect(snapshot.safeConfig.pipelineVersion).toBe(RECALL_PIPELINE_VERSION);
    });

    it('hashes behavior-driving config without retaining secrets or endpoints', () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            embedding: {
                baseUrl: 'https://private.example/v1',
                apiKey: 'secret-one',
                model: 'embedding-model',
                dimensions: 1024,
            },
            lightLLM: {
                baseUrl: 'https://light.example/v1',
                apiKey: 'light-secret',
                model: 'light-model',
            },
            rerank: {
                enabled: true,
                baseUrl: 'https://rerank.example/v1',
                apiKey: 'rerank-secret',
                model: 'rerank-model',
                topN: 5,
            },
            featureFlags: { recallRouter: false },
        }));
        const first = readRecallRuntimeSnapshot();

        const serialized = JSON.stringify(first.safeConfig);
        expect(serialized).not.toContain('secret-one');
        expect(serialized).not.toContain('private.example');
        expect(serialized).not.toContain('light-secret');
        expect(serialized).not.toContain('rerank-secret');

        const changedSecretOnly = JSON.parse(localStorage.getItem('os_memory_palace_config')!);
        changedSecretOnly.embedding.apiKey = 'secret-two';
        localStorage.setItem('os_memory_palace_config', JSON.stringify(changedSecretOnly));
        expect(readRecallRuntimeSnapshot().configSnapshotHash).toBe(first.configSnapshotHash);

        changedSecretOnly.featureFlags.recallRouter = true;
        localStorage.setItem('os_memory_palace_config', JSON.stringify(changedSecretOnly));
        expect(readRecallRuntimeSnapshot().configSnapshotHash).not.toBe(first.configSnapshotHash);
    });

    it('clears stale injections when the palace is disabled', async () => {
        const char = {
            id: 'char-disabled',
            memoryPalaceEnabled: false,
            memoryPalaceInjection: '上一轮召回',
            roomPlatesInjection: '上一轮门牌',
        };

        const trace = await injectMemoryPalace(char, [], undefined, undefined, { entryPoint: 'chat_app' });

        expect(char.memoryPalaceInjection).toBe('');
        expect(char.roomPlatesInjection).toBe('');
        expect(trace.entryPoint).toBe('chat_app');
        expect(trace.outcome).toBe('skipped_palace_disabled');
        expect(trace.injection.clearedPreviousMemory).toBe(true);
        expect(trace.injection.clearedPreviousRoomPlates).toBe(true);
    });

    it('clears stale injections when embedding is not configured', async () => {
        const char = {
            id: 'char-no-embedding',
            memoryPalaceEnabled: true,
            memoryPalaceInjection: '不能继续沿用',
            roomPlatesInjection: '也不能继续沿用',
        };

        const trace = await injectMemoryPalace(char, []);

        expect(char.memoryPalaceInjection).toBe('');
        expect(char.roomPlatesInjection).toBe('');
        expect(trace.outcome).toBe('skipped_embedding_unconfigured');
        expect(trace.pipelineVersion).toBe(RECALL_PIPELINE_VERSION);
        expect(trace.featureFlagsSnapshot).toEqual({
            recallRouter: false,
            interactionAdaptation: false,
            deepEngagement: false,
            epistemicState: false,
        });
    });

    it('distinguishes a valid empty recall from a pipeline failure', async () => {
        const char = {
            id: 'char-empty-query',
            memoryPalaceEnabled: true,
            embeddingConfig: {
                baseUrl: 'https://embedding.example/v1',
                apiKey: 'test-key',
                model: 'test-model',
                dimensions: 3,
            },
            memoryPalaceInjection: '上一轮召回',
            roomPlatesInjection: '',
        };

        // 空消息会在发起 embedding 请求前结束，测试不访问网络。
        const trace = await injectMemoryPalace(char, [], undefined, '用户', { entryPoint: 'chat_app' });

        expect(trace.outcome).toBe('empty');
        expect(trace.retrievalReason).toBe('no_effective_query');
        expect(trace.failureReason).toBeUndefined();
        expect(trace.stages.find(stage => stage.name === 'retrieve')?.outcome).toBe('empty');
        expect(char.memoryPalaceInjection).toBe('');
    });

});
