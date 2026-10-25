const { isValidProjectPath, parentProjectPath, projectPathAncestors } = require('./projectPaths');

function pathOverlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function conflict(message, code = 'path_conflict') {
  return { ok: false, status: 409, error: message, code };
}

function invalid(message) {
  return { ok: false, status: 400, error: message, code: 'invalid_project_path' };
}

function deleteEmptyFolderMetadata(db, folderPath) {
  if (!isValidProjectPath(folderPath)) {
    return invalid('Invalid project-relative folder path');
  }

  const folderIndex = db.folders.findIndex(record => record.path === folderPath);
  if (folderIndex === -1) {
    return { ok: false, status: 404, error: 'Folder not found', code: 'folder_not_found' };
  }

  const hasChildFolder = db.folders.some(record => record.path.startsWith(`${folderPath}/`));
  const tombstonePaths = new Set(db.filetombstones.map(record => record.path));
  const tombstoneDocumentIds = new Set(db.filetombstones.map(record => record.documentId).filter(Boolean));
  const hasLiveFile = db.files.some(record => record.name.startsWith(`${folderPath}/`)
    && !tombstonePaths.has(record.name)
    && !tombstoneDocumentIds.has(record.documentId));
  if (hasChildFolder || hasLiveFile) {
    return conflict('Folder is not empty; delete or move its live files and child folders first', 'folder_not_empty');
  }

  const [folder] = db.folders.splice(folderIndex, 1);
  return { ok: true, path: folder.path };
}

function renameFileMetadata(db, oldPath, newPath) {
  if (!isValidProjectPath(oldPath) || !isValidProjectPath(newPath)) {
    return invalid('Invalid project-relative file path');
  }
  if (oldPath === newPath) return invalid('The source and destination paths are the same');

  const file = db.files.find(record => record.name === oldPath);
  if (!file) return { ok: false, status: 404, error: 'File not found', code: 'file_not_found' };
  const tombstone = db.filetombstones.find(record => record.path === oldPath
    || record.documentId === file.documentId);
  if (tombstone) return conflict('A deleted document path cannot be renamed', 'file_deleted');

  const parent = parentProjectPath(newPath);
  if (parent && !db.folders.some(folder => folder.path === parent)) {
    return invalid('Parent folder does not exist');
  }
  if (db.files.some(other => other !== file && pathOverlaps(other.name, newPath))) {
    return conflict('The destination conflicts with an existing file');
  }
  if (db.folders.some(folder => folder.path === newPath || folder.path.startsWith(`${newPath}/`))) {
    return conflict('A folder exists at or below the destination path');
  }
  if (projectPathAncestors(newPath).some(ancestor => db.files.some(other => other !== file && other.name === ancestor))) {
    return conflict('A file blocks the destination path');
  }
  if (db.filetombstones.some(record => pathOverlaps(record.path, newPath))) {
    return conflict('The destination conflicts with a deleted document reservation', 'file_deleted');
  }

  file.name = newPath;
  return {
    ok: true,
    file,
    renamedFiles: [{ documentId: file.documentId, oldPath, newPath, language: file.language }],
    renamedFolders: [],
  };
}

