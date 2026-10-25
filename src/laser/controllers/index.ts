import { canonical } from '../model'
import type { Machine, Sheet } from '../model'
import { ruidaAdapter } from './ruida'
import { compareMotions, motions, type ControllerAdapter, type Motion } from './types'
const simulationAdapter: ControllerAdapter = {
  id: 'simulation', version: 'simulation-1.0.0', label: 'Simulation · no hardware', extension: 'laser.json', liveUpload: false,
  compile: (sheet, machine) => new TextEncoder().encode(canonical({ format: 'laser-simulation/v1', motions: motions(sheet, machine) })),
  inspect: bytes => {
    const data = JSON.parse(new TextDecoder().decode(bytes))
    if (data.format !== 'laser-simulation/v1' || !Array.isArray(data.motions)) throw new Error('Invalid simulation file')
    return data.motions as Motion[]
  },
}
export const adapters: Record<Machine['controller'], ControllerAdapter> = { simulation: simulationAdapter, 'ruida-rd': ruidaAdapter }
export function compileSheet(sheet: Sheet, machine: Machine) {
  const adapter = adapters[machine.controller]
  if (!adapter) throw new Error('Unknown controller adapter')
  const bytes = adapter.compile(sheet, machine), decoded = adapter.inspect(bytes)
  compareMotions(motions(sheet, machine), decoded)
  return { bytes, decoded, adapter }
}
