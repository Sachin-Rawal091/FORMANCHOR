import { openDB, IDBPDatabase } from 'idb';
import { migrateSessionTotalRows } from './migrations';
import { logger } from '../utils/logger';

// ⚠️ NEVER change this constant post-launch — IndexedDB is scoped by exact name.
// Renaming it after users have data would silently orphan every existing user's local database.
const DB_NAME = 'FormAnchorDB';
const DB_VERSION = 8; // v8: schema marker for SessionMeta.totalRows backfill (runs post-open)

export async function getDB(): Promise<IDBPDatabase> {
  const db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        if (!db.objectStoreNames.contains('recordings')) {
          db.createObjectStore('recordings', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('excelData')) {
          db.createObjectStore('excelData', { keyPath: 'rowIndex' });
        }
        if (!db.objectStoreNames.contains('logs')) {
          const logsStore = db.createObjectStore('logs', { keyPath: 'id' });
          logsStore.createIndex('sessionId', 'sessionId');
          logsStore.createIndex('timestamp', 'timestamp');
          logsStore.createIndex('sessionTimestamp', ['sessionId', 'timestamp']);
        }
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'sessionId' });
        }
      }
      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'alias' });
        }
      }
      if (oldVersion >= 1 && oldVersion < 3) {
        if (db.objectStoreNames.contains('logs')) {
          const logsStore = transaction.objectStore('logs');
          if (!logsStore.indexNames.contains('sessionId')) {
            logsStore.createIndex('sessionId', 'sessionId');
          }
          if (!logsStore.indexNames.contains('timestamp')) {
            logsStore.createIndex('timestamp', 'timestamp');
          }
        }
      }
      if (oldVersion < 5 && db.objectStoreNames.contains('logs')) {
        const logsStore = transaction.objectStore('logs');
        if (!logsStore.indexNames.contains('sessionTimestamp')) {
          logsStore.createIndex('sessionTimestamp', ['sessionId', 'timestamp']);
        }
      }
      if (oldVersion < 6) {
        if (db.objectStoreNames.contains('sessions')) {
          const sessionStore = transaction.objectStore('sessions');
          if (!sessionStore.indexNames.contains('timestamp')) {
            sessionStore.createIndex('timestamp', 'timestamp');
          }
        }
      }
      if (oldVersion < 7) {
        if (!db.objectStoreNames.contains('keys')) {
          db.createObjectStore('keys'); // out-of-line keys — db.put('keys', cryptoKey, 'fpDataKey')
        }
      }
      if (oldVersion < 8) {
        // Schema-only version bump. SessionMeta.totalRows backfill runs
        // asynchronously post-open via migrateSessionTotalRows() — NOT inside
        // this upgrade transaction, to avoid blocking DB open on large datasets.
      }
    },
  });

  db.addEventListener('versionchange', () => {
    db.close();
  });

  // BUG-AUDIT-FIX-9: Fire lazy totalRows migration as a non-blocking background task.
  // Does NOT block the extension from working — runs after DB is fully open.
  migrateSessionTotalRows(db).catch(err =>
    logger.error('DB', 'Post-open totalRows migration failed:', err)
  );

  return db;
}
