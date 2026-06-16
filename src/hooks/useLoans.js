import { useState, useMemo, useEffect } from "react";
import { today } from "../utils/helpers";

/**
 * useLoans
 * Central state hook for equipment inventory and loan records.
 * Loads data from SQLite database via Electron IPC.
 */
export function useLoans() {
  const [equipment, setEquipment] = useState([]);
  const [loans, setLoans]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  // ── Load data from database on mount ───────────────────────────────────
  useEffect(() => {
    loadDataFromDatabase();
  }, []);

  const loadDataFromDatabase = async () => {
    try {
      setLoading(true);
      
      // Map category to emoji icon
      const getCategoryIcon = (category) => {
        const icons = {
          'Laptop': '💻',
          'Camera': '📷',
          'Microcontroller': '🎮',
          'Projector': '🎬',
          'Headphones': '🎧',
          'Tablet': '📱',
          'Accessory': '🔌',
        };
        return icons[category] || '📦';
      };

      // Load equipment
      if (window.electronAPI?.db?.equipment?.getAll) {
        const equipResult = await window.electronAPI.db.equipment.getAll();
        if (equipResult.success) {
          const formattedEquip = equipResult.data.map(e => ({
            id: e.equipmentID || e._id,
            name: e.name || 'Unknown',
            category: e.category || 'Other',
            available: !!e.available,
            icon: getCategoryIcon(e.category)
          }));
          setEquipment(formattedEquip);
        } else {
          console.warn("Failed to load equipment:", equipResult.error);
        }
      }

      // Load loans
      if (window.electronAPI?.db?.loans?.getAll) {
        const loansResult = await window.electronAPI.db.loans.getAll();
        if (loansResult.success) {
          const formattedLoans = loansResult.data.map(l => ({
            id: l.id,
            studentId: l.studentId,
            studentName: l.studentName,
            equipmentId: l.equipmentId,
            equipmentName: l.equipmentName,
            startDate: l.startDate,
            returnDate: l.returnDate,
            status: l.status === 'Borrowed' ? 'active' : l.status === 'Returned' ? 'returned' : l.status.toLowerCase(),
            synced: !!l.synced
          }));
          setLoans(formattedLoans);
        } else {
          console.warn("Failed to load loans:", loansResult.error);
        }
      }

      setError(null);
    } catch (err) {
      console.error("Error loading data from database:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Derived stats ──────────────────────────────────────────────────────
  const stats = useMemo(
    () => ({
      total:       equipment.length,
      available:   equipment.filter((e) => e.available).length,
      onLoan:      equipment.filter((e) => !e.available).length,
      activeLoans: loans.filter((l) => l.status === "active").length,
    }),
    [equipment, loans]
  );

  // ── Actions ────────────────────────────────────────────────────────────

  /**
   * createLoan — records a new loan to the database
   * @param {object} item       - equipment object being loaned
   * @param {object} borrower   - { studentId, studentName, startDate }
   */
  const createLoan = async (item, borrower) => {
    try {
      const loanID = `L${String(loans.length + 1).padStart(3, '0')}`;
      const loanData = {
        loanID,
        studentID: borrower.studentId,
        equipmentID: item.id,
        borrowDate: borrower.startDate,
        status: 'Borrowed'
      };

      // Save to database
      if (window.electronAPI?.db?.loans?.create) {
        const result = await window.electronAPI.db.loans.create(loanData);
        if (result.success) {
          // Update local state
          const newLoan = {
            id: loanID,
            studentId: borrower.studentId,
            studentName: borrower.studentName,
            equipmentId: item.id,
            equipmentName: item.name,
            startDate: borrower.startDate,
            returnDate: null,
            status: "active",
            synced: false
          };

          setLoans((prev) => [newLoan, ...prev]);
          setEquipment((prev) =>
            prev.map((e) => (e.id === item.id ? { ...e, available: false } : e))
          );

          return newLoan;
        } else {
          console.error("Failed to create loan:", result.error);
          throw new Error(result.error);
        }
      }
    } catch (err) {
      console.error("Error creating loan:", err);
      throw err;
    }
  };

  /**
   * returnLoan — marks a loan as returned in the database
   * @param {string} loanId - id of the loan to close
   */
  const returnLoan = async (loanId) => {
    try {
      const loan = loans.find((l) => l.id === loanId);
      if (!loan) {
        console.error("Loan not found:", loanId);
        return;
      }

      const returnDate = today();

      // Update database
      if (window.electronAPI?.db?.loans?.return) {
        const result = await window.electronAPI.db.loans.return(loanId, returnDate);
        if (result.success) {
          // Update local state
          setLoans((prev) =>
            prev.map((l) =>
              l.id === loanId ? { ...l, returnDate, status: "returned" } : l
            )
          );
          setEquipment((prev) =>
            prev.map((e) =>
              e.id === loan.equipmentId ? { ...e, available: true } : e
            )
          );
        } else {
          console.error("Failed to return loan:", result.error);
          throw new Error(result.error);
        }
      }
    } catch (err) {
      console.error("Error returning loan:", err);
      throw err;
    }
  };

  const createEquipment = async (equipmentData) => {
    try {
      if (window.electronAPI?.db?.equipment?.create) {
        const result = await window.electronAPI.db.equipment.create(equipmentData);
        if (result.success) {
          const getCategoryIcon = (category) => {
            const icons = {
              'Laptop': '💻', 'Camera': '📷', 'Microcontroller': '🎮',
              'Projector': '🎬', 'Headphones': '🎧', 'Tablet': '📱', 'Accessory': '🔌',
            };
            return icons[category] || '📦';
          };
          const newItem = {
            id: result.data.equipmentID,
            name: result.data.name,
            category: result.data.category,
            available: true,
            icon: getCategoryIcon(result.data.category),
          };
          setEquipment((prev) => [...prev, newItem]);
          return newItem;
        } else {
          throw new Error(result.error);
        }
      }
    } catch (err) {
      console.error("Error creating equipment:", err);
      throw err;
    }
  };

  const deleteEquipment = async (equipmentID) => {
    try {
      if (window.electronAPI?.db?.equipment?.delete) {
        const result = await window.electronAPI.db.equipment.delete(equipmentID);
        if (result.success) {
          setEquipment((prev) => prev.filter((e) => e.id !== equipmentID));
        } else {
          throw new Error(result.error);
        }
      }
    } catch (err) {
      console.error("Error deleting equipment:", err);
      throw err;
    }
  };

  const updateEquipment = async (equipmentID, updates) => {
    try {
      if (window.electronAPI?.db?.equipment?.update) {
        const result = await window.electronAPI.db.equipment.update(equipmentID, updates);
        if (result.success) {
          const getCategoryIcon = (category) => {
            const icons = {
              'Laptop': '💻', 'Camera': '📷', 'Microcontroller': '🎮',
              'Projector': '🎬', 'Headphones': '🎧', 'Tablet': '📱', 'Accessory': '🔌',
            };
            return icons[category] || '📦';
          };
          setEquipment((prev) =>
            prev.map((e) =>
              e.id === equipmentID
                ? { ...e, name: updates.name, category: updates.category, available: updates.available, icon: getCategoryIcon(updates.category) }
                : e
            )
          );
        } else {
          throw new Error(result.error);
        }
      }
    } catch (err) {
      console.error("Error updating equipment:", err);
      throw err;
    }
  };

  return { equipment, loans, stats, loading, error, createLoan, returnLoan, createEquipment, updateEquipment, deleteEquipment, reloadData: loadDataFromDatabase };
}
