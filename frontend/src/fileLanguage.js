const languageAliases = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  sh: 'shell',
  yml: 'yaml',
  md: 'markdown',
};

const languageLabels = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  html: 'HTML',
  json: 'JSON',
  markdown: 'Markdown',
  python: 'Python',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  go: 'Go',
  rust: 'Rust',
  yaml: 'YAML',
  xml: 'XML',
  sql: 'SQL',
  shell: 'Shell',
  plaintext: 'Plain text',
};

const extensionLanguage = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', json: 'json', md: 'markdown', markdown: 'markdown',
  py: 'python', java: 'java', c: 'c', h: 'cpp', cc: 'cpp', cpp: 'cpp',
  cs: 'csharp', go: 'go', rs: 'rust', yml: 'yaml', yaml: 'yaml',
  xml: 'xml', sql: 'sql', sh: 'shell', bash: 'shell', txt: 'plaintext',
};

export function resolveFileLanguage(fileName, storedLanguage) {
  const stored = typeof storedLanguage === 'string' ? storedLanguage.trim().toLowerCase() : '';
  const extension = fileName?.split('.').pop()?.toLowerCase() || '';
  const candidate = stored ? (languageAliases[stored] || stored) : (extensionLanguage[extension] || 'plaintext');
  const id = languageLabels[candidate] ? candidate : (extensionLanguage[extension] || 'plaintext');
  return { id, label: languageLabels[id] || languageLabels.plaintext };
}

export function getSelectedFileLanguage(activeFile, fileLanguage) {
  return fileLanguage?.file === activeFile ? fileLanguage : resolveFileLanguage(activeFile);
}
