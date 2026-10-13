type LanguageLoader = () => Promise<unknown>

export interface ProjectFileLanguageSupport {
  createWorker: () => Worker
  release: () => void
}

const basicLanguages: Readonly<Record<string, LanguageLoader>> = {
  c: () => import('monaco-editor/languages/definitions/cpp/register.js'),
  cpp: () => import('monaco-editor/languages/definitions/cpp/register.js'),
  csharp: () => import('monaco-editor/languages/definitions/csharp/register.js'),
  css: () => import('monaco-editor/languages/definitions/css/register.js'),
  dockerfile: () => import('monaco-editor/languages/definitions/dockerfile/register.js'),
  go: () => import('monaco-editor/languages/definitions/go/register.js'),
  graphql: () => import('monaco-editor/languages/definitions/graphql/register.js'),
  html: () => import('monaco-editor/languages/definitions/html/register.js'),
  ini: () => import('monaco-editor/languages/definitions/ini/register.js'),
  java: () => import('monaco-editor/languages/definitions/java/register.js'),
  javascript: () => import('monaco-editor/languages/definitions/javascript/register.js'),
  less: () => import('monaco-editor/languages/definitions/less/register.js'),
  makefile: () => import('monaco-editor/languages/definitions/shell/register.js'),
  markdown: () => import('monaco-editor/languages/definitions/markdown/register.js'),
  php: () => import('monaco-editor/languages/definitions/php/register.js'),
  powershell: () => import('monaco-editor/languages/definitions/powershell/register.js'),
  python: () => import('monaco-editor/languages/definitions/python/register.js'),
  ruby: () => import('monaco-editor/languages/definitions/ruby/register.js'),
  rust: () => import('monaco-editor/languages/definitions/rust/register.js'),
  scss: () => import('monaco-editor/languages/definitions/scss/register.js'),
  shell: () => import('monaco-editor/languages/definitions/shell/register.js'),
  sql: () => import('monaco-editor/languages/definitions/sql/register.js'),
  toml: () => import('monaco-editor/languages/definitions/ini/register.js'),
  typescript: () => import('monaco-editor/languages/definitions/typescript/register.js'),
  xml: () => import('monaco-editor/languages/definitions/xml/register.js'),
  yaml: () => import('monaco-editor/languages/definitions/yaml/register.js'),
}

export async function loadProjectFileLanguage(
  language: string,
): Promise<ProjectFileLanguageSupport | undefined> {
  if (language === 'json') {
    const module = await import('./project-json-support')
    return module.acquireJsonSupport()
  }
  await basicLanguages[language]?.()
  return undefined
}
