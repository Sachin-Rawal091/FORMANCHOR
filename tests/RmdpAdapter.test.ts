import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RmdpAdapter } from '../src/content/datepickers/adapters/RmdpAdapter';

describe('RmdpAdapter Isolation & Retry Unit Tests', () => {
  let adapter: RmdpAdapter;

  beforeEach(() => {
    document.body.innerHTML = '';
    adapter = new RmdpAdapter();
  });

  it('matches — identifies input with rmdp-input class', () => {
    const input = document.createElement('input');
    input.className = 'rmdp-input';
    expect(adapter.matches(input)).toBe(true);

    const regularInput = document.createElement('input');
    regularInput.className = 'regular-input';
    expect(adapter.matches(regularInput)).toBe(false);
  });

  it('Adjacent Fields — opening field 2 clears stale wrapper from field 1 container', async () => {
    // 1. Create Field 1 (Claim Date)
    const container1 = document.createElement('div');
    container1.className = 'rmdp-container';
    const input1 = document.createElement('input');
    input1.id = 'claim-date';
    input1.className = 'rmdp-input';
    container1.appendChild(input1);

    const wrapper1 = document.createElement('div');
    wrapper1.className = 'rmdp-wrapper';
    const cal1 = document.createElement('div');
    cal1.className = 'rmdp-calendar';
    wrapper1.appendChild(cal1);
    container1.appendChild(wrapper1);

    // 2. Create Field 2 (Insurance Date)
    const container2 = document.createElement('div');
    container2.className = 'rmdp-container';
    const input2 = document.createElement('input');
    input2.id = 'insurance-date';
    input2.className = 'rmdp-input';
    container2.appendChild(input2);

    document.body.appendChild(container1);
    document.body.appendChild(container2);

    // 3. Call open() for field 2
    // Stale wrapper in container1 should be dismissed, and findWrapper() for input2 should NOT return wrapper1
    await (adapter as any).dismissStaleCalendars(input2);

    const resolvedForField2 = (adapter as any).findWrapper();
    // wrapper1 belongs to container1, input2 is in container2 — so resolvedForField2 should not be wrapper1
    expect(resolvedForField2).not.toBe(wrapper1);
  });

  it('Same-Element Retry Guard — dismissStaleCalendars preserves wrapper when retrying the exact same active element', async () => {
    const container = document.createElement('div');
    container.className = 'rmdp-container';
    const input = document.createElement('input');
    input.id = 'claim-date';
    input.className = 'rmdp-input';
    container.appendChild(input);

    const wrapper = document.createElement('div');
    wrapper.className = 'rmdp-wrapper';
    const cal = document.createElement('div');
    cal.className = 'rmdp-calendar';
    wrapper.appendChild(cal);
    container.appendChild(wrapper);
    document.body.appendChild(container);

    vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
      width: 200, height: 200, top: 0, left: 0, bottom: 200, right: 200, x: 0, y: 0, toJSON: () => {}
    });
    vi.spyOn(wrapper, 'getClientRects').mockReturnValue([{}] as any);

    // Set active element and active wrapper as if input was being processed by adapter
    (adapter as any).activeElement = input;
    (adapter as any).activeWrapper = wrapper;

    // Simulate open() capturing previousWrapper before clearing activeWrapper cache during a retry
    const previousWrapper = (adapter as any).activeElement === input ? (adapter as any).activeWrapper : null;
    (adapter as any).activeWrapper = null;

    // Simulate RetryEngine calling dismissStaleCalendars for the SAME element (retry)
    await (adapter as any).dismissStaleCalendars(input, previousWrapper);

    // Verify wrapper was preserved (not dismissed as stale)
    expect((adapter as any).isWrapperVisible(wrapper)).toBe(true);
  });
});
