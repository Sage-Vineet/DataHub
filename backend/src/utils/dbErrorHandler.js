/**
 * Database Error Handler Utility
 * Handles connection failures, HTML error responses, and provides retry logic
 */

const CLOUDFLARE_ERROR_PATTERN = /<!DOCTYPE html|<html|Cloudflare/i;
const SUPABASE_ERROR_PATTERN = /supabase|pgrst|postgrest/i;
const CONNECTION_ERROR_KEYWORDS = [
  'timeout',
  'terminated',
  'econn',
  'econnrefused',
  'econnreset',
  'ehostunreach',
  'enetunreach',
  'could not connect',
  'connection refused',
  'broken pipe',
];

/**
 * Checks if an error is a connection/timeout error
 */
function isConnectionError(error) {
  if (!error) return false;
  if (error.isConnectionError === true) return true;
  const message = String(error?.message || error || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  
  // Check for connection error codes
  if (/^E(TIMEOUT|CONNREFUSED|CONNRESET|HOSTUNREACH|NETUNREACH|TIMEDOUT)/.test(code)) {
    return true;
  }
  
  // Check for connection error keywords
  return CONNECTION_ERROR_KEYWORDS.some(keyword => message.includes(keyword));
}

/**
 * Detects if response is an HTML error page (from Cloudflare or other proxies)
 */
function isHtmlErrorResponse(data) {
  if (!data) return false;
  const str = String(data);
  return CLOUDFLARE_ERROR_PATTERN.test(str) && str.length < 50000; // Avoid false positives
}

/**
 * Extracts error code from HTML error response
 */
function extractErrorCodeFromHtml(html) {
  const match = String(html || '').match(/(\d{3})/);
  if (match) {
    const code = parseInt(match[1], 10);
    if (code >= 500) return `HTTP_${code}`;
  }
  return 'UNKNOWN_HTTP_ERROR';
}

/**
 * Normalizes Supabase errors and connection errors
 */
function normalizeError(error) {
  if (!error) return new Error('Unknown error');
  
  // If it's already an error with a normalized message, return it
  if (error.isNormalized) return error;
  
  // Check for HTML error responses
  if (isHtmlErrorResponse(error.message)) {
    const code = extractErrorCodeFromHtml(error.message);
    const err = new Error(`Database service unavailable (${code}). Please try again later.`);
    err.code = code;
    err.isConnectionError = true;
    err.isNormalized = true;
    return err;
  }
  
  // Check for connection errors
  if (isConnectionError(error)) {
    const err = new Error('Database connection timeout. Please try again later.');
    err.isConnectionError = true;
    err.isNormalized = true;
    err.originalError = error;
    return err;
  }
  
  // If it's a Supabase error with a message, clean it up
  if (error.message && error.message.length > 1000) {
    const err = new Error('Database operation failed. Please try again later.');
    err.code = error.code;
    err.isNormalized = true;
    err.originalError = error;
    return err;
  }
  
  // Mark as normalized and return
  error.isNormalized = true;
  return error;
}

/**
 * Retry configuration for different error types
 */
function getRetryConfig(error, attempt = 0) {
  const maxAttempts = 3;
  const isConnError = isConnectionError(error);
  
  return {
    shouldRetry: attempt < maxAttempts,
    delay: isConnError 
      ? Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 10000)
      : 0,
    attempt,
    maxAttempts,
  };
}

/**
 * Wraps a database operation with retry logic
 */
async function withRetry(operation, options = {}) {
  const {
    maxAttempts = 3,
    delayMs = 500,
    exponentialBackoff = true,
    onError = null,
    operationName = 'database operation',
  } = options;
  
  let lastError = null;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const isConnError = isConnectionError(error);
      const shouldRetry = attempt < maxAttempts - 1 && (isConnError || error.code === 'PGRST002');
      
      if (shouldRetry) {
        const delay = exponentialBackoff
          ? delayMs * Math.pow(2, attempt)
          : delayMs;
        
        if (onError) {
          onError(error, attempt, delay);
        } else {
          console.warn(
            `[dbErrorHandler] ${operationName} attempt ${attempt + 1}/${maxAttempts} failed; retrying in ${delay}ms`,
            error.message,
          );
        }
        
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      break;
    }
  }
  
  if (lastError) {
    console.warn(
      `[dbErrorHandler] ${operationName} failed after ${maxAttempts} attempt(s)`,
      lastError.message,
    );
  }
  throw normalizeError(lastError);
}

/**
 * Validates Supabase response for errors
 */
function validateSupabaseResponse(response) {
  if (!response) {
    throw new Error('No response from database');
  }
  
  const { data, error } = response;
  
  if (error) {
    const err = new Error(error.message || String(error));
    err.code = error.code;
    
    // Check if error message is HTML
    if (isHtmlErrorResponse(error.message)) {
      throw normalizeError(err);
    }
    
    throw err;
  }
  
  return data;
}

module.exports = {
  isConnectionError,
  isHtmlErrorResponse,
  extractErrorCodeFromHtml,
  normalizeError,
  getRetryConfig,
  withRetry,
  validateSupabaseResponse,
  CONNECTION_ERROR_KEYWORDS,
};
