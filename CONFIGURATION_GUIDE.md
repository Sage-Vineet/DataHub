# Optional Configuration & Enhancement Guide

## Environment Variables (Optional)
Add these to your `.env` file for fine-tuning:

```env
# Database connection timeout (milliseconds, default: 8000)
DB_TIMEOUT_MS=8000

# Circuit breaker threshold (consecutive errors, default: 3)
CIRCUIT_BREAKER_THRESHOLD=3

# Circuit breaker duration (milliseconds, default: 30000)
CIRCUIT_BREAKER_DURATION_MS=30000

# Max retry attempts for transient failures (default: 3)
DB_MAX_RETRIES=3

# Initial retry delay (milliseconds, default: 500)
DB_RETRY_DELAY_MS=500
```

## Code Integration for Configuration
To use environment variables, update `supabaseClient.js`:

```javascript
const CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '3');
const CIRCUIT_BREAKER_DURATION_MS = parseInt(process.env.CIRCUIT_BREAKER_DURATION_MS || '30000');
const DB_TIMEOUT_MS = parseInt(process.env.DB_TIMEOUT_MS || '8000');
```

And `dbErrorHandler.js`:

```javascript
const MAX_RETRY_ATTEMPTS = parseInt(process.env.DB_MAX_RETRIES || '3');
const INITIAL_RETRY_DELAY = parseInt(process.env.DB_RETRY_DELAY_MS || '500');
```

## Monitoring & Observability

### Add Metrics Tracking
Create `backend/src/utils/metrics.js`:

```javascript
const metrics = {
  connectionErrors: 0,
  retriesSucceeded: 0,
  retriesFailed: 0,
  circuitBreakerOpened: 0,
  
  recordError() { this.connectionErrors++; },
  recordRetrySuccess() { this.retriesSucceeded++; },
  recordRetryFailure() { this.retriesFailed++; },
  recordCircuitOpen() { this.circuitBreakerOpened++; },
  
  getStats() {
    return {
      connectionErrors: this.connectionErrors,
      retriesSucceeded: this.retriesSucceeded,
      retriesFailed: this.retriesFailed,
      circuitBreakerOpened: this.circuitBreakerOpened,
      successRate: this.retriesSucceeded / (this.retriesSucceeded + this.retriesFailed) * 100,
    };
  }
};

module.exports = metrics;
```

### Create Health Check Endpoint
Add to your routes:

```javascript
router.get("/health/db", async (req, res) => {
  const { isCircuitBreakerOpen } = require("../db");
  const { supabase } = require("../lib/supabaseClient");
  
  try {
    // Quick health check
    const result = await supabase
      .from("companies")
      .select("id")
      .limit(1)
      .timeout(2000);
    
    return res.json({
      status: isCircuitBreakerOpen() ? 'degraded' : 'healthy',
      database: 'connected',
      circuitBreaker: isCircuitBreakerOpen() ? 'open' : 'closed',
    });
  } catch (error) {
    return res.status(503).json({
      status: 'unhealthy',
      database: 'disconnected',
      circuitBreaker: isCircuitBreakerOpen() ? 'open' : 'closed',
      error: error.message,
    });
  }
});
```

## Advanced Improvements

### 1. Request Deduplication
Prevent duplicate requests during transient failures:

```javascript
const pendingRequests = new Map();

async function withDedup(key, operation) {
  if (pendingRequests.has(key)) {
    return pendingRequests.get(key);
  }
  
  const promise = operation()
    .finally(() => pendingRequests.delete(key));
  
  pendingRequests.set(key, promise);
  return promise;
}

// Usage:
const state = await withDedup(`dataSourceState-${companyId}`, 
  () => dataSourceService.getDataSourceState(companyId)
);
```

### 2. Fallback Cache
Cache last successful responses for fallback use:

```javascript
const cache = new Map();

function getCachedState(companyId) {
  return cache.get(`dataSource-${companyId}`);
}

function cacheState(companyId, state) {
  cache.set(`dataSource-${companyId}`, {
    data: state,
    timestamp: Date.now(),
    ttl: 300000, // 5 minutes
  });
}

// Use when circuit breaker is open
if (isCircuitBreakerOpen()) {
  const cached = getCachedState(companyId);
  if (cached && Date.now() - cached.timestamp < cached.ttl) {
    return cached.data;
  }
}
```

### 3. Graceful Degradation for Reports
When database is unavailable, serve cached/reduced data:

```javascript
router.get("/reports/balance-sheet", async (req, res) => {
  try {
    return res.json(await getFullReport(clientId));
  } catch (error) {
    if (isConnectionError(error)) {
      // Return last cached or empty report
      return res.status(200).json(getCachedReport(clientId) || {
        data: [],
        source: 'offline',
        warning: 'Data may be stale'
      });
    }
    throw error;
  }
});
```

### 4. Connection Pool Optimization
Adjust Postgres pool settings in services:

```javascript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,                    // Increase if many concurrent connections
  min: 2,                     // Keep minimum connections open
  idleTimeoutMillis: 30000,   // Close idle after 30s
  connectionTimeoutMillis: 3000, // Timeout on new connection
});
```

### 5. Distributed Tracing
Add request tracing for debugging:

```javascript
const crypto = require('crypto');

function generateRequestId() {
  return crypto.randomUUID();
}

// Middleware
app.use((req, res, next) => {
  req.id = generateRequestId();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// In error logging:
console.error(`[${req.id}] Connection error:`, error.message);
```

## Testing the Fixes

### Unit Test Example
```javascript
describe('dbErrorHandler', () => {
  it('should detect HTML error responses', () => {
    const htmlError = '<!DOCTYPE html><title>Error 522</title>';
    expect(isHtmlErrorResponse(htmlError)).toBe(true);
  });
  
  it('should retry on connection timeout', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 2) throw new Error('ETIMEDOUT');
      return 'success';
    });
    expect(attempts).toBe(2);
    expect(result).toBe('success');
  });
});
```

### Integration Test
```javascript
describe('DataSource API', () => {
  it('should return 503 when database unavailable', async () => {
    // Mock Supabase timeout
    jest.spyOn(supabase, 'from').mockRejectedValue(
      new Error('Connection timeout')
    );
    
    const res = await request(app).get('/report-sources');
    expect(res.status).toBe(503);
    expect(res.body.error).not.toContain('<!DOCTYPE');
  });
});
```

## Monitoring Checklist
- [ ] Enable request logging with request IDs
- [ ] Monitor 503 response rate (should be low)
- [ ] Alert on circuit breaker opening (indicates DB issues)
- [ ] Track retry success rates
- [ ] Monitor API response times
- [ ] Set up database connection health checks
- [ ] Create dashboard for error patterns
- [ ] Log slowest endpoints for optimization
