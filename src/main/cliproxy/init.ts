import type { Store } from '../persistence'
import { CpaService } from './service-lifecycle'

export { deriveCpaReadiness } from './state-derivation'

let singleton: CpaService | null = null

export function initCliproxy(store: Store): void {
  if (singleton) {
    return
  }
  singleton = new CpaService(store)
  void singleton.start().catch((error) => singleton?.markStartupFailure(error))
}

export async function disposeCliproxy(): Promise<void> {
  if (!singleton) {
    return
  }
  await singleton.dispose()
  singleton = null
}
