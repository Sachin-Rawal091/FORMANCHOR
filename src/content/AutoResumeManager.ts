import { ExecutionStatus } from "../types";
import { StateManager } from "./engines/StateManager";
import { loadAndApplyUserSettings } from "../utils/settingsLoader";
import { logger } from "../utils/logger";

interface AutoResumeCallbacks {
  isRunning: () => boolean;
  setStepDelay: (delay: number) => void;
  startExecution: (recordingId: string, sessionId: string) => Promise<void>;
}

/**
 * Loop D extraction (2026-07-20): owns the on-load auto-resume check, pulled
 * out of Executor per FormPilot_Loop_D_Executor_Refactor_Plan_2026-07-20.md.
 * Talks back to Executor only through the injected callbacks — it never
 * reaches into Executor's private fields directly.
 */
export class AutoResumeManager {
  private _inProgress = false;

  constructor(private readonly callbacks: AutoResumeCallbacks) {}

  /** True while a checkAutoResume() pass is still deciding whether to resume. */
  get inProgress(): boolean {
    return this._inProgress;
  }

  async checkAutoResume(): Promise<void> {
    this._inProgress = true;
    try {
      // Wait a bit to ensure state is settled from any background syncs
      await new Promise(r => setTimeout(r, 500));

      // Guard: Do not resume if execution has already been actively triggered via messages
      if (this.callbacks.isRunning()) {
        logger.debug('AutoResumeManager', 'checkAutoResume: Execution already running, skipping auto-resume.');
        this._inProgress = false;
        return;
      }

      try {
        const state = await StateManager.getState();
        if (state && state.status === ExecutionStatus.RUNNING && state.recordingId && state.sessionId) {
          // BUG-034: Early hostname guard — only proceed if we're on the right domain
          const expectedHost = state.siteUrl ? new URL(state.siteUrl).hostname : null;
          if (expectedHost && window.location.hostname !== expectedHost) {
            logger.debug('AutoResumeManager', `Auto-resume skipped: wrong domain. Expected: ${expectedHost}, Current: ${window.location.hostname}`);
            this._inProgress = false;
            return;
          }

          // BUG-001: Only auto-resume if URL already matches — do NOT redirect.
          // Redirecting causes infinite navigation loops when the target page
          // immediately injects a new content script that auto-resumes again.
          if (state.currentUrl) {
            try {
              const currentUrlObj = new URL(window.location.href);
              const stateUrlObj = new URL(state.currentUrl);

              if (currentUrlObj.hostname !== stateUrlObj.hostname || currentUrlObj.pathname !== stateUrlObj.pathname) {
                // If we are at the start of a new row (step 0), we can still resume if we are on the siteUrl
                let canResume = false;
                if (state.currentStepIndex === 0 && state.siteUrl) {
                  try {
                    const siteUrlObj = new URL(state.siteUrl);
                    if (currentUrlObj.hostname === siteUrlObj.hostname && currentUrlObj.pathname === siteUrlObj.pathname) {
                      canResume = true;
                    }
                  } catch (e) {
                    logger.warn('AutoResumeManager', 'URL parsing failed during auto-resume siteUrl check:', e);
                  }
                }

                if (!canResume) {
                  logger.debug('AutoResumeManager', `Auto-resume skipped. Expected URL: ${stateUrlObj.pathname}, Current: ${currentUrlObj.pathname}`);
                  this._inProgress = false;
                  return;
                }
              }
            } catch (e) {
              this._inProgress = false;
              return;
            }
          }

          logger.info('AutoResumeManager', 'Auto-resuming from previous state...');

          // Load custom settings overrides from local storage
          const stepDelay = await loadAndApplyUserSettings();
          this.callbacks.setStepDelay(stepDelay);

          // Re-hydrate and start (will pick up from state.currentRowIndex)
          await this.callbacks.startExecution(state.recordingId, state.sessionId);
        }
      } catch (err) {
        logger.error('AutoResumeManager', 'Inner checkAutoResume error:', err);
      }
      this._inProgress = false;
    } catch (err) {
      this._inProgress = false;
      logger.error('AutoResumeManager', 'Failed auto-resume check', err);
    }
  }
}
