export function buildFolderOptionsFromTree(tree = []) {
  return (tree || [])
    .filter((folder) => folder?.name)
    .map((folder) => ({ id: folder.id, name: folder.name }));
}

export function buildFolderMapFromTree(tree = []) {
  const map = {};

  const walk = (nodes) => {
    (nodes || []).forEach((node) => {
      if (node?.name) {
        map[node.name.toLowerCase()] = node.id;
      }
      if (node?.children?.length) {
        walk(node.children);
      }
    });
  };

  walk(tree);
  return map;
}
