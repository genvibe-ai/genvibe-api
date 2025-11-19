import express from 'express';
import axios from 'axios';
import { uuidv7 } from 'uuidv7';
import fs from 'node:fs';
import http from 'http';
import https from 'https';
import PQueue from 'p-queue';
import FormData from 'form-data';
import dashboardRouter from './dashboard.js';
import { cookieDB } from './database.js';

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ==================== DASHBOARD ====================
// Serve dashboard static assets (must come before router)
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard-dist')));

// Dashboard routes
app.use('/dashboard', dashboardRouter);

// ==================== CONFIGURATION ====================
const CONFIG = {
  port: process.env.PORT || 3000,

  serverTimeout: 0, // 0 = infinite (never timeout)
  requestTimeout: 900000, // 15 minutes for individual requests (allows long streaming)

  // ═══ REQUEST QUEUE CONFIGURATION ═══
  queue: {
    enabled: true, // Enable request queuing for production stability
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '20'), // 20 concurrent = 20 cookies × 20 unique IPs (optimal!)
    timeout: 900000, // 15 minutes queue timeout (was 2 min - too short for long streams!)
    streamingTimeout: 1800000, // 30 minutes for streaming requests (very long AI responses)
    throwOnTimeout: false, // Don't throw errors on timeout, just drop the request
    minRequestInterval: 20, // Premium proxies: ultra-fast rate (each = different IP)
  },

  // MULTI-REGION COOKIES - Loaded from database
  cookies: [],

  maxPayloadBytes: 200000, // LMArena accepts moderate payloads (tested: 166KB works, 290KB fails)
  maxMessageBytes: 85000, // Safe message limit: 80.7KB proven to work, staying close at 85KB to avoid hallucinations

  models: {
    'claude-4.1-opus-thinking': {
      id: 'claude-4.1-opus-thinking',
      lmarenaId: 'f1a2eb6f-fc30-4806-9e00-1efd0d73cbc4',
      name: 'Claude Opus 4.1',
    },
    'claude-4.5-sonnet': {
      id: 'claude-4.5-sonnet',
      lmarenaId: '019a2d13-28a5-7205-908c-0a58de904617',
      name: 'Claude Sonnet 4.5',
    },
    'claude-4.5-sonnet-thinking': {
      id: 'claude-4.5-sonnet-thinking',
      lmarenaId: 'b0ea1407-2f92-4515-b9cc-b22a6d6c14f2',
      name: 'Claude 4.5 Sonnet Thinking',
    },
    'gpt-5-high': {
      id: 'gpt-5-high',
      lmarenaId: '983bc566-b783-4d28-b24c-3c8b08eb1086',
      name: 'GPT 5 High',
    },
    'gpt-5-1': {
      id: 'gpt-5-1',
      lmarenaId: '019a7ebf-0f3f-7518-8899-fca13e32d9dc',
      name: 'GPT-5.1',
    },
    'gemini-3-pro': {
      id: 'gemini-3-pro',
      lmarenaId: '019a76f3-7595-76d0-8005-97511a795f0d',
      name: 'Gemini 3 Pro',
    },
  },
};

// ==================== LOAD COOKIES FROM DATABASE ====================
async function loadCookiesFromDB() {
  try {
    const dbCookies = await cookieDB.getActive();
    console.log(`📥 Loading ${dbCookies.length} active cookies from database...`);

    return dbCookies.map((c) => ({
      region: c.region,
      cookie: c.cookie,
      active: c.active === 1,
      requestCount: c.request_count || 0,
      lastUsed: c.last_used || 0,
      errors: c.error_count || 0,
      successRate: c.request_count > 0 ? (c.success_count / c.request_count) * 100 : 100,
      updatedAt: c.updated_at || 0,
    }));
  } catch (error) {
    console.error(`❌ Failed to load cookies from database:`, error.message);
    return [];
  }
}

// Load cookies from database (async initialization)
const cookiesLoaded = (async () => {
  CONFIG.cookies = await loadCookiesFromDB();
  
  if (CONFIG.cookies.length === 0) {
    console.warn(
      `⚠️  No cookies found in database! Please add cookies via dashboard at http://localhost:${CONFIG.port}/dashboard`,
    );
  } else {
    console.log(`✅ Loaded ${CONFIG.cookies.length} cookies from database`);
    CONFIG.cookies.forEach((c) => {
      console.log(`   - ${c.region}: ${c.requestCount} requests, ${c.successRate.toFixed(1)}% success`);
    });
    CONFIG.cookies.forEach((c) => {
      try {
        const names = String(c.cookie)
          .split(';')
          .map((p) => p.trim().split('=')[0].toLowerCase());
        const hasClearance = names.includes('cf_clearance');
        const hasBm = names.includes('__cf_bm');
        const hasAuth = names.some((n) => n.includes('arena-auth'));
        console.log(
          `   ↳ ${c.region} cookie components: cf_clearance=${hasClearance ? '✓' : '✗'}, __cf_bm=${
            hasBm ? '✓' : '✗'
          }, arena-auth=${hasAuth ? '✓' : '✗'}`,
        );
      } catch {}
    });
  }
  initializeCookieStats(); // Initialize stats after cookies are loaded
  return true;
})();

// Cookie cache timestamp - reload every 5 seconds to pick up DB changes
let cookiesLastLoaded = Date.now();
const COOKIE_RELOAD_INTERVAL = 5000; // 5 seconds

// Cookie stats
let cookieStats = {};

// Initialize cookie stats
function initializeCookieStats() {
  for (const cookie of CONFIG.cookies) {
    cookieStats[cookie.region] = {
      requestCount: cookie.requestCount || 0,
      errorCount: cookie.errors || 0,
      networkErrorCount: 0,
      authErrorCount: 0,
      successCount: Math.round((cookie.requestCount * cookie.successRate) / 100) || 0,
      lastError: null,
      lastUsed: cookie.lastUsed || null,
      averageResponseTime: 0,
      totalResponseTime: 0,
      cooldownUntil: 0,
    };
  }
}

initializeCookieStats();

const REFRESH_CHECK_INTERVAL_MS = parseInt(process.env.REFRESH_CHECK_INTERVAL_MS || '600000');
const CF_REFRESH_AGE_MS = parseInt(process.env.CF_REFRESH_AGE_MS || '3000000');
const AUTH_REFRESH_LEAD_MS = parseInt(process.env.AUTH_REFRESH_LEAD_MS || '600000');

function parseArenaAuthExpiry(cookieStr) {
  try {
    const parts = String(cookieStr)
      .split(';')
      .map((p) => p.trim());
    const authPart = parts.find(
      (p) => p.toLowerCase().startsWith('arena-auth') || p.toLowerCase().startsWith('arena-auth-prod-v1'),
    );
    if (!authPart) return null;
    const eqIdx = authPart.indexOf('=');
    if (eqIdx === -1) return null;
    let val = authPart.slice(eqIdx + 1);
    if (val.startsWith('base64-')) {
      val = val.slice('base64-'.length);
    }
    let json;
    try {
      const decoded = Buffer.from(val, 'base64').toString('utf8');
      json = JSON.parse(decoded);
    } catch {
      try {
        json = JSON.parse(val);
      } catch {
        return null;
      }
    }
    if (json && (json.expires_at || json.expiresAt)) {
      const ts = json.expires_at || json.expiresAt;
      if (typeof ts === 'number') return ts * 1000;
      const d = Date.parse(ts);
      if (!Number.isNaN(d)) return d;
    }
    if (json && typeof json.expires_in === 'number') {
      const updated = Date.now();
      return updated + json.expires_in * 1000;
    }
    return null;
  } catch {
    return null;
  }
}

// Ensure stats exist for a region (handles newly added cookies)
function ensureCookieStats(region) {
  if (!cookieStats[region]) {
    cookieStats[region] = {
      requestCount: 0,
      errorCount: 0,
      networkErrorCount: 0,
      authErrorCount: 0,
      successCount: 0,
      lastError: null,
      lastUsed: null,
      averageResponseTime: 0,
      totalResponseTime: 0,
      cooldownUntil: 0,
    };
  }
}

// ═══ INITIALIZE REQUEST QUEUE ═══
const requestQueue = new PQueue({
  concurrency: CONFIG.queue.maxConcurrent,
  timeout: CONFIG.queue.timeout,
  throwOnTimeout: CONFIG.queue.throwOnTimeout,
  interval: CONFIG.queue.minRequestInterval, // Min 500ms between requests
  intervalCap: 1, // Max 1 request per interval (avoids IP rate limits)
});

// Queue statistics
const queueStats = {
  totalQueued: 0,
  totalProcessed: 0,
  totalTimeout: 0,
  totalSuccess: 0,
  totalFailure: 0,
};

requestQueue.on('add', () => {
  queueStats.totalQueued++;
});

requestQueue.on('next', () => {
  queueStats.totalProcessed++;
});

requestQueue.on('completed', () => {
  queueStats.totalSuccess++;
});

requestQueue.on('error', () => {
  queueStats.totalFailure++;
});

console.log(`🔄 Request Queue initialized:`);
console.log(`   Max Concurrent: ${CONFIG.queue.maxConcurrent} requests`);
console.log(`   Queue Timeout: ${CONFIG.queue.timeout / 1000}s per request`);
console.log(`   Status: ${CONFIG.queue.enabled ? '✅ ENABLED' : '❌ DISABLED'}`);

// Rate limiting
let rateLimit = {
  total: 0,
  remaining: 0,
  resetAt: 0,
};

// ==================== ADAPTIVE RATE PACER (GLOBAL/MODEL/COOKIE) ====================
const RATE_PACER = (() => {
  const safety = parseFloat(process.env.RL_SAFETY || '0.85');
  const defaultWindow = parseInt(process.env.RL_DEFAULT_WINDOW || '300', 10); // seconds
  const defaultLimit = parseInt(process.env.RL_DEFAULT_LIMIT || '3000', 10);

  const buckets = new Map(); // scope -> {limit, window, tokens, lastRefill, cooldownUntil, lastHeader}

  function scopeKeys(modelId, region) {
    const keys = [
      'global',
      modelId ? `model:${modelId}` : null,
      region && modelId ? `cookie:${region}:${modelId}` : null,
    ].filter(Boolean);
    return keys;
  }

  function getBucket(scope) {
    if (!buckets.has(scope)) {
      buckets.set(scope, {
        limit: defaultLimit,
        window: defaultWindow,
        tokens: defaultLimit * safety,
        lastRefill: Date.now(),
        cooldownUntil: 0,
        lastHeader: null,
      });
    }
    return buckets.get(scope);
  }

  function refill(bucket) {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    if (elapsed <= 0) return;
    const ratePerMs = (bucket.limit * safety) / (bucket.window * 1000);
    bucket.tokens = Math.min(bucket.limit * safety, bucket.tokens + elapsed * ratePerMs);
    bucket.lastRefill = now;
  }

  async function awaitPermit(modelId, region) {
    const scopes = scopeKeys(modelId, region).map(getBucket);
    while (true) {
      let waitMs = 0;
      let blocked = false;
      for (const b of scopes) {
        refill(b);
        if (Date.now() < b.cooldownUntil) {
          waitMs = Math.max(waitMs, b.cooldownUntil - Date.now());
          blocked = true;
        }
      }
      if (blocked) {
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 2000)));
        continue;
      }

      const allHave = scopes.every((b) => b.tokens >= 1);
      if (allHave) {
        scopes.forEach((b) => (b.tokens -= 1));
        return;
      }

      let minNext = Infinity;
      for (const b of scopes) {
        refill(b);
        if (b.tokens >= 1) continue;
        const ratePerMs = (b.limit * safety) / (b.window * 1000);
        const need = 1 - b.tokens;
        const nextMs = need / ratePerMs;
        if (nextMs < minNext) minNext = nextMs;
      }
      await new Promise((r) => setTimeout(r, Math.max(5, Math.min(minNext, 2000))));
    }
  }

  function updateFromHeaders(modelId, region, headers) {
    try {
      const rl = headers?.ratelimit;
      const policy = headers?.['ratelimit-policy']; // e.g., 3000;w=300
      let limit = defaultLimit;
      let windowSec = defaultWindow;
      if (policy) {
        const m = String(policy).match(/(\d+)\s*;\s*w=(\d+)/);
        if (m) {
          limit = parseInt(m[1]);
          windowSec = parseInt(m[2]);
        }
      }
      let remaining = null;
      let reset = null;
      if (rl) {
        const m2 = String(rl).match(/limit=(\d+),\s*remaining=(\d+),\s*reset=(\d+)/);
        if (m2) {
          limit = parseInt(m2[1]);
          remaining = parseInt(m2[2]);
          reset = parseInt(m2[3]);
          windowSec = Math.max(windowSec, reset);
        }
      }
      const scopes = scopeKeys(modelId, region);
      for (const s of scopes) {
        const b = getBucket(s);
        b.limit = limit;
        b.window = windowSec;
        b.lastHeader = { limit, remaining, reset };
        if (remaining != null) {
          b.tokens = Math.min(limit * safety, remaining * safety);
          b.lastRefill = Date.now();
        }
      }
    } catch {}
  }

  function on429(modelId, region, headers) {
    // MINIMUM 5-10 minutes on 429
    const MIN_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes minimum
    const MAX_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes maximum

    let cooldownMs = MIN_COOLDOWN_MS;

    // Only use retry-after if it's LONGER than our minimum
    if (headers?.['retry-after']) {
      const retryAfter = parseInt(headers['retry-after'], 10);
      if (!isNaN(retryAfter)) {
        const headerCooldown = retryAfter * 1000;
        cooldownMs = Math.max(MIN_COOLDOWN_MS, Math.min(headerCooldown, MAX_COOLDOWN_MS));
      }
    }

    const now = Date.now();
    const scopes = scopeKeys(modelId, region).map(getBucket);

    // Apply cooldown to all relevant scopes
    scopes.forEach((b) => {
      b.cooldownUntil = now + cooldownMs;
    });

    // Light global dampening (2 minutes)
    const g = getBucket('global');
    g.cooldownUntil = Math.max(g.cooldownUntil, now + Math.min(cooldownMs, 120000));
  }

  function stats() {
    const out = {};
    for (const [k, v] of buckets.entries()) {
      refill(v);
      out[k] = {
        limit: v.limit,
        window: v.window,
        tokens: Math.round(v.tokens * 100) / 100,
        cooldownUntil: v.cooldownUntil,
        coolingDown: Date.now() < v.cooldownUntil,
        lastHeader: v.lastHeader,
      };
    }
    return out;
  }

  return { awaitPermit, updateFromHeaders, on429, stats };
})();

