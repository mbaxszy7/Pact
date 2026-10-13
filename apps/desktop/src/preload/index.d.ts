import type { DesktopBridge } from '@pact/contracts'

declare global {
  interface Window {
    pact: DesktopBridge
  }
}
