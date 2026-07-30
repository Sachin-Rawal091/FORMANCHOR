import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LogBatcher } from '../src/content/LogBatcher';
import { StorageManager } from '../src/storage/StorageManager';
import { MessageType, LogEntry, Action, StepResult } from '../src/types';
import { getDB } from '../src/storage/db';
import { sendToBackground } from '../src/shared/messages';

vi.mock('../src/shared/messages', () => ({
  sendToBackground: vi.fn()
}));

// Mock chrome.storage.local
const mockStorage = {
  data: {} as Record<string, any>,
  get: vi.fn(async (keys) => {
    if (keys === null) return mockStorage.data;
    return mockStorage.data;
  }),
  set: vi.fn(async (items) => {
    Object.assign(mockStorage.data, items);
  }),
  remove: vi.fn(async (keys) => {
    if (Array.isArray(keys)) {
      keys.forEach(k => delete mockStorage.data[k]);
    } else {
      delete mockStorage.data[keys];
    }
  }),
  clear: () => { mockStorage.data = {}; }
};

vi.stubGlobal('chrome', {
  storage: { local: mockStorage },
  runtime: { id: 'test' },
  tabs: {} // Mock tabs to pretend to be background script for StorageManager
});

describe('LogBatcher & Server-Side Ordering', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockStorage.clear();
    
    // Clear IDB
    const db = await getDB();
    const tx = db.transaction('logs', 'readwrite');
    await tx.objectStore('logs').clear();
    await tx.done;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createDummyEntry = (id: string, sessionId = "session1"): LogEntry => ({
    id,
    sessionId,
    timestamp: Date.now(),
    rowIndex: 0,
    stepId: "step1",
    action: Action.CLICK,
    selector: "button",
    result: StepResult.SUCCESS,
    status: "SUCCESS",
    retryCount: 0,
    duration: 10
  });

  it('assigns batchIndex on enqueue and buffer swaps correctly', async () => {
    const batcher = new LogBatcher();
    batcher.setSessionId("session1");
    
    batcher.enqueue(createDummyEntry("1"));
    batcher.enqueue(createDummyEntry("2"));
    
    // The internal queue should have items with batchIndex
    const internalQueue = (batcher as any).queue;
    expect(internalQueue[0].batchIndex).toBe(0);
    expect(internalQueue[1].batchIndex).toBe(1);
    
    vi.mocked(sendToBackground).mockResolvedValueOnce({ received: true } as any);
    
    const flushPromise = batcher.flushNow();
    
    // Immediately after calling flushNow, the queue should be swapped/empty
    expect((batcher as any).queue.length).toBe(0);
    
    await flushPromise;
    expect(sendToBackground).toHaveBeenCalledWith(expect.objectContaining({
      type: MessageType.ADD_LOG_BATCH,
      payload: expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({ id: "1" }),
          expect.objectContaining({ id: "2" })
        ])
      })
    }));
  });

  it('serializes flushes using flushInFlight mutex', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const batcher = new LogBatcher();
    batcher.setSessionId("session1");
    
    // Make the first sendToBackground slow
    let resolveFirst: any;
    const firstPromise = new Promise(r => { resolveFirst = r; });
    vi.mocked(sendToBackground).mockImplementationOnce(() => firstPromise as any);
    
    batcher.enqueue(createDummyEntry("1"));
    const flush1 = batcher.flushNow();
    
    // Enqueue more while first is in flight
    batcher.enqueue(createDummyEntry("2"));
    const flush2 = batcher.flushNow();
    
    // Second flush should not have called sendToBackground yet because of the mutex
    expect(sendToBackground).toHaveBeenCalledTimes(1);
    
    // Resolve first flush
    resolveFirst({ received: true });
    await flush1;
    
    // Advance timers slightly so race conditions settle
    await vi.advanceTimersByTimeAsync(10);
    
    // Now second flush should have fired
    expect(sendToBackground).toHaveBeenCalledTimes(2);
    
    await flush2; // Await it to avoid unused variable warning
    
    vi.useRealTimers();
  });

  it('bounds mutex wait and falls back to storage if ceiling exceeded', async () => {
    vi.useFakeTimers();
    const batcher = new LogBatcher();
    batcher.setSessionId("session1");
    
    // 1. Send first batch, mock doFlush to hang indefinitely so mutex is held
    vi.spyOn(batcher as any, 'doFlush').mockImplementationOnce(() => {
      (batcher as any).queue = [];
      return new Promise(() => {});
    });
    batcher.enqueue(createDummyEntry("1"));
    batcher.flushNow(); // Starts waiting
    
    // 2. Queue second batch and trigger flush
    batcher.enqueue(createDummyEntry("2"));
    const flush2Promise = batcher.flushNow(); // This waits on the first flush's mutex
    
    // 3. Advance time past the 3000ms mutex ceiling
    await vi.advanceTimersByTimeAsync(3100);
    
    await flush2Promise; // Should resolve safely because it bypassed the mutex
    
    // The second flush should have bypassed IPC (doFlush is not called)
    expect(sendToBackground).toHaveBeenCalledTimes(0); 
    
    // It should have written directly to local storage fallback
    const fallbackKeys = Object.keys(mockStorage.data).filter(k => k.startsWith('__fp_pending_logs_'));
    expect(fallbackKeys.length).toBe(1);
    expect(mockStorage.data[fallbackKeys[0]][0].id).toBe("2");
    
    vi.useRealTimers();
  });

  it('falls back to local storage if IPC times out (2500ms)', async () => {
    vi.useFakeTimers();
    const batcher = new LogBatcher();
    batcher.setSessionId("session1");
    
    // Make IPC hang
    vi.mocked(sendToBackground).mockImplementationOnce(() => new Promise(() => {}));
    
    batcher.enqueue(createDummyEntry("1"));
    const flushPromise = batcher.flushNow();
    
    // Advance time past 2500ms IPC timeout
    await vi.advanceTimersByTimeAsync(2600);
    await flushPromise;
    
    const fallbackKeys = Object.keys(mockStorage.data).filter(k => k.startsWith('__fp_pending_logs_'));
    expect(fallbackKeys.length).toBe(1);
    
    vi.useRealTimers();
  });

  it('atomically assigns sequence numbers and prevents interleaving (concurrency test)', async () => {
    // This is the crucial test requested by the user: two near-simultaneous addLogEntries() calls
    const entriesA = [
      createDummyEntry("A1", "session_atomic"),
      createDummyEntry("A2", "session_atomic")
    ];
    // batchIndex tags set by content script
    entriesA[0].batchIndex = 0;
    entriesA[1].batchIndex = 1;

    const entriesB = [
      createDummyEntry("B1", "session_atomic"),
      createDummyEntry("B2", "session_atomic")
    ];
    entriesB[0].batchIndex = 0;
    entriesB[1].batchIndex = 1;

    // Fire them concurrently without waiting
    await Promise.all([
      StorageManager.addLogEntries(entriesA),
      StorageManager.addLogEntries(entriesB)
    ]);

    // Retrieve all logs for this session
    const logs = await StorageManager.getLogs("session_atomic");
    expect(logs.length).toBe(4);

    // Verify sequences are strictly monotonically increasing
    const sequences = logs.map(l => l.sequence!).sort((a, b) => a - b);
    expect(new Set(sequences).size).toBe(4); // All 4 sequences must be unique
    
    // Verify that the entries from the SAME batch were kept together 
    // (either A got earlier sequences and B got later OR vice versa)
    const logA1 = logs.find(l => l.id === "A1")!;
    const logA2 = logs.find(l => l.id === "A2")!;
    const logB1 = logs.find(l => l.id === "B1")!;
    const logB2 = logs.find(l => l.id === "B2")!;

    if (logA1.sequence! < logB1.sequence!) {
      expect(logA2.sequence! - logA1.sequence!).toBe(1);
      expect(logB1.sequence! > logA2.sequence!).toBe(true);
      expect(logB2.sequence! - logB1.sequence!).toBe(1);
    } else {
      expect(logB2.sequence! - logB1.sequence!).toBe(1);
      expect(logA1.sequence! > logB2.sequence!).toBe(true);
      expect(logA2.sequence! - logA1.sequence!).toBe(1);
    }
  });

  it('recovers fallback logs and assigns correct sequence at sweep time', async () => {
    const entry1 = createDummyEntry("sweep1", "session_sweep");
    entry1.timestamp = 1000;
    entry1.batchIndex = 0;
    
    // Manually place in fallback storage
    mockStorage.data['__fp_pending_logs_session_sweep_1234_uuid1'] = [entry1];
    
    // Run a normal IDB write first
    const entry2 = createDummyEntry("sweep2", "session_sweep");
    entry2.timestamp = 2000;
    await StorageManager.addLogEntries([entry2]); // gets first sequence
    
    // Now trigger sweep
    await StorageManager.sweepPendingFallbackLogs();
    
    const logs = await StorageManager.getLogs("session_sweep");
    
    // Should be sorted by timestamp then sequence
    // entry1 (ts: 1000) should appear before entry2 (ts: 2000)
    // even though entry1 was swept later and got a higher sequence
    expect(logs.length).toBe(2);
    expect(logs[1].id).toBe("sweep1"); // Most recent first (reverse order)
    expect(logs[0].id).toBe("sweep2");
    
    expect(logs[1].sequence! > logs[0].sequence!).toBe(true); // Sweep happens later, gets higher sequence
  });
});
