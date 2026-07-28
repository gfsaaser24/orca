import { randomUUID } from 'node:crypto'
import { chmod, rename, writeFile } from 'node:fs/promises'

/** Write via a same-directory temp file and rename over the target, so a reader
 * (CPA reloads its config on a ~150ms watcher) never observes a partial file.
 * The mode is re-applied after the rename because rename does not carry it. */
export async function atomicWrite(
  target: string,
  value: string | Buffer,
  mode: number
): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, value, { mode })
  await rename(temporary, target)
  await chmod(target, mode).catch(() => undefined)
}
