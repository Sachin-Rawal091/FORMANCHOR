import './executor'; // initialize executor
import './recorder'; // initialize recorder
import { logger } from '../utils/logger';
import { MessageType } from '../types';

logger.info('ContentScript', 'Injected.');

// BUG-AUDIT-FIX-6: Request the service worker to inject the network proxy script
// into the MAIN world via chrome.scripting.executeScript({ world: 'MAIN' }).
// This is CSP-exempt, unlike the previous DOM-based <script> tag injection which
// was silently blocked by strict Content-Security-Policy headers on government/bank
// portals — exactly the sites this extension targets.
chrome.runtime.sendMessage({
  type: MessageType.INJECT_NETWORK_PROXY,
  payload: {},
  sessionId: '',
  timestamp: Date.now()
}).then((response: any) => {
  if (response?.success) {
    logger.debug('ContentScript', 'Network proxy script injected successfully via service worker.');
  } else {
    logger.warn('ContentScript', 'Network proxy injection returned non-success (restricted page or SW unavailable). SmartWaitEngine will use ceiling timer fallback.');
  }
}).catch((err: any) => {
  // Expected on pages where the service worker is unreachable (e.g. during extension reload).
  // SmartWaitEngine degrades gracefully to its ceiling timer — no hang risk.
  logger.warn('ContentScript', 'Failed to request network proxy injection:', err);
});

// Note: Message handlers are registered in executor.ts and recorder.ts
// We do NOT add a generic onMessage handler here to avoid
// competing sendResponse calls that would interfere with
// the recorder's and service worker's async message channels.

