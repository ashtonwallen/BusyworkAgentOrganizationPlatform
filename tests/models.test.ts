import { describe, expect, it } from 'vitest';
import { applyContextLimit, createModels } from '../packages/runtime/src/models.js';

describe('Discovered local context limits', () => {
  it('never increases an owner-configured output cap', () => {
    const model = createModels({})[2]!;
    model.maxOutputTokens = 500;
    applyContextLimit(model, 8192);
    expect(model.ready).toBe(true);
    expect(model.maxOutputTokens).toBe(500);
    expect(model.maxInputTokens + model.maxOutputTokens).toBeLessThanOrEqual(Math.floor(8192 * 0.92));
  });

  it('shrinks caps for loaded context and never grows them on rediscovery', () => {
    const model = createModels({})[2]!;
    applyContextLimit(model, 8192);
    const caps = [model.maxInputTokens, model.maxOutputTokens];
    expect(caps[0]! + caps[1]!).toBeLessThanOrEqual(Math.floor(8192 * 0.92));
    applyContextLimit(model, 32768);
    expect([model.maxInputTokens, model.maxOutputTokens]).toEqual(caps);
  });

  it.each([NaN, Infinity, -1, 0, 8192.5, 2048])('disables unusable context %s', context => {
    const model = createModels({})[2]!;
    applyContextLimit(model, context);
    expect(model.ready).toBe(false);
  });
});
