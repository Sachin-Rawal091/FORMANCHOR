import { IDBPDatabase } from 'idb';
import { logger } from '../utils/logger';

/**
 * Migration report — logged for debugging and audit trail.
 * Tracks exactly which sessions were updated, skipped, or failed.
 */
export interface MigrationReport {
  migrationName: string;
  updatedSessions: number;
  skippedSessions: number;
  failedSessions: string[];  // sessionIds that threw errors
  durationMs: number;
}

/**
 * Lazy post-open migration: backfills totalRows on legacy SessionMeta
 * records that were created before the field existed.
 *
 * Design principles:
 * ┌─────────────────────────────────────────────────────────────┐
 * │ 1. Runs OUTSIDE the IDB upgrade transaction (non-blocking) │
 * │ 2. Each session in its own transaction (error isolation)    │
 * │ 3. Only processes sessions that actually need migration     │
 * │ 4. Idempotent — safe to run multiple times                 │
 * │ 5. Logs a full MigrationReport for debugging               │
 * │ 6. Corrupted sessions are skipped, not fatal               │
 * └─────────────────────────────────────────────────────────────┘
 */
export async function migrateSessionTotalRows(
  db: IDBPDatabase
): Promise<MigrationReport> {
  const report: MigrationReport = {
    migrationName: 'SessionMeta.totalRows backfill',
    updatedSessions: 0,
    skippedSessions: 0,
    failedSessions: [],
    durationMs: 0,
  };
  const start = Date.now();

  try {
    // ── Phase 1: Read all sessions (read-only, fast) ──────────
    const allSessions = await db.getAll('sessions');

    // Filter to ONLY sessions that need migration
    const needsMigration = allSessions.filter(s => !s.totalRows);
    report.skippedSessions = allSessions.length - needsMigration.length;

    if (needsMigration.length === 0) {
      report.durationMs = Date.now() - start;
      logger.debug('Migration', 'No sessions need totalRows backfill.', report);
      return report;
    }

    logger.info(
      'Migration',
      `Starting totalRows backfill: ${needsMigration.length} of ${allSessions.length} sessions need migration.`
    );

    // ── Phase 2: Process each session individually ────────────
    // Each session gets its OWN read transaction for log scanning
    // and its OWN write transaction for the update.
    // A failure in session N does not affect session N+1.
    for (const meta of needsMigration) {
      try {
        // Count distinct rowIndex values from this session's logs
        const rowIndices = new Set<number>();
        const tx = db.transaction('logs', 'readonly');
        const logIndex = tx.store.index('sessionId');
        let cursor = await logIndex.openCursor(meta.sessionId);

        while (cursor) {
          rowIndices.add(cursor.value.rowIndex);
          cursor = await cursor.continue();
        }

        if (rowIndices.size > 0) {
          // Write the backfilled totalRows in a separate write transaction
          meta.totalRows = rowIndices.size;
          await db.put('sessions', meta);
          report.updatedSessions++;
        } else {
          // No logs found — session logs may have been wiped independently.
          // Leave totalRows as-is (undefined/0) — this is correct behavior.
          report.skippedSessions++;
        }
      } catch (err) {
        // Isolate failures — one corrupted session doesn't block others
        report.failedSessions.push(meta.sessionId);
        logger.warn(
          'Migration',
          `Failed to backfill totalRows for session ${meta.sessionId}:`,
          err
        );
      }
    }
  } catch (err) {
    // Fatal error reading sessions store — log but don't crash the extension
    logger.error('Migration', 'Fatal error during totalRows migration:', err);
  }

  report.durationMs = Date.now() - start;
  logger.info('Migration', 'SessionMeta totalRows migration complete:', report);
  return report;
}
