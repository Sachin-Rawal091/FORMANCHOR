import {
  Step,
  Action,
  ExcelRow,
  RowStatus,
  ExecutionState,
  ExecutionStatus,
  MessageType,
  FormPilotMessage,
  StepResult,
  LogStatus
} from "../types";
import { StateManager } from "./engines/StateManager";
import { sendToBackground } from "../shared/messages";
import { RetryEngine, ErrorClassification } from "./engines/RetryEngine";
import { SmartWaitEngine } from "./engines/SmartWaitEngine";
import { SelectorEngine } from "./engines/SelectorEngine";
import { ResponseDetectionEngine } from "./engines/ResponseDetectionEngine";
import { AutoResumeManager } from "./AutoResumeManager";
import { FormResetter } from "./FormResetter";
import { SubmitVerifier } from "./SubmitVerifier";
import { LogBatcher } from "./LogBatcher";
import { loadAndApplyUserSettings } from "../utils/settingsLoader";
import {
  MAX_PAGE_RETRIES,
  STEP_DELAY,
  EXCEL_CHUNK_SIZE,
  WAIT_DOM_STABLE_TIMEOUT
} from "../shared/constants";
import { logger } from "../utils/logger";
import { generateUUID } from "../utils/uuid";
import { dispatchEvents } from "./domUtils";

export class Executor {
  private isRunning = false;
  private isPaused = false;
  private sessionId = "";
  private recordingSteps: Step[] = [];
  private siteUrl = "";
  private stepDelay = STEP_DELAY;

  private readonly autoResumeManager: AutoResumeManager;
  private readonly formResetter: FormResetter;
  private readonly submitVerifier: SubmitVerifier;
  private readonly logBatcher: LogBatcher;

  constructor() {
    this.logBatcher = new LogBatcher();
    this.formResetter = new FormResetter(
      (message, timeoutMs) => this.safeSendMessage(message, timeoutMs),
      () => this.logBatcher.flushNow()
    );
    this.submitVerifier = new SubmitVerifier({
      isRunning: () => this.isRunning,
      sendMessage: (message, timeoutMs) => this.safeSendMessage(message, timeoutMs)
    });
    this.autoResumeManager = new AutoResumeManager({
      isRunning: () => this.isRunning,
      setStepDelay: (delay) => { this.stepDelay = delay; },
      startExecution: (recordingId, sessionId) => this.start(recordingId, sessionId)
    });

    this.setupMessageListener();
    this.setupStorageListener();
    this.autoResumeManager.checkAutoResume();
    (globalThis as any).__FP_EXECUTOR_INSTANCE__ = this;
  }

  private setupMessageListener() {
    chrome.runtime.onMessage.addListener((message: FormPilotMessage, _sender, sendResponse) => {
      switch (message.type) {
        case MessageType.START_EXECUTION: {
          const payload = message.payload as { recordingId: string; sessionId: string };
          this.start(payload?.recordingId, payload?.sessionId || message.sessionId, message.tabId)
            .catch(err => logger.error('Executor', 'START_EXECUTION handler failed:', err));
          break;
        }
        case MessageType.PAUSE_EXECUTION:
          this.pause().catch(err => logger.error('Executor', 'PAUSE_EXECUTION handler failed:', err));
          break;
        case MessageType.RESUME_EXECUTION:
          if (!this.isRunning) {
            StateManager.getState().then((state) => {
              if (state && state.recordingId && state.sessionId) {
                this.start(state.recordingId, state.sessionId)
                  .catch(err => logger.error('Executor', 'RESUME_EXECUTION start failed:', err));
              } else {
                this.resume().catch(err => logger.error('Executor', 'RESUME_EXECUTION resume failed:', err));
              }
            }).catch(() => {
              this.resume().catch(err => logger.error('Executor', 'RESUME_EXECUTION fallback resume failed:', err));
            });
          } else {
            this.resume().catch(err => logger.error('Executor', 'RESUME_EXECUTION running resume failed:', err));
          }
          break;
        case MessageType.ABORT_EXECUTION:
          this.abort().catch(err => logger.error('Executor', 'ABORT_EXECUTION handler failed:', err));
          break;
      }
      sendResponse({ received: true });
      return true;
    });
  }

