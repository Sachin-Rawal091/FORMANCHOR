import { Action, Step } from "../../types";
import { ExecutionEngine } from "./ExecutionEngine";
import { SmartWaitEngine } from "./SmartWaitEngine";
import { getExecutionContext } from "./executionContext";
import { InputVerifier } from "../InputVerifier";
import { logger } from "../../utils/logger";
import { WAIT_ELEMENT_TIMEOUT, MAX_STEP_RETRIES, RETRY_BACKOFF_BASE, RETRY_BACKOFF_MAX } from "../../shared/constants";

export enum ErrorClassification {
  SKIPPABLE,
  RETRYABLE,
  FATAL,
}

export interface StepExecutionResult {
  success: boolean;
  error?: Error;
  classification?: ErrorClassification;
  resolvedStatus?: string;
  retriesUsed: number;
  selectorStrategy?: number;
  resolvedValue?: string;
}

export class RetryEngine {
  static customSettings: {
    waitElementTimeout?: number;
    maxStepRetries?: number;
  } = {};

  /**
   * Orchestrates the execution of a single step with retry logic, backoff, and error classification.
   */
  static async executeStepWithRetry(
    step: Step,
    rowData: Record<string, any>
  ): Promise<StepExecutionResult> {
    
    // 1. Resolve variable
    const resolution = ExecutionEngine.resolveAndValidateValue(step, rowData);
    
    if (resolution.shouldSkipRow) {
      return {
        success: false,
        error: new Error(`Required column/value missing. Scenario resolved as ${resolution.status}.`),
        classification: ErrorClassification.FATAL, // Escalates to skip row in orchestrator
        resolvedStatus: resolution.status,
        retriesUsed: 0
      };
    }
    
    if (resolution.shouldSkipStep) {
      return {
        success: true, // skipped intentionally
        resolvedStatus: resolution.status,
        retriesUsed: 0,
        resolvedValue: resolution.value ?? undefined
      };
    }

    const maxRetries = step.maxRetries ?? RetryEngine.customSettings.maxStepRetries ?? MAX_STEP_RETRIES;
    let attempt = 0;
    let currentBackoff = RETRY_BACKOFF_BASE;

    while (attempt <= maxRetries) {
      const executorStart = getExecutionContext();
      if (executorStart && !executorStart.isRunning) {
        return {
          success: false,
          error: new Error("Execution aborted."),
          classification: ErrorClassification.FATAL,
          resolvedStatus: "FAILED",
          retriesUsed: attempt
        };
      }
      try {
        // 2. Find Element using SmartWait (which internally uses SelectorEngine 8-layer fallback)
        const selectorResult = await SmartWaitEngine.waitForElementVisible(
          step.selectorMeta,
          step.selector,
          RetryEngine.customSettings.waitElementTimeout ?? WAIT_ELEMENT_TIMEOUT
        );

        if (!selectorResult) {
          throw new Error("Element not found or not visible after timeout.");
        }

        // Check if the element is interactable (only for value-filling actions).
        // Click/Submit/Navigate actions bypass this check — matching old FormPilot behavior
        // where buttons were clicked directly without disabled-state validation.
        const el = selectorResult.element as HTMLElement;
        const isValueAction = [Action.FILL, Action.SELECT, Action.DATEPICKER, Action.SELECT_RADIO, Action.TOGGLE_CHECKBOX].includes(step.action);
        if (isValueAction && !RetryEngine.isElementInteractable(el)) {
          if (resolution.value !== null && resolution.value !== undefined) {
            let verification = InputVerifier.verify(el, resolution.value);

            // Fast dynamic poll for cold-start calculation delay (Row 1)
            if (!verification.pass) {
              const start = Date.now();
              const DYNAMIC_POLL_TIMEOUT_MS = 1500;
              const DYNAMIC_POLL_INTERVAL_MS = 100;

              while (Date.now() - start < DYNAMIC_POLL_TIMEOUT_MS) {
                await new Promise(r => setTimeout(r, DYNAMIC_POLL_INTERVAL_MS));
                verification = InputVerifier.verify(el, resolution.value);
                if (verification.pass) break;
              }
            }

            if (verification.pass) {
              logger.info(
                "RetryEngine",
                `Element is non-interactable (disabled/readonly), but contains verified expected value. Expected: "${verification.expected}" | Actual: "${verification.actual}" | Status: FILLED_READONLY`
              );
              return {
                success: true,
                resolvedStatus: "FILLED_READONLY",
                retriesUsed: attempt,
                selectorStrategy: selectorResult.strategy,
                resolvedValue: resolution.value ?? undefined
              };
            }
          }
          throw new Error("Element is disabled or non-interactable in the current page state.");
        }

        // 3. Execute Action
        await ExecutionEngine.executeAction(step, selectorResult, resolution.value);

        return {
          success: true,
          resolvedStatus: resolution.status,
          retriesUsed: attempt,
          selectorStrategy: selectorResult.strategy,
          resolvedValue: resolution.value ?? undefined
        };

      } catch (error: any) {
        if (error.message === "Execution aborted.") {
          return {
            success: false,
            error,
            classification: ErrorClassification.FATAL,
            resolvedStatus: "FAILED",
            retriesUsed: attempt
          };
        }
        const classification = this.classifyError(error, step);
        
        if (classification === ErrorClassification.FATAL) {
          return {
            success: false,
            error,
            classification,
            resolvedStatus: "FAILED",
            retriesUsed: attempt
          };
        }

        if (classification === ErrorClassification.SKIPPABLE) {
          return {
            success: true, // Skipping is a successful outcome for an optional step
            resolvedStatus: "STEP_SKIPPED",
            retriesUsed: attempt
          };
        }

        // Increment attempt AFTER classification — only for RETRYABLE errors
        attempt++;

        // If we reached max retries and it's still RETRYABLE, escalate
        if (attempt > maxRetries) {
          return {
            success: false,
            error: new Error(`Max retries (${maxRetries}) exceeded. Last error: ${error.message}`),
            classification: ErrorClassification.RETRYABLE, // Orchestrator handles pageRetryCount
            resolvedStatus: "FAILED",
            retriesUsed: attempt - 1
          };
        }

        // Apply backoff before next attempt
        const executorBefore = getExecutionContext();
        if (executorBefore && !executorBefore.isRunning) {
          throw new Error("Execution aborted.");
        }

        // Sleep in chunks of 200ms to remain responsive to pause/abort
        let slept = 0;
        while (slept < currentBackoff) {
          const executor = getExecutionContext();
          if (executor && !executor.isRunning) {
            throw new Error("Execution aborted.");
          }
          if (executor && executor.isPaused) {
            // While paused, do not increment slept, just wait
            await new Promise((r) => setTimeout(r, 200));
            continue;
          }
          await new Promise((r) => setTimeout(r, 200));
          slept += 200;
        }

        const executorAfter = getExecutionContext();
        if (executorAfter && !executorAfter.isRunning) {
          throw new Error("Execution aborted.");
        }

        currentBackoff = Math.min(currentBackoff * 2, RETRY_BACKOFF_MAX);
      }
    }

    return {
      success: false,
      error: new Error("Unexpected retry loop exit."),
      classification: ErrorClassification.FATAL,
      retriesUsed: attempt
    };
  }

