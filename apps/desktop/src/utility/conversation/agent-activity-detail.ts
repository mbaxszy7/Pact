import { basename, isAbsolute, relative } from 'node:path'

const MAX_DETAIL_LENGTH = 500

export class AgentActivityDetail {
  private constructor() {}

  static projectPath(value: string, cwd: string): string {
    const path = isAbsolute(value) ? relative(cwd, value) : value
    return AgentActivityDetail.redact(path.startsWith('..') ? basename(value) : path)
  }

  static redact(value: string): string {
    return value
      .replace(/(bearer\s+)[a-z0-9._~+/-]+/giu, '[redacted]')
      .replace(
        /((?:api[_-]?key|auth(?:orization)?|cookie|password|secret|token)\s*[:=]\s*)([^\s,;]+)/giu,
        '$1[redacted]',
      )
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, MAX_DETAIL_LENGTH)
  }
}
