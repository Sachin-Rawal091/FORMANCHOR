import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InputVerifier } from '../src/content/InputVerifier';
import { InputNormalizer } from '../src/content/datepickers/InputNormalizer';
import { RetryEngine } from '../src/content/engines/RetryEngine';
import { SmartWaitEngine } from '../src/content/engines/SmartWaitEngine';
import { Step, Action, SelectorStrategy } from '../src/types';

describe('Read-Only Input Bypass Architecture & Currency Verification (Audited)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  it('should verify <input readonly value="33513"> directly via RetryEngine and return FILLED_READONLY (passing)', async () => {
    const input = document.createElement('input');
    input.id = 'applicableISAmount';
    input.type = 'text';
    input.readOnly = true;
    input.value = '33513';
    container.appendChild(input);

    let blurCalled = false;
    input.addEventListener('blur', () => {
      blurCalled = true;
    });

    const step: Step = {
      id: 'step-readonly-1',
      action: Action.FILL,
      selector: '#applicableISAmount',
      selectorMeta: {},
      value: '33513',
      required: true,
      pageId: 'p1'
    };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue({
      element: input,
      strategy: SelectorStrategy.ID,
      confidence: 1,
      shadow: false
    });

    const result = await RetryEngine.executeStepWithRetry(step, {});

    // Verification 1: blur() MUST NOT be called (bypassed entirely!)
    expect(blurCalled).toBe(false);

    // Verification 2: RetryEngine returns FILLED_READONLY success status
    expect(result.success).toBe(true);
    expect(result.resolvedStatus).toBe('FILLED_READONLY');
    expect(input.value).toBe('33513');
  });

  it('should programmatically inject value into empty <input readonly> if DOM verification initially fails', async () => {
    const input = document.createElement('input');
    input.id = 'applicableISAmount';
    input.type = 'text';
    input.readOnly = true;
    input.value = ''; // Empty initially
    container.appendChild(input);

    const step: Step = {
      id: 'step-readonly-empty',
      action: Action.FILL,
      selector: '#applicableISAmount',
      selectorMeta: {},
      value: '33513',
      required: true,
      pageId: 'p1'
    };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue({
      element: input,
      strategy: SelectorStrategy.ID,
      confidence: 1,
      shadow: false
    });

    const result = await RetryEngine.executeStepWithRetry(step, {});

    // Verification: Fallback injected value into empty readonly input & returned FILLED_READONLY
    expect(result.success).toBe(true);
    expect(result.resolvedStatus).toBe('FILLED_READONLY');
    expect(input.value).toBe('33513');
  });

  it('should handle wrapper container <div> containing a nested <input readonly>', async () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'input-container';

    const input = document.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    input.value = '33513';
    wrapper.appendChild(input);
    container.appendChild(wrapper);

    const step: Step = {
      id: 'step-wrapper-readonly',
      action: Action.FILL,
      selector: '.input-container',
      selectorMeta: {},
      value: '33513',
      required: true,
      pageId: 'p1'
    };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue({
      element: wrapper,
      strategy: SelectorStrategy.ID,
      confidence: 1,
      shadow: false
    });

    const result = await RetryEngine.executeStepWithRetry(step, {});

    expect(result.success).toBe(true);
    expect(result.resolvedStatus).toBe('FILLED_READONLY');
  });

  it('should return FILLED_READONLY for unmapped disabled calculated element containing auto-calculated DOM value', async () => {
    const input = document.createElement('input');
    input.id = 'applicableISAmount';
    input.type = 'text';
    input.disabled = true;
    input.value = 'AutoCalculated33513';
    container.appendChild(input);

    const step: Step = {
      id: 'step-unmapped-readonly',
      action: Action.FILL,
      selector: '#applicableISAmount',
      selectorMeta: {},
      required: true,
      pageId: 'p1'
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
    expect(result.resolvedValue).toBe('AutoCalculated33513');
  });

  it('should return STEP_SKIPPED for unmapped disabled empty element without crashing session', async () => {
    const input = document.createElement('input');
    input.id = 'applicableISAmount';
    input.type = 'text';
    input.disabled = true;
    input.value = '';
    container.appendChild(input);

    const step: Step = {
      id: 'step-unmapped-empty-disabled',
      action: Action.FILL,
      selector: '#applicableISAmount',
      selectorMeta: {},
      required: true,
      pageId: 'p1'
    };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue({
      element: input,
      strategy: SelectorStrategy.ID,
      confidence: 1,
      shadow: false
    });

    const result = await RetryEngine.executeStepWithRetry(step, {});

    expect(result.success).toBe(true);
    expect(result.resolvedStatus).toBe('STEP_SKIPPED');
  });

  it('should fail verification for <input readonly value="33513"> when expected value is 33514', async () => {
    const input = document.createElement('input');
    input.id = 'applicableISAmount';
    input.type = 'text';
    input.readOnly = true;
    input.value = '33513';
    container.appendChild(input);

    const step: Step = {
      id: 'step-readonly-2',
      action: Action.FILL,
      selector: '#applicableISAmount',
      selectorMeta: {},
      value: '33514',
      required: true,
      pageId: 'p1',
      maxRetries: 0
    };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue({
      element: input,
      strategy: SelectorStrategy.ID,
      confidence: 1,
      shadow: false
    });

    const result = await RetryEngine.executeStepWithRetry(step, {});

    // Verification: Returns success: false when values mismatch
    expect(result.success).toBe(false);
    expect(result.resolvedStatus).toBe('FAILED');
  });

  it('should strictly fail verification for <input value="062100"> when expected is 62100 (leading zero PIN protection)', () => {
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = '62100';

    // PIN code / Account ID with leading zero in Excel vs missing in DOM (or vice versa)
    const resID = InputVerifier.verify(textInput, '062100');
    expect(resID.pass).toBe(false);
  });

  it('should match currency formatted portal values (Rs., INR, /- suffixes) with raw numbers in InputVerifier', () => {
    const input = document.createElement('input');
    input.type = 'text';

    // Test Rs. 33,513.00 vs 33513
    input.value = 'Rs. 33,513.00';
    const resRs = InputVerifier.verify(input, '33513');
    expect(resRs.pass).toBe(true);

    // Test INR 33513 vs 33513
    input.value = 'INR 33513';
    const resINR = InputVerifier.verify(input, '33513');
    expect(resINR.pass).toBe(true);

    // Test 33513 /- vs 33513
    input.value = '33513 /-';
    const resSuffix = InputVerifier.verify(input, '33513');
    expect(resSuffix.pass).toBe(true);
  });

  it('should sanitize currency prefixes and text codes using InputNormalizer.sanitizeNumber', () => {
    expect(InputNormalizer.sanitizeNumber('Rs. 33,513.00')).toBe('33513.00');
    expect(InputNormalizer.sanitizeNumber('INR 33513')).toBe('33513');
    expect(InputNormalizer.sanitizeNumber('USD 1,250.50')).toBe('1250.50');
    expect(InputNormalizer.sanitizeNumber('EUR 500 /-')).toBe('500');
  });
});