  private setupStorageListener() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'session' && changes.executionState) {
          const newState = changes.executionState.newValue as ExecutionState | undefined;
          if (newState) {
            if (newState.status === ExecutionStatus.PAUSED) {
              if (!this.isPaused) {
                logger.info('Executor', 'Detected pause state from storage.');
                this.isPaused = true;
              }
            } else if (newState.status === ExecutionStatus.RUNNING) {
              if (this.isPaused) {
                logger.info('Executor', 'Detected resume state from storage.');
                this.isPaused = false;
              }
            }
          }
        }
      });
    }
  }

  private safeSendMessage(message: any, timeoutMs = 2000): Promise<any> {
    return new Promise((resolve) => {
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          logger.warn('Executor', `sendMessage timed out after ${timeoutMs}ms for type: ${message.type}`);
          resolve({ error: "TIMEOUT", timeout: true });
        }
      }, timeoutMs);

      try {
        sendToBackground(message).then((response) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            if (!response && chrome.runtime.lastError) {
              logger.warn('Executor', `sendMessage lastError: ${chrome.runtime.lastError.message}`);
              resolve({ error: chrome.runtime.lastError.message });
            } else {
              resolve(response);
            }
          }
        });
      } catch (err: any) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          logger.error('Executor', "sendMessage threw exception:", err);
          resolve({ error: err.message });
        }
      }
    });
  }

  // ─── INITIAL START ──────────────────────────────────────────────────

  async start(recordingId: string, sessionId: string, tabId: number = -1) {
    if (this.isRunning) {
      if (this.sessionId && this.sessionId !== sessionId) {
        logger.warn('Executor', `Forcing restart: New session ${sessionId} requested while session ${this.sessionId} was active.`);
        this.cleanup();
      } else {
        logger.warn('Executor', "Executor is already running.");
        return;
      }
    }

    // Load custom settings overrides from storage
    this.stepDelay = await loadAndApplyUserSettings();

    // Immediate storage mutex check to prevent multi-tab race conditions
    const currentState = await StateManager.getState();
    const isStaleLock = !currentState ||
                        currentState.status === ExecutionStatus.COMPLETE ||
                        currentState.status === ExecutionStatus.FAILED ||
                        currentState.status === ExecutionStatus.IDLE;
    if (currentState?.mutexLock && currentState.mutexLock !== sessionId && !isStaleLock) {
      logger.warn('Executor', `Executor blocked: Mutex locked by session ${currentState.mutexLock} with status ${currentState.status}`);
      return;
    }

    this.isRunning = true;
    this.isPaused = false;
    this.sessionId = sessionId;
    this.logBatcher.setSessionId(sessionId);
    try {
      // 1. Fetch the targeted recording via background proxy
      const recordingRes = await this.safeSendMessage({
        type: MessageType.GET_RECORDING_DATA,
        payload: { recordingId },
        sessionId: this.sessionId,
        timestamp: Date.now()
      }, 5000);
      if (recordingRes?.error || !recordingRes?.recording) {
        throw new Error(recordingRes?.error || `Recording with ID ${recordingId} not found via extension proxy.`);
      }
      this.recordingSteps = recordingRes.recording.steps;
      this.siteUrl = recordingRes.recording.siteUrl || window.location.href;

      // 2. Fetch total rows count to process via background proxy
      const countRes = await this.safeSendMessage({
        type: MessageType.GET_EXCEL_DATA,
        payload: { countOnly: true },
        sessionId: this.sessionId,
        timestamp: Date.now()
      }, 5000);
      if (countRes?.error || countRes?.count === undefined) {
        throw new Error(countRes?.error || "No Excel data found for execution via extension proxy.");
      }
      const totalRows = countRes.count;

      // 3. Mutex check and state initialization
      let state;
      const isResume = currentState && currentState.sessionId === sessionId && (
        currentState.status === ExecutionStatus.RUNNING ||
        currentState.status === ExecutionStatus.PAUSED ||
        currentState.status === ExecutionStatus.CAPTCHA_PAUSED
      );

      if (isResume) {
        state = await StateManager.updateState({ status: ExecutionStatus.RUNNING }) || currentState;
        logger.debug('Executor', 'Re-using existing active session state for auto-resume:', state);
      } else {
        state = await StateManager.initializeSession(
          this.sessionId,
          totalRows,
          recordingId,
          this.siteUrl,
          tabId
        );
        logger.info('Executor', 'Session initialized with state:', state);
      }

      // If we are starting from the very beginning (row 0, step 0), ensure we have a clean start URL page
      const resetDoneKey = `__fp_reset_done_${this.sessionId}`;
      if (
        state &&
        state.currentRowIndex === 0 &&
        state.currentStepIndex === 0 &&
        this.siteUrl &&
        sessionStorage.getItem(resetDoneKey) !== 'true'
      ) {
        let urlsMatch = false;
        try {
          const currentUrlObj = new URL(window.location.href);
          const siteUrlObj = new URL(this.siteUrl);
          if (currentUrlObj.hostname === siteUrlObj.hostname && currentUrlObj.pathname === siteUrlObj.pathname) {
            urlsMatch = true;
          }
        } catch (e) {
          logger.warn('Executor', 'URL parsing failed during fresh start URL check:', e);
        }

        if (!urlsMatch) {
          logger.info('Executor', `Fresh start detected. Ensuring clean start URL: ${this.siteUrl}`);
          sessionStorage.setItem(resetDoneKey, 'true');

          const updatedState = await StateManager.updateState({ currentUrl: this.siteUrl });
          if (updatedState) {
            await this.safeSendMessage({
              type: MessageType.SET_EXECUTION_STATE,
              payload: { state: updatedState },
              sessionId: this.sessionId,
              timestamp: Date.now()
            }, 5000);
          }
          await this.logBatcher.flushNow();
          window.location.href = this.siteUrl;
          return; // Execution resumes on new page load via checkAutoResume
        } else {
          logger.info('Executor', 'Already at start URL. Skipping page reload to preserve state.');
          sessionStorage.setItem(resetDoneKey, 'true');
        }
      }

      // Send initial state update (status is RUNNING)
      this.broadcastStateUpdate(state);

      // 4. Start the main execution loop
      await this.runAllRows(totalRows);

    } catch (err: any) {
      logger.error('Executor', "Execution failed to start:", err);
      this.handleFatalError(err.message);
    }
  }

  // ─── MAIN EXECUTION LOOP ───────────────────────────────────────────
  // Processes ALL rows sequentially in a single JS context.
  // Between rows, resets the form by dismissing success modals and
  // navigating back to the form's initial state.
  // ─────────────────────────────────────────────────────────────────────

  private async runAllRows(totalRows: number) {
    try {
      await this._runAllRowsImpl(totalRows);
    } catch (err: any) {
      // BUG-002: Catch errors from chunk loading, state updates, etc.
      logger.error('Executor', 'runAllRows fatal error:', err);
      this.handleFatalError(err.message || 'Unexpected error in execution loop.');
    }
  }

  private async _runAllRowsImpl(totalRows: number) {
    let state = (await StateManager.getState()) || this.createFallbackState(totalRows);

    let excelRows: ExcelRow[] = [];
    let currentChunkStart = -1;  // Which logical row index this chunk starts at
    // Track the IDB rowIndex of the last row in the current chunk so we can
    // use it as the cursor boundary for the next chunk.  IDB keys (rowIndex)
    // are NOT the same as the 0-based loop counter (rowIdx) — they are
    // Excel-row-number-based (i + 2) and may have gaps from skipped blank rows.
    let lastLoadedRowIndex: number | undefined = undefined;

    for (let rowIdx = state.currentRowIndex; rowIdx < totalRows; rowIdx++) {
      if (!this.isRunning) break;

      // Load chunk if needed
      const neededChunkStart = Math.floor(rowIdx / EXCEL_CHUNK_SIZE) * EXCEL_CHUNK_SIZE;
      if (currentChunkStart !== neededChunkStart) {
        // For the first chunk, start from the beginning (afterRowIndex = undefined).
        // For subsequent chunks, use the actual IDB rowIndex of the last row in
        // the previous chunk as the cursor lower bound.
        const afterRowIndex = neededChunkStart > 0 ? lastLoadedRowIndex : undefined;
        const chunkRes = await this.safeSendMessage({
          type: MessageType.GET_EXCEL_DATA,
          payload: { afterRowIndex, limit: EXCEL_CHUNK_SIZE },
          sessionId: this.sessionId,
          timestamp: Date.now()
        }, 5000);
        if (chunkRes?.error || !chunkRes?.excelRows) {
          const isDecryptFailure = typeof chunkRes?.error === 'string' &&
            (chunkRes.error.toLowerCase().includes('decrypt') || chunkRes.error.toLowerCase().includes('keyversion'));
          if (isDecryptFailure) {
            // Same recovery StorageManager/executionSlice's pre-scan already does — mirror it here so a
            // failure mid-run leaves things in the same clean, re-uploadable state as a failure at the start.
            await this.safeSendMessage({
              type: MessageType.SET_EXCEL_DATA,
              payload: { excelRows: [], updateOnly: false },
              sessionId: this.sessionId,
              timestamp: Date.now()
            }, 5000).catch(() => {});
            throw new Error("Your spreadsheet data could not be decrypted and has been cleared. Please re-upload your Excel file and restart.");
          }
          throw new Error(chunkRes?.error || "Failed to load Excel row chunk.");
        }
        excelRows = chunkRes.excelRows;
        currentChunkStart = neededChunkStart;
        // Remember the last row's IDB key for next chunk boundary
        if (excelRows.length > 0) {
          lastLoadedRowIndex = excelRows[excelRows.length - 1].rowIndex;
        }
      }

      const chunkIndex = rowIdx - currentChunkStart;
      if (chunkIndex < 0 || chunkIndex >= excelRows.length) {
        logger.warn('Executor', `Excel chunk misaligned for row ${rowIdx}; reloading aligned chunk.`);
        currentChunkStart = -1;
        rowIdx--;
        continue;
      }

      const row = excelRows[chunkIndex];
      if (!row) {
        throw new Error(`Row ${rowIdx} not found in loaded chunk.`);
      }

      // Skip already-completed rows (from previous partial runs)
      if (row.status === RowStatus.SUCCESS || row.status === RowStatus.SKIPPED) {
        // BUG-041: Reconcile counters — if a page reload persisted the row status
        // to IndexedDB but the completedRows/skippedRows counter in state wasn't
        // saved yet, the counter falls behind. Fix by counting skipped-but-done rows.
        const skipUpdates: Partial<ExecutionState> = {
          currentRowIndex: rowIdx + 1,
          currentStepIndex: 0
        };
        const totalProcessed = state.completedRows + state.failedRows + state.skippedRows;
        if (totalProcessed < rowIdx + 1) {
          if (row.status === RowStatus.SUCCESS) {
            skipUpdates.completedRows = state.completedRows + 1;
          } else {
            skipUpdates.skippedRows = state.skippedRows + 1;
          }
        }
        state = await StateManager.updateState(skipUpdates);
        this.broadcastStateUpdate(state);
        continue;
      }

      // Process this row
      logger.info('Executor', `Processing row index: ${row.rowIndex} (${rowIdx + 1} of ${totalRows})`);

      // Pre-row health check for rowIdx > 0: ensure we are at siteUrl and initial input is ready
      if (rowIdx > 0 && this.siteUrl) {
        let isAtStartUrl = true;
        try {
          const currentUrlObj = new URL(window.location.href);
          const siteUrlObj = new URL(this.siteUrl);
          if (currentUrlObj.hostname !== siteUrlObj.hostname || currentUrlObj.pathname !== siteUrlObj.pathname) {
            isAtStartUrl = false;
          }
        } catch (e) {
          logger.warn('Executor', 'URL check failed before row execution:', e);
        }

        const firstStep = this.recordingSteps[0];
        let isFirstStepReady = false;
        if (firstStep) {
          const found = SelectorEngine.findElement(firstStep.selectorMeta, firstStep.selector);
          if (found && this.formResetter.isElementVisible(found.element as HTMLElement)) {
            isFirstStepReady = true;
          }
        } else {
          isFirstStepReady = true;
        }

        if (!isAtStartUrl || !isFirstStepReady) {
          logger.info('Executor', `Pre-row check failed for row ${rowIdx + 1}: isAtStartUrl=${isAtStartUrl}, isFirstStepReady=${isFirstStepReady}. Resetting form/redirecting...`);
          await this.resetFormBetweenRows();
          await this.logBatcher.flushNow();
        }
      }

      const rowResult = await this.executeRow(row, state);

      if (rowResult === "ABORTED") return;

      state = (await StateManager.getState()) || state;

      // Update counters based on result
      const updates: Partial<ExecutionState> = {
        currentRowIndex: rowIdx + 1,
        currentStepIndex: 0,
        pageRetryCount: 0 // Reset page retries for the next row
      };

      if (rowResult === "SUCCESS") {
        updates.completedRows = state.completedRows + 1;
        row.status = RowStatus.SUCCESS;
      } else if (rowResult === "SKIPPED") {
        updates.skippedRows = state.skippedRows + 1;
        row.status = RowStatus.SKIPPED;
      } else {
        updates.failedRows = state.failedRows + 1;
        row.status = RowStatus.FAILED;
      }

      // Persist Excel row status back to IndexedDB via background proxy and await confirmation
      const setExcelRes = await this.safeSendMessage({
        type: MessageType.SET_EXCEL_DATA,
        payload: { excelRows: [row], updateOnly: true }, // Send only the updated row to be merged
        sessionId: this.sessionId,
        timestamp: Date.now()
      }, 5000);

      if (setExcelRes?.error) {
        logger.error('Executor', 'Failed to persist Excel status to IndexedDB:', setExcelRes.error);
        throw new Error(`Failed to persist Excel row status: ${setExcelRes.error}`);
      }

      // Update and broadcast state (authoritative checkpoint)
      state = await StateManager.updateState(updates);
      this.broadcastStateUpdate(state);

      // If more rows remain, reset the form for the next row
      if (rowIdx + 1 < totalRows && this.isRunning) {
        logger.debug('Executor', `Resetting form for row ${rowIdx + 2}...`);
        await this.resetFormBetweenRows();
        await this.logBatcher.flushNow();
        // After reset, wait for DOM to fully stabilize before starting next row
        await SmartWaitEngine.waitForDOMStability(WAIT_DOM_STABLE_TIMEOUT).catch((err) => {
          logger.debug('Executor', `Post-reset DOM stability wait timed out: ${err.message}`);
        });
      }
    }

    // Mark completion
    if (this.isRunning) {
      await this.completeExecution();
    }
  }

  // ─── FORM RESET BETWEEN ROWS (delegates to FormResetter) ───────────

  private async resetFormBetweenRows(): Promise<void> {
    return this.formResetter.resetFormBetweenRows(this.recordingSteps, this.siteUrl, this.sessionId);
  }

  async dismissSuccessUI(): Promise<boolean> {
    return this.formResetter.dismissSuccessUI();
  }

  // ─── SINGLE ROW EXECUTION ──────────────────────────────────────────

  private async executeRow(row: ExcelRow, state: ExecutionState): Promise<"SUCCESS" | "FAILED" | "SKIPPED" | "ABORTED"> {
    logger.debug('Executor', `Processing row index: ${row.rowIndex}`);

    let isRowSkipped = false;
    let stepIndex = state.currentStepIndex;

    while (stepIndex < this.recordingSteps.length) {
      if (!this.isRunning) return "ABORTED";
      state = (await StateManager.getState()) || state;

      // Handle pause state
      if (this.isPaused) {
        state = await StateManager.updateState({ status: ExecutionStatus.PAUSED });
        this.broadcastStateUpdate(state);
        while (this.isPaused && this.isRunning) {
          await new Promise(r => setTimeout(r, 200));
        }
        if (!this.isRunning) return "ABORTED";

        // Post-Resume Recovery: Flush active element events & wait for portal calculations
        if (document.activeElement && document.activeElement !== document.body) {
          const activeEl = document.activeElement as HTMLElement;
          if (['INPUT', 'SELECT', 'TEXTAREA'].includes(activeEl.tagName)) {
            dispatchEvents(activeEl, ["change", "blur"]);
            activeEl.blur();
          }
        }

        await SmartWaitEngine.waitForDOMStability(500).catch((err) => {
          logger.debug('Executor', `Post-resume DOM stability wait finished/timed out: ${err.message}`);
        });

        state = await StateManager.updateState({ status: ExecutionStatus.RUNNING });
        this.broadcastStateUpdate(state);
      }

      const step = this.recordingSteps[stepIndex];

      // Page Retry Threshold Check
      if (state.pageRetryCount >= MAX_PAGE_RETRIES) {
        logger.error('Executor', `Page retry ceiling (${MAX_PAGE_RETRIES}) exceeded for step ${step.id}. Aborting row.`);
        await this.logStepFailure(row.rowIndex, step, new Error("Page retry limit exceeded."));
        return "FAILED";
      }

      // Human-like pacing delay
      await new Promise(r => setTimeout(r, this.stepDelay));

      // After navigation/page-transition clicks, wait for DOM to stabilize before proceeding
      // This handles SPA wizard transitions where sections toggle visibility
      if (stepIndex > 0) {
        const prevStep = this.recordingSteps[stepIndex - 1];
        if (prevStep && (prevStep.action === Action.CLICK || prevStep.action === Action.NAVIGATE_NEXT)) {
          let shouldWait = prevStep.action === Action.NAVIGATE_NEXT;
          
          if (!shouldWait) {
            const prevEl = SelectorEngine.findElement(prevStep.selectorMeta, prevStep.selector);
            if (prevEl) {
              const tagName = (prevEl.element as HTMLElement).tagName?.toLowerCase();
              const textContent = (prevEl.element as HTMLElement).textContent?.toLowerCase() || '';
              shouldWait = tagName === 'button' || tagName === 'a' ||
                (prevEl.element as HTMLElement).getAttribute('role') === 'button' ||
                textContent.includes('next') || textContent.includes('continue') ||
                textContent.includes('submit') || textContent.includes('proceed');
            }
          }

          if (shouldWait) {
            logger.debug('Executor', `Post-navigation DOM stability wait after step: ${prevStep.id}`);
            await SmartWaitEngine.waitForDOMStability(WAIT_DOM_STABLE_TIMEOUT).catch((err) => {
              logger.debug('Executor', `Post-navigation stability wait timed out: ${err.message}`);
            });
          }
        }
      }

      // Mid-step CAPTCHA Check
      const captchaResult = await ResponseDetectionEngine.handleCaptchaIfPresent(this.sessionId);
      if (captchaResult === "TIMEOUT") {
        await this.logStepFailure(row.rowIndex, step, new Error("CAPTCHA timeout mid-step."));
        return "FAILED";
      }

      // 1. Run Step execution via RetryEngine
      const startTime = Date.now();
      const res = await RetryEngine.executeStepWithRetry(step, row.data);
      const duration = Date.now() - startTime;

      if (!this.isRunning) return "ABORTED";

      if (res.success) {
        // Step completed successfully (or optionally skipped)
        const logStatus: LogStatus = (res.resolvedStatus as LogStatus) || "FILLED";
        const resultType = logStatus === "STEP_SKIPPED" ? StepResult.SKIPPED : StepResult.SUCCESS;

        this.logBatcher.enqueue({
          id: this.generateUUID(),
          sessionId: this.sessionId,
          timestamp: Date.now(),
          rowIndex: row.rowIndex,
          stepId: step.id,
          action: step.action,
          selector: step.selector,
          selectorStrategy: res.selectorStrategy,
          value: logStatus === "STEP_SKIPPED" ? undefined : res.resolvedValue ?? step.value,
          result: resultType,
          status: logStatus,
          retryCount: res.retriesUsed,
          duration
        });

        // 2. Perform immediate inline error validation check
        const selectorResult = SelectorEngine.findElement(step.selectorMeta, step.selector);
        if (selectorResult) {
          const inlineErr = ResponseDetectionEngine.detectInlineError(selectorResult.element as HTMLElement);
          if (inlineErr) {
            this.logBatcher.enqueue({
              id: this.generateUUID(),
              sessionId: this.sessionId,
              timestamp: Date.now(),
              rowIndex: row.rowIndex,
              stepId: step.id,
              action: step.action,
              selector: step.selector,
              result: StepResult.FAILED,
              status: "WARN",
              error: `Inline field error: ${inlineErr}`,
              retryCount: 0,
              duration: 0
            });
          }
        }

        // Reset page retries on successful page transition
        if (step.action === Action.NAVIGATE_NEXT) {
          state = await StateManager.updateState({ pageRetryCount: 0 });
        }

        stepIndex++;

        // 3. Save state Checkpoint after every successful step
        state = await StateManager.updateState({
          currentStepIndex: stepIndex,
          lastStepResult: res.resolvedStatus || "SUCCESS"
        });
        this.broadcastStateUpdate(state);

      } else {
        // Step execution failed after retries
        if (res.classification === ErrorClassification.FATAL) {
          if (res.resolvedStatus === "ROW_SKIPPED") {
            // Option 1: Missing column / required value skip
            this.logBatcher.enqueue({
              id: this.generateUUID(),
              sessionId: this.sessionId,
              timestamp: Date.now(),
              rowIndex: row.rowIndex,
              stepId: step.id,
              action: step.action,
              selector: step.selector,
              result: StepResult.SKIPPED,
              status: "ROW_SKIPPED",
              error: res.error?.message,
              retryCount: res.retriesUsed,
              duration
            });
            isRowSkipped = true;
            break; // Break step loop to advance to next row
          } else {
            // Option 2: Unrecoverable context destroyed / network error
            this.handleFatalError(res.error?.message || "Unrecoverable FATAL step execution error.");
            return "ABORTED";
          }
        } else {
          // Escalates to page retry increment
          const isOverCap = await StateManager.incrementPageRetry(MAX_PAGE_RETRIES);
          state = (await StateManager.getState()) || state;

          if (isOverCap) {
            const detailMsg = res.error?.message ? `Page retry cap exceeded: ${res.error.message}` : "Page retry cap exceeded.";
            await this.logStepFailure(row.rowIndex, step, new Error(detailMsg));
            return "FAILED";
          } else {
            // Within retry limit: wait for DOM to stabilize and retry this same step
            await SmartWaitEngine.waitForDOMStability(5000).catch((err) => {
              logger.debug('Executor', `Retry DOM stability wait timed out: ${err.message}`);
            });
          }
        }
      }
    }

    if (isRowSkipped) {
      return "SKIPPED";
    }

    // Delegate the Safe Submit-Verification Engine to SubmitVerifier — see
    // src/content/SubmitVerifier.ts for the full retry/detection sequence.
    return this.submitVerifier.verifySubmission(this.recordingSteps, row, this.sessionId);
  }

  // ─── COMPLETION ────────────────────────────────────────────────────

  /**
   * Marks the execution session as complete, releases the mutex, and cleans up.
   */
  private async completeExecution() {
    await this.logBatcher.flushNow();
    
    const finalState = await StateManager.updateState({
      status: ExecutionStatus.COMPLETE,
      mutexLock: null // Release Mutex
    });
    this.broadcastStateUpdate(finalState);

    sendToBackground({
      type: MessageType.EXECUTION_COMPLETE,
      sessionId: this.sessionId,
      payload: { state: finalState },
      timestamp: Date.now()
    });

    this.cleanup();
  }

  // ─── EXECUTION CONTROLS ────────────────────────────────────────────

  async pause() {
    this.isPaused = true;
    logger.info('Executor', 'Paused.');
    const state = await StateManager.updateState({ status: ExecutionStatus.PAUSED });
    if (state) {
      this.broadcastStateUpdate(state);
    }
  }

  async resume() {
    this.isPaused = false;
    // Broadcast message to Service Worker so badge clears immediately on resume
    sendToBackground({
      type: MessageType.CLEAR_BADGE,
      sessionId: this.sessionId,
      payload: {},
      timestamp: Date.now()
    }).catch((err) => {
      logger.warn('Executor', 'CLEAR_BADGE message failed:', err);
    });

    // Resolve any pending CAPTCHA promise
    ResponseDetectionEngine.forceResolveCaptcha();

    logger.info('Executor', 'Resumed.');

    const state = await StateManager.updateState({ status: ExecutionStatus.RUNNING });
    if (state) {
      this.broadcastStateUpdate(state);
    }
  }

  async abort() {
    logger.warn('Executor', 'Aborting...');
    this.isRunning = false;
    this.isPaused = false;

    const finalState = await StateManager.getState();
    if (finalState) {
      // Broadcast the abort state to popup before clearing
      this.broadcastStateUpdate({
        ...finalState,
        status: ExecutionStatus.IDLE,
        mutexLock: null
      });
    }

    await this.logBatcher.flushNow();
    await StateManager.clearSession();
    this.cleanup();
  }

  // ─── ERROR HANDLING & LOGGING ──────────────────────────────────────

  private async handleFatalError(errMsg: string) {
    logger.error('Executor', `FormPilot Fatal Error: ${errMsg}`);
    this.isRunning = false;
    this.isPaused = false;

    const state = await StateManager.getState();
    if (state) {
      const failedState = {
        ...state,
        status: ExecutionStatus.FAILED,
        mutexLock: null // Release Mutex
      };

      // Save log entry for the fatal error to IndexedDB so it shows in popup terminal
      this.logBatcher.enqueue({
        id: this.generateUUID(),
        sessionId: this.sessionId,
        timestamp: Date.now(),
        rowIndex: state.currentRowIndex,
        stepId: "SYSTEM",
        action: Action.WAIT,
        selector: "executor",
        result: StepResult.FAILED,
        status: "FAILED",
        error: errMsg,
        retryCount: 0,
        duration: 0
      });
      await this.logBatcher.flushNow();

      this.broadcastStateUpdate(failedState);

      // Notify service worker to clear badge icon
      sendToBackground({
        type: MessageType.EXECUTION_COMPLETE,
        sessionId: this.sessionId,
        payload: { state: failedState },
        timestamp: Date.now()
      }).catch((err) => {
        logger.warn('Executor', 'Failed to notify service worker about fatal execution completion:', err);
      });
    }

    await StateManager.clearSession();
    this.cleanup();
  }

  private async logStepFailure(rowIndex: number, step: Step, err: Error) {
    await this.safeSendMessage({
      type: MessageType.ADD_LOG_ENTRY,
      payload: {
        entry: {
          id: this.generateUUID(),
          sessionId: this.sessionId,
          timestamp: Date.now(),
          rowIndex,
          stepId: step.id,
          action: step.action,
          selector: step.selector,
          result: StepResult.FAILED,
          status: "FAILED",
          error: err.message,
          retryCount: 0,
          duration: 0
        }
      },
      sessionId: this.sessionId,
      timestamp: Date.now()
    }, 2000);
  }

  // ─── UTILITIES ─────────────────────────────────────────────────────

  private broadcastStateUpdate(state: ExecutionState) {
    sendToBackground({
      type: MessageType.STATE_UPDATE,
      sessionId: this.sessionId,
      payload: { state },
      timestamp: Date.now()
    }).catch((err: Error) => {
      // BUG-031: Only silence expected "no listener" errors when popup is closed;
      // log unexpected errors for debuggability
      const msg = err?.message?.toLowerCase() || '';
      if (!msg.includes('receiving end does not exist') && !msg.includes('no listener')) {
        logger.warn('Executor', `broadcastStateUpdate error: ${err.message}`);
      }
    });
  }

  private cleanup() {
    this.isRunning = false;
    this.isPaused = false;
    this.recordingSteps = [];
    ResponseDetectionEngine.removeCaptchaOverlay();
  }

  private createFallbackState(totalRows: number): ExecutionState {
    return {
      sessionId: this.sessionId,
      currentRowIndex: 0,
      currentStepIndex: 0,
      currentPageId: "",
      status: ExecutionStatus.RUNNING,
      totalRows,
      completedRows: 0,
      failedRows: 0,
      skippedRows: 0,
      pageRetryCount: 0,
      mutexLock: null,
      captchaPending: false,
      tabContext: -1,
      lastStepResult: ""
    };
  }

  private generateUUID(): string {
    return generateUUID();
  }
}

// Instantiate and bind to content script context with singleton guard
if (typeof window !== 'undefined' && !(globalThis as any).__FP_EXECUTOR_INIT__) {
  (globalThis as any).__FP_EXECUTOR_INIT__ = true;
  new Executor();
}