// Error tracking
let error400Tracker = {
  errors: [],

  log(error, context) {
    const entry = {
      timestamp: new Date().toISOString(),
      error: error.message || error,
      errorData: error.response?.data,
      modelId: context.modelId,
      sessionId: context.sessionId,
      messageLength: context.messageLength,
      retryCount: context.retryCount,
      cookieRegion: context.cookieRegion,
    };

    this.errors.push(entry);
    if (this.errors.length > 50) this.errors.shift();

    console.error('\n╔════════════════════════════════════════════════════════════╗');
    console.error('║              400 BAD REQUEST ERROR                         ║');
    console.error('╚════════════════════════════════════════════════════════════╝');
    console.error('⏰ Time:', entry.timestamp);
    console.error('🌍 Cookie Region:', context.cookieRegion);
    console.error('🆔 Session ID:', context.sessionId);
    console.error('🤖 Model ID:', context.modelId);
    console.error('📏 Message Length:', context.messageLength, 'chars');
    console.error('🔄 Retry Count:', context.retryCount);
    console.error('❌ Error:', error.message);

    if (error.response?.data) {
      console.error('📦 Response Data:', JSON.stringify(error.response.data, null, 2));
    }

    console.error('════════════════════════════════════════════════════════════\n');
  },

  getStats() {
    return {
      total: this.errors.length,
      last10: this.errors.slice(-10),
    };
  },
};

// ==================== COOKIE SELECTION LOGIC ====================

// Round-robin index for proper distribution
let cookieRoundRobinIndex = 0;

// ═══ IN-FLIGHT TRACKING: COOKIE AND IP WITH LIMITS ═══
// Rule: 1 request per cookie + up to 15 requests per IP (tested limit)
const inFlightCookies = new Set(); // Cookie regions currently streaming
const inFlightIPCounts = new Map(); // IP -> count of concurrent requests
const MAX_REQUESTS_PER_IP = 10; // Conservative limit (tested: 15-16 fails, so use 10 for safety)

async function selectCookie(strategy = 'round-robin', excludeRegion = null) {
  // Reload cookies from database if cache is stale (every 5 seconds)
  // This ensures we pick up deleted/added/updated cookies without restarting
  const now = Date.now();
  if (now - cookiesLastLoaded > COOKIE_RELOAD_INTERVAL) {
    CONFIG.cookies = await loadCookiesFromDB();
    cookiesLastLoaded = now;
  }

  const activeCookies = CONFIG.cookies.filter((c) => c.active && c.cookie.length > 0);

  if (activeCookies.length === 0) {
    throw new Error('No active cookies available');
  }

  // Fast-path: single-cookie scenario → always use it (avoid in-flight deadlock)
  if (activeCookies.length === 1) {
    const only = activeCookies[0];
    const now = Date.now();
    only.requestCount = (only.requestCount || 0) + 1;
    only.lastUsed = now;
    only.inFlight = (only.inFlight || 0) + 1;
    inFlightCookies.add(only.region);
    console.warn('⚠️ Single-cookie mode: selecting the only available cookie regardless of in-flight');
    return only;
  }

  // ═══ FILTER: Only cookies that are NOT currently in-flight ═══
  const availableCookies = activeCookies.filter((c) => {
    const stats = cookieStats[c.region];

    // Skip if in cooldown (429 errors)
    if (stats?.cooldownUntil > now) {
      return false;
    }

    // ═══ CRITICAL: Cookie must NOT be currently streaming ═══
    if (inFlightCookies.has(c.region)) {
      return false; // This cookie is busy
    }

    if (excludeRegion && c.region === excludeRegion) {
      return false;
    }

    return true;
  });

  // If no cookies available (all in-flight), wait/error
  let selected;
  if (availableCookies.length === 0) {
    const busyCookies = activeCookies.filter((c) => inFlightCookies.has(c.region)).length;
    throw new Error(
      `All ${busyCookies}/${activeCookies.length} cookies currently streaming - request must wait in queue`,
    );
  }

  // Select from available cookies; fallback to all active cookies if none available
  if (!selected) {
    let pool = availableCookies.length > 0 ? availableCookies : activeCookies;
    pool = pool.filter((c) => c && c.region && typeof c.cookie === 'string');
    if (pool.length === 0) {
      throw new Error('No active cookies available');
    }
    if (strategy === 'round-robin') {
      cookieRoundRobinIndex = cookieRoundRobinIndex % pool.length;
      selected = pool[cookieRoundRobinIndex];
      cookieRoundRobinIndex++;
    } else if (strategy === 'load-balanced') {
      selected = pool.reduce((prev, current) => {
        return (prev.requestCount || 0) <= (current.requestCount || 0) ? prev : current;
      });
    } else if (strategy === 'success-rate') {
      selected = pool.reduce((prev, current) => {
        return (prev.successRate || 0) >= (current.successRate || 0) ? prev : current;
      });
    } else {
      selected = pool[0];
    }
  }

  if (!selected) {
    selected = activeCookies[0];
    if (!selected) {
      throw new Error('Cookie selection failed');
    }
  }
  selected.requestCount = (selected.requestCount || 0) + 1;
  selected.lastUsed = now;

  // Track in-flight requests per cookie
  selected.inFlight = (selected.inFlight || 0) + 1;

  // ═══ MARK COOKIE AS IN-FLIGHT ═══
  inFlightCookies.add(selected.region);

  console.log(
    `🌍 Selected: Cookie ${selected.region} (direct connection) | In-flight now: ${inFlightCookies.size} cookies`,
  );

  return selected;
}

// Record cookie error and FREE cookie
function recordCookieError(region, error) {
  const cookieObj = CONFIG.cookies.find((c) => c.region === region);
  if (!cookieObj) return;

  ensureCookieStats(region);
  const stats = cookieStats[region];
  stats.lastError = error;

  // Decrement in-flight counter
  cookieObj.inFlight = Math.max((cookieObj.inFlight || 1) - 1, 0);

  // ═══ FREE COOKIE ═══
  inFlightCookies.delete(region);

  // Only count errors that are actually authentication-related, not network issues
  const isAuthError = isAuthenticationError(error);
  const is429 = error?.response?.status === 429 || /\bStatus:\s*429\b/.test(error?.message || '');

  if (isAuthError) {
    stats.authErrorCount++;
    stats.errorCount++;
    cookieObj.errors++;
    console.error(`❌ AUTH ERROR in ${region}: ${error.message} (Success rate: ${cookieObj.successRate.toFixed(1)}%)`);

    // Write to database
    try {
      cookieDB.recordRequest(region, false, 0, error.message);
    } catch (dbError) {
      console.error(`⚠️ Failed to record error to database:`, dbError.message);
    }

    if (cookieObj.errors > 10) {
      console.warn(`⚠️ Disabling ${region} - too many authentication errors`);
      cookieObj.active = false;
    }
  } else if (is429) {
    // Do not count against cookie health; track network error only
    stats.networkErrorCount++;
    console.warn(`⚠️ NETWORK ERROR in ${region}: ${error.message} (429). Not counting against cookie health.`);
  } else {
    stats.networkErrorCount++;
    console.warn(`⚠️ NETWORK ERROR in ${region}: ${error.message} (Not counting against cookie health)`);
  }

  const total = stats.successCount + stats.errorCount;
  cookieObj.successRate = total > 0 ? (stats.successCount / total) * 100 : 100;
}

// Helper function to determine if an error is authentication-related
function isAuthenticationError(error) {
  const errorMessage = error.message || '';
  const errorStatus = error.response?.status;

  // Network errors that should NOT disable cookies
  const networkErrors = [
    'Socket closed',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'timeout',
    'Network Error',
    'socket hang up',
  ];

  // 400 errors that are NOT auth errors (payload/validation issues)
  const nonAuthBadRequestErrors = [
    'Invalid content',
    'too large',
    'size',
    'limit',
    'exceed',
    'already exists', // Session conflict
  ];

  // Check if it's a network error (don't count against cookie)
  if (networkErrors.some((pattern) => errorMessage.includes(pattern))) {
    return false;
  }

  // Check if it's a 400 error that's NOT auth-related (payload/validation)
  if (errorStatus === 400 && nonAuthBadRequestErrors.some((pattern) => errorMessage.includes(pattern))) {
    return false; // This is a payload issue, not auth
  }

  // HTTP status codes that indicate authentication issues
  const authStatusCodes = [401, 403];

  // Error messages that indicate authentication issues
  const authErrorMessages = ['Unauthorized', 'Forbidden', 'Invalid token', 'Token expired', 'Authentication failed'];

  // Check if it's an authentication status code
  if (authStatusCodes.includes(errorStatus)) {
    return true;
  }

  // Check if it's an authentication error message
  if (authErrorMessages.some((pattern) => errorMessage.includes(pattern))) {
    return true;
  }

  // 400 with generic "Bad Request" - be cautious, treat as auth error
  if (errorStatus === 400 && errorMessage.includes('Bad Request')) {
    return true;
  }

  // Default: assume it's not an auth error to be safe
  return false;
}

// Record cookie success and FREE cookie
function recordCookieSuccess(region, responseTime) {
  const cookieObj = CONFIG.cookies.find((c) => c.region === region);
  if (!cookieObj) return;

  ensureCookieStats(region);
  const stats = cookieStats[region];
  stats.successCount++;
  stats.totalResponseTime += responseTime;
  stats.averageResponseTime = stats.totalResponseTime / stats.successCount;

  const total = stats.successCount + stats.errorCount;
  cookieObj.successRate = total > 0 ? (stats.successCount / total) * 100 : 100;

  // Decrement in-flight counter
  cookieObj.inFlight = Math.max((cookieObj.inFlight || 1) - 1, 0);

  // ═══ FREE COOKIE ═══
  inFlightCookies.delete(region);

  // Write to database
  try {
    cookieDB.recordRequest(region, true, responseTime);
  } catch (dbError) {
    console.error(`⚠️ Failed to record success to database:`, dbError.message);
  }

  console.log(`✅ Success: ${region} (direct): ${responseTime}ms | Freed: ${inFlightCookies.size} cookies in-flight`);
}

// ==================== COMPRESSION FUNCTIONS ====================

// Extract fenced code blocks and replace with placeholders
function extractCodeBlocks(text) {
  const codeBlocks = [];
  const placeholderPrefix = '[[CODE_BLOCK_';
  let idx = 0;
  const replaced = text.replace(/```[\s\S]*?```/g, (match) => {
    const placeholder = `${placeholderPrefix}${idx}]]`;
    codeBlocks.push(match);
    idx += 1;
    return placeholder;
  });
  return { replaced, codeBlocks };
}

function restoreCodeBlocks(text, codeBlocks) {
  return text.replace(/\[\[CODE_BLOCK_(\d+)\]\]/g, (_, n) => {
    const i = parseInt(n, 10);
    return codeBlocks[i] ?? '';
  });
}

function compressOutsideCode(text) {
  // Light whitespace compression only, keep line breaks for readability
  return text
    .replace(/\n{3,}/g, '\n\n') // collapse 3+ blank lines to 2
    .replace(/[ \t]{2,}/g, ' ') // collapse runs of spaces/tabs
    .trim();
}

function balancedTruncate(text, maxBytes) {
  // Preserve head (system/instructions) and tail (recent context)
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return { text, truncated: false };

  // Aim to keep ~50% head (instructions), 45% tail (recent context), 5% marker
  // Increased head percentage to better preserve build instructions and system prompts
  const headBytes = Math.floor(maxBytes * 0.5);
  const tailBytes = Math.floor(maxBytes * 0.45);
  const marker = '\n\n...[context summarized]...\n\n';

  // Convert to Buffer slices safely
  const buf = Buffer.from(text, 'utf8');
  const head = buf.subarray(0, headBytes).toString('utf8');
  const tail = buf.subarray(buf.length - tailBytes > 0 ? buf.length - tailBytes : 0).toString('utf8');
  const combined = head + marker + tail;
  // Ensure not exceeding maxBytes
  let final = combined;
  while (Buffer.byteLength(final, 'utf8') > maxBytes && final.length > 0) {
    // Trim a bit from the head portion
    const trimSize = Math.min(512, Math.floor(final.length * 0.01));
    final = final.slice(0, final.length - trimSize);
  }
  return { text: final, truncated: true };
}

function smartMessageCompress(message, maxBytes = 42000) {
  const originalBytes = Buffer.byteLength(message, 'utf8');
  if (originalBytes <= maxBytes) {
    return {
      message,
      compressed: false,
      originalSize: originalBytes,
      newSize: originalBytes,
    };
  }

  console.log(`🗜️  Smart compression: ${originalBytes} bytes → target ${maxBytes} bytes`);

  // Simple truncation to maxBytes
  let compressed = message;
  while (Buffer.byteLength(compressed, 'utf8') > maxBytes) {
    // Remove 10% at a time
    compressed = compressed.substring(0, Math.floor(compressed.length * 0.9));
  }

  const finalSize = Buffer.byteLength(compressed, 'utf8');
  const compressionRatio = (((originalBytes - finalSize) / originalBytes) * 100).toFixed(1);

  console.log(`✅ Compressed by ${compressionRatio}%: ${originalBytes} → ${finalSize} bytes`);

  return {
    message: compressed,
    compressed: true,
    originalSize: originalBytes,
    newSize: finalSize,
    compressionRatio: compressionRatio + '%',
    strategies: ['simple truncation'],
    wasTruncated: true,
  };
}

function contextAwareCompress(message, maxBytes = 90000) {
  const originalBytes = Buffer.byteLength(message, 'utf8');
  if (originalBytes <= maxBytes) {
    return { message, compressed: false, originalSize: originalBytes };
  }

  console.log(`🗜️ Fallback compression: ${originalBytes} bytes → target ${maxBytes} bytes`);

  // Protect code blocks during whitespace compression
  const { replaced, codeBlocks } = extractCodeBlocks(message);
  let compressed = compressOutsideCode(replaced);

  // Restore code blocks
  compressed = restoreCodeBlocks(compressed, codeBlocks);

  // If still too large, apply balanced truncation (preserve head/tail)
  if (Buffer.byteLength(compressed, 'utf8') > maxBytes) {
    const { text, truncated } = balancedTruncate(compressed, maxBytes);
    compressed = text;
  }

  const finalSize = Buffer.byteLength(compressed, 'utf8');
  const compressionRatio = (((originalBytes - finalSize) / originalBytes) * 100).toFixed(1);

  console.log(`✅ Compressed by ${compressionRatio}%: ${originalBytes} → ${finalSize} bytes`);

  return {
    message: compressed,
    compressed: true,
    originalSize: originalBytes,
    newSize: finalSize,
    compressionRatio: compressionRatio + '%',
    strategies: [
      'preserved code blocks',
      'light whitespace compression',
      ...(finalSize <= maxBytes ? [] : ['balanced truncation']),
    ],
    wasTruncated: finalSize > maxBytes,
  };
}

// Legacy functions for backward compatibility
function extractIntelligentCode(code, maxBytes) {
  return code.substring(0, Math.min(maxBytes * 0.9, code.length));
}

function smartTruncate(code, maxBytes) {
  const safeMax = Math.floor(maxBytes * 0.95);
  return code.substring(0, safeMax) + '\n\n// [Content truncated for token limit]';
}

