import { useEffect, useMemo, useRef, useState } from 'react';
import { FileCode2, FileJson2, FileText, Search } from 'lucide-react';
import { searchText } from '../workspaceSearch.js';
import { filterPaletteFiles } from '../workspaceInteractions.js';

const iconFor = fileName => {
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (extension === 'json') return <FileJson2 size={15} aria-hidden="true" />;
  if (['md', 'markdown', 'txt'].includes(extension)) return <FileText size={15} aria-hidden="true" />;
  return <FileCode2 size={15} aria-hidden="true" />;
};

export default function CommandPalette({
  mode,
  files,
  activeFile,
  onClose,
  onOpenFile,
  readCurrentText,
  onNavigate,
  searchProject,
}) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [projectSearchState, setProjectSearchState] = useState({
    status: 'idle', results: [], unavailableFiles: [], truncated: false,
  });
  const inputRef = useRef(null);
  const projectRequestRef = useRef(0);
  const matches = useMemo(() => {
    if (mode !== 'content' || !activeFile || !query.trim()) return [];
    return searchText(readCurrentText(), query, activeFile);
  }, [activeFile, mode, query, readCurrentText]);
  const visibleFiles = useMemo(() => {
    return filterPaletteFiles(files, query);
  }, [files, query]);

  useEffect(() => {
    setQuery('');
    setCaseSensitive(false);
    setWholeWord(false);
    setProjectSearchState({ status: 'idle', results: [], unavailableFiles: [], truncated: false });
    inputRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (mode !== 'project' || !query.trim() || !searchProject) {
      setProjectSearchState({ status: 'idle', results: [], unavailableFiles: [], truncated: false });
      return undefined;
    }

    const requestId = ++projectRequestRef.current;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setProjectSearchState({ status: 'loading', results: [], unavailableFiles: [], truncated: false });
      try {
        const response = await searchProject({ query, caseSensitive, wholeWord }, controller.signal);
        if (requestId !== projectRequestRef.current || controller.signal.aborted) return;
        setProjectSearchState({
          status: 'success',
          results: Array.isArray(response?.results) ? response.results : [],
          unavailableFiles: Array.isArray(response?.unavailableFiles) ? response.unavailableFiles : [],
          truncated: Boolean(response?.truncated),
        });
      } catch {
        if (requestId !== projectRequestRef.current || controller.signal.aborted) return;
        setProjectSearchState({ status: 'error', results: [], unavailableFiles: [], truncated: false });
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
      if (projectRequestRef.current === requestId) projectRequestRef.current += 1;
    };
  }, [mode, query, caseSensitive, wholeWord, searchProject]);

  const isContentSearch = mode === 'content';
  const isProjectSearch = mode === 'project';

  return (
    <div className="palette-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-labelledby="palette-title" data-command-palette>
        <div className="palette-heading">
          <div>
            <h2 id="palette-title">{isProjectSearch ? 'Search project' : isContentSearch ? 'Find in active file' : 'Open file'}</h2>
            <p>{isContentSearch
              ? (activeFile ? `Searching only ${activeFile}; other rooms are not opened.` : 'Open a file before searching its contents.')
              : isProjectSearch
                ? 'Search saved collaborative documents. The active synchronized editor is searched from its current text.'
                : 'Quickly switch to a file in this shared session.'}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close search">×</button>
        </div>

        <label className="palette-search" htmlFor="palette-query">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            id="palette-query"
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label={isProjectSearch ? 'Search project files' : isContentSearch ? 'Search active file' : 'Open a file'}
            placeholder={isProjectSearch ? 'Search all project files' : isContentSearch ? 'Search text in the active file' : 'Type a file name'}
          />
          <kbd>Esc</kbd>
        </label>

        {isProjectSearch && (
          <div className="project-search-options" aria-label="Project search options">
            <label><input type="checkbox" checked={caseSensitive} onChange={event => setCaseSensitive(event.target.checked)} /> Case sensitive</label>
            <label><input type="checkbox" checked={wholeWord} onChange={event => setWholeWord(event.target.checked)} /> Whole word</label>
          </div>
        )}

        <div className="palette-results" aria-live="polite">
          {isProjectSearch && projectSearchState.status === 'idle' && <p className="palette-empty">Enter a term to search project files.</p>}
          {isProjectSearch && projectSearchState.status === 'loading' && <p className="palette-empty" role="status">Searching project files…</p>}
          {isProjectSearch && projectSearchState.status === 'error' && <p className="palette-empty" role="alert">Project search failed. Check the backend connection and try again.</p>}
          {isProjectSearch && projectSearchState.status === 'success' && projectSearchState.results.length === 0 && (
            <p className="palette-empty">{projectSearchState.unavailableFiles.length ? 'No matches in the files that could be searched.' : 'No matches found.'}</p>
          )}
          {isProjectSearch && projectSearchState.status === 'success' && projectSearchState.unavailableFiles.length > 0 && (
            <div className="project-search-partial" role="status">
              <span>Results may be incomplete. These files were unavailable:</span>
              <ul>{projectSearchState.unavailableFiles.map(fileName => <li key={fileName}>{fileName}</li>)}</ul>
            </div>
          )}
          {isProjectSearch && projectSearchState.status === 'success' && projectSearchState.truncated && (
            <p className="palette-limit" role="status">Showing the first 300 matches. Refine the search to see more.</p>
          )}
          {isProjectSearch && projectSearchState.status === 'success' && projectSearchState.results.length > 0 && (
            <ul aria-label="Project search matches">
              {projectSearchState.results.map((match, index) => (
                <li key={`${match.fileName}-${match.lineNumber}-${match.column}-${index}`}>
                  <button type="button" className="palette-result content-result" onClick={() => onNavigate({
                    ...match,
                    searchQuery: query,
                    searchOptions: { caseSensitive, wholeWord },
                  })}>
                    <span className="match-location">{match.fileName}:{match.lineNumber}:{match.column}</span>
                    <code>{match.snippet || ' '}</code>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!isContentSearch && !isProjectSearch && visibleFiles.length > 0 && (
            <ul aria-label="Matching files">
              {visibleFiles.map(fileName => (
                <li key={fileName}>
                  <button type="button" className="palette-result" onClick={() => onOpenFile(fileName)}>
                    {iconFor(fileName)}<span>{fileName}</span>
                    {fileName === activeFile && <small>Open</small>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!isContentSearch && !isProjectSearch && visibleFiles.length === 0 && (
            <p className="palette-empty">{query ? 'No files match that name.' : 'No files are available.'}</p>
          )}

          {isContentSearch && !activeFile && <p className="palette-empty">Select a file, then search its text here.</p>}
          {isContentSearch && activeFile && !query.trim() && <p className="palette-empty">Enter a term to search the active file.</p>}
          {isContentSearch && activeFile && query.trim() && matches.length === 0 && <p className="palette-empty">No matches in this file.</p>}
          {isContentSearch && matches.length > 0 && (
            <ul aria-label="Text matches">
              {matches.map((match, index) => (
                <li key={`${match.lineNumber}-${match.column}-${index}`}>
                  <button type="button" className="palette-result content-result" onClick={() => onNavigate(match)}>
                    <span className="match-location">{match.fileName}:{match.lineNumber}</span>
                    <code>{match.snippet || ' '}</code>
                  </button>
                </li>
              ))}
              {matches.length === 300 && <li className="palette-limit">Showing the first 300 matches.</li>}
            </ul>
          )}
        </div>
        <div className="palette-footer">
          <span>{isProjectSearch
            ? (projectSearchState.status === 'success' ? `${projectSearchState.results.length} matches` : 'Project search')
            : isContentSearch ? 'Current file only · No files are executed' : `${visibleFiles.length} ${visibleFiles.length === 1 ? 'file' : 'files'}`}</span>
          <span><kbd>Ctrl/⌘ P</kbd> open files <span aria-hidden="true">·</span> <kbd>Ctrl/⌘ ⇧ F</kbd> find this file <span aria-hidden="true">·</span> <kbd>Ctrl/⌘ ⇧ G</kbd> search project</span>
        </div>
      </section>
    </div>
  );
}
