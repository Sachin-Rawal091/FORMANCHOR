import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RecordingQueueHandler } from '../src/background/handlers/RecordingQueueHandler';
import { StorageManager } from '../src/storage/StorageManager';
import { Action, Step } from '../src/types';

vi.mock('../src/storage/StorageManager', () => {
  let mockState: any = null;
  return {
    StorageManager: {
      getRecordingState: vi.fn().mockImplementation(async () => mockState),
      setRecordingState: vi.fn().mockImplementation(async (state) => {
        mockState = state;
      }),
    }
  };
});

// Setup mock for chrome storage session API
const mockSessionStorage: Record<string, any> = {};
const mockChrome = {
  storage: {
    session: {
      get: vi.fn().mockImplementation(async (keys) => {
        if (typeof keys === 'string') {
          return { [keys]: mockSessionStorage[keys] };
        }
        const result: Record<string, any> = {};
        for (const k of keys) {
          result[k] = mockSessionStorage[k];
        }
        return result;
      }),
      set: vi.fn().mockImplementation(async (obj) => {
        Object.assign(mockSessionStorage, obj);
      }),
      remove: vi.fn().mockImplementation(async (keys) => {
        if (typeof keys === 'string') {
          delete mockSessionStorage[keys];
        } else {
          for (const k of keys) {
            delete mockSessionStorage[k];
          }
        }
      })
    }
  }
};

(globalThis as any).chrome = mockChrome;

describe('RecordingQueueHandler Unit Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    RecordingQueueHandler.resetQueue();
    for (const key of Object.keys(mockSessionStorage)) {
      delete mockSessionStorage[key];
    }
  });

  it('setActiveTab and getActiveTab should track active tab in memory and session storage', async () => {
    await RecordingQueueHandler.setActiveTab(10);
    const activeTab = await RecordingQueueHandler.getActiveTab();
    expect(activeTab).toBe(10);
    expect(mockChrome.storage.session.set).toHaveBeenCalledWith({ activeRecordingTabId: 10 });

    await RecordingQueueHandler.setActiveTab(null);
    const clearedTab = await RecordingQueueHandler.getActiveTab();
    expect(clearedTab).toBe(null);
    expect(mockChrome.storage.session.remove).toHaveBeenCalledWith('activeRecordingTabId');
  });

  it('enqueueStep should append step to queue, persist queue, and process it when active', async () => {
    const mockState = {
      isRecording: true,
      activeRecordingSteps: [] as Step[],
      activeRecordingUrl: 'http://localhost',
      recordingId: 'rec-1'
    };

    vi.spyOn(StorageManager, 'getRecordingState').mockResolvedValue(mockState as any);
    vi.spyOn(StorageManager, 'setRecordingState').mockResolvedValue(undefined);

    const step: Step = {
      id: 'step-1',
      action: Action.FILL,
      selector: '#input-1',
      selectorMeta: {},
      pageId: 'page_1',
      value: 'Hello'
    };

    RecordingQueueHandler.enqueueStep(step);

    // Let microtasks run
    await new Promise(r => setTimeout(r, 50));

    expect(StorageManager.getRecordingState).toHaveBeenCalled();
    expect(StorageManager.setRecordingState).toHaveBeenCalled();
    expect(mockState.activeRecordingSteps).toHaveLength(1);
    expect(mockState.activeRecordingSteps[0].value).toBe('Hello');
  });

  it('restoreQueue should restore step queue from session storage', async () => {
    const step: Step = {
      id: 'step-1',
      action: Action.FILL,
      selector: '#input-1',
      selectorMeta: {},
      pageId: 'page_1',
      value: 'Hello'
    };
    mockSessionStorage['pendingRecordingStepQueue'] = [step];

    await RecordingQueueHandler.restoreQueue();

    // Verify enqueued steps by flushing the queue
    const mockState = {
      isRecording: true,
      activeRecordingSteps: [] as Step[],
      activeRecordingUrl: 'http://localhost',
      recordingId: 'rec-1'
    };
    vi.spyOn(StorageManager, 'getRecordingState').mockResolvedValue(mockState as any);
    vi.spyOn(StorageManager, 'setRecordingState').mockResolvedValue(undefined);

    await RecordingQueueHandler.flushQueue();
    expect(mockState.activeRecordingSteps).toHaveLength(1);
    expect(mockState.activeRecordingSteps[0].value).toBe('Hello');
  });

  it('should merge consecutive DATEPICKER steps targeting the same field or parent/child selector path', async () => {
    const mockState = {
      isRecording: true,
      activeRecordingSteps: [] as Step[],
      activeRecordingUrl: 'http://localhost',
      recordingId: 'rec-1'
    };

    vi.spyOn(StorageManager, 'getRecordingState').mockResolvedValue(mockState as any);
    vi.spyOn(StorageManager, 'setRecordingState').mockResolvedValue(undefined);

    const step1: Step = {
      id: 'step-1',
      action: Action.DATEPICKER,
      selector: 'div#app > div > div:nth-of-type(3) > input',
      selectorMeta: { cssPath: 'div#app > div > div:nth-of-type(3) > input', labelText: 'Start Date' },
      pageId: 'page_1',
      value: '04/12/2025'
    };

    const step2: Step = {
      id: 'step-2',
      action: Action.DATEPICKER,
      selector: 'div#app > div > div:nth-of-type(3)',
      selectorMeta: { cssPath: 'div#app > div > div:nth-of-type(3)', labelText: 'Start Date' },
      pageId: 'page_1',
      value: '2025-12-19'
    };

    RecordingQueueHandler.enqueueStep(step1);
    RecordingQueueHandler.enqueueStep(step2);

    await new Promise(r => setTimeout(r, 50));

    expect(mockState.activeRecordingSteps).toHaveLength(1);
    expect(mockState.activeRecordingSteps[0].value).toBe('2025-12-19');
  });
});
