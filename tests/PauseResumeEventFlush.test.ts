import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchEvents } from '../src/content/domUtils';
import { SmartWaitEngine } from '../src/content/engines/SmartWaitEngine';

describe('Post-Resume Event Flush & DOM Stabilization', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  it('should flush change and blur events on active input and remove focus upon resume', () => {
    const input = document.createElement('input');
    input.id = 'amountInput';
    container.appendChild(input);

    let changeFired = false;
    let blurFired = false;

    input.addEventListener('change', () => { changeFired = true; });
    input.addEventListener('blur', () => { blurFired = true; });

    input.focus();
    expect(document.activeElement).toBe(input);

    // Simulate post-resume recovery handler logic
    if (document.activeElement && document.activeElement !== document.body) {
      const activeEl = document.activeElement as HTMLElement;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(activeEl.tagName)) {
        dispatchEvents(activeEl, ['change', 'blur']);
        activeEl.blur();
      }
    }

    expect(changeFired).toBe(true);
    expect(blurFired).toBe(true);
    expect(document.activeElement).not.toBe(input);
  });

  it('should allow pending blur-triggered site calculations to complete during post-resume stabilization', async () => {
    const sourceInput = document.createElement('input');
    sourceInput.id = 'maxWithdrawal';
    sourceInput.value = '33513';

    const calculatedInput = document.createElement('input');
    calculatedInput.id = 'applicableISAmount';
    calculatedInput.disabled = true;
    calculatedInput.value = '';

    container.appendChild(sourceInput);
    container.appendChild(calculatedInput);

    // Simulate portal calculation listener attached to source blur
    sourceInput.addEventListener('blur', () => {
      setTimeout(() => {
        calculatedInput.value = '284.45';
      }, 100);
    });

    sourceInput.focus();

    // Trigger post-resume recovery handler
    if (document.activeElement && document.activeElement !== document.body) {
      const activeEl = document.activeElement as HTMLElement;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(activeEl.tagName)) {
        dispatchEvents(activeEl, ['change', 'blur']);
        activeEl.blur();
      }
    }

    // Run DOM stability wait
    await SmartWaitEngine.waitForDOMStability(500);

    expect(calculatedInput.value).toBe('284.45');
  });
});
