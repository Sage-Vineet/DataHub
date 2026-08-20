import { createContext } from 'react';

/**
 * Which server capabilities are live.
 *
 * The context object lives apart from its provider so the `useFeature` hook can
 * import it without either file exporting a mix of components and functions —
 * which is what keeps fast refresh working across both.
 *
 * The default is the safe one: nothing is available until the server says so.
 */
const FeatureContext = createContext({ features: {}, ready: false });

export default FeatureContext;
