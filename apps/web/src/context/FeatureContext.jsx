import { useEffect, useMemo, useState } from 'react';
import FeatureContext from './featureContextObject';
import { fetchFeatures } from '../lib/api';

/**
 * Which server capabilities are live.
 *
 * This exists because a backend kill switch, on its own, produces a *broken*
 * interface rather than a smaller one. An unmatched path does not 404 at the
 * gateway — it falls through to the catch-all proxy and reaches the legacy
 * backend, which answers with something the SPA cannot interpret. So a module
 * switched off without the client knowing leaves the nav entry in place, the
 * fetch resolving to nonsense, and a spinner that never settles.
 *
 * The rule that makes this safe is the default: **every feature is unavailable
 * until the server says otherwise, and unavailable if the answer never arrives.**
 * Optimism here would reintroduce exactly the failure the switch exists to
 * prevent.
 */
export function FeatureProvider({ children }) {
  const [features, setFeatures] = useState({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchFeatures()
      .then((payload) => {
        if (!cancelled) setFeatures(payload || {});
      })
      .catch(() => {
        // Deliberately silent, and deliberately empty: an unreachable gateway
        // means we do not know what is on, and "we do not know" resolves to off.
        if (!cancelled) setFeatures({});
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(() => ({ features, ready }), [features, ready]);
  return <FeatureContext.Provider value={value}>{children}</FeatureContext.Provider>;
}
