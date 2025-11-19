import { motion } from 'framer-motion';

function StatsGrid({ stats, loading }) {
  if (loading) {
    return (
      <div className="stats-grid">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="stat-card">
            <div className="skeleton" style={{ height: '14px', width: '80px', marginBottom: '12px' }}></div>
            <div className="skeleton" style={{ height: '36px', width: '60px' }}></div>
          </div>
        ))}
      </div>
    );
  }

  const statsData = [
    { label: 'Total Cookies', value: stats.cookies.total, type: 'info' },
    { label: 'Active Cookies', value: stats.cookies.active, type: 'success' },
    { label: 'Total Requests', value: stats.requests.total.toLocaleString(), type: 'info' },
    { 
      label: 'Success Rate', 
      value: `${stats.requests.successRate}%`,
      type: stats.requests.successRate > 80 ? 'success' : stats.requests.successRate > 50 ? 'warning' : 'danger'
    }
  ];

  return (
    <motion.div
      className="stats-grid"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1, duration: 0.4 }}
    >
      {statsData.map((stat, index) => (
        <motion.div
          key={stat.label}
          className="stat-card"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.1 + index * 0.05 }}
        >
          <div className="stat-label">{stat.label}</div>
          <div className={`stat-value ${stat.type}`}>{stat.value}</div>
        </motion.div>
      ))}
    </motion.div>
  );
}

export default StatsGrid;
