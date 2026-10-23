const DEFAULT_RESULT_LIMIT = 300;

function isWordCharacter(character) {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

function codePointBefore(text, offset) {
  return offset > 0 ? Array.from(text.slice(0, offset)).at(-1) : undefined;
}

function codePointAt(text, offset) {
  return offset < text.length ? Array.from(text.slice(offset))[0] : undefined;
}

function searchText(source, query, fileName, options = {}, maxResults = DEFAULT_RESULT_LIMIT) {
  const term = typeof query === 'string' ? query.trim() : '';
  if (!term || typeof source !== 'string' || !fileName || maxResults <= 0) return [];

  const { caseSensitive = false, wholeWord = false } = options;
  const needle = caseSensitive ? term : term.toLocaleLowerCase();
  const matches = [];
  const lines = source.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length && matches.length < maxResults; lineIndex += 1) {
    const line = lines[lineIndex];
    const haystack = caseSensitive ? line : line.toLocaleLowerCase();
    let offset = 0;
    while (offset <= haystack.length - needle.length && matches.length < maxResults) {
      const column = haystack.indexOf(needle, offset);
      if (column < 0) break;
      const end = column + needle.length;
      const isWholeWord = !wholeWord
        || (!isWordCharacter(codePointBefore(line, column))
          && !isWordCharacter(codePointAt(line, end)));
      if (isWholeWord) {
        matches.push({
          fileName,
          lineNumber: lineIndex + 1,
          column: column + 1,
          snippet: line.trim().slice(0, 180),
        });
      }
      offset = column + Math.max(needle.length, 1);
    }
  }
  return matches;
}

module.exports = { searchText, DEFAULT_RESULT_LIMIT };
