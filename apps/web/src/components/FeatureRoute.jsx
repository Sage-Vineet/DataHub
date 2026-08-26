import { useFeatures } from '../context/useFeature';

/**
 * Render a route only where the server says the capability exists.
 *
 * The gate sits ABOVE any data fetch on purpose. An unmatched path does not 404
 * at the gateway — it falls through to the catch-all proxy and reaches the legacy
 * backend, which answers with something this app cannot interpret. Letting a
 * disabled feature's page mount and fetch is exactly how a switched-off module
 * turns into a spinner that never resolves.
 *
 * While the answer is still in flight nothing is rendered, so a disabled feature
 * never flickers into view on a slow connection.
 */
export default function FeatureRoute({ feature, children, fallback = null }) {
  const { features, ready } = useFeatures();
  if (!ready) return null;
  if (features[feature] !== true) return fallback;
  return children;
}
