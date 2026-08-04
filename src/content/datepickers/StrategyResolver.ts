import { FillStrategy } from "./strategies/FillStrategy";
import { NativeDateStrategy } from "./strategies/NativeDateStrategy";
import { DatePickerStrategy } from "./strategies/DatePickerStrategy";
import { DefaultTextStrategy } from "./strategies/DefaultTextStrategy";
import { FieldDetectionResult } from "./FieldDetector";
import { logger } from "../../utils/logger";

export class StrategyResolver {
  private static nativeDateStrategy = new NativeDateStrategy();
  private static datePickerStrategy = new DatePickerStrategy();
  private static defaultTextStrategy = new DefaultTextStrategy();

  /**
   * Resolves the best FillStrategy based on the field detection results.
   */
  static resolve(detection: FieldDetectionResult): FillStrategy {
    if (detection.isNativeDate) {
      logger.debug("StrategyResolver", "Resolved NativeDateStrategy");
      return this.nativeDateStrategy;
    }

    if (detection.isCustomDatePicker) {
      logger.debug("StrategyResolver", "Resolved DatePickerStrategy");
      return this.datePickerStrategy;
    }

    logger.debug("StrategyResolver", "Resolved DefaultTextStrategy");
    return this.defaultTextStrategy;
  }
}
