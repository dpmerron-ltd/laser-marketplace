import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildArtifacts } from '../src/laser/artifacts'
import { adapters } from '../src/laser/controllers'
import { canonical, requestSchema, type JobRequest, type Plan, type QueueJob, type SheetStatus } from '../src/laser/model'
import { planJob } from '../src/laser/planner'
import { transportFor } from './transports'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const actionSchema = z.object({ action: z.enum(['stage', 'record-start', 'record-finish', 'inspect', 'reconcile']), note: z.string().max(2000).optional(), accepted: z.array(z.string()).max(500).optional(), rejected: z.array(z.string()).max(500).optional(), resolution: z.enum(['ready', 'staged', 'awaiting_inspection']).optional() })
export type Action = z.infer<typeof actionSchema>
interface Manifest { id: string; requestHash: string; artifactHash: string; adapterVersion: string; files: { name: string; mime: string; hash: string }[] }
export class WorkshopStore {
  constructor(readonly root: string, private readonly resolveTransport = transportFor) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    // No command is automatically retried after a service interruption.
    for (const job of this.list()) {
      let changed = false
      for (const s of job.sheets) if (s.state === 'transferring' || s.state === 'running') {
        s.state = 'needs_reconciliation'; changed = true
        job.events.push({ at: new Date().toISOString(), sheet: s.number, action: 'restart', note: 'Service restarted with an uncertain transfer or run; operator reconciliation required.' })
      }
      if (changed) this.save(job)
    }
  }
  private directory(id: string) { if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid job ID'); return join(this.root, id) }
  private save(job: QueueJob) { this.atomic(join(this.directory(job.id), 'status.json'), job) }
  private atomic(path: string, value: unknown) { const tmp = `${path}.${randomUUID()}.tmp`; writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(tmp, path) }
  list(): QueueJob[] { return readdirSync(this.root).filter(id => /^[a-f0-9]{24}$/.test(id)).map(id => this.get(id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
  get(id: string): QueueJob { return JSON.parse(readFileSync(join(this.directory(id), 'status.json'), 'utf8')) }
  plan(id: string): Plan { return JSON.parse(this.artifact(id, 'plan.json').bytes.toString('utf8')) }
  manifest(id: string): Manifest { return JSON.parse(readFileSync(join(this.directory(id), 'manifest.json'), 'utf8')) }
  artifact(id: string, filename: string) {
    const manifest = this.manifest(id), file = manifest.files.find(f => f.name === filename)
    if (!file || !/^[a-z0-9.-]+$/.test(filename)) throw new Error('Unknown artifact')
    if (hash(canonical(manifest.files)) !== manifest.artifactHash || manifest.artifactHash !== this.get(id).artifactHash) throw new Error('Artifact manifest hash mismatch')
    const bytes = readFileSync(join(this.directory(id), filename))
    if (hash(bytes) !== file.hash) throw new Error('Artifact hash mismatch; job must be regenerated')
    return { bytes, mime: file.mime }
  }
  prepare(raw: JobRequest, idempotencyKey: string): QueueJob {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(idempotencyKey)) throw new Error('Provide an Idempotency-Key containing 1–120 letters, numbers, hyphens or underscores')
    const request = requestSchema.parse(raw), requestHash = hash(canonical(request)), id = hash(idempotencyKey).slice(0, 24)
    if (existsSync(this.directory(id))) {
      if (this.manifest(id).requestHash !== requestHash) throw new Error('Idempotency key already belongs to a different order snapshot')
      return this.get(id)
    }
    const plan = planJob(request), artifacts = buildArtifacts(plan)
    const files = artifacts.map(a => ({ name: a.name, mime: a.mime, hash: hash(a.bytes) }))
    const artifactHash = hash(canonical(files)), dir = join(this.root, `.preparing-${randomUUID()}`)
    mkdirSync(dir, { mode: 0o700 })
    for (const a of artifacts) writeFileSync(join(dir, a.name), a.bytes, { mode: 0o600, flag: 'wx' })
    const job: QueueJob = { id, reference: request.reference, createdAt: new Date().toISOString(), controller: request.machine.controller, artifactHash, sheets: plan.sheets.map(s => ({ number: s.number, state: 'ready', accepted: [], rejected: [] })), events: [] }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id, requestHash, artifactHash, adapterVersion: adapters[request.machine.controller].version, files } satisfies Manifest, null, 2), { mode: 0o600 })
    writeFileSync(join(dir, 'status.json'), JSON.stringify(job, null, 2), { mode: 0o600 })
    renameSync(dir, this.directory(id))
    return job
  }
  async act(id: string, number: number, raw: Action): Promise<QueueJob> {
    const action = actionSchema.parse(raw)
    const job = this.get(id), status = job.sheets.find(s => s.number === number)
    if (!status) throw new Error('Unknown sheet')
    const plan = this.plan(id), sheet = plan.sheets.find(s => s.number === number)!
    const requireState = (...states: SheetStatus['state'][]) => { if (!states.includes(status.state)) throw new Error(`Cannot ${action.action} while sheet is ${status.state}`) }
    const note = action.note?.trim() ?? ''
    if (note.length > 2000) throw new Error('Note is too long')
    const requireNote = () => { if (!note) throw new Error('Record the operator check or observation in a note') }
    const busy = () => this.list().some(j => this.plan(j.id).request.machine.id === plan.request.machine.id && j.sheets.some(s => (j.id !== id || s.number !== number) && ['transferring', 'staged', 'running', 'needs_reconciliation'].includes(s.state)))
    switch (action.action) {
      case 'stage': {
        requireState('ready')
        const transport = this.resolveTransport(plan.request.machine)
        if (!transport.uploadOnlyVerified) throw new Error('Live controller upload is not commissioned. Export the file for qualification; automatic transfer is disabled.')
        if (busy()) throw new Error('This machine already has a staged, active or uncertain sheet')
        const manifest = this.manifest(id)
        for (const f of manifest.files) this.artifact(id, f.name)
        const filename = `sheet-${number}.${adapters[job.controller].extension}`
        const file = manifest.files.find(f => f.name === filename)!
        const bytes = this.artifact(id, filename).bytes
        status.state = 'transferring'; this.save(job)
        try {
          const receipt = await transport.upload({ machine: plan.request.machine, jobId: id, sheet: number, filename, bytes, hash: file.hash })
          if (receipt.storedHash !== file.hash) throw new Error('Transport receipt does not match the artifact hash')
          status.receipt = receipt.reference; status.state = 'staged'
        } catch (e) {
          status.state = 'needs_reconciliation'
          job.events.push({ at: new Date().toISOString(), sheet: number, action: 'transfer-uncertain', note: e instanceof Error ? e.message : 'Upload outcome is unknown' })
          this.save(job)
          throw new Error('Transfer outcome is uncertain; reconcile the sheet before retrying')
        }
        break
      }
      case 'record-start': requireState('staged'); requireNote(); status.state = 'running'; break
      case 'record-finish': requireState('running'); requireNote(); status.state = 'awaiting_inspection'; break
      case 'inspect': {
        requireState('awaiting_inspection'); requireNote()
        const all = sheet.placements.map(p => p.id), accepted = action.accepted ?? [], rejected = action.rejected ?? [], reported = [...accepted, ...rejected]
        if (reported.length !== all.length || new Set(reported).size !== all.length || reported.some(p => !all.includes(p))) throw new Error('Inspection must account for every component exactly once')
        status.accepted = accepted; status.rejected = rejected; status.state = 'complete'; break
      }
      case 'reconcile':
        requireState('needs_reconciliation'); requireNote()
        if (!action.resolution || !['ready', 'staged', 'awaiting_inspection'].includes(action.resolution)) throw new Error('Choose an explicit reconciliation resolution')
        if (action.resolution === 'staged' && busy()) throw new Error('Machine is already occupied')
        status.state = action.resolution; break
      default: throw new Error('Unknown queue action')
    }
    job.events.push({ at: new Date().toISOString(), sheet: number, action: action.action, note })
    this.save(job)
    return job
  }
  replacements(id: string): QueueJob {
    const source = this.get(id), plan = this.plan(id)
    if (source.sheets.some(s => s.state !== 'complete')) throw new Error('Inspect all sheets before creating replacements')
    const rejected = source.sheets.flatMap(s => s.rejected)
    if (!rejected.length) throw new Error('No rejected components need replacement')
    const lines = plan.request.lines.flatMap((line, i) => { const quantity = rejected.filter(p => p.startsWith(`line-${i + 1}-part-`)).length; return quantity ? [{ ...line, quantity }] : [] })
    return this.prepare({ ...plan.request, reference: `${plan.request.reference.slice(0, 140)} replacements`, lines }, `replacement-${id}`)
  }
}
