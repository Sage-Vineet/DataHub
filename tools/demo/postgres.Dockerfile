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
 # root:postgres at 0640, not postgres:postgres at 0600. PostgreSQL accepts a
 # key owned by root when the group can read it, and that survives an image
 # built through `docker buildx --load`, which does not preserve the postgres
 # uid on every rootless host — the demo stack stopped starting with
 # "could not load private key file: Permission denied" on exactly that path.
 && chown -R root:postgres /var/lib/postgresql/ssl \
 && chmod 640 /var/lib/postgresql/ssl/server.key \
 && chmod 644 /var/lib/postgresql/ssl/server.crt

CMD ["postgres", \
     "-c", "ssl=on", \
     "-c", "ssl_cert_file=/var/lib/postgresql/ssl/server.crt", \
     "-c", "ssl_key_file=/var/lib/postgresql/ssl/server.key"]