  private static classifyError(error: Error, step: Step): ErrorClassification {
    const msg = error.message.toLowerCase();
    
    // Page crashed, network disconnected, execution context destroyed
    if (
      msg.includes("context was destroyed") || 
      msg.includes("network error") ||
      msg.includes("fatal")
    ) {
      return ErrorClassification.FATAL;
    }

    const isOptionalNonControlStep = step.required === false && !this.isControlAction(step);

    // Element not found/visible
    if (msg.includes("element not found") || msg.includes("timeout")) {
      if (isOptionalNonControlStep) {
        return ErrorClassification.SKIPPABLE;
      }
      return ErrorClassification.RETRYABLE;
    }

    // Optional fields may be skipped when disabled by upstream form choices, but
    // flow-control buttons must retry so confirmation/final-submit clicks are not lost.
    if (msg.includes("disabled") || msg.includes("non-interactable")) {
      if (isOptionalNonControlStep) {
        return ErrorClassification.SKIPPABLE;
      }
      return ErrorClassification.RETRYABLE;
    }

    // Default to retryable for unknown temporary errors (e.g., node detached from DOM)
    return ErrorClassification.RETRYABLE;
  }

  private static isControlAction(step: Step): boolean {
    return step.action === Action.CLICK ||
      step.action === Action.SUBMIT ||
      step.action === Action.NAVIGATE_NEXT;
  }

  private static isElementInteractable(el: HTMLElement): boolean {
    let current: HTMLElement | null = el;
    let depth = 0;
    while (current && current !== document.body && depth < 20) {
      const style = window.getComputedStyle(current);
      if (style.pointerEvents === "none") {
        return false;
      }
      
      const isDisabled = 
        current.hasAttribute("disabled") ||
        current.hasAttribute("readonly") ||
        (current as HTMLInputElement).readOnly ||
        current.getAttribute("aria-disabled") === "true" ||
        current.classList.contains("disabled") ||
        current.classList.contains("disabled_date_picker") ||
        (current === el && /disabled|readonly/i.test(current.className || ""));
        
      if (isDisabled) {
        return false;
      }
      
      current = current.parentElement;
      depth++;
    }
    return true;
  }
}
