import { motion } from 'framer-motion';

function CookiesTable({ cookies, loading, selectedCookies, setSelectedCookies, onToggle, onDelete }) {
  const handleSelectAll = (e) => {
    if (e.target.checked) {
      setSelectedCookies(new Set(cookies.map(c => c.region)));
    } else {
      setSelectedCookies(new Set());
    }
  };

  const handleSelectOne = (region, checked) => {
    const newSelected = new Set(selectedCookies);
    if (checked) {
      newSelected.add(region);
    } else {
      newSelected.delete(region);
    }
    setSelectedCookies(newSelected);
  };

  const isAllSelected = cookies.length > 0 && selectedCookies.size === cookies.length;
  const isSomeSelected = selectedCookies.size > 0 && !isAllSelected;

  if (loading) {
    return (
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: '40px' }}><input type="checkbox" disabled /></th>
              <th>Region</th>
              <th>Status</th>
              <th>Requests</th>
              <th>Success Rate</th>
              <th>Avg Response Time</th>
              <th>Last Used</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {[...Array(5)].map((_, i) => (
              <tr key={i}>
                <td><div className="skeleton" style={{ width: '18px', height: '18px' }}></div></td>
                <td><div className="skeleton" style={{ height: '14px', width: '80px' }}></div></td>
                <td><div className="skeleton" style={{ height: '20px', width: '60px' }}></div></td>
                <td><div className="skeleton" style={{ height: '14px', width: '40px' }}></div></td>
                <td><div className="skeleton" style={{ height: '20px', width: '50px' }}></div></td>
                <td><div className="skeleton" style={{ height: '14px', width: '50px' }}></div></td>
                <td><div className="skeleton" style={{ height: '14px', width: '120px' }}></div></td>
                <td><div className="skeleton" style={{ height: '28px', width: '120px' }}></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (cookies.length === 0) {
    return (
      <motion.div
        className="table-container"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        <div className="empty-state">
          <div className="empty-state-icon">🍪</div>
          <h3>No cookies yet</h3>
          <p>Add your first cookie to get started</p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="table-container"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3 }}
    >
      <table>
        <thead>
          <tr>
            <th style={{ width: '40px' }}>
              <input
                type="checkbox"
                checked={isAllSelected}
                ref={input => {
                  if (input) {
                    input.indeterminate = isSomeSelected;
                  }
                }}
                onChange={handleSelectAll}
              />
            </th>
            <th>Region</th>
            <th>Status</th>
            <th>Requests</th>
            <th>Success Rate</th>
            <th>Avg Response Time</th>
            <th>Last Used</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {cookies.map((cookie) => {
            const isSelected = selectedCookies.has(cookie.region);
            
            return (
              <motion.tr
                key={cookie.region}
                className={isSelected ? 'selected' : ''}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <td>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(e) => handleSelectOne(cookie.region, e.target.checked)}
                  />
                </td>
                <td><strong>{cookie.region}</strong></td>
                <td>
                  <span className={`badge ${cookie.active ? 'active' : 'inactive'}`}>
                    {cookie.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td>{cookie.request_count.toLocaleString()}</td>
                <td>
                  <span className={`success-rate ${
                    cookie.successRate > 80 ? 'good' : 
                    cookie.successRate > 50 ? 'ok' : 'bad'
                  }`}>
                    {cookie.successRate}%
                  </span>
                </td>
                <td>{cookie.avgResponseTime}ms</td>
                <td>{cookie.lastUsedDate ? new Date(cookie.lastUsedDate).toLocaleString() : 'Never'}</td>
                <td>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => onToggle(cookie.region)}
                      style={{ padding: '6px 12px', fontSize: '12px' }}
                    >
                      {cookie.active ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      className="danger"
                      onClick={() => onDelete(cookie.region)}
                      style={{ padding: '6px 12px', fontSize: '12px' }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </motion.tr>
            );
          })}
        </tbody>
      </table>
    </motion.div>
  );
}

export default CookiesTable;
