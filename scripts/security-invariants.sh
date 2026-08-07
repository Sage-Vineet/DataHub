#!/usr/bin/env bash
#
# Security invariants — patterns that must never reappear in this codebase.
#
# Each one corresponds to a real vulnerability that was found and fixed here.
# Regressions in these are cheap to introduce and expensive to notice, so they
# are asserted mechanically rather than left to code review.
#
# Run locally:  bash scripts/security-invariants.sh
# CI calls this same script, so a green local run means a green CI check.

set -uo pipefail

FAILED=0
SRC="backend/src"

# Comment lines legitimately quote the banned patterns — the modules that fixed
# each issue document what they replaced. Strip them before deciding.
strip_comments() {
  grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)'
}

report() {
  local name="$1" detail="$2" hits="$3"
  if [ -n "$hits" ]; then
    printf '\033[31mFAIL\033[0m  %s\n' "$name"
    printf '      %s\n' "$detail"
    printf '%s\n' "$hits" | sed 's/^/      /'
    FAILED=1
  else
    printf '\033[32mok\033[0m    %s\n' "$name"
  fi
}

# ── 1. Fallback signing secrets ─────────────────────────────────────────────
# `process.env.JWT_SECRET || "change_me"` is a complete authentication bypass on
# any deploy where the variable is unset: tokens verify against a known string.
hits=$(grep -rnE '(JWT_SECRET|JWT_REFRESH_SECRET|SECRET)[[:space:]]*\|\|[[:space:]]*["'"'"']' \
        "$SRC" --include='*.js' 2>/dev/null | grep -v 'config/env.js' | strip_comments)
report "no fallback signing secrets" \
       "Secrets must be required at startup by config/env.js." "$hits"

# ── 2. TLS certificate verification ─────────────────────────────────────────
# Accepting any certificate reduces TLS to obfuscation and leaves the database
# connection open to an active man-in-the-middle.
hits=$(grep -rn 'rejectUnauthorized: false' "$SRC" --include='*.js' 2>/dev/null \
        | grep -v 'db/pgPool.js' | strip_comments)
report "no TLS verification bypass" \
       "Use buildSslOptions() from db/pgPool.js; supply DATABASE_CA_CERT for a private CA." "$hits"

# ── 3. CORS ─────────────────────────────────────────────────────────────────
# A wildcard or unconditional origin with credentials:true lets any site make
# authenticated cross-origin requests on behalf of a logged-in victim.
hits=$(grep -rnE 'origin:[[:space:]]*(true|["'"'"']\*)' "$SRC" --include='*.js' 2>/dev/null | strip_comments)
report "no wildcard CORS origin" \
       "Origins must come from CORS_ALLOWED_ORIGINS." "$hits"

# ── 4. Proxy trust ──────────────────────────────────────────────────────────
# `trust proxy: true` believes a client-supplied X-Forwarded-For, so an attacker
# can spoof their IP past every per-IP rate limit and audit record.
hits=$(grep -rnE '["'"'"']trust proxy["'"'"'][[:space:]]*,[[:space:]]*true' "$SRC" --include='*.js' 2>/dev/null | strip_comments)
report "proxy trust is a fixed hop count" \
       "Use TRUST_PROXY_HOPS (an integer), never true." "$hits"

# ── 5. Plaintext password comparison ────────────────────────────────────────
# Comparing a submitted password to a stored value with === authenticates any
# row whose stored value is not a bcrypt hash.
hits=$(grep -rnE '(password|rawPassword|plaintext)[[:space:]]*===[[:space:]]*(storedPassword|storedHash|user\.password|user\.password_hash)' \
        "$SRC" --include='*.js' 2>/dev/null | strip_comments)
report "no plaintext password comparison" \
       "Use verifyPassword() from security/passwordPolicy.js — it fails closed on non-bcrypt values." "$hits"

# ── 6. Shared static passwords ──────────────────────────────────────────────
# One shared credential across every account in a tenant class means one guess
# compromises all of them.
hits=$(grep -rn 'CLIENT_STATIC_PASSWORD' "$SRC" --include='*.js' 2>/dev/null \
        | grep -v 'config/demoUsers.js' | strip_comments)
report "no shared static password" \
       "Provision with generateStrongPassword() and require a reset." "$hits"

