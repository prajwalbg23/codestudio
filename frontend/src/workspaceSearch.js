const MAX_RESULTS = 300;

const isWordCharacter = character => character !== undefined && /[\p{L}\p{N}_]/u.test(character);
const codePointBefore = (text, offset) => offset > 0 ? Array.from(text.slice(0, offset)).at(-1) : undefined;
const codePointAt = (text, offset) => offset < text.length ? Array.from(text.slice(offset))[0] : undefined;

export function searchText(source, query, fileName, maxResults = MAX_RESULTS, options = {}) {
  const term = typeof query === 'string' ? query.trim() : '';
  if (!term || typeof source !== 'string' || !fileName || maxResults <= 0) return [];

  const { caseSensitive = false, wholeWord = false } = options;
  const needle = caseSensitive ? term : term.toLocaleLowerCase();
  const results = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
    const line = lines[index];
    const haystack = caseSensitive ? line : line.toLocaleLowerCase();
    let offset = 0;
    while (offset <= haystack.length - needle.length && results.length < maxResults) {
      const matchIndex = haystack.indexOf(needle, offset);
      if (matchIndex < 0) break;
      const matchEnd = matchIndex + needle.length;
      const isWholeWord = !wholeWord
        || (!isWordCharacter(codePointBefore(line, matchIndex))
          && !isWordCharacter(codePointAt(line, matchEnd)));
      if (isWholeWord) {
        results.push({
          fileName,
          lineNumber: index + 1,
          column: matchIndex + 1,
          snippet: line.trim().slice(0, 180),
        });
      }
      offset = matchIndex + Math.max(needle.length, 1);
    }
  }
  return results;
}
