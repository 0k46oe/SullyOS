import { describe, expect, it } from 'vitest';
import { bridgeCubism6RenderOrders } from './live2dCore';

const createModel = (
  drawables: { count: number; renderOrders?: Int32Array },
  renderOrders: Int32Array,
  offscreenCount = 0,
) => ({
  internalModel: {
    coreModel: {
      _model: {
        drawables,
        offscreens: { count: offscreenCount },
        getRenderOrders: () => renderOrders,
      },
    },
  },
});

describe('bridgeCubism6RenderOrders', () => {
  it('maps Core 6 model render orders onto the legacy drawable field', () => {
    const drawables: { count: number; renderOrders?: Int32Array } = { count: 3 };
    const renderOrders = new Int32Array([2, 0, 1]);

    const result = bridgeCubism6RenderOrders(createModel(drawables, renderOrders));

    expect(result).toEqual({ offscreenCount: 0 });
    expect(drawables.renderOrders).toEqual(renderOrders);
  });

  it('leaves pre-5.3 drawable render orders untouched', () => {
    const existing = new Int32Array([0, 1]);
    const drawables = { count: 2, renderOrders: existing };
    const model = createModel(drawables, new Int32Array([1, 0]));

    bridgeCubism6RenderOrders(model);

    expect(drawables.renderOrders).toBe(existing);
  });

  it('rejects Core 6 offscreen models instead of rendering them incorrectly', () => {
    const drawables: { count: number; renderOrders?: Int32Array } = { count: 2 };
    const model = createModel(drawables, new Int32Array([0, 2, 1]), 1);

    expect(() => bridgeCubism6RenderOrders(model)).toThrow(
      'This Cubism 5.3 model uses 1 offscreen object(s)',
    );
    expect(drawables.renderOrders).toBeUndefined();
  });
});