function renameFolderMetadata(db, oldPath, newPath) {
  if (!isValidProjectPath(oldPath) || !isValidProjectPath(newPath)) {
    return invalid('Invalid project-relative folder path');
  }
  if (oldPath === newPath) return invalid('The source and destination paths are the same');
  if (newPath.startsWith(`${oldPath}/`)) return invalid('A folder cannot be moved into its own descendant');

  const rootFolder = db.folders.find(record => record.path === oldPath);
  if (!rootFolder) return { ok: false, status: 404, error: 'Folder not found', code: 'folder_not_found' };

  const affectedFolders = db.folders.filter(record => record.path === oldPath || record.path.startsWith(`${oldPath}/`));
  const affectedFiles = db.files.filter(record => record.name.startsWith(`${oldPath}/`));
  const affectedTombstones = db.filetombstones.filter(record => record.path.startsWith(`${oldPath}/`));
  const folderSet = new Set(affectedFolders);
  const fileSet = new Set(affectedFiles);
  const tombstoneSet = new Set(affectedTombstones);
  const remap = value => `${newPath}${value.slice(oldPath.length)}`;
  const mappedFolders = affectedFolders.map(record => [record, remap(record.path)]);
  const mappedFiles = affectedFiles.map(record => [record, remap(record.name)]);
  const mappedTombstones = affectedTombstones.map(record => [record, remap(record.path)]);

  if ([...mappedFolders, ...mappedFiles, ...mappedTombstones].some(([, target]) => !isValidProjectPath(target))) {
    return invalid('A destination path in the folder subtree is invalid or too long');
  }
  if (new Set(mappedFolders.map(([, target]) => target)).size !== mappedFolders.length
    || new Set(mappedFiles.map(([, target]) => target)).size !== mappedFiles.length
    || new Set(mappedTombstones.map(([, target]) => target)).size !== mappedTombstones.length) {
    return conflict('The folder subtree contains duplicate paths');
  }

  const outsideFolders = db.folders.filter(record => !folderSet.has(record));
  const outsideFiles = db.files.filter(record => !fileSet.has(record));
  const outsideTombstones = db.filetombstones.filter(record => !tombstoneSet.has(record));

  const mappedFolderPaths = new Set(mappedFolders.map(([, target]) => target));
  const mappedFilePaths = new Set(mappedFiles.map(([, target]) => target));
  for (const filePath of mappedFilePaths) {
    if (projectPathAncestors(filePath).some(ancestor => mappedFilePaths.has(ancestor))) {
      return conflict('A file blocks another path in the folder subtree');
    }
  }
  for (const folderPath of mappedFolderPaths) {
    if (mappedFilePaths.has(folderPath)
      || projectPathAncestors(folderPath).some(ancestor => mappedFilePaths.has(ancestor))) {
      return conflict('A file blocks a folder path in the subtree');
    }
  }
  for (const [tombstone, target] of mappedTombstones) {
    if (!mappedFiles.some(([file]) => file.name === tombstone.path
      || file.documentId === tombstone.documentId)) {
      return conflict('A deleted document reservation has no matching file record', 'file_deleted');
    }
    if (outsideFiles.some(file => pathOverlaps(file.name, target))) {
      return conflict('A file blocks a deleted document reservation', 'file_deleted');
    }
  }

  const destinationParent = parentProjectPath(newPath);
  if (destinationParent && !db.folders.some(folder => !folderSet.has(folder) && folder.path === destinationParent)) {
    return invalid('Parent folder does not exist');
  }

  for (const [, target] of mappedFolders) {
    if (outsideFiles.some(record => pathOverlaps(record.name, target))) {
      return conflict('The destination subtree conflicts with an existing file');
    }
    if (outsideFolders.some(record => record.path === target || record.path.startsWith(`${target}/`))) {
      return conflict('A folder exists at or below a destination path');
    }
    if (outsideTombstones.some(record => pathOverlaps(record.path, target))) {
      return conflict('The destination subtree conflicts with a deleted document reservation', 'file_deleted');
    }
  }
  for (const [, target] of mappedFiles) {
    if (outsideFiles.some(record => pathOverlaps(record.name, target))) {
      return conflict('The destination subtree conflicts with an existing file');
    }
    if (outsideFolders.some(record => record.path === target || record.path.startsWith(`${target}/`))) {
      return conflict('A folder exists at or below a destination file path');
    }
    if (projectPathAncestors(target).some(ancestor => outsideFiles.some(record => record.name === ancestor))) {
      return conflict('A file blocks a destination path');
    }
    if (outsideTombstones.some(record => pathOverlaps(record.path, target))) {
      return conflict('The destination subtree conflicts with a deleted document reservation', 'file_deleted');
    }
  }
  for (const [, target] of mappedTombstones) {
    if (outsideTombstones.some(record => pathOverlaps(record.path, target))) {
      return conflict('A deleted document reservation blocks the destination subtree', 'file_deleted');
    }
  }

  const renamedFiles = mappedFiles.map(([record, target]) => ({
    documentId: record.documentId,
    oldPath: record.name,
    newPath: target,
    language: record.language,
  }));
  const renamedFolders = mappedFolders.map(([record, target]) => ({
    oldPath: record.path,
    newPath: target,
  }));

  for (const [record, target] of mappedFolders) record.path = target;
  for (const [record, target] of mappedFiles) record.name = target;
  for (const [record, target] of mappedTombstones) record.path = target;
  return {
    ok: true,
    folder: rootFolder,
    updatedFiles: mappedFiles.length,
    updatedFolders: mappedFolders.length,
    updatedTombstones: mappedTombstones.length,
    renamedFiles,
    renamedFolders,
  };
}

module.exports = { renameFileMetadata, renameFolderMetadata, deleteEmptyFolderMetadata };
