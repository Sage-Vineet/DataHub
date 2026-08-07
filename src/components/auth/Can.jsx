/**
 * Declarative UI permission gating.
 *
 * READ THIS FIRST: nothing in this file is a security control. Hiding a button
 * stops an honest user from clicking something that would fail, and keeps the
 * interface uncluttered — that is all it does. Anyone can open devtools, delete
 * the guard from the DOM, or skip the UI entirely and call the API directly.
 *
 * Every capability referenced here is independently enforced on the server by
 * `requirePermission` / `requireCompanyAccess` in backend/src/middleware/rbac.js.
 * If you add a gate here, add the matching server-side check there. A gate with
 * no server counterpart is not access control; it is decoration.
 *
 * Capability names live in src/lib/permissions.js so this file exports only
 * components and Fast Refresh keeps working.
 */

import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

/**
 * Renders children only when the user holds the required capabilities.
 *
 * @param {object} props
 * @param {string|string[]} [props.permission]  required capability, or list
 * @param {boolean} [props.any=false]  with a list, require ANY rather than ALL
 * @param {React.ReactNode} [props.fallback=null]  rendered when denied
 */
export function Can({ permission, any = false, fallback = null, children }) {
  const { can } = useAuth();

  if (!permission) return children;

  const required = Array.isArray(permission) ? permission : [permission];
  const allowed = any
    ? required.some((entry) => can(entry))
    : required.every((entry) => can(entry));

  return allowed ? children : fallback;
}

/**
 * Route-level guard. Redirects rather than rendering a denial, so an
 * unauthorised deep link does not leave the user staring at an empty shell.
 *
 * Uses react-router's <Navigate> rather than assigning to window.location —
 * mutating browser state during render is a side effect React may run twice,
 * and it bypasses the router's own history handling.
 *
 * Usage:
 *   <RequirePermission permission={PERMISSION.REPORT_APPROVE}>
 *     <ApprovalsPage />
 *   </RequirePermission>
 */
export function RequirePermission({ permission, redirectTo = '/', children }) {
  const { can, user, loading } = useAuth();

  // Wait for the session check to finish, or an authorised user is bounced on
  // every hard refresh before /auth/me resolves.
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;

  const required = Array.isArray(permission) ? permission : [permission];
  if (!required.every((entry) => can(entry))) {
    return <Navigate to={redirectTo} replace />;
  }

  return children;
}

export default Can;