// ==================== HELPER FUNCTIONS ====================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateRateLimit(headers) {
  try {
    if (headers.ratelimit) {
      const match = headers.ratelimit.match(/limit=(\d+), remaining=(\d+), reset=(\d+)/);
      if (match) {
        rateLimit.total = parseInt(match[1]);
        rateLimit.remaining = parseInt(match[2]);
        rateLimit.resetAt = Date.now() + parseInt(match[3]) * 1000;
      }
    }
    // Feed global pacer if available
    if (headers && RATE_PACER && RATE_PACER.updateFromHeaders) {
      RATE_PACER.updateFromHeaders('global', null, headers);
    }
  } catch (e) {}
}

function generateUUIDv7() {
  return uuidv7();
}

function sanitizeMessage(content) {
  if (typeof content !== 'string') return String(content);
  return content
    .replace(/\u0000/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

function parseStreamingResponse(responseText) {
  const lines = responseText.trim().split('\n');
  let response = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('a0:')) {
      try {
        response += JSON.parse(trimmed.substring(3));
      } catch (e) {}
    }
  }

  return { response };
}

// ==================== IMAGE UPLOAD TO HOSTING SERVICE ====================

async function uploadBase64Image(dataUri, retryCount = 0) {
  try {
    // Extract base64 data and mime type
    const matches = dataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error('Invalid data URI format');
    }

    const mimeType = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    // Determine file extension
    const ext = mimeType.split('/')[1] || 'jpg';
    const filename = `image_${Date.now()}.${ext}`;

    // Upload to freeimage.host
    const formData = new FormData();
    formData.append('key', process.env.FREEIMAGE_API_KEY || '6d207e02198a847aa98d0a2a901485a5'); // Free tier key
    formData.append('action', 'upload');
    formData.append('source', buffer, {
      filename: filename,
      contentType: mimeType,
    });
    formData.append('format', 'json');

    console.log(
      `📤 Uploading image to freeimage.host (${(buffer.length / 1024).toFixed(
        2,
      )} KB)${retryCount > 0 ? ` - Retry ${retryCount}/2` : ''}...`,
    );

    const response = await axios.post('https://freeimage.host/api/1/upload', formData, {
      headers: {
        ...formData.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000, // 120 second timeout for upload (large images can take time)
    });

    if (response.data?.image?.url) {
      const uploadedUrl = response.data.image.url;
      console.log(`✅ Image uploaded successfully: ${uploadedUrl}`);
      return uploadedUrl;
    } else if (response.data?.status_code === 200 && response.data?.image?.display_url) {
      const uploadedUrl = response.data.image.display_url;
      console.log(`✅ Image uploaded successfully: ${uploadedUrl}`);
      return uploadedUrl;
    } else {
      throw new Error(`Upload failed: ${JSON.stringify(response.data)}`);
    }
  } catch (error) {
    console.error(`❌ Image upload failed (attempt ${retryCount + 1}/3):`, error.message);

    // Retry up to 2 times on timeout or network errors
    if (retryCount < 2 && (error.code === 'ECONNABORTED' || error.message.includes('timeout'))) {
      console.log(`🔄 Retrying image upload in 2 seconds...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return uploadBase64Image(dataUri, retryCount + 1);
    }

    throw new Error(`Failed to upload image after ${retryCount + 1} attempts: ${error.message}`);
  }
}

// ==================== IMAGE DETECTION AND EXTRACTION ====================

async function detectAndExtractImages(messages) {
  const images = [];
  let hasImages = false;

  for (const message of messages) {
    if (!message.content) continue;
    const role = message.role || 'user';

    // Handle OpenAI format: content as array with image_url type
    if (Array.isArray(message.content)) {
      if (role !== 'user') {
        continue;
      }
      for (const part of message.content) {
        if (part.type === 'image_url' && part.image_url) {
          hasImages = true;
          let imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url.url;

          if (imageUrl) {
            // If it's a base64 data URI, upload it first
            if (imageUrl.startsWith('data:image/')) {
              try {
                console.log(`🔄 Detected base64 image, uploading to hosting service...`);
                imageUrl = await uploadBase64Image(imageUrl);
              } catch (error) {
                console.error(`❌ Failed to upload base64 image:`, error.message);
                throw new Error(`Image upload failed: ${error.message}`);
              }
            }

            // Extract file name from URL or use default
            const urlParts = imageUrl.split('/');
            const fileName = urlParts[urlParts.length - 1].split('?')[0] || 'image.jpg';

            // Determine content type
            let contentType = 'image/jpeg';
            if (imageUrl.match(/\.(png|jpg|jpeg|gif|webp)$/i)) {
              const ext = imageUrl.match(/\.(png|jpg|jpeg|gif|webp)$/i)[1].toLowerCase();
              contentType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
            }

            images.push({
              name: fileName,
              contentType: contentType, // LMArena uses camelCase
              url: imageUrl,
            });
          }
        }
      }
    }
    // Handle simple string content with potential image URLs
    else if (typeof message.content === 'string') {
      if (role !== 'user') {
        continue;
      }
      // Check for data URIs (base64 images) - upload them
      // CRITICAL: Only match if it's a REAL base64 image with minimum length
      const dataUriMatches = message.content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{100,}/g);
      if (dataUriMatches && dataUriMatches.length > 0) {
        console.log(`🔍 DEBUG: Found ${dataUriMatches.length} potential base64 images in string content`);

        // Verify these are ACTUAL images, not format examples or escaped strings
        const validImages = [];
        for (const match of dataUriMatches) {
          const idx = message.content.indexOf(match);
          const beforeCtx = message.content.slice(Math.max(0, idx - 80), idx);
          const inCssUrl = /url\(\s*['"]?$/i.test(beforeCtx) || /bg-\[url\(\s*['"]?$/i.test(beforeCtx);
          const inHtmlAttr = /(class(Name)?=|style=)/i.test(beforeCtx);
          if (inCssUrl || inHtmlAttr) {
            console.log(`   ⚠️  Skipping match embedded in CSS/HTML context`);
            continue;
          }
          const base64Part = match.split('base64,')[1] || '';
          const matchLength = match.length;
          const base64Length = base64Part.length;

          console.log(`   🔍 Analyzing match: total=${matchLength} chars, base64=${base64Length} chars`);
          console.log(`   📝 Preview: "${match.substring(0, 100)}..."`);

          // RELAXED VALIDATION (was 1000, now 200):
          // 1. Base64 part must be at least 200 chars (small icon ~= 200 chars)
          // 2. Must be valid base64 (no special chars except +/=)
          if (base64Length < 200) {
            console.log(`   ❌ REJECTED: Base64 too short (${base64Length} < 200) - likely format example`);
            continue;
          }

          // Check if base64 is valid (no weird characters)
          if (!/^[A-Za-z0-9+/=]+$/.test(base64Part.substring(0, 100))) {
            console.log(`   ❌ REJECTED: Invalid base64 characters - not a real image`);
            continue;
          }

          validImages.push(match);
          console.log(
            `   ✅ VALID IMAGE: ${(matchLength / 1024).toFixed(1)} KB (base64: ${(base64Length / 1024).toFixed(1)} KB)`,
          );
        }

        if (validImages.length === 0) {
          console.log(`   ℹ️  No valid images after strict filtering - all were format examples/docs`);
        } else {
          hasImages = true;
          console.log(`   ✅ Final image count: ${validImages.length} valid images`);
        }

        for (let idx = 0; idx < validImages.length; idx++) {
          const dataUri = validImages[idx];
          try {
            console.log(`🔄 Detected base64 image in text, uploading to hosting service...`);
            const uploadedUrl = await uploadBase64Image(dataUri);
            const match = uploadedUrl.match(/\.(png|jpg|jpeg|gif|webp)$/i);
            const ext = match ? match[1].toLowerCase() : 'jpg';
            const contentType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
            images.push({
              name: `image_${idx + 1}.${ext}`,
              contentType: contentType,
              url: uploadedUrl,
            });
          } catch (error) {
            console.error(`❌ Failed to upload base64 image from text:`, error.message);
            throw new Error(`Image upload failed: ${error.message}`);
          }
        }
      }

      // Check for HTTP/HTTPS image URLs
      const urlMatches = message.content.match(/https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp)/gi);
      if (urlMatches && urlMatches.length > 0) {
        console.log(`🔍 DEBUG: Found ${urlMatches.length} HTTP image URLs in string content`);

        urlMatches.forEach((url, idx) => {
          console.log(`   🔗 URL ${idx + 1}: ${url}`);

          // Check if this looks like a real image URL or just an example
          // Real URLs should be from actual image hosts, not example.com or placeholder domains
          const isPlaceholder = /example\.com|placeholder|dummy|sample|test\./i.test(url);

          if (isPlaceholder) {
            console.log(`      ⚠️  Skipping - looks like documentation/example URL`);
            return;
          }

          hasImages = true;
          const ext = url.match(/\.(jpg|jpeg|png|gif|webp)$/i)[1].toLowerCase();
          const contentType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
          images.push({
            name: `image_${idx + 1}.${ext}`,
            contentType: contentType, // LMArena uses camelCase
            url: url,
          });
          console.log(`      ✅ Added as valid image`);
        });
      }
    }
  }

  return { hasImages, images };
}

// ==================== MESSAGE PROCESSING ====================

function processMessage(message, maxBytes = CONFIG.maxMessageBytes, skipCompression = false) {
  const sanitized = sanitizeMessage(message);

  // Skip compression if requested - we'll check payload size first
  if (skipCompression) {
    const size = Buffer.byteLength(sanitized, 'utf8');
    return {
      message: sanitized,
      wasCompressed: false,
      originalSize: size,
      newSize: size,
      compressionRatio: '0%',
      strategies: [],
      wasTruncated: false,
    };
  }

  // Use context-aware compression (preserves code blocks and conversation structure)
  const result = contextAwareCompress(sanitized, maxBytes);

  return {
    message: result.message,
    wasCompressed: result.compressed,
    originalSize: result.originalSize,
    newSize: result.newSize || Buffer.byteLength(result.message, 'utf8'),
    compressionRatio: result.compressionRatio || '0%',
    strategies: result.strategies || [],
    wasTruncated: result.wasTruncated || false,
  };
}

// ==================== STREAMING REQUEST ====================

async function askLMArenaStreaming(
  modelId,
  message,
  onChunk,
  onComplete, // Receives (sessionId, timedOut) when stream completes
  onError,
  retryCount = 0,
  lastCookieRegion = null,
  skipPacerWait = false,
  attachments = [],
  existingSessionId = null, // For continuations - reuse same session ID
  lastUserMessage = null, // OPTIONAL: Just the last user message (not full history) for userMessage field
) {
  // ═══ STEP 1: Select cookie ═══
  let selectedCookie;
  try {
    if (retryCount > 0) {
      selectedCookie = selectCookie('load-balanced', lastCookieRegion || null);
    } else {
      selectedCookie = selectCookie('round-robin', null);
    }
  } catch (selErr) {
    const msg = String(selErr?.message || '').toLowerCase();
    if (msg.includes('currently streaming')) {
      const waitStart = Date.now();
      const waitMs = 8000;
      console.warn(`⏳ All cookies busy; waiting up to ${waitMs / 1000}s for availability...`);
      while (Date.now() - waitStart < waitMs) {
        try {
          onChunk(' ');
        } catch {}
        await sleep(600);
        const anyFree = CONFIG.cookies.some((c) => c.active && c.cookie.length > 0 && !inFlightCookies.has(c.region));
        if (anyFree) break;
      }
      // Try selection again (do not exclude region on first attempt)
      selectedCookie = selectCookie(retryCount > 0 ? 'load-balanced' : 'round-robin', lastCookieRegion || null);
    } else {
      throw selErr;
    }
  }

  // Adaptive pacer pre-flight with heartbeat scoped to selected region
  if (!skipPacerWait && typeof RATE_PACER !== 'undefined' && RATE_PACER.awaitPermit) {
    try {
      let granted = false;
      const permit = RATE_PACER.awaitPermit(modelId, selectedCookie.region).then(() => {
        granted = true;
      });
      // Send lightweight keepalive chunks while waiting for permit
      while (!granted) {
        try {
          onChunk(' ');
        } catch {}
        await sleep(800);
      }
      await permit;
    } catch {}
  }

  // STEP 1: Process message WITHOUT compression - check payload size before compressing
  let processed = processMessage(message, CONFIG.maxMessageBytes, true); // skipCompression = true

  // Session ID: Reuse for continuations, new for initial requests
  const sessionId = existingSessionId || generateUUIDv7();
  const userMsgId = generateUUIDv7();
  const assistantMsgId = generateUUIDv7();

  if (existingSessionId) {
    console.log(`   🔗 Reusing session ID for continuation: ${sessionId}`);
  }
  const startTime = Date.now();

  console.log(`\n🔵 Streaming Request #${retryCount + 1}`);
  console.log(`   Model: ${modelId}`);
  console.log(`   Message: ${processed.message.length} chars (${processed.newSize} bytes)`);
  console.log(`   Session: ${sessionId}`);

  // Warn about long responses with images
  if (attachments && attachments.length > 0) {
    console.log(`   ⚠️  ${attachments.length} image(s) attached - GPT vision can be VERY SLOW (5-15 min)`);
    console.log(`   💡 Client timeout must be >15 minutes for image requests!`);
  }

  // ═══ CRITICAL: Ensure NO base64 data URIs leak to LMArena! ═══
  // LMArena only accepts experimental_attachments with URLs, NOT data:image
  const sanitizedMessage = processed.message.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE_REMOVED]');

  // Verify attachments only contain URLs, never base64
  const safeAttachments = attachments.map((att) => {
    if (att.url && att.url.startsWith('data:image/')) {
      console.error('❌ CRITICAL: Found base64 in attachments! This should never happen!');
      throw new Error('Base64 data URI found in attachments - must be uploaded URL only');
    }
    return att;
  });

  // ═══ CONTINUATION VS INITIAL REQUEST ═══
  // For continuation (follow-up), use simplified payload WITHOUT messages array
  // LMArena already has the conversation history for that session ID

  let payload;

  if (existingSessionId) {
    // CONTINUATION/FOLLOW-UP: Simplified payload
    console.log(`   🔄 Building continuation payload (no messages array)`);
    payload = {
      id: sessionId,
      mode: 'direct',
      modelAId: modelId,
      userMessageId: userMsgId,
      modelAMessageId: assistantMsgId,
      userMessage: {
        content: sanitizedMessage,
        experimental_attachments: safeAttachments,
      },
      modality: 'chat',
    };
  } else {
    // INITIAL REQUEST: Split payload intelligently
    // CRITICAL INSIGHT: AI reads userMessage.content (NOT messages[0].content!)
    // So userMessage needs FULL context, messages[0] can be shorter
    //
    // CRITICAL: When attachments are present, we CANNOT use different content for
    // userMessage and messages[0] because LMArena validates content consistency.
    // Solution: Use same object reference (like non-streaming does) when attachments present.
    // Without attachments: We can optimize by shortening messages[0].content

    const hasAttachments = safeAttachments && safeAttachments.length > 0;

    // ALWAYS use full context - images or not
    // The AI needs the full conversation context to understand the request properly
    const contentForMessage = sanitizedMessage;

    const userMessage = {
      id: userMsgId,
      role: 'user',
      content: contentForMessage,
      experimental_attachments: safeAttachments,
      parentMessageIds: [],
      participantPosition: 'a',
      modelId: null,
      evaluationSessionId: sessionId,
      status: 'pending',
      failureReason: null,
    };

    payload = {
      id: sessionId,
      mode: 'direct',
      modelAId: modelId,
      userMessageId: userMsgId,
      modelAMessageId: assistantMsgId,
      userMessage: userMessage,
      messages: [
        {
          ...userMessage,
          content: contentForMessage,
        },
        {
          id: assistantMsgId,
          role: 'assistant',
          content: '',
          reasoning: '',
          experimental_attachments: [],
          parentMessageIds: [userMsgId],
          participantPosition: 'a',
          modelId: modelId,
          evaluationSessionId: sessionId,
          status: 'pending',
          failureReason: null,
        },
      ],
      modality: 'chat',
    };
  }

  // STEP 2: Build payload with ORIGINAL message and check size
  let payloadString = JSON.stringify(payload);
  let payloadBytes = Buffer.byteLength(payloadString, 'utf8');

  // Calculate actual content sizes from the payload (AFTER any modifications)
  let userMessageSize = Buffer.byteLength(payload.userMessage.content || '', 'utf8');
  let messagesContentSize = 0;

  if (payload.messages && payload.messages.length > 0) {
    messagesContentSize = Buffer.byteLength(payload.messages[0].content || '', 'utf8');
  }

  const totalContentSize = userMessageSize + messagesContentSize;
  const realMetadataBytes = payloadBytes - totalContentSize;

  console.log(
    `   userMessage: ${(userMessageSize / 1024).toFixed(1)}KB (AI reads this), messages[0]: ${(messagesContentSize / 1024).toFixed(1)}KB, total: ${(totalContentSize / 1024).toFixed(1)}KB`,
  );
  console.log(
    `   Payload total: ${(payloadBytes / 1024).toFixed(1)}KB (includes ${(realMetadataBytes / 1024).toFixed(
      1,
    )}KB metadata)`,
  );

  // STEP 3: COMPRESSION - Check message content limit FIRST (independent of payload size)
  // CRITICAL: LMArena has strict limits:
  //   - Message content: ~100KB (stricter than expected!)
  //   - Total payload: ~180KB

  const MAX_SAFE_PAYLOAD_KB = 180; // 180KB payload limit
  const MAX_MESSAGE_KB = 100; // LMArena's REAL limit (discovered empirically - 150KB fails!)
  const maxSafePayloadBytes = MAX_SAFE_PAYLOAD_KB * 1024;
  const maxMessageBytes = MAX_MESSAGE_KB * 1024;

  // FIRST: Check message content size (this is LMArena's hard limit)
  const userMessageBytes = Buffer.byteLength(payload.userMessage.content, 'utf8');

  if (userMessageBytes > maxMessageBytes && payload.messages) {
    console.log(
      `   ⚠️  userMessage ${(userMessageBytes / 1024).toFixed(1)}KB exceeds LMArena's ${MAX_MESSAGE_KB}KB content limit!`,
    );
    console.log(`   💡 Compressing userMessage (messages[0] stays short for split strategy)`);

    // Target size: Under LMArena's REAL limit with safety margin
    const targetSize = Math.floor(maxMessageBytes * 0.9); // 90% of limit for extra safety

    console.log(
      `   🗜️  Compressing userMessage from ${(userMessageBytes / 1024).toFixed(1)}KB to ${(targetSize / 1024).toFixed(1)}KB`,
    );

    const compressed = contextAwareCompress(payload.userMessage.content, targetSize);

    // ONLY compress userMessage (what AI reads)
    // Keep messages[0] as-is to preserve split strategy benefit
    payload.userMessage.content = compressed.message;
    // messages[0].content stays short (lastUserMessage) or gets compressed separately below

    // Verify actual compressed size
    const actualCompressedBytes = Buffer.byteLength(compressed.message, 'utf8');
    console.log(
      `   ✅ Compressed userMessage to ${(actualCompressedBytes / 1024).toFixed(1)}KB (target was ${(targetSize / 1024).toFixed(1)}KB)`,
    );

    // CRITICAL: Recalculate sizes after compression!
    userMessageSize = actualCompressedBytes;

    payloadString = JSON.stringify(payload);
    payloadBytes = Buffer.byteLength(payloadString, 'utf8');

    console.log(`   📦 New payload: ${(payloadBytes / 1024).toFixed(1)}KB total`);
  } else if (payloadBytes > maxSafePayloadBytes && payload.messages) {
    // SECOND: If message content is OK but payload too large, compress messages[0] only
    console.log(`   ⚠️  PAYLOAD ${(payloadBytes / 1024).toFixed(1)}KB exceeds safe ${MAX_SAFE_PAYLOAD_KB}KB limit!`);

    // userMessage is OK, just compress messages[0] to reduce payload
    console.log(
      `   💡 SMART COMPRESSION: userMessage OK (${(userMessageBytes / 1024).toFixed(1)}KB), compressing messages[0] only`,
    );

    const bytesToSave = payloadBytes - maxSafePayloadBytes;
    const targetMessagesSize = Math.max(processed.newSize - bytesToSave - 1024, 5000);

    console.log(
      `   🗜️  Compressing messages[0] from ${(processed.newSize / 1024).toFixed(1)}KB to ${(
        targetMessagesSize / 1024
      ).toFixed(1)}KB`,
    );

    const compressedHistory = contextAwareCompress(processed.message, targetMessagesSize);

    payload.messages[0].content = compressedHistory.message;
    // Keep userMessage.content FULL

    // Recalculate messages[0] size after compression
    messagesContentSize = compressedHistory.newSize;

    payloadString = JSON.stringify(payload);
    payloadBytes = Buffer.byteLength(payloadString, 'utf8');

    console.log(
      `   ✅ Smart Compression: messages[0]=${(compressedHistory.newSize / 1024).toFixed(
        1,
      )}KB, userMessage=${(userMessageBytes / 1024).toFixed(1)}KB (FULL), Payload=${(payloadBytes / 1024).toFixed(1)}KB`,
    );
  } else if (payloadBytes > maxSafePayloadBytes && existingSessionId) {
    // Continuation: no messages array, must compress userMessage
    console.log(`   ⚠️  Continuation payload ${(payloadBytes / 1024).toFixed(1)}KB exceeds limit`);
    const targetSize = Math.floor(maxSafePayloadBytes - realMetadataBytes);
    const compressed = contextAwareCompress(processed.message, targetSize);
    payload.userMessage.content = compressed.message;

    // Recalculate userMessage size after compression
    userMessageSize = compressed.newSize;

    payloadString = JSON.stringify(payload);
    payloadBytes = Buffer.byteLength(payloadString, 'utf8');
    console.log(`   ✅ Compressed continuation: ${(payloadBytes / 1024).toFixed(1)}KB`);
  } else {
    console.log(
      `   ✅ Payload ${(payloadBytes / 1024).toFixed(1)}KB under ${MAX_SAFE_PAYLOAD_KB}KB limit - no compression needed`,
    );
  }

  // Final verification before sending
  console.log(
    `   🚀 Sending to LMArena: userMessage=${(userMessageSize / 1024).toFixed(1)}KB, messages[0]=${(messagesContentSize / 1024).toFixed(1)}KB, payload=${(payloadBytes / 1024).toFixed(1)}KB`,
  );

  // ULTRA-DEBUG: Log payload structure when attachments present
  if (payload.userMessage?.experimental_attachments?.length > 0) {
    console.log(`\n   🔍 DEBUG: Payload Structure with Attachments:`);
    console.log(`   ════════════════════════════════════════════════════════`);
    console.log(`   userMessage.content length: ${payload.userMessage.content?.length || 0} chars`);
    console.log(`   messages[0].content length: ${payload.messages?.[0]?.content?.length || 0} chars`);
    console.log(
      `   userMessage === messages[0]? ${payload.userMessage === payload.messages?.[0] ? 'YES (same reference)' : 'NO (different objects)'}`,
    );
    console.log(
      `   userMessage.experimental_attachments:`,
      JSON.stringify(payload.userMessage.experimental_attachments, null, 2),
    );
    console.log(
      `   messages[0].experimental_attachments:`,
      JSON.stringify(payload.messages?.[0]?.experimental_attachments, null, 2),
    );
    console.log(`   ════════════════════════════════════════════════════════\n`);
  }

  // CRITICAL: Verify we're under limits (safety check)
  if (userMessageSize > maxMessageBytes) {
    console.error(
      `   ❌ CRITICAL: userMessage ${(userMessageSize / 1024).toFixed(1)}KB STILL exceeds ${MAX_MESSAGE_KB}KB after compression!`,
    );
    console.error(`   🚫 Aborting request to avoid guaranteed rejection`);
    throw new Error(
      `Message too large: ${(userMessageSize / 1024).toFixed(1)}KB (limit: ${MAX_MESSAGE_KB}KB). Please reduce context size.`,
    );
  }

  // Prepare request configuration (browser-identical headers)
  const isContinuation = !!existingSessionId;
  const requestUrl = isContinuation
    ? `https://lmarena.ai/nextjs-api/stream/post-to-evaluation/${sessionId}`
    : 'https://lmarena.ai/nextjs-api/stream/create-evaluation';
  let requestConfig = {
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      Accept: '*/*',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://lmarena.ai',
      Referer: isContinuation ? `https://lmarena.ai/c/${sessionId}` : 'https://lmarena.ai/?mode=direct',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'sec-ch-ua': '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="99"',
      'sec-ch-ua-arch': '"x86"',
      'sec-ch-ua-bitness': '"64"',
      'sec-ch-ua-full-version': '"131.0.0.0"',
      'sec-ch-ua-full-version-list':
        '"Chromium";v="131.0.0.0", "Google Chrome";v="131.0.0.0", "Not_A Brand";v="99.0.0.0"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-model': '""',
      'sec-ch-ua-platform': '"macOS"',
      'sec-ch-ua-platform-version': '"10.15.7"',
      Priority: 'u=1, i',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Host: 'lmarena.ai',
      Cookie: selectedCookie.cookie,
      Connection: 'keep-alive',
    },
    responseType: 'stream',
    timeout: 0,
    validateStatus: (status) => status < 500,
  };

  // Direct connection with socket-level keepalive
  requestConfig.httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000, // Send keepalive probes every 30 seconds
    timeout: 0, // No socket timeout
    scheduling: 'fifo',
  });
  requestConfig.httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000, // Send keepalive probes every 30 seconds
    timeout: 0, // No socket timeout
    scheduling: 'fifo',
  });

  try {
    const response = await axios.post(requestUrl, payloadString, requestConfig);

    if (response.status === 400) {
      let errorData = '';

      response.data.on('data', (chunk) => {
        errorData += chunk.toString();
      });

      response.data.on('end', async () => {
        const responseTime = Date.now() - startTime;

        // ═══ ULTRA-DETAILED ERROR LOGGING ═══
        console.log(`\n❌ 400 Bad Request from LMArena`);
        console.log(`   📦 Our Payload Size: ${(payloadBytes / 1024).toFixed(2)}KB (${payloadBytes} bytes)`);
        console.log(`   📝 Message Size: ${(processed.newSize / 1024).toFixed(2)}KB (appears 2× in payload)`);
        console.log(`   🔧 Metadata Size: ${(realMetadataBytes / 1024).toFixed(2)}KB`);

        // Log response headers
        console.log(`\n   📋 Response Headers:`);
        console.log(`   ════════════════════════════════════════════════════════`);
        console.log(JSON.stringify(response.headers, null, 2));
        console.log(`   ════════════════════════════════════════════════════════`);

        console.log(`\n   📄 LMArena Response Body:`);
        console.log(`   ════════════════════════════════════════════════════════`);
        console.log(errorData);
        console.log(`   ════════════════════════════════════════════════════════`);

        // Try to parse as JSON for more details
        try {
          const parsedError = JSON.parse(errorData);
          console.log(`\n   🔍 Parsed Error Details:`);
          console.log(`   ════════════════════════════════════════════════════════`);
          console.log(JSON.stringify(parsedError, null, 2));
          console.log(`   ════════════════════════════════════════════════════════\n`);
        } catch (e) {
          console.log(`   ℹ️  Response is not JSON or cannot be parsed\n`);
        }

        // Log a sample of the actual payload we sent (first 500 chars)
        console.log(`   📤 Sample of Payload Sent (first 500 chars):`);
        console.log(`   ════════════════════════════════════════════════════════`);
        console.log(payloadString.substring(0, 500) + '...');
        console.log(`   ════════════════════════════════════════════════════════`);

        // ULTRA-DEBUG: Log FULL payload when attachments present to debug 400 error
        if (payload.userMessage?.experimental_attachments?.length > 0) {
          console.log(`\n   📦 FULL PAYLOAD (for debugging "Invalid content" error):`);
          console.log(`   ════════════════════════════════════════════════════════`);
          console.log(payloadString);
          console.log(`   ════════════════════════════════════════════════════════\n`);
        }

        // Check if error is due to payload size
        const isPayloadTooLarge =
          errorData.includes('too large') ||
          errorData.includes('size') ||
          errorData.includes('limit') ||
          errorData.includes('exceed');

        if (isPayloadTooLarge && retryCount === 0) {
          console.warn(`⚠️ CONFIRMED: LMArena rejected due to payload size`);
          console.log(`🗜️ Retrying with maximum compression (30KB message = ~60KB final payload)...`);

          // Retry with maximum compression (30KB message = ~60KB final payload)
          const reprocessed = processMessage(message, 30000);

          return askLMArenaStreaming(
            modelId,
            reprocessed.message,
            onChunk,
            onComplete,
            onError,
            1, // Mark as retry to avoid infinite loop
            selectedCookie.region,
            skipPacerWait,
            attachments,
          );
        }

        // Special case: session race — "Evaluation session ... already exists"
        // NOTE: This should RARELY happen now - continuations use NEW session IDs
        // This is only a safety net for unexpected race conditions (e.g., UUID collision)
        if (
          retryCount < 2 &&
          (/session\s+[0-9a-f-]+\s+already exists/i.test(errorData) || errorData.includes('already exists'))
        ) {
          console.warn('↪ UNEXPECTED: Session conflict (already exists). Generating NEW session ID for retry...');
          await sleep(500);
          try {
            return askLMArenaStreaming(
              modelId,
              message,
              onChunk,
              onComplete,
              onError,
              retryCount + 1,
              selectedCookie.region,
              true, // skip pacer wait on quick retry
              attachments,
              null, // FIX: Generate NEW session ID instead of reusing the conflicting one
            );
          } catch (e) {
            console.error('❌ Retry after session-exists conflict failed:', e.message);
          }
        }

        // Do not penalize cookie for provider 400 in generic case
        recordCookieError(selectedCookie.region, new Error('400 Bad Request (streaming)'));

        const context = {
          modelId,
          sessionId,
          messageLength: processed.message.length,
          retryCount,
          cookieRegion: selectedCookie.region,
        };

        error400Tracker.log({ message: '400 Bad Request', response: { data: errorData } }, context);

        if (retryCount < 3) {
          const waitTime = Math.pow(2, retryCount) * 1000;
          console.log(`⏳ Retrying with different cookie in ${waitTime}ms...`);
          await sleep(waitTime);

          return askLMArenaStreaming(
            modelId,
            message,
            onChunk,
            onComplete,
            onError,
            retryCount + 1,
            selectedCookie.region,
            skipPacerWait,
            attachments, // CRITICAL FIX: Preserve attachments on retry
          );
        } else {
          onError(new Error(`400 after ${retryCount + 1} attempts across regions`));
        }
      });

      return;
    }

    // Note: Cloudflare bypass now enabled - see 403 handler below

    if (response.status === 200) {
      console.log(`✅ Got 200 response from ${selectedCookie.region}, streaming...`);
      updateRateLimit(response.headers);
      if (typeof RATE_PACER !== 'undefined' && RATE_PACER.updateFromHeaders) {
        RATE_PACER.updateFromHeaders(modelId, selectedCookie.region, response.headers);
      }

      let buffer = '';
      let fullResponse = '';
      let clientDisconnected = false;
      let completionNotified = false; // ensure onComplete called at most once
      // Soft cutoff watchdog to preempt provider timeouts (configurable)
      // DISABLED by default: AI app building can take unpredictable time (set to 0 = no timeout)
      const SOFT_LIMIT_MS = parseInt(process.env.STREAM_SOFT_LIMIT_MS || '0', 10); // default: disabled
      let softLimitTimer = null;

      // Thinking/reasoning state (stream immediately, no buffering)
      let isThinking = false;
      let thinkingStartTime = null;

      // Streaming diagnostics (compact ring buffer of recent events)
      const streamDebug = {
        startTime,
        bytes: 0,
        chars: 0,
        lastEventAt: Date.now(),
        lastA0At: null,
        lastAgAt: null,
        events: [],
        push(ev, data) {
          try {
            const s = typeof data === 'string' ? data.slice(0, 120) : String(data).slice(0, 120);
            const len = (typeof data === 'string' ? data.length : String(data).length) || 0;
            this.events.push({ t: Date.now(), ev, len, s });
            if (this.events.length > 20) this.events.shift();
          } catch {}
        },
      };

      // Track if onChunk callback fails (client disconnected)
      const safeOnChunk = (content) => {
        try {
          onChunk(content);
        } catch (e) {
          if (!clientDisconnected) {
            console.log('⚠️ Client disconnected during streaming - stopping data processing');
            clientDisconnected = true;
            response.data.destroy(); // Stop reading from LMArena
          }
          return false;
        }
        return true;
      };

      // Start soft-limit timer if enabled
      if (SOFT_LIMIT_MS > 0 && Number.isFinite(SOFT_LIMIT_MS)) {
        softLimitTimer = setTimeout(() => {
          if (!clientDisconnected) {
            console.warn(`⏳ Stream exceeded soft limit (${SOFT_LIMIT_MS}ms) — proactively triggering continuation`);
            try {
              response.data.destroy();
            } catch {}
          }
        }, SOFT_LIMIT_MS);
      }

      response.data.on('data', (chunk) => {
        // Track input byte progress and last activity
        try {
          streamDebug.bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
          streamDebug.lastEventAt = Date.now();
        } catch {}
        if (clientDisconnected) return; // Stop processing if client gone

        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (clientDisconnected) break; // Stop processing

          const trimmed = line.trim();
          if (!trimmed) continue;

          // Parse LMArena event stream
          if (trimmed.startsWith('a0:')) {
            // Content chunk - close thinking if we were in thinking mode
            if (isThinking) {
              // Calculate actual thinking duration
              const thinkingDuration = thinkingStartTime ? ((Date.now() - thinkingStartTime) / 1000).toFixed(1) : '1.0';

              // Close thinking tag with duration
              safeOnChunk(`</think:${thinkingDuration}s>`);
              isThinking = false;
              thinkingStartTime = null;
            }

            try {
              const content = JSON.parse(trimmed.substring(3));
              if (content) {
                fullResponse += content;
                try {
                  streamDebug.chars = fullResponse.length;
                  streamDebug.lastA0At = Date.now();
                  streamDebug.push('a0', content);
                } catch {}
                if (!safeOnChunk(content)) {
                  break; // Client disconnected
                }
              }
            } catch (e) {
              console.error('❌ Failed to parse a0 chunk:', e.message);
            }
          } else if (trimmed.startsWith('ag:')) {
            // ag = Reasoning/thinking chunk (from thinking models like Claude Sonnet 3.5 thinking)
            try {
              const reasoningData = JSON.parse(trimmed.substring(3));
              const reasoningText = reasoningData?.content || reasoningData;
              if (reasoningText) {
                // CRITICAL: Send thinking content IMMEDIATELY for live updates
                if (!isThinking) {
                  // First thinking chunk - record start time and send opening tag
                  isThinking = true;
                  thinkingStartTime = Date.now();
                  if (!safeOnChunk('<think>')) {
                    break;
                  }
                }

                // Send thinking content immediately (no buffering)
                // This ensures frontend sees thinking happen live and doesn't close prematurely
                try {
                  streamDebug.lastAgAt = Date.now();
                  streamDebug.push('ag', reasoningText);
                } catch {}
                if (!safeOnChunk(reasoningText)) {
                  break; // Client disconnected
                }
              }
            } catch (e) {
              console.error('❌ Failed to parse ag (reasoning) chunk:', e.message);
            }
          } else if (trimmed.startsWith('a3:')) {
            // a3 = Error message from LMArena (usually timeout)
            // Try to parse JSON body for details; fall back to raw string
            const raw = trimmed.substring(3);
            let errorMsg = null;
            let parsedObj = null;
            try {
              const parsed = JSON.parse(raw);
              parsedObj = parsed;
              if (parsed && typeof parsed === 'object') {
                errorMsg = parsed.message || parsed.error || JSON.stringify(parsed);
              } else {
                errorMsg = String(parsed);
              }
            } catch {
              errorMsg = raw.replace(/^\"|\"$/g, '');
            }

            // Minimal diagnostics: duration, sizes, key headers
            const durationMs = Date.now() - startTime;
            const idleMs = Date.now() - (streamDebug.lastEventAt || startTime);
            const sinceA0Ms = streamDebug.lastA0At ? Date.now() - streamDebug.lastA0At : null;
            const sinceAgMs = streamDebug.lastAgAt ? Date.now() - streamDebug.lastAgAt : null;
            const hdr = response?.headers || {};
            const headerPick = {
              status: response?.status,
              'cf-ray': hdr['cf-ray'],
              'retry-after': hdr['retry-after'],
              'content-type': hdr['content-type'],
              date: hdr['date'],
            };
            console.warn('⚠️ LMArena sent a3 error (likely timeout):', errorMsg);
            console.warn('   ↳ Stream diagnostics:', {
              sessionId,
              modelId,
              region: selectedCookie.region,
              retryCount,
              durationMs,
              idleMs,
              sinceA0Ms,
              sinceAgMs,
              bytesSoFar: streamDebug.bytes,
              charsSoFar: fullResponse.length,
              headers: headerPick,
              details: parsedObj && typeof parsedObj === 'object' ? parsedObj : undefined,
            });
            try {
              const recent = streamDebug.events.map((e) => ({ ev: e.ev, len: e.len, s: e.s }));
              const a3Sample = typeof raw === 'string' ? raw.slice(0, 200) : String(raw).slice(0, 200);
              console.warn('   ↳ Recent events:', recent);
              console.warn('   ↳ a3 raw sample/len:', {
                len: (typeof raw === 'string' ? raw.length : String(raw).length) || 0,
                sample: a3Sample,
              });
            } catch {}

            // If we have partial content, immediately trigger continuation
            if (fullResponse.length > 0) {
              console.log(`   📝 Have ${fullResponse.length} chars so far - will trigger continuation`);
              try {
                response.data.destroy();
              } catch {}
              if (!completionNotified) {
                completionNotified = true;
                try {
                  onComplete(sessionId, true);
                } catch {}
              }
              return; // Do not call onError
            } else {
              // No content at all - this is a real error
              console.error('❌ a3 error with no content - treating as fatal');
              response.data.destroy();
              onError(new Error(`LMArena error: ${errorMsg}`));
              return;
            }
          } else if (trimmed.startsWith('e0:')) {
            // e0 = Error event - try to parse JSON for detail
            const eRaw = trimmed.substring(3);
            try {
              const eParsed = JSON.parse(eRaw);
              console.error('❌ LMArena error event (e0):', eParsed);
              try {
                streamDebug.push('e0', typeof eParsed === 'string' ? eParsed : JSON.stringify(eParsed));
              } catch {}
            } catch {
              console.error('❌ LMArena error event (e0):', eRaw);
              try {
                streamDebug.push('e0', eRaw);
              } catch {}
            }
          } else if (trimmed.startsWith('d0:')) {
            // d0 = Data/metadata event
            const dRaw = trimmed.substring(3);
            try {
              const dParsed = JSON.parse(dRaw);
              // Log compact preview to avoid flooding
              const preview =
                typeof dParsed === 'string' ? dParsed.slice(0, 120) : JSON.stringify(dParsed).slice(0, 120);
              console.log('📦 LMArena data event:', preview);
              try {
                streamDebug.push('d0', typeof dParsed === 'string' ? dParsed : JSON.stringify(dParsed));
              } catch {}
            } catch {
              const preview = String(dRaw).slice(0, 120);
              console.log('📦 LMArena data event:', preview);
              try {
                streamDebug.push('d0', preview);
              } catch {}
            }
          }
        }
      });

      response.data.on('end', () => {
        if (softLimitTimer) {
          try {
            clearTimeout(softLimitTimer);
          } catch {}
          softLimitTimer = null;
        }
        // Close thinking tag if still open (no buffer flush needed - we stream immediately)
        if (isThinking) {
          // Calculate actual thinking duration
          const thinkingDuration = thinkingStartTime ? ((Date.now() - thinkingStartTime) / 1000).toFixed(1) : '1.0';

          safeOnChunk(`</think:${thinkingDuration}s>`);
          isThinking = false;
          thinkingStartTime = null;
        }

        const responseTime = Date.now() - startTime;

        // Fallback: If no content was streamed at all, attempt non-streaming fetch
        (async () => {
          try {
            if (fullResponse.length === 0) {
              const fallback = await askLMArena(modelId, message, 0, false, attachments);
              if (fallback && typeof fallback === 'string' && fallback.length > 0) {
                safeOnChunk(fallback);
              }
            }
          } catch (e) {
            console.error('❌ Fallback non-streaming fetch failed:', e.message);
          } finally {
            recordCookieSuccess(selectedCookie.region, responseTime);
            console.log(`✅ Stream completed from ${selectedCookie.region} (${responseTime}ms)`);
            if (!completionNotified) {
              completionNotified = true;
              onComplete(sessionId, false);
            }
          }
        })();
      });

      response.data.on('error', (error) => {
        if (softLimitTimer) {
          try {
            clearTimeout(softLimitTimer);
          } catch {}
          softLimitTimer = null;
        }
        const responseTime = Date.now() - startTime;

        recordCookieError(selectedCookie.region, error);
        onError(error);
      });

      return;
    }

    const responseTime = Date.now() - startTime;

    recordCookieError(selectedCookie.region, new Error(`Status: ${response.status}`));

    // Note: Cloudflare challenge detection removed - use manual cookie management instead
    if (response.status === 429) {
      console.log(`⚠️  Rate limit (429) detected for ${selectedCookie.region} - cookie may need manual refresh`);

      if (retryCount < 2) {
        console.log(`🔄 Retrying with different cookie...`);
        await sleep(2000);
        return askLMArenaStreaming(
          modelId,
          message,
          onChunk,
          onComplete,
          onError,
          retryCount + 1,
          selectedCookie.region,
          false,
          attachments,
        );
      }
    }

    // ═══ CAPTURE FULL RESPONSE BODY FOR DEBUGGING ═══
    let responseBody = '';

    // Collect response data if available
    if (response.data && typeof response.data.on === 'function') {
      // It's a stream - collect all chunks
      await new Promise((resolve) => {
        response.data.on('data', (chunk) => {
          responseBody += chunk.toString();
        });
        response.data.on('end', resolve);
        response.data.on('error', resolve);
        // Add timeout to prevent hanging
        setTimeout(resolve, 2000);
      });
    } else if (response.data) {
      // Already buffered
      responseBody = String(response.data);
    }

    console.error('\n╔═══════════════════════════════════════════════════════════╗');
    console.error('║          LMArena Non-200 Response Analysis                ║');
    console.error('╚═══════════════════════════════════════════════════════════╝');
    console.error(`❌ Status: ${response.status} ${response.statusText || ''}`);
    console.error(`🌍 Cookie: ${selectedCookie.region}`);

    const retryAfter = response.headers?.['retry-after'] || 'unknown';
    console.error(`⏰ Retry-After: ${retryAfter} seconds`);

    console.error(`📋 Headers:`, Object.keys(response.headers || {}).join(', '));

    // Log full response body for analysis
    if (responseBody) {
      console.error(`\n📄 Response Body (${responseBody.length} chars):`);
      console.error('─────────────────────────────────────────────────────────');

      // Check if it's HTML (Cloudflare challenge)
      if (responseBody.includes('<!DOCTYPE') || responseBody.includes('<html')) {
        console.error('⚠️  HTML Response Detected (likely Cloudflare challenge)');
        console.error(responseBody.substring(0, 500) + '...');
      }
      // Check if it's JSON error
      else if (responseBody.trim().startsWith('{') || responseBody.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(responseBody);
          console.error('📊 JSON Response:');
          console.error(JSON.stringify(parsed, null, 2));
        } catch {
          console.error(responseBody);
        }
      }
      // Plain text or other
      else {
        console.error(responseBody.substring(0, 1000));
        if (responseBody.length > 1000) {
          console.error(`... (truncated, total ${responseBody.length} chars)`);
        }
      }

      // Check for specific error patterns (case-insensitive)
      const bodyLower = responseBody.toLowerCase();
      if (bodyLower.includes('rate limit') || bodyLower.includes('too many requests')) {
        console.error('\n🚨 CONFIRMED: Real rate limit from LMArena API');

        // Parse rate limit headers if present
        if (response.headers?.['ratelimit']) {
          console.error(`   📊 Rate Limit Header: ${response.headers['ratelimit']}`);
        }
        if (response.headers?.['ratelimit-policy']) {
          console.error(`   📋 Rate Limit Policy: ${response.headers['ratelimit-policy']}`);

          // Try to parse policy (format: "limit;w=window" e.g., "3000;w=300")
          const policyMatch = response.headers['ratelimit-policy'].match(/(\d+)\s*;\s*w=(\d+)/);
          if (policyMatch) {
            const limit = parseInt(policyMatch[1]);
            const windowSec = parseInt(policyMatch[2]);
            const rps = (limit / windowSec).toFixed(2);
            console.error(`   ⚡ Limit: ${limit} requests per ${windowSec} seconds (~${rps} req/sec)`);
          }
        }
      } else if (bodyLower.includes('cloudflare') || bodyLower.includes('cf-challenge')) {
        console.error('\n🛡️  DETECTED: Cloudflare protection (not real rate limit)');
      } else if (bodyLower.includes('just a moment')) {
        console.error("\n🛡️  DETECTED: Cloudflare 'Just a moment' challenge");
      } else {
        console.error('\n❓ UNKNOWN: Pattern not recognized - may be false positive');
      }
    } else {
      console.error('📄 Response Body: (empty or unavailable)');
    }
    console.error('═══════════════════════════════════════════════════════════\n');

    // Check if this is a REAL Cloudflare challenge (HTML challenge page)
    // Activate bypass when Cloudflare challenge is detected regardless of status code
    const hasCloudflareMarkers =
      responseBody.includes('Cloudflare') ||
      responseBody.includes('Just a moment') ||
      responseBody.includes('cf-challenge') ||
      responseBody.includes('challenge-platform') ||
      responseBody.includes('turnstile');

    const isCloudflareHtmlChallenge = hasCloudflareMarkers && responseBody.includes('<!DOCTYPE');

    // Cloudflare challenge detection (automatic bypass removed - manage cookies manually)
    if (isCloudflareHtmlChallenge) {
      console.error(`\n⚠️  Cloudflare challenge detected on ${selectedCookie.region}!`);
      console.error(`💡 Please refresh cookie manually via dashboard at http://localhost:${CONFIG.port}/dashboard`);
      if (cookieStats[selectedCookie.region]) {
        cookieStats[selectedCookie.region].cooldownUntil = Date.now() + 300000;
      }
      if (retryCount < CONFIG.cookies.length) {
        await sleep(1000);
        return askLMArenaStreaming(
          modelId,
          message,
          onChunk,
          onComplete,
          onError,
          retryCount + 1,
          selectedCookie.region,
          false,
          false,
          attachments,
        );
      }
      onError(new Error('Cloudflare challenge (403)'));
      return;
    }

    // Retry on 404, 429, 403, or other non-200 status codes
    if (
      (response.status === 403 || response.status === 404 || response.status === 429 || response.status >= 500) &&
      retryCount < 3
    ) {
      if (response.status === 403 && cookieStats[selectedCookie.region]) {
        cookieStats[selectedCookie.region].cooldownUntil = Date.now() + 300000;
      }
      const retryDelay = response.status === 429 ? 2000 : 1000; // Wait longer for 429
      console.log(
        `⚠️ Got ${response.status}, retrying with different cookie (attempt ${
          retryCount + 1
        }/3) after ${retryDelay}ms...`,
      );
      await sleep(retryDelay);
      return askLMArenaStreaming(
        modelId,
        message,
        onChunk,
        onComplete,
        onError,
        retryCount + 1,
        selectedCookie.region,
        false,
        attachments,
      );
    }

    onError(new Error(`Unexpected status: ${response.status}`));
  } catch (error) {
    const responseTime = Date.now() - startTime;

    recordCookieError(selectedCookie.region, error);

    // Note: Cloudflare bypass is handled in the 403 detection above

    // Handle 429 errors with window-aware cooldown (min ~60s)
    if (error.response?.status === 429) {
      // ═══ DETAILED 429 ERROR LOGGING ═══
      console.error('\n╔═══════════════════════════════════════════════════════════╗');
      console.error('║           429 Rate Limit Error (Exception)                ║');
      console.error('╚═══════════════════════════════════════════════════════════╝');
      console.error(`🌍 Cookie: ${selectedCookie.region}`);
      console.error(`📋 Headers:`, Object.keys(error.response.headers || {}).join(', '));

      const retryAfter = error.response.headers?.['retry-after'] || 'unknown';
      console.error(`⏰ Retry-After: ${retryAfter} seconds`);

      // Try to capture response body
      if (error.response.data) {
        try {
          let body = '';
          if (typeof error.response.data === 'string') {
            body = error.response.data;
          } else if (typeof error.response.data === 'object') {
            body = JSON.stringify(error.response.data);
          } else {
            body = String(error.response.data);
          }

          console.error(`\n📄 Response Body (${body.length} chars):`);
          console.error('─────────────────────────────────────────────────────────');

          if (body.includes('<!DOCTYPE') || body.includes('<html')) {
            console.error('⚠️  HTML Response - Cloudflare challenge?');
            console.error(body.substring(0, 500) + '...');
          } else if (body.trim().startsWith('{')) {
            try {
              const parsed = JSON.parse(body);
              console.error('📊 JSON Response:');
              console.error(JSON.stringify(parsed, null, 2));
            } catch {
              console.error(body.substring(0, 1000));
            }
          } else {
            console.error(body.substring(0, 1000));
          }

          // Pattern detection (case-insensitive)
          const bodyLower = body.toLowerCase();
          if (bodyLower.includes('rate limit') || bodyLower.includes('too many requests')) {
            console.error('\n🚨 CONFIRMED: Real rate limit from LMArena');

            // Parse rate limit headers if present
            if (error.response.headers?.['ratelimit']) {
              console.error(`   📊 Rate Limit Header: ${error.response.headers['ratelimit']}`);
            }
            if (error.response.headers?.['ratelimit-policy']) {
              console.error(`   📋 Rate Limit Policy: ${error.response.headers['ratelimit-policy']}`);

              // Try to parse policy (format: "limit;w=window" e.g., "3000;w=300")
              const policyMatch = error.response.headers['ratelimit-policy'].match(/(\d+)\s*;\s*w=(\d+)/);
              if (policyMatch) {
                const limit = parseInt(policyMatch[1]);
                const windowSec = parseInt(policyMatch[2]);
                const rps = (limit / windowSec).toFixed(2);
                console.error(`   ⚡ Limit: ${limit} requests per ${windowSec} seconds (~${rps} req/sec)`);
              }
            }
          } else if (bodyLower.includes('cloudflare') || bodyLower.includes('cf-challenge')) {
            console.error('\n🛡️  DETECTED: Cloudflare protection (false positive)');
          } else {
            console.error('\n❓ UNKNOWN: Pattern not recognized');
          }
        } catch (e) {
          console.error(`📄 Response Body: (failed to parse: ${e.message})`);
        }
      } else {
        console.error('📄 Response Body: (not available)');
      }
      console.error('═══════════════════════════════════════════════════════════\n');

      if (typeof RATE_PACER !== 'undefined' && RATE_PACER.on429) {
        RATE_PACER.on429(modelId, selectedCookie.region, error.response.headers);
      }
      // Mark proxy limited for retry-after
      const ra = parseInt(error.response.headers?.['retry-after'] || '60', 10);
      // Fast failover: if global bucket has tokens, try a different proxy immediately once or twice
      const canFastSwap = (() => {
        try {
          if (typeof RATE_PACER === 'undefined' || !RATE_PACER.stats) return false;
          const buckets = RATE_PACER.stats();
          return buckets?.global?.tokens && buckets.global.tokens >= 1;
        } catch {
          return false;
        }
      })();

      if (retryCount < 3 && canFastSwap) {
        console.log(`🔁 429: trying a different proxy immediately (fast failover)`);
        return askLMArenaStreaming(
          modelId,
          message,
          onChunk,
          onComplete,
          onError,
          retryCount + 1,
          selectedCookie.region,
          true, // skipPacerWait for fast failover
          attachments,
        );
      }
      // Otherwise wait for permits as before
      if (retryCount < 2 && typeof RATE_PACER !== 'undefined' && RATE_PACER.awaitPermit) {
        console.log(`⏳ 429 received. Waiting window before retry...`);
        let granted = false;
        const permit = RATE_PACER.awaitPermit(modelId, selectedCookie.region).then(() => (granted = true));
        while (!granted) {
          try {
            onChunk(' ');
          } catch {}
          await sleep(1000);
        }
        await permit;
        return askLMArenaStreaming(
          modelId,
          message,
          onChunk,
          onComplete,
          onError,
          retryCount + 1,
          selectedCookie.region,
          false,
          attachments,
        );
      }
    }

    onError(error);
  }
}

