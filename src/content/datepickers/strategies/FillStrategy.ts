import { FieldDetectionResult } from "../FieldDetector";

export interface FillStrategy {
  readonly name: string;

  /**
   * Executes the fill strategy on the given element with the resolved value.
   * Returns true if fill and verification succeeded, or false if it failed.
   */
  execute(el: HTMLElement, rawValue: string, detection: FieldDetectionResult): Promise<boolean>;
}
