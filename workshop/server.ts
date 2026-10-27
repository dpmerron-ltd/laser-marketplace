import { createServer, type IncomingMessage } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { deadSpaceSchema, type JobRequest } from '../src/laser/model'
import { ShopifySync } from './shopifySync'
import { prepareCatalogueOrder } from './catalogueOrders'
import { WorkshopStore, type Action } from './store'

async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Content-Type must be application/json')
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > 8_000_000) throw new Error('Request exceeds 8 MB'); chunks.push(Buffer.from(chunk)) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
export function createWorkshopServer(store: WorkshopStore, port: number, webRoot?: string, sync = ShopifySync.fromEnvironment(store)) {
  return createServer(async (req, res) => {
    const send = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)) }
    const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`])
    const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, 'http://localhost:5173', 'http://127.0.0.1:5173'])
    if (!hosts.has(req.headers.host ?? '') || req.headers.origin && !origins.has(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site') { send(403, { error: 'Workshop accepts only local same-origin requests' }); return }
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`), path = url.pathname
      if (!path.startsWith('/workshop-api/')) {
        if (!webRoot || !['GET', 'HEAD'].includes(req.method ?? '')) { send(404, { error: 'Not found' }); return }
        const relative = decodeURIComponent(path).replace(/^\/laser-marketplace\/?/, '').replace(/^\//, '') || 'index.html'
        const file = resolve(webRoot, relative)
        if (!file.startsWith(resolve(webRoot) + '/') || !existsSync(file)) { send(404, { error: 'Not found; build the app with npm run build' }); return }
        const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
        res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : readFileSync(file)); return
      }
      if (req.headers['x-laser-client'] !== 'laser-marketplace') { send(403, { error: 'Missing workshop client header' }); return }
      const parts = path.slice('/workshop-api/'.length).split('/')
      if (req.method === 'GET' && parts[0] === 'health') { send(200, { status: 'ok', transport: 'simulation-only', liveUpload: false }); return }
      if (parts[0] === 'workspace') {
        if (req.method === 'GET') { send(200, sync.production.catalogue.read()); return }
        if (req.method === 'PUT') {
          const workspace = sync.production.saveCatalogue(await body(req))
          sync.production.view() // Retry held SKUs and rebuild pending beds using the newly saved library.
          send(200, workspace); return
        }
      }
      if (parts[0] === 'shopify') {
        if (req.method === 'GET' && parts[1] === 'status') { send(200, sync.status()); return }
        if (req.method === 'POST' && parts[1] === 'sync') { await body(req); await sync.sync(); send(200, sync.status()); return }
        if (req.method === 'PUT' && parts[1] === 'automation') { const data = z.object({ enabled: z.boolean() }).parse(await body(req)); send(200, sync.setEnabled(data.enabled)); return }
      }
      if (parts[0] === 'production') {
        if (req.method === 'GET' && parts.length === 1) { send(200, sync.production.view()); return }
        if (req.method === 'PUT' && parts[1] === 'batches' && parts[3] === 'sheets' && parts[5] === 'dead-spaces' && parts.length === 6) {
          const input = z.object({ zones: z.array(deadSpaceSchema).max(50) }).parse(await body(req))
          send(200, sync.production.setDeadSpaces(parts[2], z.coerce.number().int().min(1).max(1000).parse(parts[4]), input.zones)); return
        }
        if (req.method === 'POST' && parts[1] === 'batches' && parts[3] === 'release' && parts.length === 4) {
          await body(req)
          await sync.sync() // Refresh eligibility before freezing an order onto a production job.
          send(201, sync.production.release(parts[2])); return
        }
        if (req.method === 'POST' && parts[1] === 'jobs' && parts[3] === 'cancel' && parts.length === 4) {
          const input = z.object({ note: z.string().trim().min(1).max(2000) }).parse(await body(req))
          send(200, sync.production.cancelUnstarted(parts[2], input.note)); return
        }
      }
      if (req.method === 'POST' && ['jobs', 'orders'].includes(parts[0]) && parts.length === 1) {
        const input = await body(req), key = String(req.headers['idempotency-key'] ?? '')
        if (parts[0] === 'orders') {
          const jobs = prepareCatalogueOrder(store, input, key)
          send(201, jobs.length === 1 ? jobs[0] : { jobs }); return
        }
        send(201, store.prepare(input as JobRequest, key)); return
      }
      if (parts[0] === 'jobs') {
        const id = parts[1]
        if (req.method === 'GET') {
          if (!id) { send(200, store.list()); return }
          if (parts.length === 2) { send(200, store.get(id)); return }
          if (parts[2] === 'plan') { send(200, store.plan(id)); return }
          if (parts[2] === 'manifest') { send(200, store.manifest(id)); return }
          if (parts[2] === 'artifacts' && parts.length === 4) {
            const artifact = store.artifact(id, parts[3])
            res.writeHead(200, { 'Content-Type': artifact.mime, 'Content-Disposition': `attachment; filename="${parts[3]}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(artifact.bytes); return
          }
        }
        if (req.method === 'POST' && parts[2] === 'sheets' && parts[4] === 'actions') {
          const action = await body(req) as Action
          if (sync.production.tracksJob(id) && ['stage', 'record-start'].includes(action?.action)) await sync.sync()
          send(200, await store.act(id, Number(parts[3]), action)); return
        }
        if (req.method === 'POST' && parts[2] === 'replacements') { await body(req); send(201, store.replacements(id)); return }
      }
      send(404, { error: 'Unknown workshop route' })
    } catch (error) { send(400, { error: error instanceof Error ? error.message : 'Workshop request failed' }) }
  })
}
export function startWorkshop() {
  const port = Number(process.env.LASER_WORKSHOP_PORT ?? 4318)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid LASER_WORKSHOP_PORT')
  const root = resolve(process.env.LASER_WORKSHOP_DATA ?? '.workshop'), lock = join(root, 'service.lock')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'))
    let alive = true
    try { process.kill(pid, 0) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
    if (alive || !Number.isInteger(pid) || pid <= 0) throw new Error('Another workshop service owns this data directory')
    unlinkSync(lock)
  }
  writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
  const release = () => { if (existsSync(lock) && readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock) }
  process.on('exit', release)
  const store = new WorkshopStore(root), sync = ShopifySync.fromEnvironment(store), server = createWorkshopServer(store, port, resolve('dist'), sync)
  sync.start()
  server.listen(port, '127.0.0.1', () => console.log(`Laser workshop: http://127.0.0.1:${port}/laser-marketplace/ (simulation; live transfer disabled)`))
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { sync.stop(); server.close(() => { release(); process.exit(0) }) })
  server.on('error', error => { sync.stop(); console.error(error.message); release(); process.exitCode = 1 })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startWorkshop()
