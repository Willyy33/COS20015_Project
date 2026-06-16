/**
 * preload.js
 *
 * Runs in a privileged context with access to both the DOM and Node/Electron
 * APIs, but exposes only an explicit, narrow surface to the renderer via
 * contextBridge. This keeps the renderer sandboxed while still allowing it
 * to communicate with the main process.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // ── App metadata ──────────────────────────────────────────────────────
  getVersion: () => ipcRenderer.invoke("app:version"),

  // ── Database: Equipment ────────────────────────────────────────────────
  db: {
    equipment: {
      getAll: () => ipcRenderer.invoke("db:equipment:getAll"),
      create: (equipmentData) => ipcRenderer.invoke("db:equipment:create", equipmentData),
      update: (equipmentID, updates) => ipcRenderer.invoke("db:equipment:update", equipmentID, updates),
      delete: (equipmentID) => ipcRenderer.invoke("db:equipment:delete", equipmentID),
    },

    // ── Database: Loans ───────────────────────────────────────────────
    loans: {
      getAll: () => ipcRenderer.invoke("db:loans:getAll"),
      create: (loanData) => ipcRenderer.invoke("db:loans:create", loanData),
      return: (loanID, returnDate) => ipcRenderer.invoke("db:loans:return", loanID, returnDate),
      getUnsynced: () => ipcRenderer.invoke("db:loans:getUnsynced"),
    },

    // ── Database: Students ─────────────────────────────────────────────
    students: {
      getAll: () => ipcRenderer.invoke("db:students:getAll"),
    },
  },

  // ── Sync: CouchDB ──────────────────────────────────────────────────────
  sync: {
    verify: () => ipcRenderer.invoke("sync:verify"),
    syncLoans: () => ipcRenderer.invoke("sync:loans"),
    getSettings: () => ipcRenderer.invoke("sync:getSettings"),
    setSettings: (settings) => ipcRenderer.invoke("sync:setSettings", settings),
    getPendingCount: () => ipcRenderer.invoke("sync:getPendingCount"),
    getConflicts: () => ipcRenderer.invoke("sync:getConflicts"),
    resolveConflict: (conflictID, resolution, winnerData) => ipcRenderer.invoke("sync:resolveConflict", conflictID, resolution, winnerData),
  },

  // ── Platform info (useful for conditional UI) ─────────────────────────
  platform: process.platform,   // 'win32' | 'darwin' | 'linux'
});
