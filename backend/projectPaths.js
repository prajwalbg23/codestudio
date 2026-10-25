const MAX_PROJECT_PATH_LENGTH = 255;
const MAX_PROJECT_SEGMENT_LENGTH = 120;

function isValidProjectPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PROJECT_PATH_LENGTH
    || value !== value.trim() || value.startsWith('/') || value.includes('\\')
    || /^[a-z]:/i.test(value) || value.startsWith('~')) {
    return false;
  }

  return value.split('/').every(segment => segment.length > 0
    && segment.length <= MAX_PROJECT_SEGMENT_LENGTH
    && segment !== '.' && segment !== '..'
    && !/[\u0000-\u001f<>:"|?*]/.test(segment)
    && !/[. ]$/.test(segment));
}

function parentProjectPath(projectPath) {
  const separator = projectPath.lastIndexOf('/');
  return separator === -1 ? '' : projectPath.slice(0, separator);
}

function projectPathAncestors(projectPath) {
  const segments = projectPath.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

module.exports = { isValidProjectPath, parentProjectPath, projectPathAncestors };
