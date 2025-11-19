import { motion } from 'framer-motion';

function DeleteConfirmModal({ count, onClose, onConfirm }) {
  return (
    <motion.div
      className="modal-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="modal"
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        transition={{ type: 'spring', damping: 20 }}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '480px' }}
      >
        <h2>⚠️ Confirm Deletion</h2>
        <p>
          Are you sure you want to delete <strong>{count}</strong> cookie{count > 1 ? 's' : ''}? 
          This action cannot be undone.
        </p>

        <div className="modal-actions">
          <button
            type="button"
            className="ghost"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            onClick={onConfirm}
          >
            Delete {count} Cookie{count > 1 ? 's' : ''}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default DeleteConfirmModal;
