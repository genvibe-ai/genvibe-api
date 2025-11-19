import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import StatsGrid from './components/StatsGrid';
import CookiesTable from './components/CookiesTable';
import AddCookieModal from './components/AddCookieModal';
import DeleteConfirmModal from './components/DeleteConfirmModal';
import Toast from './components/Toast';

function App() {
  const [cookies, setCookies] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedCookies, setSelectedCookies] = useState(new Set());
  const [showAddModal, setShowAddModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [toast, setToast] = useState(null);

  // Load cookies and stats
  const loadData = async () => {
    try {
      const [cookiesRes, statsRes] = await Promise.all([
        fetch('/dashboard/api/cookies'),
        fetch('/dashboard/api/stats/summary')
      ]);

      const cookiesData = await cookiesRes.json();
      const statsData = await statsRes.json();

      setCookies(cookiesData.data || []);
      setStats(statsData.data || null);
    } catch (error) {
      showToast('Failed to load data', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 10000); // Auto-refresh every 10s
    return () => clearInterval(interval);
  }, []);

  // Toast notifications
  const showToast = (message, type = 'info', title = '') => {
    setToast({ message, type, title, id: Date.now() });
    setTimeout(() => setToast(null), 4000);
  };

  // Add cookie
  const handleAddCookie = async (region, cookie) => {
    try {
      const res = await fetch('/dashboard/api/cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region, cookie })
      });

      const result = await res.json();

      if (result.success) {
        showToast(`Cookie for ${region} added successfully`, 'success', 'Success!');
        setShowAddModal(false);
        loadData();
      } else {
        showToast(result.error || 'Failed to add cookie', 'error', 'Error');
      }
    } catch (error) {
      showToast('Failed to add cookie', 'error', 'Error');
    }
  };

  // Toggle cookie active status
  const handleToggleCookie = async (region) => {
    try {
      const res = await fetch(`/dashboard/api/cookies/${region}/toggle`, {
        method: 'PATCH'
      });

      const result = await res.json();

      if (result.success) {
        showToast(result.message, 'success');
        loadData();
      } else {
        showToast(result.error || 'Failed to toggle cookie', 'error');
      }
    } catch (error) {
      showToast('Failed to toggle cookie', 'error');
    }
  };

  // Delete single cookie
  const handleDeleteCookie = async (region) => {
    try {
      const res = await fetch(`/dashboard/api/cookies/${region}`, {
        method: 'DELETE'
      });

      const result = await res.json();

      if (result.success) {
        showToast(`Cookie for ${region} deleted`, 'success');
        loadData();
      } else {
        showToast(result.error || 'Failed to delete cookie', 'error');
      }
    } catch (error) {
      showToast('Failed to delete cookie', 'error');
    }
  };

  // Bulk delete
  const handleBulkDelete = async () => {
    const regions = Array.from(selectedCookies);
    
    try {
      const res = await fetch('/dashboard/api/cookies/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regions })
      });

      const result = await res.json();

      if (result.success) {
        showToast(`Deleted ${result.count} cookie(s)`, 'success', 'Success!');
        setSelectedCookies(new Set());
        setShowDeleteModal(false);
        loadData();
      } else {
        showToast(result.error || 'Failed to delete cookies', 'error');
      }
    } catch (error) {
      showToast('Failed to delete cookies', 'error');
    }
  };

  // Reset stats
  const handleResetStats = async () => {
    if (!confirm('Are you sure you want to reset all statistics?')) return;

    try {
      const res = await fetch('/dashboard/api/cookies/reset-stats', {
        method: 'POST'
      });

      const result = await res.json();

      if (result.success) {
        showToast('All statistics reset successfully', 'success');
        loadData();
      } else {
        showToast(result.error || 'Failed to reset stats', 'error');
      }
    } catch (error) {
      showToast('Failed to reset stats', 'error');
    }
  };

  return (
    <div className="container">
      <motion.div
        className="header"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <h1>🚀 LMArena API Dashboard</h1>
        <p>Manage your API cookies and monitor performance in real-time</p>
      </motion.div>

      {/* Stats Grid */}
      {stats && <StatsGrid stats={stats} loading={loading} />}

      {/* Actions Bar */}
      <motion.div
        className="actions"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2 }}
      >
        <button className="success" onClick={() => setShowAddModal(true)}>
          ➕ Add Cookie
        </button>
        <button onClick={loadData}>
          🔄 Refresh
        </button>
        <button className="danger" onClick={handleResetStats}>
          🗑️ Reset Stats
        </button>
        {selectedCookies.size > 0 && (
          <motion.button
            className="warning"
            onClick={() => setShowDeleteModal(true)}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
          >
            🗑️ Delete Selected ({selectedCookies.size})
          </motion.button>
        )}
      </motion.div>

      {/* Cookies Table */}
      <CookiesTable
        cookies={cookies}
        loading={loading}
        selectedCookies={selectedCookies}
        setSelectedCookies={setSelectedCookies}
        onToggle={handleToggleCookie}
        onDelete={handleDeleteCookie}
      />

      {/* Modals */}
      <AnimatePresence>
        {showAddModal && (
          <AddCookieModal
            onClose={() => setShowAddModal(false)}
            onSubmit={handleAddCookie}
          />
        )}
        {showDeleteModal && (
          <DeleteConfirmModal
            count={selectedCookies.size}
            onClose={() => setShowDeleteModal(false)}
            onConfirm={handleBulkDelete}
          />
        )}
      </AnimatePresence>

      {/* Toast Notifications */}
      <Toast toast={toast} />
    </div>
  );
}

export default App;
