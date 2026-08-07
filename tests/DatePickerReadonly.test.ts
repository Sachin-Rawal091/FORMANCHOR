import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RetryEngine } from '../src/content/engines/RetryEngine';
import { SmartWaitEngine } from '../src/content/engines/SmartWaitEngine';
import { DatePickerEngine } from '../src/content/datepickers/DatePickerEngine';
import { Step, Action, SelectorStrategy } from '../src/types';

describe('DatePicker Readonly Interactability', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should allow Action.DATEPICKER on empty <input readonly> elements', async () => {
    const input = document.createElement('input');
    input.id = 'dob';
    input.type = 'text';
    input.className = 'rmdp-input';
    input.readOnly = true;
    input.value = '';
    document.body.appendChild(input);

    const step: Step = {
      id: 'step-dob',
      action: Action.DATEPICKER,
      selector: '#dob',
      selectorMeta: { id: 'dob' },
      pageId: 'p1',
      required: false,
      retryable: true,
      maxRetries: 0
    };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue({
      element: input,
      strategy: SelectorStrategy.ID,
      confidence: 1,
      shadow: false
    });

    vi.spyOn(DatePickerEngine, 'fill').mockResolvedValue(true);

    const result = await RetryEngine.executeStepWithRetry(step, { dob: '2000-12-02' });

    // Action.DATEPICKER on <input readonly> should succeed instead of being skipped/rejected
    expect(result.success).toBe(true);
    expect(result.resolvedStatus).not.toBe('STEP_SKIPPED');
  });

  it('should STILL BLOCK Action.DATEPICKER inside <div class="disabled_date_picker"> hard lock', async () => {
    const parent = document.createElement('div');
    parent.className = 'disabled_date_picker';
    
    const input = document.createElement('input');
    input.id = 'disbursal';
    input.type = 'text';
    input.className = 'rmdp-input';
    input.readOnly = true;
    input.value = '';
    parent.appendChild(input);
    document.body.appendChild(parent);

    const step: Step = {
      id: 'step-disbursal',
      action: Action.DATEPICKER,
      selector: '#disbursal',
      selectorMeta: { id: 'disbursal' },
      pageId: 'p1',
      required: false,
      retryable: true,
      maxRetries: 0
    };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue({
      element: input,
      strategy: SelectorStrategy.ID,
      confidence: 1,
      shadow: false
    });

    const result = await RetryEngine.executeStepWithRetry(step, { disbursal: '2026-08-15' });

    // Hard disable MUST block execution and trigger non-interactable (which skips optional step)
    expect(result.success).toBe(true);
    expect(result.resolvedStatus).toBe('STEP_SKIPPED');
  });

  it('should STILL BLOCK Action.FILL on <input readonly> elements', async () => {
    const input = document.createElement('input');
    input.id = 'read-only-text';
    input.type = 'text';
    input.readOnly = true;
    input.value = '';
    document.body.appendChild(input);

    const step: Step = {
      id: 'step-fill-readonly',
      action: Action.FILL,
      selector: '#read-only-text',
      selectorMeta: { id: 'read-only-text' },
      pageId: 'p1',
      required: false,
      retryable: true,
      maxRetries: 0
    };

    vi.spyOn(SmartWaitEngine, 'waitForElementVisible').mockResolvedValue({
      element: input,
      strategy: SelectorStrategy.ID,
      confidence: 1,
      shadow: false
    });

    const result = await RetryEngine.executeStepWithRetry(step, { 'read-only-text': 'Some Value' });

    // FILL action MUST respect readonly and get skipped for optional step
    expect(result.success).toBe(true);
    expect(result.resolvedStatus).toBe('STEP_SKIPPED');
  });
});
