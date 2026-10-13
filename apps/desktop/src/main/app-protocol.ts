import { net, protocol } from 'electron'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const APP_SCHEME = 'app'

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
])

export function registerAppProtocol(rendererRoot: string): void {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url)
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const filePath = resolve(rendererRoot, `.${pathname}`)
    const relativePath = relative(rendererRoot, filePath)

    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      return new Response('Not found', { status: 404 })
    }

    return net.fetch(pathToFileURL(filePath).toString())
  })
}
