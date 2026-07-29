/**
 * Loop D.4: typed accessor for the Executor's live running/paused state.
 *
 * SmartWaitEngine and RetryEngine need to check abort/pause status mid-loop.
 * They call getExecutionContext() which reads from the single existing global
 * `__FP_EXECUTOR_INSTANCE__`, avoiding raw `(globalThis as any)` casts across
 * engine modules without introducing a second global.
 */
export interface ExecutionContext {
  isRunning: boolean;
  isPaused: boolean;
}

export function getExecutionContext(): ExecutionContext | undefined {
  return (globalThis as any).__FP_EXECUTOR_INSTANCE__;
}
