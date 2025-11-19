import { motion, AnimatePresence } from 'framer-motion';

function Toast({ toast }) {
  if (!toast) return null;

  const icons = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ'
  };

  return (
    <div className="toast-container">
      <AnimatePresence>
        {toast && (
          <motion.div
            className={`toast ${toast.type}`}
            initial={{ opacity: 0, y: 50, scale: 0.3 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.5, transition: { duration: 0.2 } }}
            transition={{ type: 'spring', damping: 20 }}
          >
            <div style={{ fontSize: '20px' }}>{icons[toast.type] || icons.info}</div>
            <div className="toast-content">
              {toast.title && <div className="toast-title">{toast.title}</div>}
              <div className="toast-message">{toast.message}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default Toast;
