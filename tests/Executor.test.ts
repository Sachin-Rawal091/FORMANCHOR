import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageType, RowStatus, ExecutionStatus, Action, ExcelRow } from '../src/types';

// Setup mock chrome BEFORE importing executor
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
  },
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    }
  }
};

(globalThis as any).chrome = mockChrome;

// Mock global XPathResult for tests
(globalThis as any).XPathResult = {
  FIRST_ORDERED_NODE_TYPE: 9,
};

describe('Executor Unit Tests', () => {
  let executionStateStore: any = null;

  beforeEach(async () => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    mockChrome.runtime.sendMessage.mockReset();
    executionStateStore = null;

    const { StorageManager } = await import('../src/storage/StorageManager');
    vi.spyOn(StorageManager, 'getExecutionState').mockImplementation(async () => executionStateStore);
    vi.spyOn(StorageManager, 'setExecutionState').mockImplementation(async (state) => {
      executionStateStore = state;
    });
    vi.spyOn(StorageManager, 'clearExecutionState').mockImplementation(async () => {
      executionStateStore = null;
    });

    // Mock getBoundingClientRect
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should skip already-completed rows and reconcile counters in _runAllRowsImpl', async () => {
    const { StorageManager } = await import('../src/storage/StorageManager');
    const { Executor } = await import('../src/content/executor');

    const mockRecording = {
      id: 'rec-1',
      name: 'Test Flow',
      siteUrl: 'http://localhost',
      siteId: 'localhost',
      steps: [
        { id: 'step-1', action: Action.CLICK, selector: '#btn', selectorMeta: {}, pageId: 'page_1' }
      ],
      pages: [],
      pageCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1
    };

    const mockExcelRows: ExcelRow[] = [
      { rowIndex: 0, data: {}, status: RowStatus.SUCCESS, isValid: true, validationErrors: [] },
      { rowIndex: 1, data: {}, status: RowStatus.PENDING, isValid: true, validationErrors: [] }
    ];

    vi.spyOn(StorageManager, 'getRecordings').mockResolvedValue([mockRecording]);
    vi.spyOn(StorageManager, 'getExcelData').mockResolvedValue(mockExcelRows);
    vi.spyOn(StorageManager, 'setExcelData').mockResolvedValue(undefined);
    vi.spyOn(StorageManager, 'addLogEntries').mockResolvedValue(undefined);

    mockChrome.runtime.sendMessage.mockImplementation((msg: any, callback?: any) => {
      if (callback) {
        if (msg.type === MessageType.GET_RECORDING_DATA) {
          callback({ recording: mockRecording });
        } else if (msg.type === MessageType.GET_EXCEL_DATA) {
          if (msg.payload?.countOnly) {
            callback({ count: mockExcelRows.length });
          } else {
            callback({ excelRows: mockExcelRows });
          }
        } else if (msg.type === MessageType.SET_EXCEL_DATA) {
          callback({ success: true });
        } else if (msg.type === MessageType.ADD_LOG_ENTRY) {
          callback({ success: true });
        }
      }
      return Promise.resolve(undefined);
    });

    const executor = (globalThis as any).__FP_EXECUTOR_INSTANCE__ || new Executor();
    sessionStorage.setItem('__fp_reset_done_sess-1', 'true');

    // Setup initial running state
    executionStateStore = {
      sessionId: 'sess-1',
      recordingId: 'rec-1',
      currentRowIndex: 0,
      currentStepIndex: 0,
      currentPageId: '',
      status: ExecutionStatus.RUNNING,
      totalRows: 2,
      completedRows: 0,
      failedRows: 0,
      skippedRows: 0,
      pageRetryCount: 0,
      mutexLock: 'sess-1',
      captchaPending: false,
      tabContext: 1,
      lastStepResult: ''
    };

    // Construct DOM element to click for row 2 (which is PENDING)
    const btn = document.createElement('button');
    btn.id = 'btn';
    document.body.appendChild(btn);

    // Run execution start
    await executor.start('rec-1', 'sess-1');

    // Wait a brief period for async loops
    await new Promise(r => setTimeout(r, 600));

    // Reconcile completedRows count: row 0 was SUCCESS, row 1 executed successfully, total completed is 2
    expect(executionStateStore.completedRows).toBe(2);
    expect(executionStateStore.currentRowIndex).toBe(2); // Ran past both rows (row 0 skipped, row 1 executed)
  });

  it('should dismiss success UI modals in dismissSuccessUI', async () => {
    const { Executor } = await import('../src/content/executor');
    const executor = (globalThis as any).__FP_EXECUTOR_INSTANCE__ || new Executor();
    
    // Create a mock modal element
    const modal = document.createElement('div');
    modal.className = 'modal show';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-close';
    modal.appendChild(closeBtn);
    document.body.appendChild(modal);

    const clickSpy = vi.spyOn(closeBtn, 'click');

    // Call private dismissSuccessUI via prototype casting
    const dismissed = await (executor as any).dismissSuccessUI();
    expect(dismissed).toBe(true);
    expect(clickSpy).toHaveBeenCalled();
  });

  it('should retry form submission when stuck on the same page with UNKNOWN outcome, then succeed', async () => {
    const { ResponseDetectionEngine } = await import('../src/content/engines/ResponseDetectionEngine');
    const { RetryEngine } = await import('../src/content/engines/RetryEngine');
    const { StorageManager } = await import('../src/storage/StorageManager');
    const { Executor } = await import('../src/content/executor');

    const mockRecording = {
      id: 'rec-2',
      name: 'Test Submit Flow',
      siteUrl: 'http://localhost',
      siteId: 'localhost',
      steps: [
        { id: 'step-submit', action: Action.CLICK, selector: '#submit-btn', selectorMeta: {}, pageId: 'page_1' }
      ],
      pages: [],
      pageCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1
    };

    const mockExcelRows: ExcelRow[] = [
      { rowIndex: 0, data: {}, status: RowStatus.PENDING, isValid: true, validationErrors: [] }
    ];

    vi.spyOn(StorageManager, 'getRecordings').mockResolvedValue([mockRecording]);
    vi.spyOn(StorageManager, 'getExcelData').mockResolvedValue(mockExcelRows);
    vi.spyOn(StorageManager, 'setExcelData').mockResolvedValue(undefined);
    vi.spyOn(StorageManager, 'addLogEntries').mockResolvedValue(undefined);

    // Mock first submission outcome as UNKNOWN, second as SUCCESS
    let runCount = 0;
    const runSubmissionDetectionSpy = vi.spyOn(ResponseDetectionEngine, 'runSubmissionDetection').mockImplementation(async () => {
      runCount++;
      return runCount === 1 ? "UNKNOWN" : "SUCCESS";
    });

    const executeStepWithRetrySpy = vi.spyOn(RetryEngine, 'executeStepWithRetry').mockResolvedValue({
      success: true,
      resolvedStatus: 'SUCCESS',
      retriesUsed: 0
    });

    mockChrome.runtime.sendMessage.mockImplementation((msg: any, callback?: any) => {
      if (callback) {
        if (msg.type === MessageType.GET_RECORDING_DATA) {
          callback({ recording: mockRecording });
        } else if (msg.type === MessageType.GET_EXCEL_DATA) {
          if (msg.payload?.countOnly) {
            callback({ count: mockExcelRows.length });
          } else {
            callback({ excelRows: mockExcelRows });
          }
        } else if (msg.type === MessageType.SET_EXCEL_DATA) {
          callback({ success: true });
        } else if (msg.type === MessageType.ADD_LOG_ENTRY) {
          callback({ success: true });
        }
      }
      return Promise.resolve(undefined);
    });

    const executor = new Executor();
    sessionStorage.setItem('__fp_reset_done_sess-2', 'true');

    // Setup initial running state
    executionStateStore = {
      sessionId: 'sess-2',
      recordingId: 'rec-2',
      currentRowIndex: 0,
      currentStepIndex: 0,
      currentPageId: '',
      status: ExecutionStatus.RUNNING,
      totalRows: 1,
      completedRows: 0,
      failedRows: 0,
      skippedRows: 0,
      pageRetryCount: 0,
      mutexLock: 'sess-2',
      captchaPending: false,
      tabContext: 1,
      lastStepResult: ''
    };

    // Run execution start
    await executor.start('rec-2', 'sess-2');

    // Wait a brief period for async loops
    await new Promise(r => setTimeout(r, 600));

    // Verify executeStepWithRetry was called twice (once for initial run, once for retry because it was stuck)
    expect(executeStepWithRetrySpy).toHaveBeenCalledTimes(2);
    // Verify runSubmissionDetection was called twice
    expect(runSubmissionDetectionSpy).toHaveBeenCalledTimes(2);
    // Verify row status was updated to SUCCESS
    expect(executionStateStore.completedRows).toBe(1);
    expect(executionStateStore.currentRowIndex).toBe(1);
  });
});
