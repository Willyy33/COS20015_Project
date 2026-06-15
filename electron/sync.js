/**
 * sync.js
 * Two-way CouchDB sync using PouchDB's built-in replication
 */

const { studentsDB, equipmentDB, loansDB, detectConflicts } = require('./db');

// CouchDB configuration (env-driven for marker reproducibility)
const COUCHDB_URL = process.env.COUCHDB_URL || 'http://localhost:5984/campus_equipment_loan2';

// Track sync state
let activeSyncHandlers = [];
let syncStatus = 'idle';
let lastSyncTime = null;
let syncListener = null;

// Debounce helper: a burst of sync 'change' events for the same DB
// within CONFLICT_SCAN_DEBOUNCE_MS only triggers one detectConflicts().
let conflictScanTimer = null;
const CONFLICT_SCAN_DEBOUNCE_MS = 750;

function scheduleConflictScan(dbName) {
  if (conflictScanTimer) clearTimeout(conflictScanTimer);
  conflictScanTimer = setTimeout(async () => {
    conflictScanTimer = null;
    try {
      const newConflicts = await detectConflicts();
      if (newConflicts.length > 0) {
        console.log(`[SYNC] Detected ${newConflicts.length} new conflict(s) after ${dbName} change:`, newConflicts);
        emitSyncEvent({ type: 'conflicts', database: dbName, count: newConflicts.length, items: newConflicts });
      }
    } catch (err) {
      console.error('[SYNC] Conflict detection failed:', err);
    }
  }, CONFLICT_SCAN_DEBOUNCE_MS);
}

/**
 * Set a listener for sync events
 */
function setSyncListener(listener) {
  syncListener = listener;
}

/**
 * Emit sync event
 */
function emitSyncEvent(event) {
  if (syncListener) {
    syncListener(event);
  }
}

/**
 * Create a single database sync handler
 */
function createSyncHandler(localDB, remoteURL, dbName) {
  const remoteDB = new (require('pouchdb'))(remoteURL);

  const syncHandler = localDB
    .sync(remoteDB, { live: true, retry: true })
    .on('change', (info) => {
      console.log(`[SYNC] ${dbName} change:`, info.direction, info.change?.docs?.length, 'doc(s)');
      emitSyncEvent({
        type: 'change',
        database: dbName,
        direction: info.direction,
        docsCount: info.change?.docs?.length || 0
      });
      // Debounce conflict detection: a burst of changes can produce many
      // _conflicts arrays; we only need to scan once they're all in.
      scheduleConflictScan(dbName);
    })
    .on('paused', (info) => {
      console.log(`[SYNC] ${dbName} paused (idle)`);
      if (syncStatus !== 'active') {
        syncStatus = 'idle';
        emitSyncEvent({ type: 'idle', database: dbName });
      }
    })
    .on('active', () => {
      console.log(`[SYNC] ${dbName} active (syncing)`);
      syncStatus = 'active';
      emitSyncEvent({ type: 'active', database: dbName });
    })
    .on('error', (err) => {
      console.error(`[SYNC] ${dbName} error:`, err);
      syncStatus = 'error';
      emitSyncEvent({ type: 'error', database: dbName, error: err.message });
    });

  return syncHandler;
}

/**
 * Start live two-way sync with CouchDB
 */
async function startLiveSync() {
  console.log('[SYNC] Starting live two-way sync...');

  // Stop any existing sync
  stopSync();

  const syncURL = `${COUCHDB_URL}`;

  // Start sync for each database
  const studentsSync = createSyncHandler(studentsDB, `${syncURL}_students`, 'students');
  const equipmentSync = createSyncHandler(equipmentDB, `${syncURL}_equipment`, 'equipment');
  const loansSync = createSyncHandler(loansDB, `${syncURL}_loans`, 'loans');

  activeSyncHandlers = [studentsSync, equipmentSync, loansSync];
  syncStatus = 'active';
  lastSyncTime = new Date().toISOString();

  console.log('[SYNC] Live sync started for all databases');
  return { success: true, message: 'Live sync started' };
}

/**
 * Perform a single push-pull sync (non-live)
 */
async function oneTimeSync() {
  console.log('[SYNC] Starting one-time sync...');

  const syncURL = `${COUCHDB_URL}`;
  const results = {};

  const databases = [
    { name: 'students', db: studentsDB },
    { name: 'equipment', db: equipmentDB },
    { name: 'loans', db: loansDB }
  ];

  for (const { name, db } of databases) {
    try {
      const remoteDB = new (require('pouchdb'))(`${syncURL}_${name}`);

      // One-time sync.
      // db.sync() returns the sync handler, not the result. Wrap in a
      // Promise that resolves with the `info` payload from the
      // 'complete' event (and rejects on 'error') so the push/pull
      // counts below are real numbers, not handler properties.
      const result = await new Promise((resolve, reject) => {
        const handler = db.sync(remoteDB);
        handler.on('complete', (info) => {
          console.log(`[SYNC] ${name} sync complete:`, info);
          resolve(info);
        });
        handler.on('error', (err) => reject(err));
      });

      results[name] = {
        success: true,
        pushed: result.push?.docs_written || 0,
        pulled: result.pull?.docs_written || 0,
        pushErrors: result.push?.errors || 0,
        pullErrors: result.pull?.errors || 0,
      };
    } catch (err) {
      console.error(`[SYNC] ${name} sync failed:`, err);
      results[name] = { success: false, error: err.message };
    }
  }

  lastSyncTime = new Date().toISOString();
  console.log('[SYNC] One-time sync completed:', results);

  // After sync, scan for documents with _conflicts and log them.
  // The live-sync 'change' handler does the same on a debounce.
  let newConflicts = [];
  try {
    newConflicts = await detectConflicts();
    if (newConflicts.length > 0) {
      console.log(`[SYNC] Detected ${newConflicts.length} new conflict(s):`, newConflicts);
    }
  } catch (err) {
    console.error('[SYNC] Conflict detection failed:', err);
  }

  return {
    success: Object.values(results).every(r => r.success),
    results,
    newConflicts: newConflicts.length,
    message: 'One-time sync completed'
  };
}

/**
 * Stop all sync operations
 */
function stopSync() {
  activeSyncHandlers.forEach(handler => {
    try {
      handler.cancel();
    } catch (err) {
      console.error('[SYNC] Error stopping sync:', err);
    }
  });
  activeSyncHandlers = [];
  syncStatus = 'idle';
  console.log('[SYNC] Sync stopped');
}

/**
 * Get current sync status
 */
function getSyncStatus() {
  return {
    status: syncStatus,
    lastSyncTime,
    activeSyncs: activeSyncHandlers.length
  };
}

/**
 * Verify connection to CouchDB
 */
async function verifyCouchDBConnection() {
  try {
    const PouchDB = require('pouchdb');
    const testDB = new PouchDB(`${COUCHDB_URL}_test`);
    const info = await testDB.info();
    await testDB.destroy();

    console.log('[SYNC] CouchDB connection verified');
    return {
      success: true,
      database: info.db_name,
      message: 'Connected to CouchDB'
    };
  } catch (err) {
    console.error('[SYNC] CouchDB connection failed:', err.message);
    return {
      success: false,
      error: err.message,
      message: 'Failed to connect to CouchDB'
    };
  }
}

module.exports = {
  startLiveSync,
  oneTimeSync,
  stopSync,
  getSyncStatus,
  verifyCouchDBConnection,
  setSyncListener,
};
