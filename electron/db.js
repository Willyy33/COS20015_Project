/**
 * db.js
 * PouchDB database module for managing students, equipment, and loans
 */

const PouchDB = require('pouchdb');
const path = require('path');
const { app } = require('electron');

// Database path: store in user's app data directory.
// Tests can override via POUCHDB_DIR_OVERRIDE to point at a temp
// directory and avoid the Electron `app` import.
let DB_DIR;
if (process.env.POUCHDB_DIR_OVERRIDE) {
  DB_DIR = process.env.POUCHDB_DIR_OVERRIDE;
} else {
  const { app } = require('electron');
  DB_DIR = app.getPath('userData');
}

// Create separate PouchDB instances for each collection
const studentsDB = new PouchDB(path.join(DB_DIR, 'students'));
const equipmentDB = new PouchDB(path.join(DB_DIR, 'equipment'));
const loansDB = new PouchDB(path.join(DB_DIR, 'loans'));

// Separate store for detected conflicts (one record per pending or
// resolved conflict, used by the Conflict Modal in the renderer).
const conflictsDB = new PouchDB(path.join(DB_DIR, 'conflicts'));

/**
 * Initialize database - no schema needed for PouchDB
 */
async function initializeDatabase() {
  console.log('PouchDB initialized at:', DB_DIR);
  await insertSeedData();
}

/**
 * Insert seed data if databases are empty
 */
async function insertSeedData() {
  const equipCount = await equipmentDB.info();
  if (equipCount.doc_count > 0) {
    console.log('Seed data already exists, skipping insert');
    return;
  }

  console.log('Inserting seed data...');

  // Insert students
  const students = [
    { _id: 'S001', studentID: 'S001', firstName: 'William', lastName: 'Yong', phone: '0123456789', email: 'william@swinburne.edu.my' },
    { _id: 'S002', studentID: 'S002', firstName: 'John', lastName: 'Tan', phone: '0112345678', email: 'john@swinburne.edu.my' },
    { _id: 'S003', studentID: 'S003', firstName: 'Sarah', lastName: 'Lee', phone: '0198765432', email: 'sarah@swinburne.edu.my' },
    { _id: 'S004', studentID: 'S004', firstName: 'Emily', lastName: 'Chen', phone: '0167890123', email: 'emily@swinburne.edu.my' },
    { _id: 'S005', studentID: 'S005', firstName: 'Raj', lastName: 'Kumar', phone: '0189012345', email: 'raj@swinburne.edu.my' }
  ];

  // Insert equipment
  const equipment = [
    { _id: 'E001', equipmentID: 'E001', name: 'Dell Latitude 5430', category: 'Laptop', available: true },
    { _id: 'E002', equipmentID: 'E002', name: 'Canon EOS R50', category: 'Camera', available: true },
    { _id: 'E003', equipmentID: 'E003', name: 'Arduino Uno R3', category: 'Microcontroller', available: true },
    { _id: 'E004', equipmentID: 'E004', name: 'Epson Projector X500', category: 'Projector', available: true },
    { _id: 'E005', equipmentID: 'E005', name: 'Sony WH-1000XM5', category: 'Headphones', available: true },
    { _id: 'E006', equipmentID: 'E006', name: 'iPad Air M2', category: 'Tablet', available: true },
    { _id: 'E007', equipmentID: 'E007', name: 'Logitech C920 Webcam', category: 'Camera', available: true },
    { _id: 'E008', equipmentID: 'E008', name: 'USB-C Hub Adapter', category: 'Accessory', available: true }
  ];

  await studentsDB.bulkDocs(students);
  await equipmentDB.bulkDocs(equipment);
  console.log('Seed data inserted');
}

/**
 * Get all equipment
 */
