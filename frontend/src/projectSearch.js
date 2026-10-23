import { searchText } from './workspaceSearch.js';

export function canUseLocalSearchSnapshot({ activeFile, roomState, hasEditorModel }) {
  return Boolean(activeFile
    && hasEditorModel
    && roomState?.file === activeFile
    && roomState.initialSyncComplete
    && !roomState.unavailable);
}

export function mergeProjectSearchResults(remoteResponse, {
  activeFile,
  activeText,
  query,
  caseSensitive,
  wholeWord,
  files,
}) {
  const hasLiveActiveSnapshot = activeFile && typeof activeText === 'string' && files.includes(activeFile);
  const results = remoteResponse.results.filter(result => !hasLiveActiveSnapshot || result.fileName !== activeFile);
  if (hasLiveActiveSnapshot) {
    results.push(...searchText(activeText, query, activeFile, 300, { caseSensitive, wholeWord }));
  }

  const fileOrder = new Map(files.map((name, index) => [name, index]));
  results.sort((left, right) => (fileOrder.get(left.fileName) ?? Number.MAX_SAFE_INTEGER)
    - (fileOrder.get(right.fileName) ?? Number.MAX_SAFE_INTEGER)
    || left.lineNumber - right.lineNumber
    || left.column - right.column);
  return {
    results: results.slice(0, 300),
    unavailableFiles: remoteResponse.unavailableFiles,
    truncated: Boolean(remoteResponse.truncated) || results.length > 300,
  };
}

export function getProjectNavigationStatus(match, activeFile, roomState) {
  if (!match || match.fileName !== activeFile || roomState?.file !== activeFile) return 'waiting';
  if (roomState.unavailable) return 'unavailable';
  return roomState.synced && roomState.connection === 'connected' ? 'ready' : 'waiting';
}

export function resolveProjectSearchMatch(source, match) {
  const currentMatches = searchText(
    source,
    match.searchQuery,
    match.fileName,
    300,
    match.searchOptions,
  );
  return currentMatches.find(result => result.lineNumber === match.lineNumber && result.column === match.column)
    || currentMatches[0]
    || null;
}
