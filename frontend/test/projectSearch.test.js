import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canUseLocalSearchSnapshot,
  getProjectNavigationStatus,
  mergeProjectSearchResults,
  resolveProjectSearchMatch,
} from '../src/projectSearch.js';

test('active Monaco text is a safe search snapshot only after that room has synchronized', () => {
  const base = { activeFile: 'main.js', hasEditorModel: true };
  assert.equal(canUseLocalSearchSnapshot({
    ...base, roomState: { file: 'main.js', connection: 'connecting', synced: false, initialSyncComplete: false },
  }), false);
  assert.equal(canUseLocalSearchSnapshot({
    ...base, roomState: { file: 'main.js', connection: 'disconnected', synced: false, initialSyncComplete: true },
  }), true);
  assert.equal(canUseLocalSearchSnapshot({
    ...base, roomState: { file: 'main.js', connection: 'unavailable', initialSyncComplete: true, unavailable: true },
  }), false);
  assert.equal(canUseLocalSearchSnapshot({
    ...base, hasEditorModel: false, roomState: { file: 'main.js', initialSyncComplete: true },
  }), false);
});

test('project results merge live Monaco text without mutating it or returning stale active-file matches', () => {
  const activeText = 'unpersisted match();';
  const remote = {
    results: [{ fileName: 'main.js', lineNumber: 1, column: 1, snippet: 'older persisted value' }],
    unavailableFiles: ['broken.js'],
    truncated: false,
  };
  const merged = mergeProjectSearchResults(remote, {
    activeFile: 'main.js', activeText, query: 'match', caseSensitive: false, wholeWord: true,
    files: ['main.js', 'broken.js'],
  });

  assert.deepEqual(merged.results, [
    { fileName: 'main.js', lineNumber: 1, column: 13, snippet: 'unpersisted match();' },
  ]);
  assert.deepEqual(merged.unavailableFiles, ['broken.js']);
  assert.equal(activeText, 'unpersisted match();');
  assert.deepEqual(remote.results, [{ fileName: 'main.js', lineNumber: 1, column: 1, snippet: 'older persisted value' }]);
});

test('project result navigation waits for the selected room to sync and rechecks a stale location', () => {
  const match = {
    fileName: 'other.js', lineNumber: 4, column: 3, snippet: 'needle',
    searchQuery: 'needle', searchOptions: { caseSensitive: false, wholeWord: true },
  };
  assert.equal(getProjectNavigationStatus(match, 'main.js', { file: 'main.js', synced: true, connection: 'connected' }), 'waiting');
  assert.equal(getProjectNavigationStatus(match, 'other.js', { file: 'other.js', synced: false, connection: 'connecting' }), 'waiting');
  assert.equal(getProjectNavigationStatus(match, 'other.js', { file: 'other.js', synced: true, connection: 'connected' }), 'ready');
  assert.equal(getProjectNavigationStatus(match, 'other.js', { file: 'other.js', unavailable: true }), 'unavailable');

  assert.deepEqual(resolveProjectSearchMatch('header\nneedle();', match), {
    fileName: 'other.js', lineNumber: 2, column: 1, snippet: 'needle();',
  });
  assert.equal(resolveProjectSearchMatch('header\nno result', match), null);
});