# ── 7. Tokens outside the Authorization header ──────────────────────────────
# Query-string tokens leak into access logs, browser history and the Referer
# header sent to third-party origins.
hits=$(grep -rnE 'query(\?)?\.(token|access_token|accessToken)|headers\[["'"'"']x-(access|auth)-token' \
        "$SRC" --include='*.js' 2>/dev/null | strip_comments)
report "tokens read only from the Authorization header" \
       "Use extractBearerToken() from security/tokens.js." "$hits"

# ── 8. Weak bcrypt cost ─────────────────────────────────────────────────────
hits=$(grep -rnE 'bcrypt\.hash(Sync)?\([^,]+,[[:space:]]*(1[01]|[0-9])[[:space:]]*\)' \
        "$SRC" --include='*.js' 2>/dev/null | strip_comments)
report "bcrypt cost is at least 12" \
       "Use hashPassword() from security/passwordPolicy.js." "$hits"

# ── 9. Directory listing ────────────────────────────────────────────────────
# express.static without index:false can serve a directory index.
hits=$(grep -rn 'express.static' "$SRC" --include='*.js' 2>/dev/null | strip_comments)
report "no static file serving in the API" \
       "This service serves JSON only. If static files become necessary, set index:false and dotfiles:'deny'." "$hits"

# ── 10. Env template completeness ───────────────────────────────────────────
missing=""
for key in JWT_SECRET JWT_REFRESH_SECRET SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY \
           CORS_ALLOWED_ORIGINS DATABASE_SSL_REJECT_UNAUTHORIZED DATA_ENCRYPTION_KEY \
           SESSION_IDLE_TIMEOUT_SECONDS SINGLE_DEVICE_LOGIN BCRYPT_ROUNDS TRUST_PROXY_HOPS; do
  grep -q "^${key}=" backend/.env.example || missing="${missing}${key} "
done
report "env template documents every required variable" \
       "Add the missing keys to backend/.env.example." "$missing"

# ── 11. No real secrets in tracked templates ────────────────────────────────
secret_hits=""
for file in $(git ls-files '*.env.example' 2>/dev/null); do
  # Gmail app passwords: four groups of four lowercase letters.
  gmail=$(grep -nEi '^[a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}$' "$file" || true)
  # Any populated secret-shaped assignment.
  populated=$(grep -nE '^[A-Z_]*(SECRET|KEY|PASS|TOKEN)[A-Z_]*=[^[:space:]]{16,}$' "$file" \
              | grep -vE '=(your_|<|\$\{|CHANGE|REPLACE|example)' || true)
  [ -n "$gmail" ] && secret_hits="${secret_hits}${file}: ${gmail}"$'\n'
  [ -n "$populated" ] && secret_hits="${secret_hits}${file}: ${populated}"$'\n'
done
report "no real secrets in tracked .env templates" \
       "Remove the value AND rotate the credential — it is in git history." "$secret_hits"

# ── 12. No tracked .env ─────────────────────────────────────────────────────
hits=$(git ls-files 2>/dev/null | grep -E '(^|/)\.env($|\.[^e])' || true)
report "no .env file tracked by git" \
       "Remove it, rotate every credential it held, and purge it from history." "$hits"

# ── 13. Tax returns and bank statements are read by Gemini only ─────────────
# These two document types must be interpreted by the Gemini API. Routing them
# to a second model or to a rule-based extractor means the same document yields
# different structured output depending on which entry point received it.
hits=$(grep -rn "@anthropic-ai/sdk\|anthropic\.messages\|ANTHROPIC_MODEL" \
        "$SRC" --include='*.js' 2>/dev/null | strip_comments)
report "no Anthropic client in document extraction" \
       "Tax returns and bank statements are read by Gemini. Use the helpers in services/bankStatementExtractor.js or services/geminiFinancialParser.js." \
       "$hits"

hits=$(grep -n "extractWithPython" \
        "$SRC/services/keyReports/bankStatementExtractionService.js" \
        "$SRC/services/keyReports/taxReturnExtractionService.js" 2>/dev/null | strip_comments)
report "bank statement / tax return do not use the Python extractor" \
       "extract_excel.py is rule-based and mis-parses unanticipated layouts. Both types go through Gemini." \
       "$hits"

echo
if [ "$FAILED" -ne 0 ]; then
  echo "Security invariants FAILED. See SECURITY.md for the rationale behind each."
  exit 1
fi
echo "All security invariants hold."
