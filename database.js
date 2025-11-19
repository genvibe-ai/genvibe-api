// PostgreSQL Database Adapter
// Auto-switches between SQLite (local) and PostgreSQL (production)

import pg from 'pg';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Determine which database to use
const usePostgres = !!process.env.DATABASE_URL;
const isProduction = process.env.NODE_ENV === 'production';

console.log(`🗄️  Database: ${usePostgres ? 'PostgreSQL' : 'SQLite'}`);

let db, pool;

if (usePostgres) {
  // PostgreSQL for production (Render)
  const { Pool } = pg;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined
  });
  
  console.log('✅ PostgreSQL pool created');
} else {
  // SQLite for local development
  db = new Database(join(__dirname, 'lmarena.db'));
  db.pragma('journal_mode = WAL');
  
  console.log('✅ SQLite database loaded');
}

// Initialize database tables
async function initializeDatabase() {
  if (usePostgres) {
    await initializePostgreSQL();
  } else {
    initializeSQLite();
  }
}

function initializeSQLite() {
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS request_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER DEFAULT (strftime('%s', 'now')),
      region TEXT NOT NULL,
      model TEXT NOT NULL,
      success INTEGER DEFAULT 0,
      response_time INTEGER DEFAULT 0,
      error_message TEXT
    )
  `);

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

  console.log('✅ SQLite tables initialized');
}

async function initializePostgreSQL() {
  const client = await pool.connect();
  
  try {
    // Cookies table
    await client.query(`
      CREATE TABLE IF NOT EXISTS cookies (
        id SERIAL PRIMARY KEY,
        region TEXT UNIQUE NOT NULL,
        cookie TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        request_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        network_error_count INTEGER DEFAULT 0,
        auth_error_count INTEGER DEFAULT 0,
        total_response_time BIGINT DEFAULT 0,
        last_used BIGINT DEFAULT 0,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
        updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
      )
    `);

    // Request stats table
    await client.query(`
      CREATE TABLE IF NOT EXISTS request_stats (
        id SERIAL PRIMARY KEY,
        timestamp BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
        region TEXT NOT NULL,
        model TEXT NOT NULL,
        success INTEGER DEFAULT 0,
        response_time INTEGER DEFAULT 0,
        error_message TEXT
      )
    `);

    // API stats table
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_stats (
        id SERIAL PRIMARY KEY,
        date TEXT UNIQUE NOT NULL,
        total_requests INTEGER DEFAULT 0,
        successful_requests INTEGER DEFAULT 0,
        failed_requests INTEGER DEFAULT 0,
        total_response_time BIGINT DEFAULT 0,
        image_requests INTEGER DEFAULT 0
      )
    `);

    console.log('✅ PostgreSQL tables initialized');
  } finally {
    client.release();
  }
}

