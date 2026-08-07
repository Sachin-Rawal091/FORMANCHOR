import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RetryEngine, ErrorClassification } from '../src/content/engines/RetryEngine';
import { SmartWaitEngine } from '../src/content/engines/SmartWaitEngine';
import { ExecutionEngine } from '../src/content/engines/ExecutionEngine';
import { Action, Step, SelectorResult, SelectorStrategy } from '../src/types';

describe('RetryEngine', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should immediately return FATAL when resolveAndValidateValue requires a row skip', async () => {
    const step: Step = {
      id: 's1',
      action: Action.FILL,
      selector: '#inp',
      selectorMeta: {},
      columnName: 'Email',
      required: true,
      pageId: 'p1',
    };

    const result = await RetryEngine.executeStepWithRetry(step, { Name: 'Sachin' });
    expect(result.success).toBe(false);
    expect(result.classification).toBe(ErrorClassification.FATAL);
    expect(result.resolvedStatus).toBe('ROW_SKIPPED');
  });

  it('should immediately return success when resolveAndValidateValue requires a step skip', async () => {
    const step: Step = {
      id: 's2',
      action: Action.FILL,
      selector: '#inp',
      selectorMeta: {},
      columnName: 'Email',
      required: false,
      pageId: 'p1',
    };

    const result = await RetryEngine.executeStepWithRetry(step, { Name: 'Sachin' });
    expect(result.success).toBe(true);
    expect(result.resolvedStatus).toBe('STEP_SKIPPED');
  });

  it('should execute successfully on first attempt without retries', async () => {
    const step: Step = {
      id: 's3',
      action: Action.FILL,
      selector: '#inp',
      selectorMeta: {},
      pageId: 'p1',
    };

    const mockElement = document.createElement('input');
    const mockResult: SelectorResult = { element: mockElement, strategy: SelectorStrategy.ID, confidence: 1.0, shadow: false };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue(mockResult);
    const executeSpy = vi.spyOn(ExecutionEngine, 'executeAction').mockResolvedValue(undefined);

    const result = await RetryEngine.executeStepWithRetry(step, {});
    expect(result.success).toBe(true);
    expect(result.retriesUsed).toBe(0);
    expect(executeSpy).toHaveBeenCalledWith(step, mockResult, null);
  });

  it('should retry on failure and resolve successfully when element appears', async () => {
    const step: Step = {
      id: 's4',
      action: Action.FILL,
      selector: '#inp',
      selectorMeta: {},
      pageId: 'p1',
      maxRetries: 2,
    };

    const mockElement = document.createElement('input');
    const mockResult: SelectorResult = { element: mockElement, strategy: SelectorStrategy.ID, confidence: 1.0, shadow: false };

    // Fails on 1st attempt, succeeds on 2nd attempt
    vi.spyOn(SmartWaitEngine, 'waitForElementVisible')
      .mockRejectedValueOnce(new Error('Element not found'))
      .mockResolvedValueOnce(mockResult);

    vi.spyOn(ExecutionEngine, 'executeAction').mockResolvedValue(undefined);

    const result = await RetryEngine.executeStepWithRetry(step, {});
    expect(result.success).toBe(true);
    expect(result.retriesUsed).toBe(1);
  });

  it('should escalate to RETRYABLE when max retries exceeded', async () => {
    const step: Step = {
      id: 's5',
      action: Action.FILL,
      selector: '#inp',
      selectorMeta: {},
      pageId: 'p1',
      maxRetries: 2,
      required: true,
    };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockRejectedValue(new Error('Element not found'));

    const result = await RetryEngine.executeStepWithRetry(step, {});
    expect(result.success).toBe(false);
    expect(result.classification).toBe(ErrorClassification.RETRYABLE);
    expect(result.retriesUsed).toBe(2); // attempt 0 + 2 retries = 3 attempts total, 2 retries
  });

  it('should return SKIPPABLE when optional step fails to find element', async () => {
    const step: Step = {
      id: 's6',
      action: Action.FILL,
      selector: '#inp',
      selectorMeta: {},
      pageId: 'p1',
      required: false,
    };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockRejectedValue(new Error('Element not found'));

    const result = await RetryEngine.executeStepWithRetry(step, {});
    expect(result.success).toBe(true);
    expect(result.resolvedStatus).toBe('STEP_SKIPPED');
    expect(result.retriesUsed).toBe(0); // Optional step skipped on first attempt, 0 retries used
  });

  it('should skip optional non-control fields when they are disabled', async () => {
    const step: Step = {
      id: 's6-disabled-field',
      action: Action.FILL,
      selector: '#optional-field',
      selectorMeta: {},
      pageId: 'p1',
      required: false,
    };

    const input = document.createElement('input');
    input.disabled = true;
    const mockResult: SelectorResult = { element: input, strategy: SelectorStrategy.ID, confidence: 1.0, shadow: false };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue(mockResult);
    const executeSpy = vi.spyOn(ExecutionEngine, 'executeAction').mockResolvedValue(undefined);

    const result = await RetryEngine.executeStepWithRetry(step, {});
    expect(result.success).toBe(true);
    expect(result.resolvedStatus).toBe('STEP_SKIPPED');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('should retry recorded button controls even when marked not required by form metadata', async () => {
    // CLICK actions bypass the isElementInteractable check (only value-filling
    // actions like FILL/SELECT/DATEPICKER check for disabled state). So a
    // disabled button is clicked directly on the first attempt.
    const step: Step = {
      id: 's6-final-button',
      action: Action.CLICK,
      selector: '#final-submit',
      selectorMeta: {},
      pageId: 'p1',
      required: false,
      maxRetries: 1,
    };

    const button = document.createElement('button');
    button.disabled = true;
    const mockResult: SelectorResult = { element: button, strategy: SelectorStrategy.ID, confidence: 1.0, shadow: false };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue(mockResult);
    const executeSpy = vi.spyOn(ExecutionEngine, 'executeAction').mockResolvedValue(undefined);

    const result = await RetryEngine.executeStepWithRetry(step, {});
    expect(result.success).toBe(true);
    expect(result.retriesUsed).toBe(0);
    expect(executeSpy).toHaveBeenCalledWith(step, mockResult, null);
  });

  it('should return FATAL on fatal network errors or destroyed contexts', async () => {
    const step: Step = {
      id: 's7',
      action: Action.FILL,
      selector: '#inp',
      selectorMeta: {},
      pageId: 'p1',
    };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockRejectedValue(new Error('Fatal Network Error occurred'));

    const result = await RetryEngine.executeStepWithRetry(step, {});
    expect(result.success).toBe(false);
    expect(result.classification).toBe(ErrorClassification.FATAL);
  });

  describe('Pause & Resume Execution Handling', () => {
    afterEach(() => {
      delete (globalThis as any).__FP_EXECUTOR_INSTANCE__;
    });

    it('should park execution at retry loop entry while paused and resume when unpaused', async () => {
      const step: Step = {
        id: 'pause-s1',
        action: Action.FILL,
        selector: '#inp',
        selectorMeta: {},
        pageId: 'p1',
      };

      const mockElement = document.createElement('input');
      const mockResult: SelectorResult = { element: mockElement, strategy: SelectorStrategy.ID, confidence: 1.0, shadow: false };

      const waitSpy = vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue(mockResult);
      vi.spyOn(ExecutionEngine, 'executeAction').mockResolvedValue(undefined);

      // Start paused
      const executorMock = { isRunning: true, isPaused: true };
      (globalThis as any).__FP_EXECUTOR_INSTANCE__ = executorMock;

      // Start step execution in background promise
      const execPromise = RetryEngine.executeStepWithRetry(step, {});

      // Verify element search has not been called yet because we are parked in pause loop
      await new Promise(r => setTimeout(r, 100));
      expect(waitSpy).not.toHaveBeenCalled();

      // Resume execution after delay
      executorMock.isPaused = false;

      const result = await execPromise;
      expect(result.success).toBe(true);
      expect(result.retriesUsed).toBe(0);
      expect(waitSpy).toHaveBeenCalledTimes(1);
    });

    it('should abort execution if aborted while parked in pause loop at retry entry', async () => {
      const step: Step = {
        id: 'pause-abort-s2',
        action: Action.FILL,
        selector: '#inp',
        selectorMeta: {},
        pageId: 'p1',
      };

      const waitSpy = vi.spyOn(SmartWaitEngine, 'waitForElementVisible');

      const executorMock = { isRunning: true, isPaused: true };
      (globalThis as any).__FP_EXECUTOR_INSTANCE__ = executorMock;

      const execPromise = RetryEngine.executeStepWithRetry(step, {});

      // Simulate abort event while paused
      setTimeout(() => {
        executorMock.isRunning = false;
      }, 100);

      const result = await execPromise;
      expect(result.success).toBe(false);
      expect(result.classification).toBe(ErrorClassification.FATAL);
      expect(result.error?.message).toContain('Execution aborted');
      expect(waitSpy).not.toHaveBeenCalled();
    });

    it('should park and adjust budget during pause in readonly verification dynamic poll loop', async () => {
      const step: Step = {
        id: 'pause-readonly-s3',
        action: Action.FILL,
        selector: '#readonly-inp',
        selectorMeta: {},
        columnName: 'readonly-inp',
        pageId: 'p1',
      };

      const mockElement = document.createElement('input');
      mockElement.setAttribute('readonly', 'true');
      mockElement.value = ''; // Initial value empty -> verification fails initially

      const mockResult: SelectorResult = { element: mockElement, strategy: SelectorStrategy.ID, confidence: 1.0, shadow: false };

      vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue(mockResult);

      const executorMock = { isRunning: true, isPaused: false };
      (globalThis as any).__FP_EXECUTOR_INSTANCE__ = executorMock;

      // Start execution with expected value "284.45"
      const execPromise = RetryEngine.executeStepWithRetry(step, { 'readonly-inp': '284.45' });

      // Pause mid-poll
      setTimeout(() => {
        executorMock.isPaused = true;
      }, 50);

      // Supply expected value and unpause after delay
      setTimeout(() => {
        mockElement.value = '284.45';
        executorMock.isPaused = false;
      }, 350);

      const result = await execPromise;
      expect(result.success).toBe(true);
      expect(result.resolvedStatus).toBe('FILLED_READONLY');
    });

    it('should park during retry backoff sleep when paused and resume backoff when unpaused', async () => {
      const step: Step = {
        id: 'pause-backoff-s4',
        action: Action.FILL,
        selector: '#inp',
        selectorMeta: {},
        pageId: 'p1',
        maxRetries: 1,
      };

      const mockElement = document.createElement('input');
      const mockResult: SelectorResult = { element: mockElement, strategy: SelectorStrategy.ID, confidence: 1.0, shadow: false };

      vi.spyOn(SmartWaitEngine, 'waitForElementVisible')
        .mockRejectedValueOnce(new Error('Temporary DOM error'))
        .mockResolvedValueOnce(mockResult);

      vi.spyOn(ExecutionEngine, 'executeAction').mockResolvedValue(undefined);

      const executorMock = { isRunning: true, isPaused: false };
      (globalThis as any).__FP_EXECUTOR_INSTANCE__ = executorMock;

      // Pause during backoff sleep after first failure
      setTimeout(() => {
        executorMock.isPaused = true;
      }, 50);

      // Unpause after delay
      setTimeout(() => {
        executorMock.isPaused = false;
      }, 350);

      const result = await RetryEngine.executeStepWithRetry(step, {});
      expect(result.success).toBe(true);
      expect(result.retriesUsed).toBe(1);
    });
  });
});
