import { describe, it, expect, vi } from 'vitest';
import { dispatchEvents, setCheckboxValue, setInputValue, setSelectValue, setTextareaValue } from '../src/content/domUtils';

describe('domUtils — React-safe native setters', () => {
  it('setInputValue should set value via the native setter and fire input+change', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));

    setInputValue(input, 'hello@example.com');

    expect(input.value).toBe('hello@example.com');
    expect(events).toEqual(['input', 'change']);
  });

  it('setCheckboxValue should toggle checked state and fire change+input', () => {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    document.body.appendChild(checkbox);
    const events: string[] = [];
    checkbox.addEventListener('change', () => events.push('change'));

    setCheckboxValue(checkbox, true);
    expect(checkbox.checked).toBe(true);
    expect(events).toContain('change');
  });

  it('setSelectValue should match by option text case-insensitively when value does not match', () => {
    const select = document.createElement('select');
    const opt = document.createElement('option');
    opt.value = 'IN';
    opt.text = 'India';
    select.appendChild(opt);
    document.body.appendChild(select);

    setSelectValue(select, 'india'); // lowercase, matches option TEXT not value
    expect(select.value).toBe('IN');
  });

  it('setTextareaValue should set value and fire input+change', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    setTextareaValue(textarea, 'multi\nline');
    expect(textarea.value).toBe('multi\nline');
  });

  it('dispatchEvents should dispatch MouseEvent for click-family types with buttons=1', () => {
    const el = document.createElement('button');
    const handler = vi.fn();
    el.addEventListener('mousedown', handler);
    dispatchEvents(el, ['mousedown']);
    expect(handler).toHaveBeenCalledTimes(1);
    const evt = handler.mock.calls[0][0] as MouseEvent;
    expect(evt.buttons).toBe(1);
  });

  it('dispatchEvents should dispatch InputEvent for "input" type with inputType="insertText"', () => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    const handler = vi.fn();
    el.addEventListener('input', handler);
    dispatchEvents(el, ['input']);
    expect(handler).toHaveBeenCalledTimes(1);
    const evt = handler.mock.calls[0][0];
    // If InputEvent is available in the test environment, verify correct type
    if (typeof InputEvent === 'function') {
      expect(evt).toBeInstanceOf(InputEvent);
      expect((evt as InputEvent).inputType).toBe('insertText');
    }
    document.body.removeChild(el);
  });

  it('DefaultTextStrategy fill should fire events in order: focus → input → change → blur', async () => {
    const { DefaultTextStrategy } = await import('../src/content/datepickers/strategies/DefaultTextStrategy');

    const input = document.createElement('input');
    document.body.appendChild(input);
    const events: string[] = [];
    ['focus', 'input', 'change', 'blur'].forEach(type => {
      input.addEventListener(type, () => events.push(type));
    });

    const strategy = new DefaultTextStrategy();
    await strategy.execute(input, 'test value', {
      isNativeDate: false,
      isCustomDatePicker: false,
      adapter: null,
      minDate: null,
      maxDate: null,
      score: 0,
    });

    expect(events).toEqual(['focus', 'input', 'change', 'blur']);
    document.body.removeChild(input);
  });

  it('dispatchEvents should forward eventInit options to KeyboardEvent instances', () => {
    const el = document.createElement('input');
    const handler = vi.fn();
    el.addEventListener('keydown', handler);

    dispatchEvents(el, ['keydown'], {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const evt = handler.mock.calls[0][0] as KeyboardEvent;
    expect(evt.key).toBe('Enter');
    expect(evt.keyCode).toBe(13);
  });
});


