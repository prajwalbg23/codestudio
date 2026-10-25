import { createElement } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, Pencil, Trash2 } from 'lucide-react';

function FolderBranch({ folder, depth, expandedFolders, selectedFolder, onSelectFolder, ...props }) {
  const expanded = expandedFolders.has(folder.path);
  return (
    <li className={`project-tree-folder ${selectedFolder === folder.path ? 'target-folder' : ''}`}>
      <div className="project-tree-folder-row">
        <button
          type="button"
          className="project-folder-button"
          style={{ paddingLeft: `${10 + depth * 14}px` }}
          aria-expanded={expanded}
          aria-pressed={selectedFolder === folder.path}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} and select folder ${folder.path}`}
          onClick={() => onSelectFolder(folder.path)}
        >
          {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          {expanded ? <FolderOpen size={15} aria-hidden="true" /> : <Folder size={15} aria-hidden="true" />}
          <span>{folder.name}</span>
        </button>
        <button type="button" className="rename-btn" aria-label={`Rename folder ${folder.path}`}
          title="Rename folder" onClick={() => props.onRenameFolder(folder.path)}><Pencil size={13} /></button>
        <button type="button" className="delete-btn" aria-label={`Delete folder ${folder.path}`}
          title="Delete empty folder" onClick={event => props.onDeleteFolder(event, folder.path)}><Trash2 size={13} /></button>
      </div>
      {expanded && (
        <ul className="project-tree-children">
          {folder.folders.map(child => (
            <FolderBranch key={child.path} folder={child} depth={depth + 1} expandedFolders={expandedFolders}
              selectedFolder={selectedFolder} onSelectFolder={onSelectFolder} {...props} />
          ))}
          {folder.files.map(file => <FileLeaf key={file.path} file={file} depth={depth + 1} {...props} />)}
          {folder.folders.length === 0 && folder.files.length === 0 && (
            <li className="project-tree-empty" style={{ paddingLeft: `${38 + depth * 14}px` }}>Empty folder</li>
          )}
        </ul>
      )}
    </li>
  );
}

function FileLeaf({ file, depth, activeFile, FileIcon, onOpenFile, onDeleteFile, onRenameFile }) {
  return (
    <li className={`project-tree-file ${file.path === activeFile ? 'active' : ''}`}>
      <button type="button" className="project-file-button" style={{ paddingLeft: `${38 + depth * 14}px` }}
        aria-current={file.path === activeFile ? 'page' : undefined} onClick={() => onOpenFile(file.path)}>
        {createElement(FileIcon, { name: file.path })}
        <span title={file.path}>{file.name}</span>
      </button>
      <button type="button" className="rename-btn" onClick={() => onRenameFile(file.path)}
        aria-label={`Rename file ${file.path}`} title="Rename file"><Pencil size={13} /></button>
      <button type="button" className="delete-btn" onClick={event => onDeleteFile(event, file.path)}
        aria-label={`Delete ${file.path}`} title="Delete file"><Trash2 size={14} /></button>
    </li>
  );
}

export default function ProjectTree({
  tree,
  activeFile,
  selectedFolder,
  expandedFolders,
  FileIcon,
  onSelectFolder,
  onOpenFile,
  onDeleteFile,
  onRenameFile,
  onRenameFolder,
  onDeleteFolder,
}) {
  const props = { activeFile, FileIcon, onOpenFile, onDeleteFile, onRenameFile, onRenameFolder, onDeleteFolder };
  return (
    <ul className="project-tree" aria-label="Project files and folders">
      {tree.files.map(file => <FileLeaf key={file.path} file={file} depth={0} {...props} />)}
      {tree.folders.map(folder => (
        <FolderBranch key={folder.path} folder={folder} depth={0} expandedFolders={expandedFolders}
          selectedFolder={selectedFolder} onSelectFolder={onSelectFolder} {...props} />
      ))}
    </ul>
  );
}
