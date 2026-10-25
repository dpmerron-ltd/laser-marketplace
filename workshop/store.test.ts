// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { defaultMachine, defaultMaterial, demoDesign, type JobRequest } from '../src/laser/model'
import { WorkshopStore } from './store'
import { createWorkshopServer } from './server'
let root: string, store: WorkshopStore
const fixture = (): JobRequest => structuredClone({ reference: 'ORDER-1', machine: defaultMachine, material: { ...defaultMaterial, approved: true }, lines: [{ design: { ...demoDesign, approved: true }, quantity: 2, order: 'ORDER-1' }] })
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'laser-workshop-test-')); store = new WorkshopStore(root) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
describe('durable jobs and lifecycle', async () => {
  it('deduplicates order retries and rejects changed snapshots under the same key', async () => {
    const job = store.prepare(fixture(), 'order-1')
    expect(store.prepare(fixture(), 'order-1').id).toBe(job.id)
    const changed = fixture(); changed.lines[0].quantity++
    expect(() => store.prepare(changed, 'order-1')).toThrow('different order snapshot')
    expect(store.list()).toHaveLength(1)
  })
  it('freezes source/settings and verifies every artifact before staging', async () => {
    const input = fixture(), job = store.prepare(input, 'order-1')
    input.machine.controller = 'ruida-rd'; input.material.cut.maxPower = 60
    expect(store.plan(job.id).request.machine.controller).toBe('simulation')
    const file = join(root, job.id, 'sheet-1.laser.json')
    writeFileSync(file, readFileSync(file, 'utf8') + ' ')
    await expect(store.act(job.id, 1, { action: 'stage' })).rejects.toThrow('hash mismatch')
    expect(store.get(job.id).sheets[0].state).toBe('ready')
  })
  it('never marks parts accepted merely because a file was staged or a run finished', async () => {
    const job = store.prepare(fixture(), 'order-1')
    await expect(store.act(job.id, 1, { action: 'record-start', note: 'loaded' })).rejects.toThrow('ready')
    await store.act(job.id, 1, { action: 'stage' })
    expect(store.get(job.id).sheets[0].accepted).toEqual([])
    await expect(store.act(job.id, 1, { action: 'record-start' })).rejects.toThrow('note')
    await store.act(job.id, 1, { action: 'record-start', note: 'Operator observed start' })
    await store.act(job.id, 1, { action: 'record-finish', note: 'Operator observed finish' })
    expect(store.get(job.id).sheets[0].accepted).toEqual([])
    await expect(store.act(job.id, 1, { action: 'inspect', note: 'checked', accepted: [] })).rejects.toThrow('every component')
    const ids = store.plan(job.id).sheets[0].placements.map(p => p.id)
    await store.act(job.id, 1, { action: 'inspect', note: 'Second tag failed inspection', accepted: [ids[0]], rejected: [ids[1]] })
    const replacement = store.replacements(job.id)
    expect(store.plan(replacement.id).request.lines[0].quantity).toBe(1)
    expect(store.replacements(job.id).id).toBe(replacement.id)
    expect(store.get(job.id).sheets[0].state).toBe('complete')
  })
  it('allows one staged sheet per machine and reconciles interrupted runs after restart', async () => {
    const a = store.prepare(fixture(), 'a'), b = store.prepare(fixture(), 'b')
    await store.act(a.id, 1, { action: 'stage' })
    await expect(store.act(b.id, 1, { action: 'stage' })).rejects.toThrow('already has')
    await store.act(a.id, 1, { action: 'record-start', note: 'Started' })
    const restarted = new WorkshopStore(root)
    expect(restarted.get(a.id).sheets[0].state).toBe('needs_reconciliation')
    await expect(restarted.act(a.id, 1, { action: 'stage' })).rejects.toThrow('reconciliation')
    await restarted.act(a.id, 1, { action: 'reconcile', resolution: 'awaiting_inspection', note: 'Operator confirmed the run finished' })
    expect((await restarted.act(b.id, 1, { action: 'stage' })).sheets[0].state).toBe('staged')
  })
  it('holds the machine claim during asynchronous transfer and never retries an uncertain upload', async () => {
    let release!: () => void
    let calls = 0
    const pending = new Promise<void>(resolve => { release = resolve })
    const transport = { id: 'test', uploadOnlyVerified: true, async upload() { calls++; await pending; throw new Error('Acknowledgement lost') }, async status() { return { state: 'simulation' as const, message: 'test' } } }
    const service = new WorkshopStore(root, () => transport)
    const a = service.prepare(fixture(), 'a'), b = service.prepare(fixture(), 'b')
    const transferring = service.act(a.id, 1, { action: 'stage' })
    expect(service.get(a.id).sheets[0].state).toBe('transferring')
    await expect(service.act(b.id, 1, { action: 'stage' })).rejects.toThrow('already has')
    await expect(service.act(a.id, 1, { action: 'stage' })).rejects.toThrow('transferring')
    release()
    await expect(transferring).rejects.toThrow('uncertain')
    expect(service.get(a.id).sheets[0].state).toBe('needs_reconciliation')
    await expect(service.act(a.id, 1, { action: 'stage' })).rejects.toThrow('reconciliation')
    expect(calls).toBe(1)
  })
  it('refuses live upload irrespective of approval flags', async () => {
    const input = fixture(); input.machine.controller = 'ruida-rd'
    const job = store.prepare(input, 'ruida')
    expect(store.artifact(job.id, 'sheet-1.rd').bytes.length).toBeGreaterThan(100)
    await expect(store.act(job.id, 1, { action: 'stage' })).rejects.toThrow('not commissioned')
    expect(store.get(job.id).sheets[0].state).toBe('ready')
  })
})
it('serves order automation locally and rejects cross-origin mutations', async () => {
  const server = createWorkshopServer(store, 4318)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port')
  const call = (path: string, method: string, input?: unknown, extra: Record<string, string> = {}) => new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path: '/workshop-api/' + path, method, headers: { Host: '127.0.0.1:4318', 'Content-Type': 'application/json', 'X-Laser-Client': 'laser-marketplace', ...extra } }, res => { const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) })) })
    req.on('error', reject); req.end(input === undefined ? undefined : JSON.stringify(input))
  })
  try {
    const input = fixture(), workspace = { machine: input.machine, material: input.material, designs: [input.lines[0].design] }
    expect((await call('workspace', 'PUT', workspace, { Origin: 'https://attacker.example' })).status).toBe(403)
    expect((await call('workspace', 'PUT', workspace)).status).toBe(200)
    const result = await call('orders', 'POST', { reference: 'WEB-1', lines: [{ sku: demoDesign.sku, quantity: 5 }] }, { 'Idempotency-Key': 'web-1' })
    expect(result.status).toBe(201)
    expect(store.plan(result.data.id).sheets.flatMap(s => s.placements)).toHaveLength(5)
    expect((await call('jobs', 'GET', undefined, { 'X-Laser-Client': '' })).status).toBe(403)
    expect((await call(`jobs/${result.data.id}/artifacts/../status.json`, 'GET')).status).not.toBe(200)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
