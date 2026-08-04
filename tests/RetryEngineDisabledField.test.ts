import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RetryEngine } from '../src/content/engines/RetryEngine';
import { SmartWaitEngine } from '../src/content/engines/SmartWaitEngine';
import { Action, Step, SelectorStrategy } from '../src/types';

describe('RetryEngine Disabled/ReadOnly Field Verification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('should return FILLED_READONLY when element is disabled but value matches expected rawValue', async () => {
    const input = document.createElement('input');
    input.id = 'applicableISAmount';
    input.type = 'text';
    input.disabled = true;
    input.value = '284.45';
    document.body.appendChild(input);

    const step: Step = {
      id: 'step-disabled',
      action: Action.FILL,
      selector: '#applicableISAmount',
      selectorMeta: {},
      value: '₹284.45',
      required: true,
      pageId: 'p1',
    };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue({
      element: input,
      strategy: SelectorStrategy.ID,
      confidence: 1,
      shadow: false
    });

    const result = await RetryEngine.executeStepWithRetry(step, {});
    expect(result.success).toBe(true);
    expect(result.resolvedStatus).toBe('FILLED_READONLY');
    expect(result.resolvedValue).toBe('₹284.45');
  });

  it('should return FILLED_READONLY when element is readonly but value matches expected rawValue', async () => {
    const input = document.createElement('input');
    input.id = 'maxAmount';
    input.type = 'text';
    input.readOnly = true;
    input.value = '1,000';
    document.body.appendChild(input);

    const step: Step = {
      id: 'step-readonly',
      action: Action.FILL,
      selector: '#maxAmount',
      selectorMeta: {},
      value: '1000',
      required: true,
      pageId: 'p1',
    };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue({
      element: input,
      strategy: SelectorStrategy.ID,
      confidence: 1,
      shadow: false
    });

    const result = await RetryEngine.executeStepWithRetry(step, {});
    expect(result.success).toBe(true);
    expect(result.resolvedStatus).toBe('FILLED_READONLY');
  });

  it('should fail with RETRYABLE disabled error when element is disabled and empty/mismatched', async () => {
    const input = document.createElement('input');
    input.id = 'applicableISAmount';
    input.type = 'text';
    input.disabled = true;
    input.value = '';
    document.body.appendChild(input);

    const step: Step = {
      id: 'step-disabled-empty',
      action: Action.FILL,
      selector: '#applicableISAmount',
      selectorMeta: {},
      value: '284.45',
      required: true,
      pageId: 'p1',
    };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue({
      element: input,
      strategy: SelectorStrategy.ID,
      confidence: 1,
      shadow: false
    });

    const result = await RetryEngine.executeStepWithRetry(step, {});
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('Element is disabled or non-interactable');
  }, 15000);

  it('should dynamically poll and succeed when disabled value populates after a 200ms cold-start calculation delay', async () => {
    const input = document.createElement('input');
    input.id = 'applicableISAmount';
    input.type = 'text';
    input.disabled = true;
    input.value = '';
    document.body.appendChild(input);

    // Simulate website calculation script populating value 200ms after step start
    setTimeout(() => {
      input.value = '284.45';
    }, 200);

    const step: Step = {
      id: 'step-delayed',
      action: Action.FILL,
      selector: '#applicableISAmount',
      selectorMeta: {},
      value: '₹284.45',
      required: true,
      pageId: 'p1',
    };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue({
      element: input,
      strategy: SelectorStrategy.ID,
      confidence: 1,
      shadow: false
    });

    const start = Date.now();
    const result = await RetryEngine.executeStepWithRetry(step, {});
    const duration = Date.now() - start;

    expect(result.success).toBe(true);
    expect(result.resolvedStatus).toBe('FILLED_READONLY');
    expect(duration).toBeGreaterThanOrEqual(150);
    expect(duration).toBeLessThan(1500);
  });
});
