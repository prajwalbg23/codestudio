import { ChevronDown, ChevronUp, Trash2, X } from 'lucide-react';

const formatTime = timestamp => new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
}).format(new Date(timestamp));

export default function OutputPanel({
  entries,
  activeTab,
  onSelectTab,
  onClear,
  onClose,
  collapsed,
  expanded,
  onToggleCollapse,
  onToggleExpand,
}) {
  return (
    <section
      className={`output-panel ${expanded ? 'expanded' : ''} ${collapsed ? 'collapsed' : ''}`}
      aria-label={activeTab === 'program' ? 'Program output panel' : activeTab === 'problems' ? 'Problems panel' : 'CodeStudio activity panel, not program output'}
    >
      <header className="output-panel-header">
        <div className="output-tabs" aria-label="Output views">
          <button type="button" aria-pressed={activeTab === 'output'} className={activeTab === 'output' ? 'active' : ''} onClick={() => onSelectTab('output')}>Output</button>
          <button type="button" aria-pressed={activeTab === 'program'} className={activeTab === 'program' ? 'active' : ''} onClick={() => onSelectTab('program')}>Program Output</button>
          <button type="button" aria-pressed={activeTab === 'problems'} className={activeTab === 'problems' ? 'active' : ''} onClick={() => onSelectTab('problems')}>Problems</button>
        </div>
        <div className="output-panel-actions">
          {activeTab === 'output' && (
            <button type="button" className="icon-button" onClick={onClear} aria-label="Clear output" title="Clear output"><Trash2 size={15} /></button>
          )}
          {!collapsed && (
            <button type="button" className="icon-button" onClick={onToggleExpand} aria-label={expanded ? 'Reduce output panel height' : 'Expand output panel height'} title={expanded ? 'Reduce panel' : 'Expand panel'}>
              {expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
          )}
          <button type="button" className="icon-button" onClick={onToggleCollapse} aria-label={collapsed ? 'Expand output panel' : 'Collapse output panel'} title={collapsed ? 'Expand panel' : 'Collapse panel'}>
            {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Hide output panel" title="Hide panel"><X size={16} /></button>
        </div>
      </header>

      {!collapsed && (
        activeTab === 'output' ? (
          <div className="output-panel-content">
            <p className="output-panel-note">CodeStudio activity only. This workspace does not execute code.</p>
            {entries.length === 0 ? (
              <p className="output-empty">No activity yet.</p>
            ) : (
              <ol className="output-entries" role="log" aria-live="polite" aria-relevant="additions text">
                {entries.map(entry => (
                  <li className={`output-entry ${entry.level}`} key={entry.id}>
                    <time dateTime={new Date(entry.timestamp).toISOString()}>{formatTime(entry.timestamp)}</time>
                    <span className="output-source">{entry.source}</span>
                    <span className="output-message">{entry.message}</span>
                    {entry.count > 1 && <span className="output-repeat" aria-label={`Repeated ${entry.count} times`}>×{entry.count}</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        ) : activeTab === 'program' ? (
          <div className="output-panel-content problems-empty" role="status">
            <strong>Program execution is unavailable</strong>
            <span>No code has been run. A verified isolation runtime is required before CodeStudio can execute collaborator-submitted JavaScript.</span>
          </div>
        ) : (
          <div className="output-panel-content problems-empty" role="status">
            <strong>No diagnostics available</strong>
            <span>CodeStudio has no compiler or runtime integration. No program has been executed.</span>
          </div>
        )
      )}
    </section>
  );
}
