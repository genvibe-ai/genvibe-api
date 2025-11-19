import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const db = new Database(join(__dirname, 'lmarena.db'));
db.pragma('journal_mode = WAL'); // Better performance

// Initialize database tables
function initializeDatabase() {
  // Cookies table
  db.exec(`
    CREATE TABLE IF NOT EXISTS cookies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      region TEXT UNIQUE NOT NULL,
      cookie TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      request_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      network_error_count INTEGER DEFAULT 0,
      auth_error_count INTEGER DEFAULT 0,
      total_response_time INTEGER DEFAULT 0,
      last_used INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // Request stats table
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER DEFAULT (strftime('%s', 'now')),
      region TEXT NOT NULL,
      model TEXT NOT NULL,
      success INTEGER DEFAULT 0,
      response_time INTEGER DEFAULT 0,
      error_message TEXT,
      FOREIGN KEY (region) REFERENCES cookies(region)
    )
  `);

  // API stats table
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE NOT NULL,
      total_requests INTEGER DEFAULT 0,
      successful_requests INTEGER DEFAULT 0,
      failed_requests INTEGER DEFAULT 0,
      total_response_time INTEGER DEFAULT 0,
      image_requests INTEGER DEFAULT 0
    )
  `);

  console.log('✅ Database initialized');
}

// Cookie operations
export const cookieDB = {
  // Get all cookies
  getAll() {
    return db.prepare('SELECT * FROM cookies ORDER BY region').all();
  },

  // Get active cookies only
  getActive() {
    return db.prepare('SELECT * FROM cookies WHERE active = 1').all();
  },

  // Get cookie by region
  getByRegion(region) {
    return db.prepare('SELECT * FROM cookies WHERE region = ?').get(region);
  },

  // Add new cookie
  add(region, cookie) {
    try {
      const stmt = db.prepare(`
        INSERT INTO cookies (region, cookie, active)
        VALUES (?, ?, 1)
      `);
      const result = stmt.run(region, cookie);
      return { id: result.lastInsertRowid, region, success: true };
    } catch (error) {
      if (error.message.includes('UNIQUE constraint')) {
        throw new Error(`Cookie for region "${region}" already exists`);
      }
      throw error;
    }
  },

  // Update cookie
  update(region, cookie, active = true) {
    const stmt = db.prepare(`
      UPDATE cookies 
      SET cookie = ?, active = ?, updated_at = strftime('%s', 'now')
      WHERE region = ?
    `);
    const result = stmt.run(cookie, active ? 1 : 0, region);
    return result.changes > 0;
  },

  // Toggle active status
  toggleActive(region) {
    const stmt = db.prepare(`
      UPDATE cookies 
      SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END,
          updated_at = strftime('%s', 'now')
      WHERE region = ?
    `);
    const result = stmt.run(region);
    return result.changes > 0;
  },

  // Delete cookie
  delete(region) {
    // First delete all related stats records to avoid foreign key constraint
    const deleteStatsStmt = db.prepare('DELETE FROM request_stats WHERE region = ?');
    deleteStatsStmt.run(region);

    // Then delete the cookie
    const stmt = db.prepare('DELETE FROM cookies WHERE region = ?');
    const result = stmt.run(region);
    return result.changes > 0;
  },

  // Record request
  recordRequest(region, success, responseTime, errorMessage = null) {
    const updateStmt = db.prepare(`
      UPDATE cookies 
      SET request_count = request_count + 1,
          success_count = success_count + ?,
          error_count = error_count + ?,
          total_response_time = total_response_time + ?,
          last_used = strftime('%s', 'now'),
          updated_at = strftime('%s', 'now')
      WHERE region = ?
    `);
    updateStmt.run(success ? 1 : 0, success ? 0 : 1, responseTime || 0, region);

    // Record in stats table
    const statsStmt = db.prepare(`
      INSERT INTO request_stats (region, model, success, response_time, error_message)
      VALUES (?, ?, ?, ?, ?)
    `);
    statsStmt.run(region, 'unknown', success ? 1 : 0, responseTime || 0, errorMessage);
  },

  // Get cookie stats with calculated fields
  getStats() {
    const cookies = this.getAll();
    return cookies.map(cookie => {
      const successRate = cookie.request_count > 0 
        ? (cookie.success_count / cookie.request_count * 100).toFixed(1)
        : 100;
      const avgResponseTime = cookie.success_count > 0
        ? Math.round(cookie.total_response_time / cookie.success_count)
        : 0;
      
      return {
        ...cookie,
        successRate: parseFloat(successRate),
        avgResponseTime,
        lastUsedDate: cookie.last_used ? new Date(cookie.last_used * 1000).toISOString() : null
      };
    });
  },

  // Reset all stats
  resetStats() {
    const stmt = db.prepare(`
      UPDATE cookies 
      SET request_count = 0,
          success_count = 0,
          error_count = 0,
          network_error_count = 0,
          auth_error_count = 0,
          total_response_time = 0,
          updated_at = strftime('%s', 'now')
    `);
    return stmt.run();
  }
};

// Stats operations
export const statsDB = {
  // Record daily stats
  recordDaily(date, requests, successful, failed, responseTime, imageRequests = 0) {
    const stmt = db.prepare(`
      INSERT INTO api_stats (date, total_requests, successful_requests, failed_requests, total_response_time, image_requests)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        total_requests = total_requests + ?,
        successful_requests = successful_requests + ?,
        failed_requests = failed_requests + ?,
        total_response_time = total_response_time + ?,
        image_requests = image_requests + ?
    `);
    stmt.run(
      date, requests, successful, failed, responseTime, imageRequests,
      requests, successful, failed, responseTime, imageRequests
    );
  },

  // Get stats for date range
  getRange(startDate, endDate) {
    const stmt = db.prepare(`
      SELECT * FROM api_stats 
      WHERE date BETWEEN ? AND ?
      ORDER BY date DESC
    `);
    return stmt.all(startDate, endDate);
  },

  // Get recent stats
  getRecent(days = 7) {
    const stmt = db.prepare(`
      SELECT * FROM api_stats 
      ORDER BY date DESC 
      LIMIT ?
    `);
    return stmt.all(days);
  },

  // Get total stats
  getTotal() {
    const stmt = db.prepare(`
      SELECT 
        SUM(total_requests) as total_requests,
        SUM(successful_requests) as successful_requests,
        SUM(failed_requests) as failed_requests,
        SUM(total_response_time) as total_response_time,
        SUM(image_requests) as image_requests
      FROM api_stats
    `);
    return stmt.get();
  }
};

// Initialize database on import
initializeDatabase();

export default db;
