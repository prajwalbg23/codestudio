function createDirectory(name, path) {
  return { name, path, folders: [], files: [] };
}

export function buildProjectTree(fileNames, folderPaths) {
  const root = createDirectory('', '');

  const ensureFolder = folderPath => {
    let parent = root;
    let path = '';
    for (const name of folderPath.split('/')) {
      path = path ? `${path}/${name}` : name;
      let folder = parent.folders.find(child => child.name === name);
      if (!folder) {
        folder = createDirectory(name, path);
        parent.folders.push(folder);
      }
      parent = folder;
    }
    return parent;
  };

  for (const folderPath of folderPaths) {
    if (typeof folderPath === 'string' && folderPath.length > 0) ensureFolder(folderPath);
  }

  for (const filePath of fileNames) {
    if (typeof filePath !== 'string' || filePath.length === 0) continue;
    const segments = filePath.split('/');
    const fileName = segments.pop();
    const parent = segments.length > 0 ? ensureFolder(segments.join('/')) : root;
    if (!parent.files.some(file => file.path === filePath)) {
      parent.files.push({ name: fileName, path: filePath });
    }
  }

  const sort = directory => {
    directory.folders.sort((a, b) => a.name.localeCompare(b.name));
    directory.files.sort((a, b) => a.name.localeCompare(b.name));
    directory.folders.forEach(sort);
  };
  sort(root);
  return root;
}

export function filterProjectTree(tree, query) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return tree;

  const filterDirectory = directory => {
    const folders = directory.folders
      .map(folder => {
        if (folder.path.toLocaleLowerCase().includes(needle)) return folder;
        const filtered = filterDirectory(folder);
        return filtered.folders.length || filtered.files.length ? filtered : null;
      })
      .filter(Boolean);
    const files = directory.files.filter(file => file.path.toLocaleLowerCase().includes(needle));
    return { ...directory, folders, files };
  };

  return filterDirectory(tree);
}
