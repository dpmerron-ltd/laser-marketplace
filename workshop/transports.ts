import { createHash } from 'node:crypto'
import type { Machine } from '../src/laser/model'

export interface UploadRequest { machine: Machine; jobId: string; sheet: number; filename: string; bytes: Uint8Array; hash: string }
export interface UploadReceipt { reference: string; storedHash: string }
export interface WorkshopTransport {
  readonly id: string
  readonly uploadOnlyVerified: boolean
  upload(request: UploadRequest): Promise<UploadReceipt>
  status(machine: Machine): Promise<{ state: 'simulation' | 'unavailable'; message: string }>
}
const simulation: WorkshopTransport = {
  id: 'simulation', uploadOnlyVerified: true,
  async upload(request) {
    const actual = createHash('sha256').update(request.bytes).digest('hex')
    if (actual !== request.hash) throw new Error('Transport received a corrupt artifact')
    return { reference: `simulated:${request.jobId}:sheet-${request.sheet}`, storedHash: actual }
  },
  async status() { return { state: 'simulation', message: 'No physical controller is connected' } },
}
const uncommissionedRuida: WorkshopTransport = {
  id: 'ruida-rd', uploadOnlyVerified: false,
  async upload() { throw new Error('Live Ruida upload is not commissioned') },
  async status() { return { state: 'unavailable', message: 'Ruida is available for experimental offline export only' } },
}
export function transportFor(machine: Machine): WorkshopTransport {
  const transports: Record<Machine['controller'], WorkshopTransport> = { simulation, 'ruida-rd': uncommissionedRuida }
  const transport = transports[machine.controller]
  if (!transport) throw new Error('No transport registered for this controller')
  return transport
}