// ==================== NON-STREAMING REQUEST ====================

async function askLMArena(modelId, message, retryCount = 0, isIterationRequest = false, attachments = []) {
  // Select cookie for request
  const selectedCookie = await selectCookie('round-robin');

  // Adaptive pacer pre-flight for non-streaming, region-scoped
  if (typeof RATE_PACER !== 'undefined' && RATE_PACER.awaitPermit) {
    try {
      await RATE_PACER.awaitPermit(modelId, selectedCookie.region);
    } catch {}
  }
  if (rateLimit.remaining < 5) {
    const waitTime = Math.max(0, rateLimit.resetAt - Date.now());
    if (waitTime > 0) await sleep(waitTime);
  }
  // STEP 1: Process message WITHOUT compression - check payload size before compressing
  let processed = processMessage(message, CONFIG.maxMessageBytes, true); // skipCompression = true

  const sessionId = generateUUIDv7();
  const userMsgId = generateUUIDv7();
  const assistantMsgId = generateUUIDv7();

  console.log(`\n🔵 Non-streaming Request #${retryCount + 1}`);
  console.log(`   Compressed: ${processed.originalSize} → ${processed.newSize} bytes`);
  console.log(`   Cookie: ${selectedCookie.region}`);

  // CRITICAL: Check if images are present - this affects content handling
  const hasAttachments = attachments && attachments.length > 0;

  // ALWAYS use full context - images or not
  const contentForMessage = processed.message;

  if (hasAttachments) {
    console.log(`   🖼️  Image attachments detected: ${attachments.length} image(s)`);
    console.log(`   📊 Using full context: ${(Buffer.byteLength(contentForMessage, 'utf8') / 1024).toFixed(2)}KB`);
    console.log(`   🔗 Attachments:`, JSON.stringify(attachments, null, 2));
  }

  // CRITICAL: Use SIMPLIFIED payload format matching lmarena.py and streaming implementation
  // LMArena ONLY needs: id, mode, modelAId, userMessageId, modelAMessageId, userMessage, modality
  // The old format with full messages array was causing 403 rejections!
  const payload = {
    id: sessionId,
    mode: 'direct',
    modelAId: modelId,
    userMessageId: userMsgId,
    modelAMessageId: assistantMsgId,
    userMessage: {
      content: contentForMessage,
      experimental_attachments: attachments || [],
    },
    modality: 'chat',
  };

  // STEP 2: Smart compression based on MESSAGE size
  let payloadString = JSON.stringify(payload);
  let payloadBytes = Buffer.byteLength(payloadString, 'utf8');
  const realMetadataBytes = payloadBytes - processed.newSize;

  if (processed.newSize > CONFIG.maxMessageBytes) {
    const targetMessageSize = CONFIG.maxMessageBytes;
    const recompressed = contextAwareCompress(processed.message, targetMessageSize);
    payload.userMessage.content = recompressed.message;
    payloadString = JSON.stringify(payload);
    payloadBytes = Buffer.byteLength(payloadString, 'utf8');
  }

  // Prepare request configuration (match streaming headers exactly)
  const requestConfig = {
    headers: {
      'Content-Type': process.env.LM_JSON === 'true' ? 'application/json' : 'text/plain;charset=UTF-8',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://lmarena.ai',
      Referer: 'https://lmarena.ai/?mode=direct',

      // Cloudflare checks these headers
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'sec-ch-ua': '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-ch-ua-full-version': '"131.0.0.0"',
      'sec-ch-ua-full-version-list':
        '"Chromium";v="131.0.0.0", "Google Chrome";v="131.0.0.0", "Not_A Brand";v="99.0.0.0"',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'X-Requested-With': 'XMLHttpRequest',

      Host: 'lmarena.ai',
      Cookie: selectedCookie.cookie,
      Connection: 'keep-alive',
    },
    responseType: 'stream',
    timeout: 0,
    validateStatus: (status) => status < 500,
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true }),
  };

  // Preflight for non-streaming: avoid starting request if Cloudflare challenge
  try {
    const pre = await axios.get('https://lmarena.ai/', {
      headers: {
        'User-Agent': requestConfig.headers['User-Agent'],
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://lmarena.ai/?mode=direct',
        Origin: 'https://lmarena.ai',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Upgrade-Insecure-Requests': '1',
        'Accept-Encoding': 'gzip, deflate, br',
        Cookie: selectedCookie.cookie,
        Connection: 'keep-alive',
      },
      maxRedirects: 0,
      validateStatus: (s) => s < 500,
      responseType: 'text',
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true }),
    });
    // Cloudflare bypass removed - manage cookies manually
  } catch {}

  // CRITICAL: LMArena ONLY supports streaming responses!
  // Must set responseType:'stream' even for non-streaming client requests
  requestConfig.responseType = 'stream';

  // CRITICAL: Use same HTTP agents as streaming for consistent behavior
  requestConfig.httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    timeout: 120000, // Match requestConfig timeout
    scheduling: 'fifo',
  });
  requestConfig.httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    timeout: 120000, // Match requestConfig timeout
    scheduling: 'fifo',
  });

  try {
    const response = await axios.post(
      'https://lmarena.ai/nextjs-api/stream/create-evaluation',
      JSON.stringify(payload),
      requestConfig,
    );

    // Explicit 429 handling on resolved responses (axios does not throw for <500)
    if (response.status === 429) {
      // Inform pacer about 429
      if (typeof RATE_PACER !== 'undefined' && RATE_PACER.on429) {
        RATE_PACER.on429(modelId, selectedCookie.region, response.headers);
      }
      // Fast failover attempts before waiting (skip pacer)
      const maxFast = parseInt(process.env.PROXY_FAST_FAILOVER_ATTEMPTS || '3', 10);
      if (retryCount < maxFast) {
        console.log('🔁 429: fast failover to a different proxy');
        // Retry with non-streaming function (don't switch to streaming)
        return askLMArena(modelId, message, retryCount + 1, false, attachments);
      }
      // Otherwise wait for permits then retry with non-streaming
      if (typeof RATE_PACER !== 'undefined' && RATE_PACER.awaitPermit) {
        await RATE_PACER.awaitPermit(modelId, selectedCookie.region);
      }
      return askLMArena(modelId, message, retryCount + 1, false, false, attachments);
    }

    if (response.status === 400) {
      // ═══ DETAILED ERROR LOGGING FOR PAYLOAD SIZE TESTING ═══
      const errorData = JSON.stringify(response.data);
      console.log(`\n❌ 400 Bad Request from LMArena (Non-Streaming)`);
      console.log(`   📦 Our Payload Size: ${(payloadBytes / 1024).toFixed(2)}KB (${payloadBytes} bytes)`);
      console.log(`   📝 Message Size: ${(processed.newSize / 1024).toFixed(2)}KB (appears 2× in payload)`);
      console.log(`   🔧 Metadata Size: ${(realMetadataBytes / 1024).toFixed(2)}KB`);
      console.log(`   📄 LMArena Response:`);
      console.log(`   ════════════════════════════════════════════════════════`);
      console.log(errorData);
      console.log(`   ════════════════════════════════════════════════════════\n`);

      if (retryCount >= 3) {
        throw new Error(`400 Bad Request after ${retryCount} retries: ${errorData}`);
      }

      recordCookieError(selectedCookie.region, new Error('400 Bad Request'));
      const waitTime = Math.pow(2, retryCount) * 1000;
      await sleep(waitTime);
      return askLMArena(modelId, message, retryCount + 1, false, attachments);
    }

    updateRateLimit(response.headers);

    if (response.status === 200) {
      recordCookieSuccess(selectedCookie.region, 0);

      // Buffer the stream response
      let responseText = '';
      for await (const chunk of response.data) {
        responseText += chunk.toString();
      }

      const parsed = parseStreamingResponse(responseText);
      const finalResponse = parsed.response;

      if (!finalResponse || finalResponse.trim().length === 0) {
        throw new Error('Empty response');
      }

      console.log(`✅ Success`);
      return finalResponse.trim();
    }

    // Check if it's a REAL Cloudflare 403 challenge (must have multiple indicators)
    if (response.status === 403) {
      const responseData = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

      const hasCloudflareMarkers =
        responseData.includes('Cloudflare') ||
        responseData.includes('Just a moment') ||
        responseData.includes('cf-challenge') ||
        responseData.includes('challenge-platform') ||
        responseData.includes('turnstile');

      const is403Cloudflare = hasCloudflareMarkers && responseData.includes('<!DOCTYPE'); // Must be HTML with CF markers

      if (is403Cloudflare) {
        console.error(`\n⚠️  Cloudflare challenge detected on ${selectedCookie.region}!`);
        console.error(`💡 Please refresh cookie manually via dashboard at http://localhost:${CONFIG.port}/dashboard`);

        // Mark cookie for cooldown (5 minutes)
        if (cookieStats[selectedCookie.region]) {
          cookieStats[selectedCookie.region].cooldownUntil = Date.now() + 300000;
        }
      }
    }

    throw new Error(`Status: ${response.status}`);
  } catch (error) {
    recordCookieError(selectedCookie.region, error);

    // Note: Cloudflare bypass removed - manage cookies manually via dashboard

    // Handle 429 errors with window-aware cooldown (min ~60s) and region scoping
    if (error.response?.status === 429) {
      const retryAfter = parseInt(error.response.headers?.['retry-after'] || '60', 10);
      if (typeof RATE_PACER !== 'undefined' && RATE_PACER.on429) {
        RATE_PACER.on429(modelId, selectedCookie.region, error.response.headers);
      }
      if (retryCount < 2 && typeof RATE_PACER !== 'undefined' && RATE_PACER.awaitPermit) {
        console.log(`⏳ 429 received. Waiting window before retry...`);
        await RATE_PACER.awaitPermit(modelId, selectedCookie.region);
        return askLMArena(modelId, message, retryCount + 1, false, false, attachments);
      }
    }

    throw error;
  }
}

