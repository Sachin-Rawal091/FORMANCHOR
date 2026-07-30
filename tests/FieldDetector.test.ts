import { describe, it, expect } from 'vitest';
import { FieldDetector } from '../src/content/datepickers/FieldDetector';

describe('FieldDetector Unit Tests', () => {
  it('correctly scores native <input type="date"> elements', () => {
    const input = document.createElement('input');
    input.type = 'date';
    input.min = '2020-01-01';
    input.max = '2030-01-01';

    const detection = FieldDetector.detect(input);
    expect(detection.isNativeDate).toBe(true);
    expect(detection.score).toBeGreaterThanOrEqual(100);
    expect(detection.minDate).toBe('2020-01-01');
    expect(detection.maxDate).toBe('2030-01-01');
  });

  it('correctly detects AntD DatePicker wrapper via ancestor score', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'ant-picker';
    const input = document.createElement('input');
    input.className = 'ant-picker-input';
    input.placeholder = 'Select date';
    wrapper.appendChild(input);
    document.body.appendChild(wrapper);

    const detection = FieldDetector.detect(input);
    expect(detection.isNativeDate).toBe(false);
    expect(detection.isCustomDatePicker).toBe(true);
    expect(detection.score).toBeGreaterThanOrEqual(25);

    document.body.removeChild(wrapper);
  });

  it('correctly scores standard text inputs as default text strategy', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'username';

    const detection = FieldDetector.detect(input);
    expect(detection.isNativeDate).toBe(false);
    expect(detection.isCustomDatePicker).toBe(false);
  });

  it('rejects AntD Select dropdowns from being classified as DatePickers', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'ant-select ant-select-single';
    const input = document.createElement('input');
    input.className = 'ant-select-selection-search-input';
    input.setAttribute('aria-haspopup', 'listbox');
    wrapper.appendChild(input);

    const detection = FieldDetector.detect(input);
    expect(detection.isCustomDatePicker).toBe(false);
    expect(detection.score).toBe(0);
  });
});
