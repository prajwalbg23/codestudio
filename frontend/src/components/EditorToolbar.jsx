import { ChevronUp, Files, Play, Search, Square } from 'lucide-react';

export default function EditorToolbar({
  activeFile,
  languageLabel,
  openPalette,
  outputOpen,
  setOutputOpen,
  roomStatus,
  persistedRevision,
  executionUnavailableReason,
}) {
  const saveStatus = !activeFile
    ? 'No document selected'
    : roomStatus === 'unavailable'
      ? 'History unavailable · editing blocked'
      : persistedRevision
        ? `Saved · revision ${persistedRevision.revisionId.slice(0, 15)}…`
        : roomStatus === 'connected'
          ? 'Awaiting durable save confirmation'
          : 'Read-only until synchronized';

  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Editor actions">
      <span className="editor-toolbar-context">{activeFile ? `${languageLabel} · ${activeFile}` : 'No active document'}</span>
      <div className="editor-toolbar-actions">
        <button type="button" className="toolbar-action" onClick={() => openPalette('files')} aria-label="Open file" title="Open file (Ctrl/⌘ P)">
          <Search size={14} /><span>Open</span>
        </button>
        <button type="button" className="toolbar-action" onClick={() => openPalette('content')} disabled={!activeFile} aria-label="Find in active file" title="Find in active file (Ctrl/⌘ Shift F)">
          <Search size={14} /><span>Find</span>
        </button>
        <button type="button" className="toolbar-action" onClick={() => openPalette('project')} aria-label="Search project files" title="Search project (Ctrl/⌘ Shift G)">
          <Files size={14} /><span>Project</span>
        </button>
        <button
          type="button"
          className="toolbar-action execution-action"
          disabled
          aria-label="Run JavaScript (unavailable)"
          title={executionUnavailableReason}
          aria-describedby="execution-disabled-reason"
        >
          <Play size={14} /><span>Run</span>
        </button>
        <button type="button" className="toolbar-action execution-action" disabled aria-label="Stop program (not running)" title="No program is running.">
          <Square size={14} /><span>Stop</span>
        </button>
        <button
          type="button"
          className="toolbar-action editor-output-toggle"
          onClick={() => setOutputOpen(open => !open)}
          aria-pressed={outputOpen}
          aria-label={outputOpen ? 'Hide CodeStudio activity panel' : 'Show CodeStudio activity panel'}
          title="Toggle CodeStudio activity (Ctrl/⌘ J)"
        >
          <ChevronUp size={14} /><span>Output</span>
        </button>
      </div>
      <div className="execution-details">
        <span className={`revision-status ${persistedRevision ? 'confirmed' : ''}`} role="status">{saveStatus}</span>
        <span className="execution-status" title={executionUnavailableReason}>Execution disabled</span>
        <span id="execution-disabled-reason" className="visually-hidden">{executionUnavailableReason}</span>
      </div>
    </div>
  );
}
