import { useContext } from 'react';
import FeatureContext from './featureContextObject';

/**
 * Is one capability live?
 *
 * False while the answer is still in flight and false if it never arrives, so a
 * caller can render nothing without first checking readiness — which is what
 * keeps a disabled feature from flickering into view on a slow connection, and
 * what makes "off" the only thing an unreachable gateway can mean.
 */
export function useFeature(name) {
  return useContext(FeatureContext).features[name] === true;
}

/** The whole set, plus whether the answer has arrived. */
export function useFeatures() {
  return useContext(FeatureContext);
}
