import { SelectStrategy } from "./SelectStrategy";
import { setSelectValue } from "../../domUtils";
import { SmartWaitEngine } from "../SmartWaitEngine";
import { logger } from "../../../utils/logger";

export class NativeSelectStrategy implements SelectStrategy {
  readonly name = "NativeSelectStrategy";

  matches(el: HTMLElement): boolean {
    return el instanceof HTMLSelectElement;
  }

  async execute(el: HTMLElement, value: string): Promise<void> {
    const select = el as HTMLSelectElement;
    const matchResult = setSelectValue(select, value);

    if (matchResult) {
      logger.info(
        "NativeSelectStrategy",
        `Matched "${value}" using strategy ${matchResult.strategy} (${matchResult.confidence}%) -> "${matchResult.matchedText}"`
      );
    }

    await SmartWaitEngine.waitForDOMStability(1000).catch((err) => {
      logger.debug("NativeSelectStrategy", `DOM stability wait timed out: ${err.message}`);
    });

    // Readback verification
    if (value && !select.value) {
      throw new Error(`Select element remained unselected after fill attempt.`);
    }
  }
}
