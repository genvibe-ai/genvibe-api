import { useState } from 'react';
import { motion } from 'framer-motion';

function AddCookieModal({ onClose, onSubmit }) {
  const [region, setRegion] = useState('');
  const [cookie, setCookie] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!region.trim() || !cookie.trim()) {
      return;
    }

    setSubmitting(true);
    await onSubmit(region.trim(), cookie.trim());
    setSubmitting(false);
  };

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
      >
        <h2>Add New Cookie</h2>
        <p>Add a new cookie to expand your API access</p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="region">Region Name</label>
            <input
              id="region"
              type="text"
              placeholder="e.g., us-east, europe-1, asia-pacific"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              disabled={submitting}
              autoFocus
            />
          </div>

          <div className="form-group">
            <label htmlFor="cookie">Cookie String</label>
            <textarea
              id="cookie"
              placeholder="Paste your full cookie string here..."
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              disabled={submitting}
            ></textarea>
          </div>

          <div className="modal-actions">
            <button
              type="button"
              className="ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="success"
              disabled={submitting || !region.trim() || !cookie.trim()}
            >
              {submitting ? 'Adding...' : 'Add Cookie'}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}

export default AddCookieModal;