// Cookie operations
export const cookieDB = {
  // Get all cookies
  async getAll() {
    if (usePostgres) {
      const result = await pool.query('SELECT * FROM cookies ORDER BY region');
      return result.rows;
    } else {
      return db.prepare('SELECT * FROM cookies ORDER BY region').all();
    }
  },

  // Get active cookies only
  async getActive() {
    if (usePostgres) {
      const result = await pool.query('SELECT * FROM cookies WHERE active = 1');
      return result.rows;
    } else {
      return db.prepare('SELECT * FROM cookies WHERE active = 1').all();
    }
  },

  // Get cookie by region
  async getByRegion(region) {
    if (usePostgres) {
      const result = await pool.query('SELECT * FROM cookies WHERE region = $1', [region]);
      return result.rows[0];
    } else {
      return db.prepare('SELECT * FROM cookies WHERE region = ?').get(region);
    }
  },

  // Add new cookie
  async add(region, cookie) {
    try {
      if (usePostgres) {
        const result = await pool.query(
          'INSERT INTO cookies (region, cookie, active) VALUES ($1, $2, 1) RETURNING id',
          [region, cookie]
        );
        return { id: result.rows[0].id, region, success: true };
      } else {
        const stmt = db.prepare('INSERT INTO cookies (region, cookie, active) VALUES (?, ?, 1)');
        const result = stmt.run(region, cookie);
        return { id: result.lastInsertRowid, region, success: true };
      }
    } catch (error) {
      if (error.message.includes('unique') || error.message.includes('UNIQUE')) {
        throw new Error(`Cookie for region "${region}" already exists`);
      }
      throw error;
    }
  },

  // Update cookie
  async update(region, cookie, active = true) {
    if (usePostgres) {
      const result = await pool.query(
        'UPDATE cookies SET cookie = $1, active = $2, updated_at = EXTRACT(EPOCH FROM NOW()) WHERE region = $3',
        [cookie, active ? 1 : 0, region]
      );
      return result.rowCount > 0;
    } else {
      const stmt = db.prepare('UPDATE cookies SET cookie = ?, active = ?, updated_at = strftime(\'%s\', \'now\') WHERE region = ?');
      const result = stmt.run(cookie, active ? 1 : 0, region);
      return result.changes > 0;
    }
  },

  // Toggle active status
  async toggleActive(region) {
    if (usePostgres) {
      const result = await pool.query(
        'UPDATE cookies SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END, updated_at = EXTRACT(EPOCH FROM NOW()) WHERE region = $1',
        [region]
      );
      return result.rowCount > 0;
    } else {
      const stmt = db.prepare('UPDATE cookies SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END, updated_at = strftime(\'%s\', \'now\') WHERE region = ?');
      const result = stmt.run(region);
      return result.changes > 0;
    }
  },

  // Delete cookie
  async delete(region) {
    if (usePostgres) {
      // Delete related stats first
      await pool.query('DELETE FROM request_stats WHERE region = $1', [region]);
      // Delete cookie
      const result = await pool.query('DELETE FROM cookies WHERE region = $1', [region]);
      return result.rowCount > 0;
    } else {
      db.prepare('DELETE FROM request_stats WHERE region = ?').run(region);
      const stmt = db.prepare('DELETE FROM cookies WHERE region = ?');
      const result = stmt.run(region);
      return result.changes > 0;
    }
  },

  // Record request
  async recordRequest(region, success, responseTime, errorMessage = null) {
    if (usePostgres) {
      await pool.query(
        `UPDATE cookies 
         SET request_count = request_count + 1,
             success_count = success_count + $1,
             error_count = error_count + $2,
             total_response_time = total_response_time + $3,
             last_used = EXTRACT(EPOCH FROM NOW()),
             updated_at = EXTRACT(EPOCH FROM NOW())
         WHERE region = $4`,
        [success ? 1 : 0, success ? 0 : 1, responseTime || 0, region]
      );

      await pool.query(
        'INSERT INTO request_stats (region, model, success, response_time, error_message) VALUES ($1, $2, $3, $4, $5)',
        [region, 'unknown', success ? 1 : 0, responseTime || 0, errorMessage]
      );
    } else {
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

      const statsStmt = db.prepare('INSERT INTO request_stats (region, model, success, response_time, error_message) VALUES (?, ?, ?, ?, ?)');
      statsStmt.run(region, 'unknown', success ? 1 : 0, responseTime || 0, errorMessage);
    }
  },

  // Get cookie stats with calculated fields
  async getStats() {
    const cookies = await this.getAll();
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
  async resetStats() {
    if (usePostgres) {
      const result = await pool.query(`
        UPDATE cookies 
        SET request_count = 0,
            success_count = 0,
            error_count = 0,
            network_error_count = 0,
            auth_error_count = 0,
            total_response_time = 0,
            updated_at = EXTRACT(EPOCH FROM NOW())
      `);
      return result.rowCount;
    } else {
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
  }
};

// Stats operations
export const statsDB = {
  async recordDaily(date, requests, successful, failed, responseTime, imageRequests = 0) {
    if (usePostgres) {
      await pool.query(`
        INSERT INTO api_stats (date, total_requests, successful_requests, failed_requests, total_response_time, image_requests)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(date) DO UPDATE SET
          total_requests = api_stats.total_requests + $2,
          successful_requests = api_stats.successful_requests + $3,
          failed_requests = api_stats.failed_requests + $4,
          total_response_time = api_stats.total_response_time + $5,
          image_requests = api_stats.image_requests + $6
      `, [date, requests, successful, failed, responseTime, imageRequests]);
    } else {
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
      stmt.run(date, requests, successful, failed, responseTime, imageRequests, requests, successful, failed, responseTime, imageRequests);
    }
  },

  async getRange(startDate, endDate) {
    if (usePostgres) {
      const result = await pool.query('SELECT * FROM api_stats WHERE date BETWEEN $1 AND $2 ORDER BY date DESC', [startDate, endDate]);
      return result.rows;
    } else {
      return db.prepare('SELECT * FROM api_stats WHERE date BETWEEN ? AND ? ORDER BY date DESC').all(startDate, endDate);
    }
  },

  async getRecent(days = 7) {
    if (usePostgres) {
      const result = await pool.query('SELECT * FROM api_stats ORDER BY date DESC LIMIT $1', [days]);
      return result.rows;
    } else {
      return db.prepare('SELECT * FROM api_stats ORDER BY date DESC LIMIT ?').all(days);
    }
  },

  async getTotal() {
    if (usePostgres) {
      const result = await pool.query(`
        SELECT 
          COALESCE(SUM(total_requests), 0)::int as total_requests,
          COALESCE(SUM(successful_requests), 0)::int as successful_requests,
          COALESCE(SUM(failed_requests), 0)::int as failed_requests,
          COALESCE(SUM(total_response_time), 0)::bigint as total_response_time,
          COALESCE(SUM(image_requests), 0)::int as image_requests
        FROM api_stats
      `);
      return result.rows[0];
    } else {
      return db.prepare(`
        SELECT 
          SUM(total_requests) as total_requests,
          SUM(successful_requests) as successful_requests,
          SUM(failed_requests) as failed_requests,
          SUM(total_response_time) as total_response_time,
          SUM(image_requests) as image_requests
        FROM api_stats
      `).get();
    }
  }
};

// Initialize database on import
await initializeDatabase();

export default usePostgres ? pool : db;
