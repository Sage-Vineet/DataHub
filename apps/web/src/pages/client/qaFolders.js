/**
 * The pure half of the seller's attach sheet: which folders exist, and which one
 * a question's category points at.
 *
 * Split out of CompanyQA.jsx rather than exported from it, so the page stays a
 * component-only module (react-refresh) and so this logic is testable without a
 * DOM — which is how the folder-tree shape mismatch was caught.
 */

/**
 * Where a category's evidence naturally belongs.
 *
 * Only the cases where the category name and the folder name genuinely differ —
 * everything else matches on substring. The point is that the picker is never
 * blank, because `folder_id` is required and a blank default is an error state
 * waiting to happen in front of someone.
 */
const FOLDER_SYNONYMS = { finance: 'financial', tax: 'tax return', ma: 'legal' };

/**
 * Flatten the folder tree into indented options, as MoveFolderModal does.
 *
 * `listFolderTree` resolves to an ARRAY of roots, not a single root node, and its
 * nodes carry no `type` field — it is a folder tree, so everything in it is a
 * folder. Filtering on `type === 'folder'` here would silently empty the picker,
 * and an empty picker means no `folder_id`, which means the attach is skipped
 * without ever saying so.
 */
export function flattenFolders(nodes, depth = 0, out = []) {
  for (const child of Array.isArray(nodes) ? nodes : (nodes?.children ?? [])) {
    if (!child?.id) continue;
    out.push({ id: child.id, name: child.name, depth });
    flattenFolders(child.children ?? [], depth + 1, out);
  }
  return out;
}

/** The folder a question's category points at, or the first one. */
export function defaultFolderFor(categoryLabel, folders) {
  if (folders.length === 0) return '';
  const label = (categoryLabel ?? '').toLowerCase().trim();
  if (label) {
    const needle = FOLDER_SYNONYMS[label.replace(/[^a-z]/g, '')] ?? label;
    const match = folders.find((f) => f.name.toLowerCase().includes(needle));
    if (match) return match.id;
  }
  return folders[0].id;
}

export function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
