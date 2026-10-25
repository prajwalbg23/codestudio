const snippetsByLanguage = {
  java: [
    ['sout', 'Print a line', 'System.out.println(${1});'],
    ['souf', 'Print formatted text', 'System.out.printf("${1}");'],
    ['syso', 'Print a line', 'System.out.println(${1});'],
    ['main', 'Java main method', 'public static void main(String[] args) {\n\t${1}\n}'],
    ['fori', 'Indexed for loop', 'for (int ${1:i} = ${2:0}; ${1:i} < ${3:length}; ${1:i}++) {\n\t${4}\n}'],
    ['if', 'If statement', 'if (${1:condition}) {\n\t${2}\n}'],
  ],
  c: [
    ['printf', 'Print formatted text', 'printf("${1}");'],
    ['main', 'C main function', 'int main(void) {\n\t${1}\n\treturn 0;\n}'],
    ['for', 'Indexed for loop', 'for (int ${1:i} = ${2:0}; ${1:i} < ${3:count}; ${1:i}++) {\n\t${4}\n}'],
    ['if', 'If statement', 'if (${1:condition}) {\n\t${2}\n}'],
    ['include', 'Include the standard I/O header', '#include <stdio.h>'],
  ],
  python: [
    ['print', 'Print text', 'print("${1}")'],
    ['main', 'Python main guard', 'if __name__ == "__main__":\n\t${1:main()}'],
    ['def', 'Function definition', 'def ${1:function_name}(${2}):\n\t${3:pass}'],
    ['for', 'For each item', 'for ${1:item} in ${2:items}:\n\t${3:pass}'],
    ['class', 'Class definition', 'class ${1:ClassName}:\n\t${2:pass}'],
    ['if', 'If statement', 'if ${1:condition}:\n\t${2:pass}'],
  ],
  html: [
    ['html5', 'HTML5 document', '<!DOCTYPE html>\n<html lang="${1:en}">\n<head>\n\t<meta charset="${2:UTF-8}">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n\t<title>${3:Document}</title>\n</head>\n<body>\n\t${4}\n</body>\n</html>'],
    ['div', 'Div element', '<div>${1}</div>'],
  ],
  css: [
    ['flex', 'Flexbox declaration', 'display: flex;\n${1:align-items: center;}\n${2:justify-content: center;}'],
    ['center', 'Center content with flexbox', 'display: flex;\njustify-content: center;\nalign-items: center;'],
  ],
  javascript: [
    ['clg', 'Log a value to the console', 'console.log(${1});'],
    ['fn', 'Function declaration', 'function ${1:name}(${2}) {\n\t${3}\n}'],
    ['arrow', 'Arrow function', 'const ${1:name} = (${2}) => {\n\t${3}\n};'],
    ['for', 'Indexed for loop', 'for (let ${1:i} = ${2:0}; ${1:i} < ${3:length}; ${1:i}++) {\n\t${4}\n}'],
  ],
};

const providersByMonaco = new WeakMap();

export function registerCodeSnippetProviders(monaco) {
  const existing = providersByMonaco.get(monaco);
  if (existing) return existing;

  const providers = new Map();
  for (const [language, snippets] of Object.entries(snippetsByLanguage)) {
    const provider = monaco.languages.registerCompletionItemProvider(language, {
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: position.column,
        };

        return {
          suggestions: snippets.map(([label, description, insertText], index) => ({
            label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            detail: 'CodeStudio snippet',
            documentation: description,
            insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            filterText: label,
            sortText: `0${String(index).padStart(2, '0')}`,
            range,
          })),
        };
      },
    });
    providers.set(language, provider);
  }

  providersByMonaco.set(monaco, providers);
  return providers;
}
