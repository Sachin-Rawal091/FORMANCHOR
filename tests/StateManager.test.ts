import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StateManager } from '../src/content/engines/StateManager';
import { StorageManager } from '../src/storage/StorageManager';
import { ExecutionStatus, ExecutionState } from '../src/types';

describe('StateManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('initializeSession', () => {
    it('should initialize a new session if no mutex lock exists', async () => {
      vi.spyOn(StorageManager, 'getExecutionState').mockResolvedValue(null);
      const setSpy = vi.spyOn(StorageManager, 'setExecutionState').mockResolvedValue(undefined);

      const state = await StateManager.initializeSession('session-123', 10);

      expect(state.sessionId).toBe('session-123');
      expect(state.totalRows).toBe(10);
      expect(state.mutexLock).toBe('session-123');
      expect(state.status).toBe(ExecutionStatus.RUNNING);
      expect(setSpy).toHaveBeenCalledWith(state);
    });

    it('should throw an error if another session holds the mutex lock', async () => {
      const existingState: ExecutionState = {
        sessionId: 'session-old',
        currentRowIndex: 1,
        currentStepIndex: 0,
        currentPageId: '',
        status: ExecutionStatus.RUNNING,
        totalRows: 10,
        completedRows: 1,
        failedRows: 0,
        skippedRows: 0,
        pageRetryCount: 0,
        mutexLock: 'session-old',
        captchaPending: false,
        tabContext: 1,
        lastStepResult: ''
      };

      vi.spyOn(StorageManager, 'getExecutionState').mockResolvedValue(existingState);

      await expect(StateManager.initializeSession('session-new', 10)).rejects.toThrow(
        'Active session exists (ID: session-old). Please abort or resume it first.'
      );
    });

    it('should NOT call addSessionMeta (popup handles that to avoid duplicate writes)', async () => {
      vi.spyOn(StorageManager, 'getExecutionState').mockResolvedValue(null);
      vi.spyOn(StorageManager, 'setExecutionState').mockResolvedValue(undefined);
      const spy = vi.spyOn(StorageManager, 'addSessionMeta').mockResolvedValue(undefined);

      await StateManager.initializeSession('sess-1', 10, 'recording-1');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('getState', () => {
    it('should return the execution state from storage', async () => {
      const mockState: ExecutionState = {
        sessionId: 'session-123',
        currentRowIndex: 2,
        currentStepIndex: 1,
        currentPageId: 'p2',
        status: ExecutionStatus.RUNNING,
        totalRows: 5,
        completedRows: 2,
        failedRows: 0,
        skippedRows: 0,
        pageRetryCount: 1,
        mutexLock: 'session-123',
        captchaPending: false,
        tabContext: 1,
        lastStepResult: ''
      };

      vi.spyOn(StorageManager, 'getExecutionState').mockResolvedValue(mockState);

      const state = await StateManager.getState();
      expect(state).toEqual(mockState);
    });
  });

  describe('updateState', () => {
    it('should merge updates and save them to storage', async () => {
      const oldState: ExecutionState = {
        sessionId: 'session-123',
        currentRowIndex: 0,
        currentStepIndex: 0,
        currentPageId: '',
        status: ExecutionStatus.IDLE,
        totalRows: 5,
        completedRows: 0,
        failedRows: 0,
        skippedRows: 0,
        pageRetryCount: 0,
        mutexLock: 'session-123',
        captchaPending: false,
        tabContext: 1,
        lastStepResult: ''
      };

      vi.spyOn(StorageManager, 'getExecutionState').mockResolvedValue(oldState);
      const setSpy = vi.spyOn(StorageManager, 'setExecutionState').mockResolvedValue(undefined);

      const updated = await StateManager.updateState({
        status: ExecutionStatus.RUNNING,
        currentRowIndex: 1
      });

      expect(updated.status).toBe(ExecutionStatus.RUNNING);
      expect(updated.currentRowIndex).toBe(1);
      expect(updated.sessionId).toBe('session-123'); // preserved
      expect(setSpy).toHaveBeenCalledWith(updated);
    });

    it('should throw an error if no active session is found during update', async () => {
      vi.spyOn(StorageManager, 'getExecutionState').mockResolvedValue(null);

      await expect(StateManager.updateState({ status: ExecutionStatus.RUNNING })).rejects.toThrow(
        'Cannot update state: No active session found in storage.'
      );
    });
  });

  describe('incrementPageRetry', () => {
    it('should return false if there is no active session', async () => {
      vi.spyOn(StorageManager, 'getExecutionState').mockResolvedValue(null);

      const result = await StateManager.incrementPageRetry(3);
      expect(result).toBe(false);
    });

    it('should increment pageRetryCount and return false if below or equal to maxPageRetries', async () => {
      const activeState: ExecutionState = {
        sessionId: 'session-123',
        currentRowIndex: 0,
        currentStepIndex: 0,
        currentPageId: '',
        status: ExecutionStatus.RUNNING,
        totalRows: 5,
        completedRows: 0,
        failedRows: 0,
        skippedRows: 0,
        pageRetryCount: 0,
        mutexLock: 'session-123',
        captchaPending: false,
        tabContext: 1,
        lastStepResult: ''
      };

      vi.spyOn(StorageManager, 'getExecutionState').mockResolvedValue(activeState);
      const setSpy = vi.spyOn(StorageManager, 'setExecutionState').mockResolvedValue(undefined);

      const isOverLimit = await StateManager.incrementPageRetry(3);
      expect(isOverLimit).toBe(false);
      expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ pageRetryCount: 1 }));
    });

    it('should increment pageRetryCount and return true if it exceeds maxPageRetries', async () => {
      const activeState: ExecutionState = {
        sessionId: 'session-123',
        currentRowIndex: 0,
        currentStepIndex: 0,
        currentPageId: '',
        status: ExecutionStatus.RUNNING,
        totalRows: 5,
        completedRows: 0,
        failedRows: 0,
        skippedRows: 0,
        pageRetryCount: 2,
        mutexLock: 'session-123',
        captchaPending: false,
        tabContext: 1,
        lastStepResult: ''
      };

      vi.spyOn(StorageManager, 'getExecutionState').mockResolvedValue(activeState);
      const setSpy = vi.spyOn(StorageManager, 'setExecutionState').mockResolvedValue(undefined);

      const isOverLimit = await StateManager.incrementPageRetry(2); // new pageRetryCount is 3, max is 2
      expect(isOverLimit).toBe(true);
      expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ pageRetryCount: 3 }));
    });
  });

  describe('clearSession / abortSession', () => {
    it('should call clearExecutionState to release mutex lock and clear session', async () => {
      const clearSpy = vi.spyOn(StorageManager, 'clearExecutionState').mockResolvedValue(undefined);

      await StateManager.clearSession();
      expect(clearSpy).toHaveBeenCalledTimes(1);

      await StateManager.abortSession();
      expect(clearSpy).toHaveBeenCalledTimes(2);
    });
  });
});
