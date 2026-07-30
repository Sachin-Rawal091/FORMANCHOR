import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ExcelRow, Recording } from '../src/types';
import { MessageType } from '../src/types';

// 1. Setup global chrome mock BEFORE importing any scripts so they register correctly
const listeners: Array<(message: any, sender: any, sendResponse: any) => void> = [];

const mockChrome = {
  runtime: {
    onMessage: {
      addListener: (fn: any) => {
        listeners.push(fn);
      },
      removeListener: (fn: any) => {
        const index = listeners.indexOf(fn);
        if (index > -1) listeners.splice(index, 1);
      }
    },
    sendMessage: vi.fn().mockResolvedValue(undefined),
  }
};

(globalThis as any).chrome = mockChrome;

// Mock global XPathResult for tests
(globalThis as any).XPathResult = {
  FIRST_ORDERED_NODE_TYPE: 9,
};

describe('Integration Flow - Record to Execution Loop', () => {
  let executionStateStore: any = null;

  beforeEach(async () => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    mockChrome.runtime.sendMessage.mockReset();
    mockChrome.runtime.sendMessage.mockImplementation((msg: any, callback?: any) => {
      if (callback) {
        if (msg.type === MessageType.GET_RECORDING_DATA) {
          import('../src/storage/StorageManager').then(({ StorageManager }) => {
            StorageManager.getRecordings().then(recs => {
              callback({ recording: recs.find(r => r.id === msg.payload.recordingId) });
            });
          });
          return true;
        }
        if (msg.type === MessageType.GET_EXCEL_DATA) {
          import('../src/storage/StorageManager').then(({ StorageManager }) => {
            if (msg.payload?.countOnly) {
              StorageManager.getExcelData().then(rows => {
                callback({ count: rows.length });
              });
            } else {
              StorageManager.getExcelData().then(rows => {
                callback({ excelRows: rows });
              });
            }
          });
          return true;
        }
        if (msg.type === MessageType.SET_EXCEL_DATA) {
          import('../src/storage/StorageManager').then(({ StorageManager }) => {
            StorageManager.setExcelData(msg.payload.excelRows).then(() => {
              callback({ success: true });
            });
          });
          return true;
        }
        if (msg.type === MessageType.ADD_LOG_BATCH) {
          import('../src/storage/StorageManager').then(({ StorageManager }) => {
            StorageManager.addLogEntries(msg.payload.entries).then(() => {
              callback({ success: true });
            });
          });
          return true;
        }
        callback({ received: true });
        return true;
      }
      return Promise.resolve(undefined);
    });

    // Mock layout globally since Happy DOM doesn't compute actual layouts
    (globalThis as any).Element.prototype.getBoundingClientRect = () => ({
      width: 100,
      height: 25,
      top: 0,
      left: 0,
      bottom: 25,
      right: 100,
    } as any);
    
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      pointerEvents: 'auto',
    } as any);
    
    // Setup in-memory mock for execution state
    executionStateStore = null;

    // Dynamically import StorageManager to mock it cleanly
    const { StorageManager } = await import('../src/storage/StorageManager');
    vi.spyOn(StorageManager, 'getExecutionState').mockImplementation(async () => executionStateStore);
    vi.spyOn(StorageManager, 'setExecutionState').mockImplementation(async (state) => {
      executionStateStore = state;
    });
    vi.spyOn(StorageManager, 'clearExecutionState').mockImplementation(async () => {
      executionStateStore = null;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function broadcastChromeMessage(msg: any) {
    for (const listener of listeners) {
      listener(msg, {}, () => {});
    }
  }

  it('should complete the end-to-end Recording -> Storage -> Execution loop', async () => {
    vi.useFakeTimers();

    // Dynamically import engines to prevent ESM import hoisting ReferenceErrors
    const { StorageManager } = await import('../src/storage/StorageManager');
    const { MessageType, Action, RowStatus, ExecutionStatus } = await import('../src/types');
    await import('../src/content/recorder');
    await import('../src/content/executor');

    // --- 1. RECORDING PHASE ---
    // Start recording session
    broadcastChromeMessage({
      type: MessageType.START_RECORDING,
      sessionId: 'session-123',
      payload: { recordingId: 'flow-abc' }
    });

    // Create form elements to record interactions on
    const nameInput = document.createElement('input');
    nameInput.id = 'user-name';
    nameInput.className = 'form-input';
    document.body.appendChild(nameInput);

    const newsletterSelect = document.createElement('select');
    newsletterSelect.id = 'newsletter-opt';
    const optYes = document.createElement('option');
    optYes.value = 'yes';
    const optNo = document.createElement('option');
    optNo.value = 'no';
    newsletterSelect.appendChild(optYes);
    newsletterSelect.appendChild(optNo);
    document.body.appendChild(newsletterSelect);

    // Simulate input typing
    nameInput.value = 'Sachin';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));

    // Simulate selection change
    newsletterSelect.value = 'no';
    newsletterSelect.dispatchEvent(new Event('change', { bubbles: true }));

    // Fast-forward input debounce timer (300ms)
    vi.advanceTimersByTime(350);

    // Verify RecordingEvents are dispatched
    expect(mockChrome.runtime.sendMessage).toHaveBeenCalled();
    const sentMessages = mockChrome.runtime.sendMessage.mock.calls.map(c => c[0]);
    
    // Extract steps from messages
    const recordEvents = sentMessages.filter(m => m.type === MessageType.RECORDING_EVENT);
    expect(recordEvents).toHaveLength(2);

    const step1 = recordEvents.find(m => m.payload.step.selector.includes('user-name')).payload.step;
    const step2 = recordEvents.find(m => m.payload.step.selector.includes('newsletter-opt')).payload.step;

    expect(step1.action).toBe(Action.FILL);
    expect(step1.selector).toContain('#user-name');
    
    expect(step2.action).toBe(Action.SELECT);
    expect(step2.selector).toContain('#newsletter-opt');

    // Make the values templates so we can bind Excel row columns
    step1.value = '{{Name}}';
    step1.columnName = 'Name';
    step2.value = '{{Newsletter}}';
    step2.columnName = 'Newsletter';

    // Stop recording
    broadcastChromeMessage({
      type: MessageType.STOP_RECORDING,
      sessionId: 'session-123'
    });

    // --- 2. PERSISTENCE STORAGE PHASE ---
    const capturedSteps = [step1, step2];
    const mockRecording: Recording = {
      id: 'flow-abc',
      name: 'Flow ABC',
      siteUrl: 'http://localhost',
      siteId: 'localhost',
      steps: capturedSteps,
      pages: [],
      pageCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1
    };

    const mockExcelRows: ExcelRow[] = [
      {
        rowIndex: 2,
        data: { Name: 'Rahul', Newsletter: 'no' },
        status: RowStatus.PENDING,
        isValid: true,
        validationErrors: []
      }
    ];

    vi.spyOn(StorageManager, 'getRecordings').mockResolvedValue([mockRecording]);
    vi.spyOn(StorageManager, 'getExcelData').mockResolvedValue(mockExcelRows);
    const saveExcelSpy = vi.spyOn(StorageManager, 'setExcelData').mockResolvedValue(undefined);
    const addLogSpy = vi.spyOn(StorageManager, 'addLogEntries').mockResolvedValue(undefined);

    // Switch back to real timers for Execution Phase (async executors rely on actual tick timing)
    vi.useRealTimers();

    // Mock ResponseDetectionEngine to simulate a success element on page so UNKNOWN isn't returned
    const { ResponseDetectionEngine } = await import('../src/content/engines/ResponseDetectionEngine');
    vi.spyOn(ResponseDetectionEngine, 'runSubmissionDetection').mockResolvedValue('SUCCESS');

    // --- 3. EXECUTION PHASE ---
    // Clear DOM and recreate fresh inputs to be populated
    document.body.innerHTML = '';
    
    const freshNameInput = document.createElement('input');
    freshNameInput.id = 'user-name';
    document.body.appendChild(freshNameInput);

    const freshNewsletterSelect = document.createElement('select');
    freshNewsletterSelect.id = 'newsletter-opt';
    const optYesFresh = document.createElement('option');
    optYesFresh.value = 'yes';
    const optNoFresh = document.createElement('option');
    optNoFresh.value = 'no';
    freshNewsletterSelect.appendChild(optYesFresh);
    freshNewsletterSelect.appendChild(optNoFresh);
    document.body.appendChild(freshNewsletterSelect);

    // Track input & change triggers to verify React event listeners
    const inputHandler = vi.fn();
    const changeHandler = vi.fn();
    freshNameInput.addEventListener('input', inputHandler);
    freshNewsletterSelect.addEventListener('change', changeHandler);

    // Start Execution
    // Integration test starts manually for flow
    const { Executor } = await import('../src/content/executor');
    const executor = (globalThis as any).__FP_EXECUTOR_INSTANCE__ || new Executor();
    sessionStorage.setItem('__fp_reset_done_session-123', 'true');
    
    // Simulate background start
    executor.start('flow-abc', 'session-123');

    // Wait for the asynchronous chunk loop to complete execution
    await vi.waitFor(() => {
      expect(freshNameInput.value).toBe('Rahul');
      expect(freshNewsletterSelect.value).toBe('no');
      expect(saveExcelSpy).toHaveBeenCalled();
      expect(addLogSpy).toHaveBeenCalled();
    }, { timeout: 2000 });

    // Verify correct end state in StorageManager
    expect(executionStateStore).not.toBeNull();
    expect(executionStateStore.status).toBe(ExecutionStatus.COMPLETE);
    expect(executionStateStore.completedRows).toBe(1);
    expect(executionStateStore.mutexLock).toBeNull();
  });
});