async function getAllEquipment() {
  const result = await equipmentDB.allDocs({ include_docs: true });
  return result.rows
    .map(row => row.doc)
    .filter(doc => !doc._id.startsWith('_design/'))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get all loans with related student and equipment info
 */
async function getAllLoans() {
  const [loansResult, studentsResult, equipmentResult] = await Promise.all([
    loansDB.allDocs({ include_docs: true }),
    studentsDB.allDocs({ include_docs: true }),
    equipmentDB.allDocs({ include_docs: true })
  ]);

  const students = {};
  studentsResult.rows.forEach(row => {
    if (!row.id.startsWith('_design/')) {
      students[row.doc.studentID] = row.doc;
    }
  });

  const equipment = {};
  equipmentResult.rows.forEach(row => {
    if (!row.id.startsWith('_design/')) {
      equipment[row.doc.equipmentID] = row.doc;
    }
  });

  return loansResult.rows
    .map(row => row.doc)
    .filter(doc => !doc._id.startsWith('_design/'))
    .map(loan => {
      const student = students[loan.studentID] || {};
      const equip = equipment[loan.equipmentID] || {};
      return {
        id: loan.loanID,
        studentId: loan.studentID,
        studentName: `${student.firstName || ''} ${student.lastName || ''}`.trim(),
        firstName: student.firstName,
        lastName: student.lastName,
        equipmentId: loan.equipmentID,
        equipmentName: equip.name,
        startDate: loan.borrowDate,
        returnDate: loan.returnDate,
        status: loan.status,
        synced: loan.synced ? 1 : 0
      };
    })
    .sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
}

/**
 * Create a new loan
 */
async function createLoan(loanData) {
  const { loanID, studentID, equipmentID, borrowDate, status } = loanData;

  // Create loan document
  const loanDoc = {
    _id: `loan_${loanID}`,
    loanID,
    studentID,
    equipmentID,
    borrowDate,
    returnDate: null,
    status,
    synced: false,
    type: 'loan'
  };

  await loansDB.put(loanDoc);

  // Update equipment availability
  const equipDoc = await equipmentDB.get(equipmentID);
  await equipmentDB.put({ ...equipDoc, available: false });

  return { ...loanData, synced: 0 };
}

/**
 * Return a loan (mark as returned)
 */
async function returnLoan(loanID, returnDate) {
  // Find the loan
  const loansResult = await loansDB.allDocs({ include_docs: true });
  const loanDoc = loansResult.rows.find(row => row.doc.loanID === loanID)?.doc;

  if (!loanDoc) throw new Error('Loan not found');

  // Update loan
  await loansDB.put({
    ...loanDoc,
    returnDate,
    status: 'Returned',
    synced: false
  });

  // Update equipment availability
  const equipDoc = await equipmentDB.get(loanDoc.equipmentID);
  await equipmentDB.put({ ...equipDoc, available: true });

  return { success: true };
}

/**
 * Get all students
 */
async function getAllStudents() {
  const result = await studentsDB.allDocs({ include_docs: true });
  return result.rows
    .map(row => row.doc)
    .filter(doc => !doc._id.startsWith('_design/'))
    .sort((a, b) => {
      const lastNameCompare = (a.lastName || '').localeCompare(b.lastName || '');
      return lastNameCompare !== 0 ? lastNameCompare : (a.firstName || '').localeCompare(b.firstName || '');
    });
}

/**
 * Create a new equipment item
 */
async function createEquipment(equipmentData) {
  const { equipmentID, name, category } = equipmentData;

  const doc = {
    _id: equipmentID,
    equipmentID,
    name,
    category,
    available: true
  };

  await equipmentDB.put(doc);
  return { ...equipmentData, available: true };
}

/**
 * Update equipment details
 */
async function updateEquipment(equipmentID, updates) {
  const { name, category, available } = updates;
  const doc = await equipmentDB.get(equipmentID);

  await equipmentDB.put({
    ...doc,
    name,
    category,
    available
  });

  return { success: true };
}

/**
 * Delete an equipment item (only if not currently on loan)
 */
async function deleteEquipment(equipmentID) {
  // Check if on loan
  const loansResult = await loansDB.allDocs({ include_docs: true });
  const activeLoan = loansResult.rows.find(row => {
    const doc = row.doc;
    return doc.equipmentID === equipmentID && doc.status === 'Borrowed';
  });

  if (activeLoan) {
    throw new Error('Cannot delete: item is currently on loan');
  }

  const doc = await equipmentDB.get(equipmentID);
  await equipmentDB.remove(doc);
  return { success: true };
}

/**
 * Get unsynced loans (for backward compatibility)
 */
async function getUnsyncedLoans() {
  const result = await loansDB.allDocs({ include_docs: true });
  return result.rows
    .map(row => row.doc)
    .filter(doc => !doc._id.startsWith('_design/') && doc.synced === false);
}

/**
 * Mark loan as synced (for backward compatibility)
 */
async function markLoanSynced(loanID) {
  const loansResult = await loansDB.allDocs({ include_docs: true });
  const loanDoc = loansResult.rows.find(row => row.doc.loanID === loanID)?.doc;

  if (loanDoc) {
    await loansDB.put({ ...loanDoc, synced: true });
  }
  return { success: true };
}

// ── Sync-related functions (kept for compatibility) ──────────────────────

/**
 * Get a record by ID from a collection
 */
async function getRecordById(table, id) {
  try {
    if (table === 'students') {
      const doc = await studentsDB.get(id);
      return doc || null;
    } else if (table === 'equipment') {
      const doc = await equipmentDB.get(id);
      return doc || null;
    } else if (table === 'loans') {
      const result = await loansDB.allDocs({ include_docs: true });
      const loan = result.rows.find(row => row.doc.loanID === id);
      return loan ? loan.doc : null;
    }
    return null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Upsert a record from remote (CouchDB)
 */
async function upsertFromRemote(table, record) {
  if (table === 'students') {
    const doc = {
      _id: record.studentID,
      ...record
    };
    // Check if exists
    try {
      const existing = await studentsDB.get(record.studentID);
      doc._rev = existing._rev;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    await studentsDB.put(doc);
  } else if (table === 'equipment') {
    const doc = {
      _id: record.equipmentID,
      ...record
    };
    try {
      const existing = await equipmentDB.get(record.equipmentID);
      doc._rev = existing._rev;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    await equipmentDB.put(doc);
  } else if (table === 'loans') {
    const doc = {
      _id: `loan_${record.loanID}`,
      ...record,
      synced: true
    };
    try {
      const existing = await loansDB.allDocs({ include_docs: true });
      const existingLoan = existing.rows.find(row => row.doc.loanID === record.loanID);
      if (existingLoan) {
        doc._rev = existingLoan.doc._rev;
        doc._id = existingLoan.doc._id;
      }
    } catch (err) {
      // ignore
    }
    await loansDB.put(doc);
  } else {
    throw new Error(`Unknown table: ${table}`);
  }
}

/**
 * Log change - no-op for PouchDB (handles this internally)
 */
async function logChange() {
  // PouchDB tracks changes internally via _rev
}

/**
 * Get unsynced changes - returns empty (PouchDB sync handles this)
 */
async function getUnsyncedChanges() {
  return [];
}

/**
 * Mark change synced - no-op for PouchDB
 */
async function markChangeSynced() {
  // PouchDB sync handles this
}

/**
 * Mark all changes synced - no-op for PouchDB
 */
async function markAllChangesSynced() {
  // PouchDB sync handles this
}

/**
 * Get last sync timestamp - not needed for PouchDB sync
 */
async function getLastSyncTimestamp() {
  return null;
}

/**
 * Log a conflict (writes a record to the conflicts collection).
 * De-duplicates on (table, documentID) while the conflict is still
 * pending so repeated sync passes don't flood the store.
 */
async function logConflict({ table, documentID, localRev, remoteRev, localDoc, remoteDoc }) {
  // De-dupe: a pending conflict for the same doc is logged only once
  const existing = await conflictsDB.allDocs({ include_docs: true });
  const dup = existing.rows.find((row) =>
    row.doc.status === 'pending' &&
    row.doc.table === table &&
    row.doc.documentID === documentID
  );
  if (dup) return dup.doc;

  const conflictID = `conflict_${Date.now()}_${documentID}`;
  const doc = {
    _id: conflictID,
    conflictID,
    table,
    documentID,
    localRev,
    remoteRev,
    localDoc,
    remoteDoc,
    status: 'pending',
    resolution: null,
    winnerData: null,
    timestamp: new Date().toISOString(),
    resolvedAt: null,
  };
  await conflictsDB.put(doc);
  return doc;
}

/**
 * Get all pending (unresolved) conflicts, newest first.
 */
async function getPendingConflicts() {
  const result = await conflictsDB.allDocs({ include_docs: true });
  return result.rows
    .map((row) => row.doc)
    .filter((doc) => !doc._id.startsWith('_design/') && doc.status === 'pending')
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
}

/**
 * Resolve a conflict by conflictID.
 * `resolution` is one of: 'local' | 'remote' | 'merge'
 * `winnerData` is the document to write back to the source table
 * (may be omitted for resolution='remote' — we re-pull the remote rev).
 */
async function resolveConflict(conflictID, resolution, winnerData) {
  const result = await conflictsDB.allDocs({ include_docs: true });
  const conflictDoc = result.rows.find((row) => row.doc.conflictID === conflictID)?.doc;
  if (!conflictDoc) throw new Error(`Conflict not found: ${conflictID}`);

  // Apply the winner to the source table
  if (resolution === 'remote' && conflictDoc.remoteDoc) {
    await upsertFromRemote(conflictDoc.table, conflictDoc.remoteDoc);
  } else if ((resolution === 'local' || resolution === 'merge') && winnerData) {
    await upsertFromRemote(conflictDoc.table, winnerData);
  }

  await conflictsDB.put({
    ...conflictDoc,
    status: 'resolved',
    resolution,
    winnerData: winnerData || null,
    resolvedAt: new Date().toISOString(),
  });

  return { success: true, conflictID, resolution };
}

/**
 * Scan all three source databases for documents with `_conflicts` and
 * log each conflict to conflictsDB. Safe to call repeatedly; the
 * logConflict de-dupe logic keeps the store tidy.
 * Returns the list of newly-detected conflicts in this pass.
 */
async function detectConflicts() {
  const sources = [
    { table: 'students',  db: studentsDB  },
    { table: 'equipment', db: equipmentDB },
    { table: 'loans',     db: loansDB     },
  ];
  const detected = [];

  for (const { table, db } of sources) {
    const result = await db.allDocs({ include_docs: true, conflicts: true });
    for (const row of result.rows) {
      const conflicts = row.doc._conflicts;
      if (!conflicts || conflicts.length === 0) continue;

      for (const conflictingRev of conflicts) {
        try {
          const remoteDoc = await db.get(row.doc._id, { rev: conflictingRev });
          const logged = await logConflict({
            table,
            documentID: row.doc._id,
            localRev: row.doc._rev,
            remoteRev: conflictingRev,
            localDoc: row.doc,
            remoteDoc,
          });
          if (logged && !detected.find((d) => d.conflictID === logged.conflictID)) {
            detected.push({ table, documentID: row.doc._id, conflictID: logged.conflictID });
          }
        } catch (err) {
          // Skip revs that can't be fetched; nothing actionable here
        }
      }
    }
  }
  return detected;
}

/**
 * Set equipment availability
 */
async function setEquipmentAvailable(equipmentID, available) {
  const doc = await equipmentDB.get(equipmentID);
  await equipmentDB.put({ ...doc, available });
}

module.exports = {
  initializeDatabase,
  getAllEquipment,
  createEquipment,
  updateEquipment,
  deleteEquipment,
  getAllLoans,
  createLoan,
  returnLoan,
  getUnsyncedLoans,
  markLoanSynced,
  getAllStudents,
  logChange,
  getUnsyncedChanges,
  markChangeSynced,
  getRecordById,
  upsertFromRemote,
  setEquipmentAvailable,
  logConflict,
  getPendingConflicts,
  resolveConflict,
  detectConflicts,
  getLastSyncTimestamp,
  markAllChangesSynced,
  // Export DB instances for sync
  studentsDB,
  equipmentDB,
  loansDB,
  conflictsDB,
};
