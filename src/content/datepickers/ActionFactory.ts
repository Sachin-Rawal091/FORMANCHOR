import { Action } from "../../types";
import { FieldDetectionResult } from "./FieldDetector";

export interface ResolvedActionDetails {
  action: Action;
  expectedType?: "text" | "number" | "date" | "boolean";
  metadata?: Record<string, unknown>;
}

export class ActionFactory {
  /**
   * Resolves the appropriate Action enum and semantic metadata based on FieldDetector results.
   */
  static resolveAction(detection: FieldDetectionResult, rawAction: Action): ResolvedActionDetails {
    if ((detection.isNativeDate || detection.isCustomDatePicker) && rawAction !== Action.CLICK && rawAction !== Action.SUBMIT) {
      return {
        action: Action.DATEPICKER,
        expectedType: "date",
        metadata: {
          fieldType: "date",
          framework: detection.adapter ? detection.adapter.name : detection.isNativeDate ? "native" : "custom",
          isNative: detection.isNativeDate,
          score: detection.score,
        },
      };
    }

    return {
      action: rawAction,
      expectedType: undefined,
    };
  }
}
