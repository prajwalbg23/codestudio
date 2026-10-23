/** Return the workspace action for a keyboard event, respecting text-entry focus. */
export function getWorkspaceShortcutAction(event) {
  if (event.key === 'Escape') return 'escape';
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;

  const target = event.target;
  const isFormControl = Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'));
  const isPalette = Boolean(target?.closest?.('[data-command-palette]'));
  const isMonaco = Boolean(target?.closest?.('.monaco-editor'));
  if (isFormControl && !isPalette && !isMonaco) return null;

  const key = event.key.toLowerCase();
  if (key === 'p' && !event.shiftKey) return 'open-files';
  if (key === 'f' && event.shiftKey) return 'find-text';
  if (key === 'g' && event.shiftKey) return 'search-project';
  if (key === 'j' && !event.shiftKey) return 'toggle-output';
  return null;
}

/** Apply a keyboard action to the active workspace controls. */
export function handleWorkspaceShortcut(event, {
  paletteOpen,
  explorerOpen,
  closePalette,
  closeExplorer,
  openFiles,
  findText,
  searchProject,
  toggleOutput,
}) {
  const action = getWorkspaceShortcutAction(event);
  if (action === 'escape') {
    if (paletteOpen) {
      event.preventDefault();
      closePalette?.();
    } else if (explorerOpen) {
      closeExplorer?.();
    }
    return;
  }

  const handlers = {
    'open-files': openFiles,
    'find-text': findText,
    'search-project': searchProject,
    'toggle-output': toggleOutput,
  };
  if (action && handlers[action]) {
    event.preventDefault();
    handlers[action]();
  }
}

/** Filter command-palette file choices using its case-insensitive query rules. */
export function filterPaletteFiles(files, query) {
  const term = typeof query === 'string' ? query.trim().toLocaleLowerCase() : '';
  return files.filter(fileName => fileName.toLocaleLowerCase().includes(term));
}