// ==================== API ENDPOINTS ====================

app.get('/', (req, res) => {
  res.json({
    name: 'LM Arena API - Multi-Region Load Distribution',
    version: '4.0.0',
    status: 'online',
    features: ['streaming', 'non-streaming', 'multi-region', 'load-balancing'],
    regions: CONFIG.cookies.map((c) => ({
      region: c.region,
      active: c.active && c.cookie.length > 0,
      requests: c.requestCount,
      successRate: c.successRate.toFixed(1) + '%',
    })),
    models: Object.keys(CONFIG.models),
  });
});

app.get('/v1/models', (req, res) => {
  const models = Object.entries(CONFIG.models).map(([id, data]) => ({
    id,
    object: 'model',
    owned_by: 'lmarena',
    description: data.name,
  }));

  res.json({ object: 'list', data: models });
});

app.post('/v1/chat/completions', async (req, res) => {
  // Add queue status headers
  res.setHeader('X-Queue-Size', requestQueue.size);
  res.setHeader('X-Queue-Pending', requestQueue.pending);
  res.setHeader('X-Max-Concurrent', CONFIG.queue.maxConcurrent);

  // If queue is disabled, process immediately
  if (!CONFIG.queue.enabled) {
    return handleChatCompletion(req, res);
  }

  // Determine timeout based on streaming mode
  const isStreaming = req.body?.stream === true;
  const timeout = isStreaming ? CONFIG.queue.streamingTimeout : CONFIG.queue.timeout;

  // Queue the request with appropriate timeout
  try {
    await requestQueue.add(
      async () => {
        return handleChatCompletion(req, res);
      },
      { timeout },
    ); // Use longer timeout for streaming requests
  } catch (error) {
    // Queue timeout or error
    if (error.message?.includes('timeout')) {
      queueStats.totalTimeout++;
      return res.status(503).json({
        error: {
          message: isStreaming
            ? `Streaming request timeout after ${timeout / 1000 / 60} minutes - response too long. Try a shorter query.`
            : 'Request queue timeout - server is overloaded. Please try again later.',
          type: 'queue_timeout',
          queueSize: requestQueue.size,
          retryAfter: 60,
          isStreaming,
        },
      });
    }
    return res.status(500).json({ error: { message: error.message } });
  }
});

