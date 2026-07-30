import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { setupChromeMocks } from './helpers/chromeMock';
import { RecordingEngine } from '../src/content/recorder';
import { Action, Step, MessageType } from '../src/types';

const mockSendMessage = vi.fn().mockImplementation(() => Promise.resolve({}));

describe('DatePicker Recording Per-Adapter Unit Tests', () => {
  let recorder: RecordingEngine;
  let sentSteps: Step[] = [];

  beforeAll(async () => {
    setupChromeMocks();
    await (globalThis as any).chrome.storage.session.set({ recordingState: { isRecording: true, recordingId: 'test-session' } });
    await (globalThis as any).chrome.storage.local.set({ isRecordingActive: true, recordingId: 'test-session' });
    (globalThis as any).chrome.runtime.sendMessage = mockSendMessage;

    mockSendMessage.mockImplementation((msg: any, callback?: any) => {
      const res = { recordingState: { isRecording: true, recordingId: 'test-session' } };
      if (msg.type === MessageType.RECORDING_EVENT && msg.payload?.step) {
        sentSteps.push(msg.payload.step);
      }
      if (typeof callback === 'function') {
        callback(res);
      }
      return Promise.resolve(res);
    });

    recorder = new RecordingEngine();
    (recorder as any).isRecording = true;
    (recorder as any).recordingId = 'test-session';
  });

  beforeEach(() => {
    document.body.innerHTML = '';
    sentSteps.length = 0;
  });

  it('Native HTML5 Datepicker — opening picker and selecting date records exactly 1 DATEPICKER step', async () => {
    const input = document.createElement('input');
    input.type = 'date';
    input.id = 'dob';
    input.value = '2025-01-01';
    document.body.appendChild(input);

    // 1. Simulate opening click on input (value unchanged)
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));

    // 2. User selects new date (dispatches input event)
    input.value = '2025-12-19';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await new Promise(r => setTimeout(r, 600));

    const dateSteps = sentSteps.filter(s => s.action === Action.DATEPICKER);
    expect(dateSteps).toHaveLength(1);
    expect(dateSteps[0].value).toBe('2025-12-19');
  });

  it('Ant Design DatePicker — opening popup and day-cell selection records exactly 1 DATEPICKER step', async () => {
    const container = document.createElement('div');
    container.className = 'ant-picker';
    const input = document.createElement('input');
    input.className = 'ant-picker-input';
    input.value = '2025-01-01';
    container.appendChild(input);

    const popupCell = document.createElement('div');
    popupCell.className = 'ant-picker-cell-inner';
    popupCell.textContent = '19';
    document.body.appendChild(container);
    document.body.appendChild(popupCell);

    // 1. Click to open AntD picker (value unchanged)
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));

    // 2. Click day-cell (React updates input.value on day click)
    popupCell.addEventListener('click', () => {
      input.value = '2025-12-19';
    });
    popupCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));

    const dateSteps = sentSteps.filter(s => s.action === Action.DATEPICKER);
    expect(dateSteps).toHaveLength(1);
    expect(dateSteps[0].value).toBe('2025-12-19');
  });

  it('React Multi Date Picker (RMDP) — day-cell click records exactly 1 DATEPICKER step', async () => {
    const container = document.createElement('div');
    container.className = 'rmdp-container';
    const input = document.createElement('input');
    input.className = 'rmdp-input';
    input.value = '2025-01-01';
    container.appendChild(input);

    const dayCell = document.createElement('span');
    dayCell.className = 'rmdp-day';
    dayCell.textContent = '19';
    container.appendChild(dayCell);
    document.body.appendChild(container);

    // 1. Click input to open calendar
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));

    // 2. Click day cell in calendar
    dayCell.addEventListener('click', () => {
      input.value = '2025-12-19';
    });
    dayCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));

    const dateSteps = sentSteps.filter(s => s.action === Action.DATEPICKER);
    expect(dateSteps).toHaveLength(1);
    expect(dateSteps[0].value).toBe('2025-12-19');
  });

  it('MUI DatePicker — popper day selection records exactly 1 DATEPICKER step', async () => {
    const container = document.createElement('div');
    container.className = 'MuiFormControl-root';
    const input = document.createElement('input');
    input.className = 'MuiInputBase-input';
    input.placeholder = 'MM/DD/YYYY';
    input.value = '01/01/2025';
    container.appendChild(input);

    const dayButton = document.createElement('button');
    dayButton.type = 'button';
    dayButton.className = 'MuiPickersDay-root';
    dayButton.textContent = '19';
    document.body.appendChild(container);
    document.body.appendChild(dayButton);

    // 1. Click input to open popper
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));

    // 2. Click MUI day button
    dayButton.addEventListener('click', () => {
      input.value = '12/19/2025';
    });
    dayButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));

    const dateSteps = sentSteps.filter(s => s.action === Action.DATEPICKER);
    expect(dateSteps).toHaveLength(1);
    expect(dateSteps[0].value).toBe('12/19/2025');
  });

  it('Generic Custom Datepicker — value change on calendar click records exactly 1 DATEPICKER step', async () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-date-picker-wrapper';
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'cycle_start_date';
    input.value = '04/12/2025';
    wrapper.appendChild(input);

    const calendarIcon = document.createElement('button');
    calendarIcon.type = 'button';
    calendarIcon.className = 'icon-calendar';
    wrapper.appendChild(calendarIcon);
    document.body.appendChild(wrapper);

    // 1. Click calendar icon to open popup
    calendarIcon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 350));

    // 2. Custom JS updates input value to 2025-12-19 on day click
    calendarIcon.addEventListener('click', () => {
      input.value = '2025-12-19';
    });
    calendarIcon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));

    const dateSteps = sentSteps.filter(s => s.action === Action.DATEPICKER);
    expect(dateSteps).toHaveLength(1);
    expect(dateSteps[0].value).toBe('2025-12-19');
  });
});
