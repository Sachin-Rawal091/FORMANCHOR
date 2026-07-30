/**
 * PURPOSE: In-memory Chrome API mocks for Vitest tests.
 * USED BY: All test files that use StorageManager, StateManager, or ResponseDetectionEngine.
 * MUST NOT: Import from any engine file (no circular deps).
 *
 * Usage:
 *   import { setupChromeMocks, resetChromeMocks } from './helpers/chromeMock';
 *   beforeEach(() => setupChromeMocks());
 *   afterEach(() => resetChromeMocks());
 */

import { disableActionSettleWait } from '../../src/content/engines/ExecutionEngine';

// In-memory stores simulating Chrome storage APIs
const sessionStore: Record<string, unknown> = {};
const localStore: Record<string, unknown> = {};

/**
 * Sets up all required Chrome API mocks on globalThis.
 * Call in beforeEach for any test that uses StorageManager or StateManager.
 */
export function setupChromeMocks(): void {
  disableActionSettleWait();
  (globalThis as any).chrome = {
    storage: {
      session: {
        get: (keys: any, callback?: (res: any) => void) => {
          let res: Record<string, unknown> = {};
          if (keys === null) res = { ...sessionStore };
          else if (typeof keys === 'string') {
            res = { [keys]: sessionStore[keys] };
          } else if (Array.isArray(keys)) {
            res = Object.fromEntries(keys.map(k => [k, sessionStore[k]]));
          } else if (keys) {
            res = Object.fromEntries(
              Object.keys(keys).map(k => [k, sessionStore[k] ?? (keys as Record<string, unknown>)[k]])
            );
          }
          if (typeof callback === 'function') callback(res);
          return Promise.resolve(res);
        },
        set: async (items: Record<string, unknown>) => {
          Object.assign(sessionStore, items);
        },
        remove: async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          keyList.forEach(k => delete sessionStore[k]);
        },
        clear: async () => {
          Object.keys(sessionStore).forEach(k => delete sessionStore[k]);
        },
      },
      local: {
        get: (keys: any, callback?: (res: any) => void) => {
          let res: Record<string, unknown> = {};
          if (keys === null) res = { ...localStore };
          else if (typeof keys === 'string') {
            res = { [keys]: localStore[keys] };
          } else if (Array.isArray(keys)) {
            res = Object.fromEntries(keys.map(k => [k, localStore[k]]));
          } else if (keys) {
            res = Object.fromEntries(
              Object.keys(keys).map(k => [k, localStore[k] ?? (keys as Record<string, unknown>)[k]])
            );
          }
          if (typeof callback === 'function') callback(res);
          return Promise.resolve(res);
        },
        set: async (items: Record<string, unknown>) => {
          Object.assign(localStore, items);
        },
        remove: async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          keyList.forEach(k => delete localStore[k]);
        },
        clear: async () => {
          Object.keys(localStore).forEach(k => delete localStore[k]);
        },
      },
    },
    runtime: {
      sendMessage: async (_message: unknown) => {
        // No-op mock — override per test if you need to inspect messages
        return undefined;
      },
      onMessage: {
        addListener: (_listener: unknown) => {},
        removeListener: (_listener: unknown) => {},
      },
    },
    tabs: {
      sendMessage: async (_tabId: number, _message: unknown) => {
        return undefined;
      },
      update: async (_tabId: number, _props: unknown) => {
        return undefined;
      },
      query: async (_queryInfo: unknown) => {
        return [];
      },
    },
    notifications: {
      create: async (_id: string, _options: unknown) => {
        return _id;
      },
      clear: async (_id: string) => {
        return true;
      },
    },
    action: {
      setBadgeText: async (_details: unknown) => {},
      setBadgeBackgroundColor: async (_details: unknown) => {},
    },
    scripting: {
      executeScript: async (_injection: unknown) => {
        return [];
      },
    },
  };
}

/**
 * Resets all in-memory stores and clears Chrome mocks.
 * Call in afterEach to prevent state leaking between tests.
 */
export function resetChromeMocks(): void {
  // Clear in-memory stores
  Object.keys(sessionStore).forEach(k => delete sessionStore[k]);
  Object.keys(localStore).forEach(k => delete localStore[k]);
  // Remove global chrome mock
  delete (globalThis as any).chrome;
}

/**
 * Returns the current contents of the session store for assertions.
 * Useful for verifying StateManager saved the correct state.
 */
export function getSessionStore(): Record<string, unknown> {
  return { ...sessionStore };
}

/**
 * Returns the current contents of the local store for assertions.
 */
export function getLocalStore(): Record<string, unknown> {
  return { ...localStore };
}

/**
 * Pre-seeds the session store with a value before a test.
 * Use to simulate existing state (e.g. crash recovery scenarios).
 */
export function seedSessionStore(data: Record<string, unknown>): void {
  Object.assign(sessionStore, data);
}

/**
 * Spy on chrome.runtime.sendMessage and capture all messages sent.
 * Returns an array that accumulates messages as they are sent.
 */
export function captureRuntimeMessages(): unknown[] {
  const messages: unknown[] = [];
  if ((globalThis as any).chrome?.runtime) {
    (globalThis as any).chrome.runtime.sendMessage = async (msg: unknown) => {
      messages.push(msg);
      return undefined;
    };
  }
  return messages;
}
