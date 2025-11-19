import express from 'express';
import { cookieDB, statsDB } from './database.js';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================== COOKIE MANAGEMENT ====================

// Get all cookies with stats
router.get('/api/cookies', (req, res) => {
  try {
    const cookies = cookieDB.getStats();
    res.json({ success: true, data: cookies });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add new cookie
router.post('/api/cookies', (req, res) => {
  try {
    const { region, cookie } = req.body;
    
    if (!region || !cookie) {
      return res.status(400).json({ 
        success: false, 
        error: 'Region and cookie are required' 
      });
    }

    const result = cookieDB.add(region, cookie);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Update cookie
router.put('/api/cookies/:region', (req, res) => {
  try {
    const { region } = req.params;
    const { cookie, active } = req.body;

    if (!cookie) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cookie is required' 
      });
    }

    const success = cookieDB.update(region, cookie, active);
    
    if (success) {
      res.json({ success: true, message: `Cookie for ${region} updated` });
    } else {
      res.status(404).json({ success: false, error: 'Cookie not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Toggle cookie active status
router.patch('/api/cookies/:region/toggle', (req, res) => {
  try {
    const { region } = req.params;
    const success = cookieDB.toggleActive(region);
    
    if (success) {
      const cookie = cookieDB.getByRegion(region);
      res.json({ 
        success: true, 
        message: `Cookie for ${region} ${cookie.active ? 'enabled' : 'disabled'}`,
        active: cookie.active === 1
      });
    } else {
      res.status(404).json({ success: false, error: 'Cookie not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete cookie
router.delete('/api/cookies/:region', (req, res) => {
  try {
    const { region } = req.params;
    const success = cookieDB.delete(region);
    
    if (success) {
      res.json({ success: true, message: `Cookie for ${region} deleted` });
    } else {
      res.status(404).json({ success: false, error: 'Cookie not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bulk delete cookies (for multi-select)
router.post('/api/cookies/bulk-delete', (req, res) => {
  try {
    const { regions } = req.body;
    
    if (!Array.isArray(regions) || regions.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Regions array is required' 
      });
    }

    let deleted = 0;
    for (const region of regions) {
      if (cookieDB.delete(region)) {
        deleted++;
      }
    }

    res.json({ 
      success: true, 
      message: `Deleted ${deleted} cookie(s)`,
      count: deleted
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reset all stats
router.post('/api/cookies/reset-stats', (req, res) => {
  try {
    cookieDB.resetStats();
    res.json({ success: true, message: 'All stats reset' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== STATS ====================

// Get dashboard summary
router.get('/api/stats/summary', (req, res) => {
  try {
    const cookies = cookieDB.getStats();
    const totalStats = statsDB.getTotal();
    const recentStats = statsDB.getRecent(7);

    const activeCookies = cookies.filter(c => c.active === 1).length;
    const totalRequests = cookies.reduce((sum, c) => sum + c.request_count, 0);
    const totalSuccess = cookies.reduce((sum, c) => sum + c.success_count, 0);
    const totalErrors = cookies.reduce((sum, c) => sum + c.error_count, 0);
    const avgSuccessRate = totalRequests > 0 
      ? ((totalSuccess / totalRequests) * 100).toFixed(1)
      : 100;

    res.json({
      success: true,
      data: {
        cookies: {
          total: cookies.length,
          active: activeCookies,
          inactive: cookies.length - activeCookies
        },
        requests: {
          total: totalRequests,
          successful: totalSuccess,
          failed: totalErrors,
          successRate: parseFloat(avgSuccessRate)
        },
        recentActivity: recentStats,
        topPerformers: cookies
          .filter(c => c.active === 1)
          .sort((a, b) => b.successRate - a.successRate)
          .slice(0, 5)
          .map(c => ({
            region: c.region,
            successRate: c.successRate,
            requests: c.request_count,
            avgResponseTime: c.avgResponseTime
          }))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get health status
router.get('/api/health', (req, res) => {
  try {
    const cookies = cookieDB.getActive();
    const allCookies = cookieDB.getAll();
    
    const healthy = cookies.filter(c => {
      if (c.request_count === 0) return true;
      const successRate = (c.success_count / c.request_count) * 100;
      return successRate > 80;
    }).length;

    const degraded = cookies.filter(c => {
      if (c.request_count === 0) return false;
      const successRate = (c.success_count / c.request_count) * 100;
      return successRate > 50 && successRate <= 80;
    }).length;

    const failing = cookies.filter(c => {
      if (c.request_count === 0) return false;
      const successRate = (c.success_count / c.request_count) * 100;
      return successRate <= 50;
    }).length;

    res.json({
      success: true,
      data: {
        status: failing > cookies.length * 0.3 ? 'critical' : 
                degraded > cookies.length * 0.3 ? 'degraded' : 'healthy',
        activeCookies: cookies.length,
        totalCookies: allCookies.length,
        healthy,
        degraded,
        failing
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ==================== SERVE REACT DASHBOARD ====================
// Note: Static assets are served from the main app, not the router

// Serve React app for dashboard route
router.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'dashboard-dist', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      // Fallback if build doesn't exist yet
      res.status(500).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Dashboard Build Required</title>
            <style>
              body {
                font-family: sans-serif;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 100vh;
                margin: 0;
                background: #0a0e1a;
                color: #fff;
              }
              .message {
                text-align: center;
                padding: 40px;
                background: #1e293b;
                border-radius: 12px;
                max-width: 500px;
              }
              code {
                background: #0f172a;
                padding: 4px 8px;
                border-radius: 4px;
                font-family: monospace;
              }
            </style>
          </head>
          <body>
            <div class="message">
              <h1>⚠️ Dashboard Not Built</h1>
              <p>Please build the React dashboard first:</p>
              <pre><code>cd genvibe-api/dashboard && npm install && npm run build</code></pre>
            </div>
          </body>
        </html>
      `);
    }
  });
});

export default router;

