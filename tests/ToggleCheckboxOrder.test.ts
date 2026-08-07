import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExecutionEngine } from '../src/content/engines/ExecutionEngine';
import { Step, Action, SelectorStrategy } from '../src/types';

describe('TOGGLE_CHECKBOX Order of Operations', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  it('should update .checked BEFORE dispatching click event so framework listeners observe updated state', async () => {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'declarationText';
    checkbox.checked = false;
    container.appendChild(checkbox);

    let observedCheckedInClickListener: boolean | null = null;

    checkbox.addEventListener('click', (e) => {
      observedCheckedInClickListener = (e.target as HTMLInputElement).checked;
    });

    const step: Step = {
      id: 'step-declaration',
      action: Action.TOGGLE_CHECKBOX,
      selector: '#declarationText',
      selectorMeta: { id: 'declarationText' },
      checked: true,
      pageId: 'p1',
      required: true,
      retryable: true
    };

    await ExecutionEngine.executeAction(step, {
      element: checkbox,
      strategy: SelectorStrategy.ID,
      confidence: 1,
      shadow: false
    }, 'true');

    // Verification 1: The click listener MUST observe checked === true (not stale false!)
    expect(observedCheckedInClickListener).toBe(true);

    // Verification 2: Checkbox remains checked in DOM
    expect(checkbox.checked).toBe(true);
  });

  it('should cleanly uncheck a checkbox when desiredState is false', async () => {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'optout';
    checkbox.checked = true;
    container.appendChild(checkbox);

    let observedCheckedInClickListener: boolean | null = null;

    checkbox.addEventListener('click', (e) => {
      observedCheckedInClickListener = (e.target as HTMLInputElement).checked;
    });

    const step: Step = {
      id: 'step-optout',
      action: Action.TOGGLE_CHECKBOX,
      selector: '#optout',
      selectorMeta: { id: 'optout' },
      checked: false,
      pageId: 'p1',
      required: true,
      retryable: true
    };

    await ExecutionEngine.executeAction(step, {
      element: checkbox,
      strategy: SelectorStrategy.ID,
      confidence: 1,
      shadow: false
    }, 'false');

    expect(observedCheckedInClickListener).toBe(false);
    expect(checkbox.checked).toBe(false);
  });
});