// Extracted handler function for queue wrapping
async function handleChatCompletion(req, res) {
  try {
    const activeCookies = CONFIG.cookies.filter((c) => c.active && c.cookie.length > 0);
    if (activeCookies.length === 0) {
      return res.status(500).json({
        error: { message: 'No active cookies configured' },
      });
    }

    let { model = 'claude-4.5-sonnet', messages, stream = false } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: 'messages required' } });
    }

    // Debug: Log incoming message format
    console.log(
      `📥 Incoming request format:`,
      JSON.stringify({
        model,
        messageCount: messages.length,
        firstMessageContent:
          typeof messages[0]?.content === 'string'
            ? `string (${messages[0].content.length} chars)`
            : `array (${messages[0]?.content?.length} parts)`,
        stream,
      }),
    );

    // Debug: Show message structure
    messages.forEach((msg, idx) => {
      const contentInfo =
        typeof msg.content === 'string'
          ? `string (${msg.content.length} chars)`
          : Array.isArray(msg.content)
            ? `array (${msg.content.length} parts: ${msg.content.map((p) => p.type).join(', ')})`
            : 'unknown';
      console.log(`🔍 Message ${idx} (${msg.role}): ${contentInfo}`);

      // DEBUG: Show array content parts in detail
      if (Array.isArray(msg.content)) {
        msg.content.forEach((part, partIdx) => {
          console.log(`   📦 Part ${partIdx}: type="${part.type}"`);
          if (part.type === 'text') {
            console.log(`      text: "${part.text?.substring(0, 100)}..."`);
          } else if (part.type === 'image_url') {
            const imgUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            const urlPreview = imgUrl?.substring(0, 100) || 'N/A';
            console.log(`      image_url: "${urlPreview}..."`);
            console.log(`      isBase64: ${imgUrl?.startsWith('data:image/')}`);
            if (imgUrl?.startsWith('data:image/')) {
              const base64Part = imgUrl.split('base64,')[1] || '';
              console.log(`      base64 length: ${base64Part.length} chars`);
            }
          }
        });
      }

      // Show preview if it contains "data:image"
      if (typeof msg.content === 'string' && msg.content.includes('data:image')) {
        const parts = msg.content.split('data:image');
        console.log(`   📸 Contains ${parts.length - 1} "data:image" occurrences in text`);

        // Show context around EACH occurrence
        parts.slice(1).forEach((part, idx) => {
          const before = parts[idx].slice(-100); // 100 chars before
          const after = part.substring(0, 150); // 150 chars after
          console.log(`   🔍 Occurrence ${idx + 1}:`);
          console.log(`      Before: "...${before}"`);
          console.log(`      After: "data:image${after}..."`);
        });
      }
    });

    // ═══ IMAGE ATTACHMENTS DISABLED ═══
    // LMArena's experimental_attachments feature is unreliable and causes failures
    // Image upload functionality is disabled both in frontend and backend
    console.log(`ℹ️  Image attachments are currently disabled`);
    const hasImages = false;
    const images = [];
    const originalModel = model;

    const modelConfig = CONFIG.models[model];
    if (!modelConfig) {
      return res.status(400).json({ error: { message: `Model not found: ${model}` } });
    }

    // ═══ REMOVED: <complete> tag instruction (was causing premature cutoffs)
    // The AI was interpreting "finished" as "finished coding" not "finished explaining"
    // Now relying on natural stream completion from LMArena

    // Extract last user message separately (for userMessage field)
    const lastUserMessage = messages
      .slice()
      .reverse()
      .find((m) => m.role === 'user');

    let lastUserContent = '';
    if (lastUserMessage) {
      if (Array.isArray(lastUserMessage.content)) {
        lastUserContent = lastUserMessage.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(' ');
      } else if (typeof lastUserMessage.content === 'string') {
        lastUserContent = lastUserMessage.content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE]');
      }
    }

    // Build full conversation prompt (for messages array)
    const prompt = messages
      .filter((m) => m.role && m.content)
      .map((m, idx) => {
        // Extract text content from array format
        let content = m.content;
        if (Array.isArray(m.content)) {
          content = m.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join(' ');
        } else if (typeof content === 'string') {
          // Remove base64 image data URIs from string content
          content = content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE]');
        }

        // Simple role formatting without completion tags
        if (m.role === 'system') {
          return `System: ${content}`;
        }
        if (m.role === 'user') return `User: ${content}`;
        if (m.role === 'assistant') return `Assistant: ${content}`;
        return content;
      })
      .join('\n\n');

    console.log(
      `📝 Full prompt: ${prompt.length} chars, Last user msg: ${lastUserContent.length} chars, Images: ${images.length}`,
    );

    // STREAMING
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders(); // Immediately send headers to client

      // Track if response is still writable
      let responseOpen = true;
      let lastChunkTime = Date.now();
      let fullResponse = ''; // Accumulate full response
      let continuationCount = 0; // Track continuation attempts
      // MAX_CONTINUATIONS: Only 1 continuation needed - a3 timeouts typically occur near end (95%+ complete)
      // Continuation includes FULL original prompt + previous response for complete context
      const MAX_CONTINUATIONS = 1;
      let currentSessionId = null; // Capture session ID for continuation logging

      // Continuation now only triggers on provider timeout (a3 event)

      // ═══ SMART PRE-COMPRESSION: Compress prompt for continuation storage ═══
      const promptBytes = Buffer.byteLength(prompt, 'utf8');
      let originalPrompt = prompt;

      // Continuation budget: Message limit is 85KB (safe based on testing)
      // Continuation prompt structure: originalPrompt + context (8KB) + instructions (1KB)
      // So: originalPrompt + 9KB <= 85KB → originalPrompt <= 76KB
      const maxSafeContinuationPrompt = 76000; // Leaves 9KB for context+instructions

      if (promptBytes > maxSafeContinuationPrompt) {
        console.log(
          `   ⚠️  Large prompt for continuations: ${(promptBytes / 1024).toFixed(1)}KB → compressing to ${(
            maxSafeContinuationPrompt / 1024
          ).toFixed(1)}KB`,
        );
        const precompressed = processMessage(prompt, maxSafeContinuationPrompt);
        originalPrompt = precompressed.message;
        console.log(`   ✅ Pre-compressed to ${(precompressed.newSize / 1024).toFixed(1)}KB for continuation storage`);
      } else {
        console.log(
          `   ✅ Prompt size OK for continuations: ${(promptBytes / 1024).toFixed(1)}KB (no pre-compression needed)`,
        );
      }

      const originalImages = images;

      res.on('close', () => {
        console.log('⚠️ Client closed connection');
        console.log(`   📊 Chunks sent: ${fullResponse.length} chars`);
        responseOpen = false;
      });
      res.on('finish', () => {
        console.log('✅ Response finished normally');
        responseOpen = false;
      });
      res.on('error', (err) => {
        console.error('❌ Response stream error:', err.message);
        console.error('   Stack:', err.stack);
        responseOpen = false;
      });

      // Heartbeat to keep connection alive during slow responses
      const heartbeatInterval = setInterval(() => {
        if (!responseOpen) {
          clearInterval(heartbeatInterval);
          return;
        }

        // If no chunk received in last 10 seconds, send comment to keep connection alive
        if (Date.now() - lastChunkTime > 10000) {
          try {
            // Check if response is still writable before sending heartbeat
            if (res.writable && !res.writableEnded) {
              res.write(': keepalive\n\n'); // SSE comment (ignored by client)
            } else {
              console.log('⚠️ Response not writable, stopping heartbeat');
              clearInterval(heartbeatInterval);
              responseOpen = false;
            }
          } catch (e) {
            console.error('❌ Heartbeat write failed:', e.message);
            console.error('   Writable:', res.writable, 'WritableEnded:', res.writableEnded);
            clearInterval(heartbeatInterval);
            responseOpen = false;
          }
        }
      }, 5000); // Check every 5 seconds

      // Cleanup on finish
      res.on('finish', () => {
        clearInterval(heartbeatInterval);
      });

      await askLMArenaStreaming(
        modelConfig.lmarenaId,
        prompt,
        (content) => {
          if (!responseOpen) {
            console.log('⚠️ Skipping chunk - client already disconnected');
            return;
          }
          try {
            lastChunkTime = Date.now(); // Update heartbeat timer

            // Accumulate full response
            fullResponse += content;

            // Send content directly (no tag stripping needed)
            if (content) {
              const chunk = {
                id: 'chatcmpl-' + generateUUIDv7(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: content },
                    finish_reason: null,
                  },
                ],
              };
              const written = res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              if (!written) {
                console.log('⚠️ Write buffer full - backpressure detected');
              }
            }
          } catch (e) {
            console.error('❌ CRITICAL: Error in chunk handler:', e.message);
            console.error('   Stack:', e.stack);
            console.error('   Content length:', content?.length);
            console.error('   ResponseOpen:', responseOpen);
            responseOpen = false;
          }
        },
        async (receivedSessionId, timedOut) => {
          clearInterval(heartbeatInterval); // Stop heartbeat

          // Capture session ID for continuation logging
          if (receivedSessionId) {
            currentSessionId = receivedSessionId;
          }

          if (!responseOpen) {
            console.log('⚠️ Stream completed but client already disconnected - response incomplete!');
            return;
          }

          // Continuation only if provider timed out (a3 event)
          if (timedOut && continuationCount < MAX_CONTINUATIONS && fullResponse.length > 0) {
            continuationCount++;
            console.log(
              `🔄 Provider timeout detected - auto-continuing (attempt ${continuationCount}/${MAX_CONTINUATIONS})...`,
            );
            console.log(`   📝 Current response: ${fullResponse.length} chars, last 50: "${fullResponse.slice(-50)}"`);

            // ═══ CONTEXT-AWARE CONTINUATION: Include FULL context ═══
            // CRITICAL: After a3 timeout, the session is CLOSED on LMArena's side
            // - We CANNOT append to a closed session (results in "session already exists" error)
            // - Must create NEW session ID with full context
            // - Include: original prompt + previous response for seamless continuation

            // Build continuation prompt with FULL context
            // CRITICAL: Force immediate continuation WITHOUT thinking/explanation
            const continuationPrompt = `${originalPrompt}

---YOUR PREVIOUS RESPONSE (CUT OFF AT THIS EXACT POINT)---
${fullResponse}
---END---

CRITICAL INSTRUCTIONS FOR CONTINUATION:
1. Continue writing IMMEDIATELY from the exact character where you stopped
2. Do NOT use <think> tags or reasoning blocks
3. Do NOT explain what you're going to do or ask clarification questions
4. Do NOT repeat ANY code or text already written above
5. Do NOT add preamble like "Let me continue..." or "I should..."
6. Just output the next tokens as if the timeout never happened
7. Start your response with the VERY NEXT CHARACTER that should follow

BEGIN CONTINUATION NOW (no preamble, no analysis, just the next character):`;

            const totalBytes = Buffer.byteLength(continuationPrompt, 'utf8');
            console.log(
              `   📊 Continuation prompt: ${totalBytes} bytes (original: ${originalPrompt.length} + response: ${fullResponse.length})`,
            );
            console.log(
              `   🔄 Generating NEW session ID (after provider timeout, session is closed and can't be reused)`,
            );

            // Send continuation request (recursive call to askLMArenaStreaming)
            try {
              // Define completion handler for continuation
              const handleContinuationComplete = async (receivedSessionId, timedOut) => {
                // Update session ID for further continuations
                if (receivedSessionId) {
                  currentSessionId = receivedSessionId;
                }
                // Continuation disabled - always end normally
                if (false && continuationCount < MAX_CONTINUATIONS) {
                  // Recurse - call this handler again
                  continuationCount++;
                  console.log(`🔄 Auto-continuing response (attempt ${continuationCount}/${MAX_CONTINUATIONS})...`);

                  try {
                    await askLMArenaStreaming(
                      modelConfig.lmarenaId,
                      continuationPrompt,
                      continuationChunkHandler,
                      handleContinuationComplete, // Recursive call
                      continuationErrorHandler,
                      0,
                      null,
                      false,
                      [], // Don't resend images - they were already processed
                      null, // Generate NEW session (a3 timeout closed previous session)
                      null, // No split payload for continuations
                    );
                    return;
                  } catch (err) {
                    console.error('❌ Continuation recursion failed:', err.message);
                  }
                }

                // If we get here, either complete or max retries
                sendFinalChunk();
              };

              // Define chunk handler for continuation
              const continuationChunkHandler = (content) => {
                if (!responseOpen) return;
                try {
                  lastChunkTime = Date.now();
                  fullResponse += content;

                  // Send content directly without tag checking
                  if (content) {
                    const chunk = {
                      id: 'chatcmpl-' + generateUUIDv7(),
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model,
                      choices: [
                        {
                          index: 0,
                          delta: { content: content },
                          finish_reason: null,
                        },
                      ],
                    };
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                  }
                } catch (e) {
                  console.error('❌ Error writing continuation chunk:', e.message);
                  responseOpen = false;
                }
              };

              // Define error handler for continuation
              const continuationErrorHandler = (error) => {
                console.error('❌ Continuation failed:', error.message);
                sendFinalChunk();
              };

              // Helper to send final chunk
              const sendFinalChunk = () => {
                if (!responseOpen) return;
                try {
                  console.log('📤 Sending final chunk and [DONE] marker...');
                  const finalChunk = {
                    id: 'chatcmpl-' + generateUUIDv7(),
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  };
                  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                  res.write('data: [DONE]\n\n');
                  res.end();
                  console.log(`✅ Stream completed normally`);
                } catch (e) {
                  console.error('❌ Error sending final chunk:', e.message);
                }
              };

              // Start the continuation chain
              await askLMArenaStreaming(
                modelConfig.lmarenaId,
                continuationPrompt,
                continuationChunkHandler,
                handleContinuationComplete,
                continuationErrorHandler,
                0,
                null,
                false,
                [], // Don't resend images - they were already processed in first request
                null, // FIX: Generate NEW session (a3 timeout closed the previous session)
                null, // No split payload needed for continuations
              );
              return; // Don't send [DONE] yet, continuation in progress
            } catch (error) {
              console.error('❌ Failed to start continuation:', error.message);
              // Fall through to send [DONE]
            }
          }

          // Fallback: if nothing streamed, perform non-streaming fetch and emit
          if (fullResponse.length === 0) {
            try {
              const fallbackText = await askLMArena(modelConfig.lmarenaId, prompt, 0, false, images);
              if (fallbackText && responseOpen) {
                const chunk = {
                  id: 'chatcmpl-' + generateUUIDv7(),
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: fallbackText },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                fullResponse = fallbackText;
              }
            } catch (e) {
              console.error('❌ Non-streaming fallback failed:', e.message);
            }
          }

          // Send final chunk and [DONE]
          try {
            console.log('📤 Sending final chunk and [DONE] marker...');
            const finalChunk = {
              id: 'chatcmpl-' + generateUUIDv7(),
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            };
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            console.log(`✅ Stream completed - sent to client`);
          } catch (e) {
            console.error('❌ Error writing final chunk:', e.message, e.stack);
          }
        },
        (error) => {
          clearInterval(heartbeatInterval); // Stop heartbeat
          if (!responseOpen) {
            console.log('⚠️ Error occurred but client already disconnected');
            return;
          }
          try {
            console.error('❌ Streaming error:', error.message);
            res.write(
              `data: ${JSON.stringify({
                error: { message: error.message, stack: error.stack },
              })}\n\n`,
            );
            res.end();
          } catch (e) {
            console.error('❌ Error writing error response:', e.message);
          }
        },
        0, // retryCount
        null, // lastCookieRegion
        true, // skipPacerWait to reduce pre-flight delay
        images, // attachments
        null, // existingSessionId - not a continuation
        lastUserContent, // SPLIT PAYLOAD: just the user's question (not full context)
      );

      return;
    }

    // NON-STREAMING
    const responseText = await askLMArena(
      modelConfig.lmarenaId,
      prompt,
      0, // retryCount
      false, // isIterationRequest
      images, // attachments
    );

    res.json({
      id: 'chatcmpl-' + generateUUIDv7(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: responseText },
          finish_reason: 'stop',
        },
      ],
    });
  } catch (error) {
    try {
      if (req.body?.stream === true || res.headersSent) {
        try {
          res.write(
            `data: ${JSON.stringify({
              error: { message: error.message },
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        } catch {}
      }
      res.status(500).json({ error: { message: error.message } });
    } catch (e) {
      try {
        res.end();
      } catch {}
    }
  }
}

// Queue statistics endpoint
app.get('/stats/queue', (req, res) => {
  res.json({
    enabled: CONFIG.queue.enabled,
    maxConcurrent: CONFIG.queue.maxConcurrent,
    currentSize: requestQueue.size,
    pending: requestQueue.pending,
    stats: {
      totalQueued: queueStats.totalQueued,
      totalProcessed: queueStats.totalProcessed,
      totalTimeout: queueStats.totalTimeout,
      totalSuccess: queueStats.totalSuccess,
      totalFailure: queueStats.totalFailure,
    },
  });
});

app.get('/stats/cookies', (req, res) => {
  res.json({
    cookies: CONFIG.cookies.map((c) => ({
      region: c.region,
      active: c.active && c.cookie.length > 0,
      requests: c.requestCount,
      errors: c.errors,
      successRate: c.successRate.toFixed(1) + '%',
      lastUsed: new Date(c.lastUsed),
    })),
    stats: cookieStats,
  });
});

app.post('/admin/reset-cookies', (req, res) => {
  // Reset all cookie error counts and reactivate them
  for (const cookie of CONFIG.cookies) {
    cookie.errors = 0;
    cookie.active = true;
    cookie.successRate = 100;

    // Reset stats as well
    if (cookieStats[cookie.region]) {
      cookieStats[cookie.region].errorCount = 0;
      cookieStats[cookie.region].successCount = 0;
      cookieStats[cookie.region].lastError = null;
      cookieStats[cookie.region].averageResponseTime = 0;
      cookieStats[cookie.region].totalResponseTime = 0;
    }
  }

  console.log('🔄 All cookies have been reset and reactivated');

  res.json({
    message: 'All cookies have been reset and reactivated',
    cookies: CONFIG.cookies.map((c) => ({
      region: c.region,
      active: c.active,
      errors: c.errors,
      successRate: c.successRate.toFixed(1) + '%',
    })),
  });
});

app.get('/debug/400-errors', (req, res) => {
  res.json(error400Tracker.getStats());
});

// Rate limiter stats
app.get('/stats/rate-limits', (req, res) => {
  try {
    if (typeof RATE_PACER !== 'undefined' && RATE_PACER.stats) {
      res.json({ buckets: RATE_PACER.stats() });
      return;
    }
    res.json({ buckets: {} });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

app.get('/health', (req, res) => {
  const activeCookies = CONFIG.cookies.filter((c) => c.active && c.cookie.length > 0).length;

  res.json({
    status: 'ok',
    activeCookies: activeCookies,
    totalCookies: CONFIG.cookies.length,
    cookieStats: CONFIG.cookies.map((c) => ({
      region: c.region,
      active: c.active && c.cookie.length > 0,
      successRate: c.successRate.toFixed(1) + '%',
    })),
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: { message: `Endpoint not found: ${req.method} ${req.path}` },
  });
});

// ==================== START SERVER ====================

// ═══ CLOUDFLARE BYPASS ENABLED ═══
// Automatic bypass triggers on-demand when 403 challenges are detected
// No initialization needed - bypass activates only when necessary
// This reduces overhead while still providing protection
console.log(`\n🛡️  Cloudflare Bypass: Ready (on-demand activation)`);
console.log(`   Will automatically solve challenges when 403 detected`);

// ==================== START SERVER ====================
// Wait for cookies to load before starting server
await cookiesLoaded;

const server = app.listen(CONFIG.port, async () => {
  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║   LM Arena API - Multi-Region Load Distribution 🌍       ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);
  console.log(`🚀 Server: http://localhost:${CONFIG.port}`);
  console.log(`🌍 Active Regions: ${CONFIG.cookies.filter((c) => c.active).length}`);
  console.log(`Regions: ${CONFIG.cookies.map((c) => c.region).join(', ') || 'None'}\n`);

  console.log(`Load Distribution Strategy:`);
  console.log(`✅ Round-robin (default)`);
  console.log(`✅ Load-balanced selection`);
  console.log(`✅ Success-rate based routing`);
  console.log(`✅ Auto-failover on errors`);
  console.log(`✅ Response time tracking\n`);

  console.log(`Features:`);
  console.log(`✅ Multi-region cookie rotation`);
  console.log(`✅ Balanced compression`);
  console.log(`✅ Automatic error recovery`);
  console.log(`✅ Per-region statistics`);
  console.log(`✅ Load monitoring`);
  console.log(`✅ Global rate limiting`);
  console.log(`✅ Fallback to direct connections\n`);

  console.log(`Endpoints:`);
  console.log(`📡 POST /v1/chat/completions`);
  console.log(`📊 GET  /stats/cookies (view all stats)`);
  console.log(`🏥 GET  /health`);
  console.log(`🐛 GET  /debug/400-errors\n`);

  if (CONFIG.cookies.length === 0) {
    console.log(`Setup:`);
    console.log(`export COOKIE_SG="your_singapore_cookie"`);
    console.log(`export COOKIE_US="your_us_cookie"`);
    console.log(`export COOKIE_EU="your_eu_cookie"`);
    console.log(`export COOKIE_JP="your_japan_cookie"\n`);
  }
});

// Note: Automatic cookie health monitor removed - manage cookies manually via dashboard

// ==================== FIX SERVER TIMEOUTS FOR STREAMING ====================
// Set server timeouts to 0 (infinite) to allow long streaming responses
server.timeout = 0; // No timeout for requests (allows long streaming)
server.keepAliveTimeout = 0; // Keep connections alive indefinitely
server.headersTimeout = 0; // No timeout for headers
console.log('🔧 Server timeouts disabled for streaming support');

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// Test comment - watch mode demo
function mergeCookies(primary, extra, options = {}) {
  const map = new Map();
  const skipNames = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'httponly', 'secure', 'priority']);
  const essentials = ['cf_clearance', '__cf_bm', 'arena-auth', 'arena-auth-prod-v1'];
  const preferExtraEssentials = !!options.preferExtraEssentials;

  const primMap = new Map();
  const extraMap = new Map();

  const addTo = (str, target) => {
    String(str)
      .split(';')
      .forEach((raw) => {
        const part = raw.trim();
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) return;
        const name = part.slice(0, eqIdx).trim();
        const val = part.slice(eqIdx + 1).trim();
        if (!name || !val) return;
        const lower = name.toLowerCase();
        if (skipNames.has(lower)) return;
        target.set(name, val);
      });
  };

  addTo(primary, primMap);
  addTo(extra, extraMap);

  // Base: start with extras, then overlay primary (primary wins by default)
  for (const [k, v] of extraMap.entries()) map.set(k, v);
  for (const [k, v] of primMap.entries()) map.set(k, v);

  // Adjust essentials preference
  for (const key of essentials) {
    if (preferExtraEssentials) {
      if (extraMap.has(key)) map.set(key, extraMap.get(key));
    } else {
      if (primMap.has(key)) map.set(key, primMap.get(key));
    }
  }

  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}
// Preflight: verify cookie avoids Cloudflare challenge before streaming
try {
  const preHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://lmarena.ai/?mode=direct',
    Origin: 'https://lmarena.ai',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Upgrade-Insecure-Requests': '1',
    'Accept-Encoding': 'gzip, deflate, br',
    Cookie: selectedCookie.cookie,
    Connection: 'keep-alive',
  };
  const pre = await axios.get('https://lmarena.ai/', {
    headers: preHeaders,
    maxRedirects: 0,
    validateStatus: (s) => s < 500,
    responseType: 'text',
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true }),
  });
  // Cloudflare bypass removed - manage cookies manually
} catch {}
