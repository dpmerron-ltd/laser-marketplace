import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseWorkspace, type Workspace } from '../src/laser/workspace'
export function atomicJson(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(temp, path)
}
export class Catalogue {
  private file: string
  constructor(root: string) { this.file = join(root, 'workspace.json') }
  read(): Workspace | null { return existsSync(this.file) ? parseWorkspace(JSON.parse(readFileSync(this.file, 'utf8'))) : null }
  save(value: unknown): Workspace { const workspace = parseWorkspace(value); atomicJson(this.file, workspace); return workspace }
}
