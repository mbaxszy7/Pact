const languageByExtension: Readonly<Record<string, string>> = {
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  gql: 'graphql',
  graphql: 'graphql',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  less: 'less',
  md: 'markdown',
  mdx: 'markdown',
  php: 'php',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell',
}

const languageByFileName: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  gemfile: 'ruby',
  makefile: 'shell',
}

export function projectFileLanguage(path: string): string | undefined {
  const fileName = path.split(/[\\/]/u).at(-1)?.toLowerCase()
  if (!fileName) return undefined
  const namedLanguage = languageByFileName[fileName]
  if (namedLanguage) return namedLanguage
  const extension = fileName.includes('.') ? fileName.split('.').at(-1) : undefined
  return extension ? languageByExtension[extension] : undefined
}
