import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { setupChromeMocks } from './helpers/chromeMock';
import { RecordingEngine } from '../src/content/recorder';
import { Action, Step, MessageType } from '../src/types';
import { ExecutionEngine } from '../src/content/engines/ExecutionEngine';
import { FieldDetector } from '../src/content/datepickers/FieldDetector';
import { ActionFactory } from '../src/content/datepickers/ActionFactory';

const mockSendMessage = vi.fn().mockImplementation(() => Promise.resolve({}));

describe('Recorder & ExecutionEngine Submit Button Disambiguation Tests', () => {
  let recorder: RecordingEngine;
  let sentSteps: Step[] = [];

  beforeAll(async () => {
    setupChromeMocks();
    await (globalThis as any).chrome.storage.session.set({ recordingState: { isRecording: true, recordingId: 'test-submit-session' } });
    await (globalThis as any).chrome.storage.local.set({ isRecordingActive: true, recordingId: 'test-submit-session' });
    (globalThis as any).chrome.runtime.sendMessage = mockSendMessage;

    mockSendMessage.mockImplementation((msg: any, callback?: any) => {
      const res = { recordingState: { isRecording: true, recordingId: 'test-submit-session' } };
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
    (recorder as any).recordingId = 'test-submit-session';
  });

  beforeEach(() => {
    document.body.innerHTML = '';
    sentSteps.length = 0;
  });

  // ============================================================
  // Original tests — Submit button classification
  // ============================================================

  it('Modal Close Button (<button id="btn-close-modal"> with no type) — records Action.CLICK, NOT Action.SUBMIT', async () => {
    const modalBtn = document.createElement('button');
    modalBtn.id = 'btn-close-modal';
    modalBtn.textContent = 'Close Modal';
    document.body.appendChild(modalBtn);

    modalBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));

    const submitSteps = sentSteps.filter(s => s.action === Action.SUBMIT);
    const clickSteps = sentSteps.filter(s => s.action === Action.CLICK);

    expect(submitSteps).toHaveLength(0);
    expect(clickSteps.length).toBeGreaterThanOrEqual(1);
  });

  it('Generic Form Button (<button> with no type inside <form>) — records Action.SUBMIT', async () => {
    const form = document.createElement('form');
    const submitBtn = document.createElement('button');
    submitBtn.id = 'submit-btn';
    submitBtn.textContent = 'Submit Data';
    form.appendChild(submitBtn);
    document.body.appendChild(form);

    submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));

    const submitSteps = sentSteps.filter(s => s.action === Action.SUBMIT);
    expect(submitSteps).toHaveLength(1);
  });

  it('DatePicker Day Span inside <form> — records NO Action.SUBMIT', async () => {
    const form = document.createElement('form');
    form.id = 'kisan-form';
    const daySpan = document.createElement('span');
    daySpan.className = 'rmdp-day';
    daySpan.textContent = '19';
    form.appendChild(daySpan);
    document.body.appendChild(form);

    daySpan.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));

    const submitSteps = sentSteps.filter(s => s.action === Action.SUBMIT);
    expect(submitSteps).toHaveLength(0);
  });

  it('Cancel Input (<input type="submit" id="cancel-btn">) — excludes cancel keyword and records Action.CLICK', async () => {
    const cancelInput = document.createElement('input');
    cancelInput.type = 'submit';
    cancelInput.id = 'cancel-btn';
    cancelInput.value = 'Cancel Application';
    document.body.appendChild(cancelInput);

    cancelInput.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));

    const submitSteps = sentSteps.filter(s => s.action === Action.SUBMIT);
    const clickSteps = sentSteps.filter(s => s.action === Action.CLICK);

    expect(submitSteps).toHaveLength(0);
    expect(clickSteps.length).toBeGreaterThanOrEqual(1);
  });

  it('ExecutionEngine.findPrimarySubmitButton — resolves real submit button over modal close button in form', () => {
    const form = document.createElement('form');

    const closeBtn = document.createElement('button');
    closeBtn.id = 'btn-close-modal';
    closeBtn.textContent = 'Close';

    const saveDraftBtn = document.createElement('button');
    saveDraftBtn.type = 'button';
    saveDraftBtn.textContent = 'Save Draft';

    const realSubmitBtn = document.createElement('button');
    realSubmitBtn.type = 'submit';
    realSubmitBtn.id = 'real-submit-btn';
    realSubmitBtn.textContent = 'Submit Application';

    form.appendChild(closeBtn);
    form.appendChild(saveDraftBtn);
    form.appendChild(realSubmitBtn);
    document.body.appendChild(form);

    const resolved = ExecutionEngine.findPrimarySubmitButton(form);
    expect(resolved).toBe(realSubmitBtn);
  });

  // ============================================================
  // BUG A — ActionFactory must never convert SUBMIT to DATEPICKER
  // ============================================================

  it('BUG A: ActionFactory preserves Action.SUBMIT even when FieldDetector detects a date field', () => {
    const detection = {
      isNativeDate: false,
      isCustomDatePicker: true,
      adapter: null,
      minDate: null,
      maxDate: null,
      score: 30,
    };

    const resolved = ActionFactory.resolveAction(detection, Action.SUBMIT);
    expect(resolved.action).toBe(Action.SUBMIT);
    expect(resolved.action).not.toBe(Action.DATEPICKER);
  });

  // ============================================================
  // BUG B — FieldDetector allowlist guard
  // ============================================================

  it('BUG B: FieldDetector.detect on <form> returns score 0 and isCustomDatePicker=false', () => {
    const form = document.createElement('form');
    form.id = 'kisan-form';

    // Add RMDP date input inside form
    const dateInput = document.createElement('input');
    dateInput.id = 'application-date';
    dateInput.className = 'rmdp-input';
    dateInput.readOnly = true;
    form.appendChild(dateInput);
    document.body.appendChild(form);

    const detection = FieldDetector.detect(form);
    expect(detection.score).toBe(0);
    expect(detection.isCustomDatePicker).toBe(false);
    expect(detection.isNativeDate).toBe(false);
  });

  it('BUG B: FieldDetector.detect on <div> container returns score 0', () => {
    const container = document.createElement('div');
    container.className = 'rmdp-container';

    const dateInput = document.createElement('input');
    dateInput.className = 'rmdp-input';
    container.appendChild(dateInput);
    document.body.appendChild(container);

    const detection = FieldDetector.detect(container);
    expect(detection.score).toBe(0);
    expect(detection.isCustomDatePicker).toBe(false);
  });

  it('BUG B: FieldDetector.detect on actual <input class="rmdp-input"> still works correctly', () => {
    const container = document.createElement('div');
    container.className = 'rmdp-container';

    const dateInput = document.createElement('input');
    dateInput.className = 'rmdp-input';
    dateInput.readOnly = true;
    container.appendChild(dateInput);
    document.body.appendChild(container);

    const detection = FieldDetector.detect(dateInput);
    expect(detection.isCustomDatePicker).toBe(true);
    expect(detection.score).toBeGreaterThanOrEqual(25);
  });

  // ============================================================
  // BUG A+B combined — Submit inside form with date inputs
  // ============================================================

  it('BUG A+B: Submit button click inside form with RMDP date inputs records exactly 1 Action.SUBMIT (not DATEPICKER)', async () => {
    const form = document.createElement('form');
    form.id = 'kisan-form';

    const dateInput = document.createElement('input');
    dateInput.id = 'application-date';
    dateInput.className = 'rmdp-input form-control';
    dateInput.readOnly = true;
    dateInput.value = '2026/07/01';

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.id = 'btn-submit';
    submitBtn.textContent = 'Submit Details';

    form.appendChild(dateInput);
    form.appendChild(submitBtn);
    document.body.appendChild(form);

    submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));

    const submitSteps = sentSteps.filter(s => s.action === Action.SUBMIT);
    const datepickerSteps = sentSteps.filter(s => s.action === Action.DATEPICKER);

    expect(submitSteps).toHaveLength(1);
    // Must NOT create a phantom DATEPICKER step on form#kisan-form
    expect(datepickerSteps).toHaveLength(0);
  });

  // ============================================================
  // Passive Container Click Filtering Tests
  // ============================================================

  it('Passive Container (<div class="row">) click — records NO Action.CLICK step', async () => {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'row';
    rowDiv.innerHTML = '<p>Some text</p>';
    document.body.appendChild(rowDiv);

    rowDiv.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));

    const clickSteps = sentSteps.filter(s => s.action === Action.CLICK);
    expect(clickSteps).toHaveLength(0);
  });

  it('Passive Container (<span class="label-text">) click — records NO Action.CLICK step', async () => {
    const labelSpan = document.createElement('span');
    labelSpan.className = 'label-text';
    labelSpan.textContent = 'Application Details Header';
    document.body.appendChild(labelSpan);

    labelSpan.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));

    const clickSteps = sentSteps.filter(s => s.action === Action.CLICK);
    expect(clickSteps).toHaveLength(0);
  });

  it('Interactive Button (<button type="button">) click — records Action.CLICK step', async () => {
    const customBtn = document.createElement('button');
    customBtn.type = 'button';
    customBtn.id = 'toggle-panel-btn';
    customBtn.textContent = 'Toggle View';
    document.body.appendChild(customBtn);

    customBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));

    const clickSteps = sentSteps.filter(s => s.action === Action.CLICK);
    expect(clickSteps).toHaveLength(1);
  });
});
