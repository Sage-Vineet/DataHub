# Postgres with SSL enabled, for the demo stack.
#
# The legacy backend's direct-Postgres fallback pool hardcodes
# `ssl: { rejectUnauthorized: false }` (backend/src/services/userService.js:37).
# A stock postgres image has SSL off, so that pool fails with "The server does not
# support SSL connections" and legacy cannot read a user at all.
#
# Turning SSL on here fixes it without editing frozen legacy code — and
# `rejectUnauthorized: false` means a self-signed certificate is accepted, which
# is precisely what this generates. Demo only: a real environment gets a real
# certificate.

FROM postgres:16-alpine

RUN apk add --no-cache openssl \
 && mkdir -p /var/lib/postgresql/ssl \
 && openssl req -new -x509 -days 3650 -nodes -text \
      -out /var/lib/postgresql/ssl/server.crt \
      -keyout /var/lib/postgresql/ssl/server.key \
      -subj "/CN=localhost" \
 && chmod 600 /var/lib/postgresql/ssl/server.key \
 && chown -R postgres:postgres /var/lib/postgresql/ssl

CMD ["postgres", \
     "-c", "ssl=on", \
     "-c", "ssl_cert_file=/var/lib/postgresql/ssl/server.crt", \
     "-c", "ssl_key_file=/var/lib/postgresql/ssl/server.key"]
