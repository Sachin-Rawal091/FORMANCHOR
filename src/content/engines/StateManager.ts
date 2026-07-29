import { ExecutionState, ExecutionStatus, RowStatus } from "../../types";
import { StorageManager } from "../../storage/StorageManager";
import { EXCEL_CHUNK_SIZE } from "../../shared/constants";
import { logger } from "../../utils/logger";

export class StateManager {
  /**
   * Initializes a new execution session.
   * Blocks and throws an error if another session holds the mutex lock.
   */
  static async initializeSession(
    sessionId: string, 
    totalRows: number,
    recordingId?: string,
    siteUrl?: string,
    tabContext: number = -1
  ): Promise<ExecutionState> {
    const currentState = await StorageManager.getExecutionState();
    
    // Mutex check: prevent concurrent runs
    if (currentState?.mutexLock && currentState.mutexLock !== sessionId) {
      throw new Error(`Active session exists (ID: ${currentState.mutexLock}). Please abort or resume it first.`);
    }

    // Re-use row-status counters already persisted on the session record (set by
    // the popup's startExecution) instead of rescanning all Excel rows in IndexedDB.
    let initialCompleted = 0;
    let initialSkipped = 0;
    let initialFailed = 0;
    if (currentState && currentState.sessionId === sessionId) {
      // Counters were already computed and persisted by the popup — reuse them.
      initialCompleted = currentState.completedRows ?? 0;
      initialSkipped = currentState.skippedRows ?? 0;
      initialFailed = currentState.failedRows ?? 0;
    } else {
      // Fallback: no prior state for this session — scan IndexedDB paginated.
      try {
        const totalExcelRows = await StorageManager.getExcelDataCount();
        let lastRowIndex: number | undefined = undefined;
        for (let offset = 0; offset < totalExcelRows; offset += EXCEL_CHUNK_SIZE) {
          const afterRowIndex = offset > 0 ? lastRowIndex : undefined;
          const excelRows = await StorageManager.getExcelData(afterRowIndex, EXCEL_CHUNK_SIZE);
          if (excelRows.length > 0) {
            lastRowIndex = excelRows[excelRows.length - 1].rowIndex;
          }
          excelRows.forEach(row => {
            if (row.status === RowStatus.SUCCESS) initialCompleted++;
            else if (row.status === RowStatus.SKIPPED) initialSkipped++;
            else if (row.status === RowStatus.FAILED) initialFailed++;
          });
        }
      } catch (err) {
        logger.warn('StateManager', 'Failed to pre-scan Excel row statuses during session initialization:', err);
      }
    }

    const existingTabContext = currentState?.tabContext ?? -1;
    const finalTabContext = tabContext !== -1 ? tabContext : (existingTabContext !== -1 ? existingTabContext : -1);

    const newState: ExecutionState = {
      sessionId,
      currentRowIndex: 0,
      currentStepIndex: 0,
      currentPageId: "",
      status: ExecutionStatus.RUNNING, // Start as RUNNING, not IDLE
      totalRows,
      completedRows: initialCompleted,
      failedRows: initialFailed,
      skippedRows: initialSkipped,
      pageRetryCount: 0,
      mutexLock: sessionId, // Set mutex lock
      captchaPending: false,
      tabContext: finalTabContext,
      lastStepResult: "",
      recordingId: recordingId || undefined,
      siteUrl: siteUrl || undefined,
      currentUrl: window.location.href
    };

    // NOTE: addSessionMeta is intentionally NOT called here — the popup's
    // executionSlice.ts already writes session meta before sending START_EXECUTION.
    // A duplicate write from the content script caused a timestamp overwrite race.

    await StorageManager.setExecutionState(newState);
    return newState;
  }

  /**
   * Retrieves the current execution state snapshot.
   */
  static async getState(): Promise<ExecutionState | null> {
    return StorageManager.getExecutionState();
  }

  static async updateState(updates: Partial<ExecutionState>): Promise<ExecutionState> {
    const currentState = await StorageManager.getExecutionState();
    if (!currentState) {
      throw new Error("Cannot update state: No active session found in storage.");
    }

    // TOCTOU Race check: If the state in storage has already been marked as FAILED or COMPLETE,
    // do not allow overwriting it back to an active/running state (RUNNING, PAUSED, CAPTCHA_PAUSED).
    if (
      (currentState.status === ExecutionStatus.FAILED || currentState.status === ExecutionStatus.COMPLETE) &&
      (updates.status !== ExecutionStatus.FAILED && updates.status !== ExecutionStatus.COMPLETE)
    ) {
      logger.warn("StateManager", `Blocked stale state update reverting status from ${currentState.status} to ${updates.status || currentState.status}`);
      return currentState;
    }

    const updatedState: ExecutionState = { 
      ...currentState, 
      ...updates,
    };

    // Only track currentUrl during active RUNNING state — prevents storing
    // confirmation/success page URLs that would trigger spurious auto-resume.
    // If updates explicitly overrides currentUrl, honor it; otherwise default to window.location.href.
    const effectiveStatus = updates.status ?? currentState.status;
    if (effectiveStatus === ExecutionStatus.RUNNING) {
      updatedState.currentUrl = updates.currentUrl ?? window.location.href;
    }

    await StorageManager.setExecutionState(updatedState);
    return updatedState;
  }

  /**
   * Increments the page retry count. Escalate to fatal if over limit.
   */
  static async incrementPageRetry(maxPageRetries: number): Promise<boolean> {
    const state = await this.getState();
    if (!state) return false;

    const newCount = state.pageRetryCount + 1;
    await this.updateState({ pageRetryCount: newCount });

    // Returns true if we've exceeded the max
    return newCount >= maxPageRetries;
  }

  /**
   * Clears the execution state completely (used on COMPLETE, FATAL error, or user ABORT).
   * This releases the mutex lock.
   */
  static async clearSession(): Promise<void> {
    await StorageManager.clearExecutionState();
  }

  /**
   * Aborts the current session and releases the mutex.
   */
  static async abortSession(): Promise<void> {
    await this.clearSession();
  }
}
