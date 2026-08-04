import { SelectStrategy } from "./select-strategies/SelectStrategy";
import { NativeSelectStrategy } from "./select-strategies/NativeSelectStrategy";
import { AntDSelectStrategy } from "./select-strategies/AntDSelectStrategy";

const strategies: SelectStrategy[] = [
  new AntDSelectStrategy(),   // Specific component strategies first
  new NativeSelectStrategy(), // Native <select> fallback
];

export class SelectStrategyResolver {
  static resolve(el: HTMLElement): SelectStrategy | null {
    for (const strategy of strategies) {
      if (strategy.matches(el)) {
        return strategy;
      }
    }
    return null;
  }
}
