import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = resolve(import.meta.dirname, '..')

// Node's native TypeScript transform preserves source-directory identities. Only
// repository-local .js specifiers lacking a real JS file resolve to their TS source.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (
        error.code !== 'ERR_MODULE_NOT_FOUND' ||
        !specifier.endsWith('.js') ||
        !specifier.startsWith('.') ||
        !context.parentURL?.startsWith('file:')
      )
        throw error
      const file = fileURLToPath(new URL(specifier, context.parentURL)),
        remainder = relative(repository, file)
      if (
        isAbsolute(remainder) ||
        remainder === '..' ||
        remainder.startsWith('../') ||
        remainder.startsWith('..\\')
      )
        throw error
      const typescript = file.slice(0, -3) + '.ts'
      if (!existsSync(typescript)) throw error
      return nextResolve(pathToFileURL(typescript).href, context)
    }
  },
})
