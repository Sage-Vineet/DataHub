// Balance Sheet Normalization Engine — public entry point.
//
// A multi-layer, ERP-agnostic classifier that reorganizes a Balance Sheet
// row tree into the mandated GAAP hierarchy (Assets > Current/Non-Current,
// Liabilities > Current/Long-Term, Equity) without ever changing an account
// name or dollar amount.
//
// See engine.js for the phase orchestration and the priority order:
//   1  Existing hierarchy       (treeWalk.js)
//   2  Chart of Accounts metadata
//   3  Account Type
//   4  Account Subtype
//   5  Parent Account
//   6  Account Number
//   7  Normal Balance (contra detection)
//   8  Section totals as boundaries   (treeWalk.js)
//   9  Neighboring accounts
//   10 Historical classification      (historyCache.js)
//   11 Lexicon (regex) — last deterministic resort
//   12 AI classification — async-only, opt-in, cached forever

export { restructureBalanceSheetTree, restructureBalanceSheetTreeAsync, classifyForInspection } from "./engine.js";
export { createHistoryCache, historyCacheKey } from "./historyCache.js";
export { noopAIClassifier } from "./aiClassifier.js";
export { collectItems, detectRootSection, detectSubsectionWrapper, detectSelfCategoryLabel } from "./treeWalk.js";
export {
  classifyByCoaMetadata,
  classifyByAccountType,
  classifyByAccountSubType,
  classifyByParentAccount,
  classifyByAccountNumber,
  extractAccountNumber,
  classifyByNeighbors,
  classifyByLexicon,
  detectContra,
} from "./classifiers.js";
export { SECTION, SUBSECTION, ASSET_CATEGORIES, LIABILITY_CATEGORIES, EQUITY_CATEGORIES, DEFAULT_ACCOUNT_NUMBER_RANGES } from "./canonical.js";
