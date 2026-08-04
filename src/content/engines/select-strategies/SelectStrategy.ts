export interface SelectStrategy {
  readonly name: string;
  matches(el: HTMLElement): boolean;
  execute(el: HTMLElement, value: string): Promise<void>;
}
