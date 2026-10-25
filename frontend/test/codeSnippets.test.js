import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCodeSnippetProviders } from '../src/codeSnippets.js';

function createMonacoMock() {
  const registered = new Map();
  return {
    registered,
    languages: {
      CompletionItemKind: { Snippet: 27 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider(language, provider) {
        assert.equal(registered.has(language), false, `duplicate provider for ${language}`);
        registered.set(language, provider);
        return { dispose() {} };
      },
    },
  };
}

function suggestions(monaco, language) {
  const provider = monaco.registered.get(language);
  assert.ok(provider, `provider registered for ${language}`);
  return provider.provideCompletionItems({
    getWordUntilPosition: () => ({ word: '', startColumn: 1, endColumn: 1 }),
  }, { lineNumber: 2, column: 1 }).suggestions;
}

test('snippet providers register only for the six configured languages', () => {
  const monaco = createMonacoMock();
  const first = registerCodeSnippetProviders(monaco);
  const second = registerCodeSnippetProviders(monaco);

  assert.equal(first, second);
  assert.deepEqual([...monaco.registered.keys()], ['java', 'c', 'python', 'html', 'css', 'javascript']);
  assert.equal(monaco.registered.size, 6);
});

test('each language receives its requested snippet prefixes and Monaco snippet insertion rules', () => {
  const monaco = createMonacoMock();
  registerCodeSnippetProviders(monaco);
  const expectedPrefixes = {
    java: ['sout', 'souf', 'syso', 'main', 'fori', 'if'],
    c: ['printf', 'main', 'for', 'if', 'include'],
    python: ['print', 'main', 'def', 'for', 'class', 'if'],
    html: ['html5', 'div'],
    css: ['flex', 'center'],
    javascript: ['clg', 'fn', 'arrow', 'for'],
  };

  for (const [language, expected] of Object.entries(expectedPrefixes)) {
    const items = suggestions(monaco, language);
    assert.deepEqual(items.map(item => item.label), expected, language);
    for (const item of items) {
      assert.equal(item.kind, monaco.languages.CompletionItemKind.Snippet);
      assert.equal(item.insertTextRules, monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet);
      assert.equal(item.filterText, item.label);
      assert.equal(item.detail, 'CodeStudio snippet');
      assert.ok(item.range.startLineNumber === 2);
    }
  }
});

test('snippets include the expected templates and editable placeholders', () => {
  const monaco = createMonacoMock();
  registerCodeSnippetProviders(monaco);
  const find = (language, label) => suggestions(monaco, language).find(item => item.label === label);

  assert.equal(find('java', 'sout').insertText, 'System.out.println(${1});');
  assert.match(find('java', 'main').insertText, /public static void main\(String\[\] args\)/);
  assert.match(find('c', 'main').insertText, /int main\(void\)[\s\S]*return 0;/);
  assert.equal(find('c', 'include').insertText, '#include <stdio.h>');
  assert.match(find('python', 'main').insertText, /if __name__ == "__main__":/);
  assert.match(find('python', 'def').insertText, /\$\{1:function_name\}[\s\S]*\$\{3:pass\}/);
  assert.match(find('html', 'html5').insertText, /<!DOCTYPE html>[\s\S]*\$\{4\}[\s\S]*<\/html>/);
  assert.equal(find('html', 'div').insertText, '<div>${1}</div>');
  assert.match(find('css', 'center').insertText, /justify-content: center;[\s\S]*align-items: center;/);
  assert.equal(find('javascript', 'clg').insertText, 'console.log(${1});');
  assert.match(find('javascript', 'arrow').insertText, /=>/);
});
