import { LogEntry, MessageType } from "../types";
import { sendToBackground } from "../shared/messages";
import { logger } from "../utils/logger";
import { generateUUID } from "../utils/uuid";

const BATCH_ACK_TIMEOUT_MS = 2500;
const FALLBACK_TIMEOUT_MS = 500;
const MUTEX_WAIT_CEILING_MS = 3000;
const AUTO_FLUSH_DELAY_MS = 500;

export class LogBatcher {
  private queue: LogEntry[] = [];
  private flushInFlight: Promise<void> | null = null;
  private autoFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionId: string = "";

  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
  }

  enqueue(entry: LogEntry) {
    entry.batchIndex = this.queue.length;
    this.queue.push(entry);

    if (!this.autoFlushTimer) {
      this.autoFlushTimer = setTimeout(() => {
        this.flushNow().catch(err => {
          logger.error('LogBatcher', 'Auto-flush failed:', err);
        });
      }, AUTO_FLUSH_DELAY_MS);
    }
  }

  async flushNow(): Promise<void> {
    if (this.autoFlushTimer) {
      clearTimeout(this.autoFlushTimer);
      this.autoFlushTimer = null;
    }

    if (this.queue.length === 0) return;

    if (this.flushInFlight) {
      try {
        await Promise.race([
          this.flushInFlight,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Mutex Wait Ceiling Exceeded')), MUTEX_WAIT_CEILING_MS))
        ]);
      } catch (err: any) {
        if (err.message === 'Mutex Wait Ceiling Exceeded') {
          logger.warn('LogBatcher', `Prior flush exceeded ${MUTEX_WAIT_CEILING_MS}ms. Bypassing mutex and writing directly to fallback storage to unblock navigation.`);
          await this.writeToFallbackStorage(this.queue);
          this.queue = [];
          return; // Early return to avoid queuing up multiple overlapping flush calls in IDB
        } else {
          // Ignore other mutex errors, just continue to do the flush
        }
      }
    }

    const currentFlush = this.doFlush();
    this.flushInFlight = currentFlush;

    try {
      await currentFlush;
    } finally {
      if (this.flushInFlight === currentFlush) {
        this.flushInFlight = null;
      }
    }
  }

  private async doFlush(): Promise<void> {
    if (this.queue.length === 0) return;

    const toFlush = this.queue;
    this.queue = [];

    const sessionId = this.sessionId || (toFlush[0] && toFlush[0].sessionId) || "unknown";

    try {
      await Promise.race([
        sendToBackground({
          type: MessageType.ADD_LOG_BATCH,
          payload: { entries: toFlush },
          sessionId: sessionId,
          timestamp: Date.now()
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Batch Ack Timeout')), BATCH_ACK_TIMEOUT_MS))
      ]);
    } catch (err: any) {
      if (err.message === 'Batch Ack Timeout' || (err.message || '').includes('Receiving end does not exist')) {
        logger.warn('LogBatcher', `Service worker unavailable or timed out after ${BATCH_ACK_TIMEOUT_MS}ms. Falling back to local storage.`);
        await this.writeToFallbackStorage(toFlush);
      } else {
        logger.error('LogBatcher', 'Unexpected error during flush:', err);
        // Fallback anyway to be safe
        await this.writeToFallbackStorage(toFlush);
      }
    }
  }

  private async writeToFallbackStorage(entries: LogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const sessionId = this.sessionId || entries[0].sessionId || "unknown";
    const timestamp = Date.now();
    const uuid = generateUUID();
    const fallbackKey = `__fp_pending_logs_${sessionId}_${timestamp}_${uuid}`;
    
    try {
      await Promise.race([
        chrome.storage.local.set({ [fallbackKey]: entries }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Fallback Write Timeout')), FALLBACK_TIMEOUT_MS))
      ]);
      logger.info('LogBatcher', `Successfully wrote ${entries.length} logs to fallback storage (${fallbackKey}).`);
      
      // Dispatch LOGS_UPDATED event so the UI refreshes
      chrome.runtime.sendMessage({
        type: MessageType.LOGS_UPDATED,
        sessionId,
        timestamp: Date.now()
      }).catch(err => {
        logger.debug('LogBatcher', 'Failed to broadcast LOGS_UPDATED from fallback path (UI might not be open):', err);
      });
    } catch (err: any) {
      logger.error('LogBatcher', `FATAL: Failed to write logs to fallback storage after ${FALLBACK_TIMEOUT_MS}ms. Logs may be lost:`, err);
    }
  }
}
