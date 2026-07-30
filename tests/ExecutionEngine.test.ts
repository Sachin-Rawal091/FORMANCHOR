/**
 * PURPOSE: Missing tests for ExecutionEngine — covers all 13 action types
 * and the complete resolveAndValidateValue 8-scenario decision tree.
 * DEPENDS ON: ExecutionEngine, domUtils, SmartWaitEngine, chromeMock
 * USED BY: Vitest test suite
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionEngine } from '../src/content/engines/ExecutionEngine';
import { SmartWaitEngine } from '../src/content/engines/SmartWaitEngine';
import { Action, Step, SelectorResult, SelectorStrategy } from '../src/types';
import * as domUtils from '../src/content/domUtils';

// Helpers
function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'test-step-id',
    action: Action.FILL,
    selector: '#test',
    selectorMeta: {},
    pageId: 'page-1',
    ...overrides,
  };
}

function makeSelectorResult(el: Element): SelectorResult {
  return {
    element: el,
    strategy: SelectorStrategy.ID,
    confidence: 1.0,
    shadow: false,
  };
}

// ─────────────────────────────────────────────
// resolveAndValidateValue — 8 Scenarios
// ─────────────────────────────────────────────
describe('ExecutionEngine.resolveAndValidateValue', () => {
  it('Scenario 1 — value exists, valid type → FILLED', () => {
    const step = makeStep({ columnName: 'Email' });
    const result = ExecutionEngine.resolveAndValidateValue(step, { Email: 'test@test.com' });
    expect(result.status).toBe('FILLED');
    expect(result.value).toBe('test@test.com');
    expect(result.shouldSkipRow).toBe(false);
    expect(result.shouldSkipStep).toBe(false);
  });

  it('Scenario 2 — column not found, required → ROW_SKIPPED', () => {
    const step = makeStep({ columnName: 'Email', required: true });
    const result = ExecutionEngine.resolveAndValidateValue(step, { Name: 'Sachin' });
    expect(result.status).toBe('ROW_SKIPPED');
    expect(result.shouldSkipRow).toBe(true);
  });

  it('Scenario 3 — column not found, optional → STEP_SKIPPED', () => {
    const step = makeStep({ columnName: 'Email', required: false });
    const result = ExecutionEngine.resolveAndValidateValue(step, { Name: 'Sachin' });
    expect(result.status).toBe('STEP_SKIPPED');
    expect(result.shouldSkipStep).toBe(true);
    expect(result.shouldSkipRow).toBe(false);
  });

  it('Scenario 4 — empty value, default set → FILLED_DEFAULT', () => {
    const step = makeStep({ columnName: 'Phone', defaultValue: '0000000000' });
    const result = ExecutionEngine.resolveAndValidateValue(step, { Phone: '' });
    expect(result.status).toBe('FILLED_DEFAULT');
    expect(result.value).toBe('0000000000');
  });

  it('Scenario 5 — empty value, no default, required → ROW_SKIPPED', () => {
    const step = makeStep({ columnName: 'Email', required: true });
    const result = ExecutionEngine.resolveAndValidateValue(step, { Email: '' });
    expect(result.status).toBe('ROW_SKIPPED');
    expect(result.shouldSkipRow).toBe(true);
  });

  it('Scenario 6 — empty value, no default, optional → STEP_SKIPPED', () => {
    const step = makeStep({ columnName: 'Phone', required: false });
    const result = ExecutionEngine.resolveAndValidateValue(step, { Phone: null });
    expect(result.status).toBe('STEP_SKIPPED');
    expect(result.shouldSkipStep).toBe(true);
  });

  it('Scenario 7 — wrong type, coercible → FILLED_COERCED (string to number)', () => {
    const step = makeStep({ columnName: 'Age', expectedType: 'number' });
    const result = ExecutionEngine.resolveAndValidateValue(step, { Age: '25' });
    expect(result.status).toBe('FILLED_COERCED');
    expect(result.value).toBe('25');
  });

  it('Scenario 7b — wrong type, coercible → FILLED_COERCED (ISO string to Date)', () => {
    const step = makeStep({ columnName: 'DOB', expectedType: 'date' });
    const result = ExecutionEngine.resolveAndValidateValue(step, { DOB: '2000-05-15' });
    expect(result.status).toBe('FILLED_COERCED');
    expect(result.value).toBe('2000-05-15');
  });

  it('Scenario 7c — wrong type, coercible → FILLED_COERCED (boolean string)', () => {
    const step = makeStep({ columnName: 'Active', expectedType: 'boolean' });
    const result = ExecutionEngine.resolveAndValidateValue(step, { Active: 'true' });
    expect(result.status).toBe('FILLED_COERCED');
    expect(result.value).toBe('true');
  });

  it('Scenario 8 — wrong type, not coercible → WARN', () => {
    const step = makeStep({ columnName: 'Age', expectedType: 'number' });
    const result = ExecutionEngine.resolveAndValidateValue(step, { Age: 'not-a-number' });
    expect(result.status).toBe('WARN');
  });

  it('no columnName — uses step.value directly', () => {
    const step = makeStep({ columnName: undefined, value: 'direct-value' });
    const result = ExecutionEngine.resolveAndValidateValue(step, {});
    expect(result.status).toBe('FILLED');
    expect(result.value).toBe('direct-value');
  });

  it('sanitizes control characters without HTML-encoding legitimate form values', () => {
    const step = makeStep({ columnName: 'Company' });
    const result = ExecutionEngine.resolveAndValidateValue(step, { Company: 'AT&T <Acme>\u0000' });
    expect(result.status).toBe('FILLED');
    expect(result.value).toBe('AT&T <Acme>');
  });
});

// ─────────────────────────────────────────────
// executeAction — All 13 Action Types
// ─────────────────────────────────────────────
describe('ExecutionEngine.executeAction', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('FILL — calls setInputValue on HTMLInputElement', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const spy = vi.spyOn(domUtils, 'setInputValue');
    await ExecutionEngine.executeAction(makeStep({ action: Action.FILL }), makeSelectorResult(input), 'hello@test.com');
    expect(spy).toHaveBeenCalledWith(input, 'hello@test.com');
  });

  it('FILL — calls setTextareaValue on HTMLTextAreaElement', async () => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    const spy = vi.spyOn(domUtils, 'setTextareaValue');
    await ExecutionEngine.executeAction(makeStep({ action: Action.FILL }), makeSelectorResult(ta), 'some text');
    expect(spy).toHaveBeenCalledWith(ta, 'some text');
  });

  it('CLICK — dispatches mousedown, mouseup, click events', async () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    const spy = vi.spyOn(domUtils, 'dispatchEvents');
    await ExecutionEngine.executeAction(makeStep({ action: Action.CLICK }), makeSelectorResult(btn), null);
    expect(spy).toHaveBeenCalledWith(btn, ['mousedown', 'mouseup', 'click']);
  });

  it('NAVIGATE_NEXT — same as CLICK, dispatches click events and waits for URL change', async () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    const spy = vi.spyOn(domUtils, 'dispatchEvents');
    const waitSpy = vi.spyOn(SmartWaitEngine, 'waitForURLChange').mockResolvedValue(true);
    await ExecutionEngine.executeAction(makeStep({ action: Action.NAVIGATE_NEXT }), makeSelectorResult(btn), null);
    expect(spy).toHaveBeenCalledWith(btn, ['mousedown', 'mouseup', 'click']);
    expect(waitSpy).toHaveBeenCalled();
  });

  it('SELECT — calls setSelectValue and waitForDOMStability', async () => {
    const sel = document.createElement('select');
    const opt = document.createElement('option');
    opt.value = 'option-value';
    sel.appendChild(opt);
    document.body.appendChild(sel);
    const setSpy = vi.spyOn(domUtils, 'setSelectValue').mockImplementation((el, val) => {
      (el as HTMLSelectElement).value = val;
      return {
        option: (el as HTMLSelectElement).options[(el as HTMLSelectElement).selectedIndex],
        strategy: 'EXACT',
        confidence: 100,
        matchedText: val
      };
    });
    const waitSpy = vi.spyOn(SmartWaitEngine, 'waitForDOMStability').mockResolvedValue(true as any);
    await ExecutionEngine.executeAction(makeStep({ action: Action.SELECT, selectorMeta: {}, selector: '' }), makeSelectorResult(sel), 'option-value');
    expect(setSpy).toHaveBeenCalledWith(sel, 'option-value');
    expect(waitSpy).toHaveBeenCalled();
  });

  it('SELECT_RADIO — selects radio by value attribute case-insensitively', async () => {
    const form = document.createElement('form');
    const radio1 = document.createElement('input');
    radio1.type = 'radio'; radio1.name = 'choice'; radio1.value = 'Opt-A';
    const radio2 = document.createElement('input');
    radio2.type = 'radio'; radio2.name = 'choice'; radio2.value = 'Opt-B';
    form.appendChild(radio1); form.appendChild(radio2);
    document.body.appendChild(form);

    const step = makeStep({ action: Action.SELECT_RADIO });
    await ExecutionEngine.executeAction(step, makeSelectorResult(radio1), 'opt-b ');
    expect(radio2.checked).toBe(true);
    expect(radio1.checked).toBe(false);
  });

  it('SELECT_RADIO — selects radio by label text', async () => {
    const form = document.createElement('form');
    
    // Label for id approach
    const radio1 = document.createElement('input');
    radio1.type = 'radio'; radio1.name = 'choice'; radio1.value = '1'; radio1.id = 'r1';
    const label1 = document.createElement('label');
    label1.setAttribute('for', 'r1');
    label1.textContent = 'Option One';
    
    // Nested label approach
    const label2 = document.createElement('label');
    const radio2 = document.createElement('input');
    radio2.type = 'radio'; radio2.name = 'choice'; radio2.value = '2';
    label2.appendChild(radio2);
    label2.appendChild(document.createTextNode('Option Two'));

    form.appendChild(radio1);
    form.appendChild(label1);
    form.appendChild(label2);
    document.body.appendChild(form);

    const step = makeStep({ action: Action.SELECT_RADIO });
    await ExecutionEngine.executeAction(step, makeSelectorResult(radio1), 'Option Two');
    expect(radio2.checked).toBe(true);
    expect(radio1.checked).toBe(false);
  });

  it('TOGGLE_CHECKBOX — handles standard boolean strings', async () => {
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = false;
    document.body.appendChild(cb);
    const setCbSpy = vi.spyOn(domUtils, 'setCheckboxValue');

    const step = makeStep({ action: Action.TOGGLE_CHECKBOX });
    
    // Test True string
    await ExecutionEngine.executeAction(step, makeSelectorResult(cb), 'yes');
    expect(setCbSpy).toHaveBeenLastCalledWith(cb, true);

    // Test False string
    cb.checked = true;
    await ExecutionEngine.executeAction(step, makeSelectorResult(cb), '0');
    expect(setCbSpy).toHaveBeenLastCalledWith(cb, false);
  });

  it('TOGGLE_CHECKBOX — handles custom value and label matching', async () => {
    const container = document.createElement('div');
    
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = 'sports'; cb.checked = false;
    label.appendChild(cb);
    label.appendChild(document.createTextNode('Sports Activities'));
    container.appendChild(label);
    document.body.appendChild(container);

    const setCbSpy = vi.spyOn(domUtils, 'setCheckboxValue');
    const step = makeStep({ action: Action.TOGGLE_CHECKBOX });

    // Should match because 'sports' is in 'Music, Sports'
    await ExecutionEngine.executeAction(step, makeSelectorResult(cb), 'Music, Sports');
    expect(setCbSpy).toHaveBeenLastCalledWith(cb, true);

    // Should match by label text
    cb.checked = false;
    await ExecutionEngine.executeAction(step, makeSelectorResult(cb), 'Sports Activities, Reading');
    expect(setCbSpy).toHaveBeenLastCalledWith(cb, true);

    // Should NOT match for different values
    cb.checked = true;
    await ExecutionEngine.executeAction(step, makeSelectorResult(cb), 'Reading, Cooking');
    expect(setCbSpy).toHaveBeenLastCalledWith(cb, false);
  });

  it('TOGGLE_CHECKBOX — falls back to step.checked when resolvedValue is not provided', async () => {
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = false;
    document.body.appendChild(cb);
    const setCbSpy = vi.spyOn(domUtils, 'setCheckboxValue');

    const step = makeStep({ action: Action.TOGGLE_CHECKBOX, checked: true });
    await ExecutionEngine.executeAction(step, makeSelectorResult(cb), null);
    expect(setCbSpy).toHaveBeenCalledWith(cb, true);
  });

  it('SCROLL — scrolls element into view', async () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    const spy = vi.spyOn(div, 'scrollIntoView').mockImplementation(() => {});
    await ExecutionEngine.executeAction(makeStep({ action: Action.SCROLL }), makeSelectorResult(div), null);
    expect(spy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  it('SUBMIT — calls form.submit() on HTMLFormElement if no submit button', async () => {
    const form = document.createElement('form');
    document.body.appendChild(form);
    const spy = vi.spyOn(form, 'submit').mockImplementation(() => {});
    await ExecutionEngine.executeAction(makeStep({ action: Action.SUBMIT }), makeSelectorResult(form), null);
    expect(spy).toHaveBeenCalled();
  });

  it('SUBMIT — dispatches click on non-form submit button', async () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    const spy = vi.spyOn(domUtils, 'dispatchEvents');
    await ExecutionEngine.executeAction(makeStep({ action: Action.SUBMIT }), makeSelectorResult(btn), null);
    expect(spy).toHaveBeenCalledWith(btn, ['mousedown', 'mouseup', 'click']);
  });

  it('RICH_TEXT - replaces contenteditable text without deprecated execCommand', async () => {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    document.body.appendChild(div);
    const execSpy = vi.fn().mockReturnValue(true);
    document.execCommand = execSpy;
    const events: string[] = [];
    ['beforeinput', 'input', 'change', 'blur'].forEach((eventName) => {
      div.addEventListener(eventName, () => events.push(eventName));
    });

    await ExecutionEngine.executeAction(makeStep({ action: Action.RICH_TEXT }), makeSelectorResult(div), 'Hello World');

    expect(div.textContent).toBe('Hello World');
    expect(execSpy).not.toHaveBeenCalled();
    expect(events).toEqual(['beforeinput', 'input', 'change', 'blur']);
  });
});
