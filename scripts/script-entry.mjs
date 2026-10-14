import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Node canonicalizes module filenames. CLI aliases and junctions must not silently skip execution. */
export function isScriptEntry(url, argv = process.argv) {
  return Boolean(
    argv[1] &&
    argv[1] !== '-' &&
    realpathSync(resolve(argv[1])) === realpathSync(fileURLToPath(url)),
  )
}
