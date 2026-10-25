const INVALID_SEGMENT = /[<>:"|?*\\/]/;

export function buildRenamePath(oldPath, input, kind) {
  const segment = typeof input === 'string' ? input.trim() : '';
  const hasControlCharacter = [...segment].some(character => character.charCodeAt(0) < 32);
  if (!segment || segment === '.' || segment === '..' || hasControlCharacter || INVALID_SEGMENT.test(segment)
    || segment.length > 120 || /[. ]$/.test(segment)) {
    throw new Error('Enter a valid name without path separators or reserved characters.');
  }
  const parent = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
  const path = [parent, segment].filter(Boolean).join('/');
  if (path.length > 255) throw new Error('The resulting project path is too long.');
  if (path === oldPath) throw new Error(`Enter a different ${kind} name.`);
  return path;
}

export function remapProjectPath(path, mappings = []) {
  if (typeof path !== 'string') return path;
  const mapping = [...mappings]
    .filter(item => item && typeof item.oldPath === 'string' && typeof item.newPath === 'string')
    .sort((a, b) => b.oldPath.length - a.oldPath.length)
    .find(item => path === item.oldPath || path.startsWith(`${item.oldPath}/`));
  return mapping ? `${mapping.newPath}${path.slice(mapping.oldPath.length)}` : path;
}

export function getDocumentRename(event, documentId) {
  if (!event || event.type !== 'rename' || !Array.isArray(event.files)) return null;
  return event.files.find(file => file.documentId === documentId) || null;
}

export function remapExpandedFolders(expandedFolders, mappings) {
  return new Set([...expandedFolders].map(path => remapProjectPath(path, mappings)));
}

export function getFolderDeletionTransition(event, { selectedFolder, expandedFolders }) {
  const folderPath = event?.type === 'folder-deleted' ? event.folder?.path : null;
  if (typeof folderPath !== 'string' || !folderPath) return null;
  return {
    folderPath,
    selectedFolder: selectedFolder === folderPath ? '' : selectedFolder,
    expandedFolders: new Set([...expandedFolders].filter(path => path !== folderPath)),
  };
}

export async function requestProjectRename({ backendHttpUrl, kind, oldPath, newPath, fetchImpl = fetch }) {
  const isFolder = kind === 'folder';
  const response = await fetchImpl(`${backendHttpUrl}/api/${isFolder ? 'folders' : 'files'}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPath, newPath }),
  });
  if (!response.ok) {
    let message = `Could not rename the ${kind}.`;
    if (response.status < 500) {
      try {
        const body = await response.json();
        if (typeof body.error === 'string') message = body.error;
      } catch {
        // Non-JSON errors use the safe local message.
      }
    }
    const error = new Error(message);
    error.isServerResponse = true;
    throw error;
  }
  return response.json();
}
