import { Action, ExcelRow, MessageType, Step, StepResult } from "../types";
import { RetryEngine } from "./engines/RetryEngine";
import { SmartWaitEngine } from "./engines/SmartWaitEngine";
import { ResponseDetectionEngine } from "./engines/ResponseDetectionEngine";
import { MAX_SUBMIT_RETRIES, POST_SUBMIT_SETTLE_MS, SUBMIT_RETRY_SETTLE_MS } from "../shared/constants";
import { logger } from "../utils/logger";
import { generateUUID } from "../utils/uuid";

type SendMessageFn = (message: any, timeoutMs?: number) => Promise<any>;

interface SubmitVerifierDeps {
  isRunning: () => boolean;
  sendMessage: SendMessageFn;
}

/**
 * Loop D extraction (2026-07-20): owns the Safe Submit-Verification Engine
 * (SSVE) block, pulled out of Executor.executeRow() per
 * FormPilot_Loop_D_Executor_Refactor_Plan_2026-07-20.md.
 *
 * After all recorded steps complete, verifies the submission outcome. If the
 * page is stuck (no success, no failure, no navigation), safely retries the
 * submit action up to MAX_SUBMIT_RETRIES times. NEVER retries when validation
 * errors are visible (useless) or when success is detected (would cause
 * duplicate submissions).
 */
export class SubmitVerifier {
  constructor(private readonly deps: SubmitVerifierDeps) {}

  async verifySubmission(
    recordingSteps: Step[],
    row: ExcelRow,
    sessionId: string
  ): Promise<"SUCCESS" | "FAILED" | "ABORTED"> {
    const preSubmitUrl = window.location.href;
    let submitRetryCount = 0;
    let finalOutcome: "SUCCESS" | "FAILED" | "UNKNOWN" = "UNKNOWN";
    let failureReason = "Submission failure detected on page (error banners or validation errors visible).";

    while (submitRetryCount <= MAX_SUBMIT_RETRIES) {
      if (!this.deps.isRunning()) return "ABORTED";

      // 1. Wait for DOM to stabilize after submit
      const settleMs = submitRetryCount === 0
        ? POST_SUBMIT_SETTLE_MS
        : SUBMIT_RETRY_SETTLE_MS;
      await SmartWaitEngine.waitForDOMStability(settleMs).catch((err) => {
        logger.debug('SubmitVerifier', `Post-submit DOM stability wait timed out: ${err.message}`);
      });

      // 2. Run full detection (CAPTCHA + success + failure)
      finalOutcome = await ResponseDetectionEngine.runSubmissionDetection(
        window.location.href,
        sessionId
      );

      // 3. Definitive outcome — stop immediately
      if (finalOutcome === "SUCCESS" || finalOutcome === "FAILED") {
        break;
      }

      // 4. Check if the URL changed (navigation occurred) — treat as success
      if (window.location.href !== preSubmitUrl) {
        logger.debug('SubmitVerifier', `URL changed after submit (${preSubmitUrl} → ${window.location.href}), treating as SUCCESS.`);
        finalOutcome = "SUCCESS";
        break;
      }

      // 5. UNKNOWN outcome — page is stuck. Attempt safe retry if budget remains.
      if (submitRetryCount < MAX_SUBMIT_RETRIES) {
        submitRetryCount++;
        logger.warn('SubmitVerifier', `Submit verification inconclusive — page stuck on same URL. Safe retry ${submitRetryCount}/${MAX_SUBMIT_RETRIES}...`);

        // Find and re-click the last submit/click/navigate step
        const lastStep = recordingSteps[recordingSteps.length - 1];
        if (lastStep) {
          const retryRes = await RetryEngine.executeStepWithRetry(lastStep, row.data);
          if (!retryRes.success) {
            logger.warn('SubmitVerifier', `Submit retry step failed: ${retryRes.error?.message}`);
            
            // If the element is not found, it likely means the form submitted and the page changed state!
            if (retryRes.error?.message.toLowerCase().includes('not found') || retryRes.error?.message.toLowerCase().includes('timeout')) {
              logger.debug('SubmitVerifier', 'Retry failed because submit button is missing. Treating as SUCCESS.');
              finalOutcome = "SUCCESS";
            } else {
              finalOutcome = "FAILED";
              failureReason = `Submit retry failed: ${retryRes.error?.message}`;
            }
            break;
          }
        }
      } else {
        // Budget exhausted — treat as success if all steps completed
        // (many forms simply don't show success banners)
        break;
      }
    }

    // If all recorded steps completed successfully and no explicit failure was
    // detected on the page, treat the row as SUCCESS.  The old logic treated
    // "UNKNOWN" (no success banner AND no failure banner) as FAILED, which
    // incorrectly failed every row on forms that don't render a success modal.
    const isRowSuccess = finalOutcome !== "FAILED";

    // Only log a page_summary entry when the detection found an actual failure,
    // so it doesn't pollute the logs with misleading "Submission check returned FAILED" entries.
    if (!isRowSuccess) {
      await this.deps.sendMessage({
        type: MessageType.ADD_LOG_ENTRY,
        payload: {
          entry: {
            id: generateUUID(),
            sessionId,
            timestamp: Date.now(),
            rowIndex: row.rowIndex,
            stepId: "row_summary",
            action: Action.SUBMIT,
            selector: "page_summary",
            result: StepResult.FAILED,
            status: "FAILED",
            error: failureReason,
            retryCount: 0,
            duration: 0
          }
        },
        sessionId,
        timestamp: Date.now()
      }, 2000);
    }

    return isRowSuccess ? "SUCCESS" : "FAILED";
  }
}
