/**
 * The shared session guard (ADR-0007). Domain modules protect routes with this
 * instead of re-implementing auth or reaching into the auth module: it resolves
 * the **Better Auth** session (httpOnly cookie or bearer) and populates
 * `req.user: SessionUser`, or responds 401.
 *
 * The Better Auth instance + repo are created once (in `server.ts`) and injected,
 * so a domain router simply does `router.use(requireSession(auth, repo))` and then
 * reads `req.user`. `resolveSessionUser` is re-exported for handlers that need the
 * session without failing closed.
 */
export {
  requireBetterAuth as requireSession,
  resolveSessionUser,
} from "../modules/auth/better-session.js";
