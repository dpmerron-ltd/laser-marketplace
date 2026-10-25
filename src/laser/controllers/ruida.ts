import { bounds } from '../geometry'
import { motions, type ControllerAdapter, type Motion } from './types'
import type { Settings } from '../model'

// Restricted absolute-vector RD dialect. Protocol references and qualification status:
// docs/CONTROLLERS.md. This codec never sends bytes to a machine.
const integer = (n: number, length = 5) => {
  n = Math.round(n)
  if (!Number.isSafeInteger(n) || n < 0 || n >= 128 ** length) throw new Error('RD value is outside its encoding range')
  return Array.from({ length }, (_, i) => Math.floor(n / 128 ** (length - i - 1)) % 128)
}
export function scramble(b: number) { return ((((b & 0x7e) | ((b & 1) << 7) | ((b & 0x80) >> 7)) ^ 0x88) + 1) & 255 }
export function unscramble(b: number) { const v = ((b - 1) & 255) ^ 0x88; return (v & 0x7e) | ((v & 1) << 7) | ((v & 0x80) >> 7) }
const coord = (n: number) => integer(n * 1000)
const power = (n: number) => integer(n * 16383 / 100, 2)
export const ruidaAdapter: ControllerAdapter = {
  id: 'ruida-rd', version: 'rd-vector-0.1.0', label: 'Ruida RD · experimental export', extension: 'rd', liveUpload: false,
  compile(sheet, machine) {
    const motion = motions(sheet, machine)
    const box = bounds(motion.map(m => m.to)), raw: number[] = []
    const cmd = (...bytes: number[]) => { raw.push(...bytes) }
    cmd(0xd8, 0x10); cmd(0xe6, 0x01); cmd(0xf0); cmd(0xf1, 0x02, 0x00); cmd(0xd8, 0x00)
    cmd(0xe7, 0x06, ...integer(0), ...integer(0)); cmd(0xe7, 0x38, 0)
    for (const c of [0x03, 0x50]) cmd(0xe7, c, ...coord(box.minX), ...coord(box.minY))
    for (const c of [0x07, 0x51]) cmd(0xe7, c, ...coord(box.maxX), ...coord(box.maxY))
    cmd(0xe7, 0x04, ...[1, 1, 0, 0, 0, 0, 0].flatMap(n => integer(n, 2))); cmd(0xe7, 0x05, 0)
    const settings = [sheet.paths[0].settings, ...sheet.paths.map(p => p.settings)].filter((s, i, all) => all.findIndex(t => JSON.stringify(t) === JSON.stringify(s)) === i)
    settings.forEach((s, layer) => {
      cmd(0xc9, 0x04, layer, ...coord(s.speedMmS))
      cmd(0xc6, 0x31, layer, ...power(s.minPower)); cmd(0xc6, 0x32, layer, ...power(s.maxPower))
      cmd(0xc6, 0x41, layer, 0, 0); cmd(0xc6, 0x42, layer, 0, 0)
      cmd(0xca, 0x06, layer, ...integer(layer ? 0xff0000 : 0x0000ff)); cmd(0xca, 0x41, layer, 0)
      for (const c of [0x52, 0x61]) cmd(0xe7, c, layer, ...coord(box.minX), ...coord(box.minY))
      for (const c of [0x53, 0x62]) cmd(0xe7, c, layer, ...coord(box.maxX), ...coord(box.maxY))
    })
    cmd(0xca, 0x22, settings.length - 1)
    for (const c of [0x54, 0x55]) for (const axis of [0, 1]) cmd(0xe7, c, axis, ...integer(0))
    cmd(0xf1, 0x03, ...integer(0), ...integer(0)); cmd(0xe7, 0x0a, ...integer(0))
    let previous = ''
    for (const m of motion) {
      const key = JSON.stringify(m.settings)
      if (key !== previous) {
        if (previous) { cmd(0xe7, 0x00); cmd(0xca, 0x01, 0x00) }
        const layer = settings.findIndex(s => s.speedMmS === m.settings.speedMmS && s.minPower === m.settings.minPower && s.maxPower === m.settings.maxPower && s.airAssist === m.settings.airAssist)
        cmd(0xca, 0x02, layer); cmd(0xca, 0x01, 0x10); cmd(0xca, 0x01, m.settings.airAssist ? 0x13 : 0x12)
        cmd(0xc9, 0x02, ...coord(m.settings.speedMmS))
        cmd(0xc6, 0x12, ...integer(0)); cmd(0xc6, 0x13, ...integer(0))
        cmd(0xc6, 0x01, ...power(m.settings.minPower)); cmd(0xc6, 0x02, ...power(m.settings.maxPower))
        cmd(0xc6, 0x21, 0, 0); cmd(0xc6, 0x22, 0, 0); cmd(0xca, 0x03, 1)
        previous = key
      }
      cmd(m.burn ? 0xa8 : 0x88, ...coord(m.to.x), ...coord(m.to.y))
    }
    cmd(0xe7, 0x00); cmd(0xca, 0x01, 0x00); cmd(0xca, 0x01, 0x30)
    const sum = raw.reduce((a, b) => a + b, 0) + 0xd7
    cmd(0xe5, 0x05, ...integer(sum)); cmd(0xd7)
    return Uint8Array.from(raw, scramble)
  },
  inspect(bytes) {
    const raw = Array.from(bytes, unscramble), result: Motion[] = []
    const settings: Settings = { speedMmS: 0, minPower: 0, maxPower: 0, airAssist: false, passes: 1 }
    let i = 0, checksumSeen = false, ended = false
    const take = (length: number) => {
      if (i + length > raw.length) throw new Error('Truncated RD command')
      const data = raw.slice(i, i + length); i += length
      if (data.some(b => b >= 128)) throw new Error('Invalid RD command payload')
      return data
    }
    const num = (length = 5) => take(length).reduce((a, b) => a * 128 + b, 0)
    while (i < raw.length) {
      const start = i, op = raw[i++]
      if (checksumSeen && op !== 0xd7) throw new Error('Data after RD checksum')
      if (op === 0x88 || op === 0xa8) { const x = num() / 1000, y = num() / 1000; if (!settings.speedMmS) throw new Error('RD movement has no speed'); result.push({ to: { x, y }, burn: op === 0xa8, settings: { ...settings } }); continue }
      if (op === 0xd7) { if (!checksumSeen || i !== raw.length) throw new Error('Invalid RD end'); ended = true; continue }
      if (op === 0xf0) continue
      const sub = take(1)[0]
      if (op === 0xe5 && sub === 5) { if (num() !== raw.slice(0, start).reduce((a, b) => a + b, 0) + 0xd7) throw new Error('RD checksum mismatch'); checksumSeen = true; continue }
      if (op === 0xc6) {
        if ([1, 2, 0x21, 0x22].includes(sub)) {
          const p = num(2) * 100 / 16383
          if (sub === 1) settings.minPower = p
          else if (sub === 2) settings.maxPower = p
          else if (p !== 0) throw new Error('Second laser must be disabled')
        } else if ([0x31, 0x32, 0x41, 0x42].includes(sub)) { take(1); const p = num(2); if ([0x41, 0x42].includes(sub) && p !== 0) throw new Error('Second laser must be disabled') }
        else if ([0x12, 0x13].includes(sub)) take(5)
        else throw new Error('Unsupported RD power command')
      } else if (op === 0xc9 && sub === 2) settings.speedMmS = num() / 1000
      else if (op === 0xc9 && sub === 4) take(6)
      else if (op === 0xca) {
        if (sub === 1) { const mode = take(1)[0]; if (mode === 0x12 || mode === 0x13) settings.airAssist = mode === 0x13; else if (![0, 0x10, 0x30].includes(mode)) throw new Error('Unsupported RD mode') }
        else if ([2, 3, 0x22].includes(sub)) take(1)
        else if (sub === 6) take(6)
        else if (sub === 0x41) take(2)
        else throw new Error('Unsupported RD layer command')
      } else if (op === 0xe7) {
        const lengths: Record<number, number> = { 0: 0, 3: 10, 4: 14, 5: 1, 6: 10, 7: 10, 0x38: 1, 0x50: 10, 0x51: 10, 0x52: 11, 0x53: 11, 0x61: 11, 0x62: 11, 0x54: 6, 0x55: 6, 0x0a: 5 }
        if (!(sub in lengths)) throw new Error('Unsupported RD document command')
        take(lengths[sub])
      } else if (op === 0xf1 && sub === 2) take(1)
      else if (op === 0xf1 && sub === 3) take(10)
      else if (op === 0xd8 && [0, 0x10].includes(sub) || op === 0xe6 && sub === 1) { /* fixed header */ }
      else throw new Error(`Unknown RD command ${op.toString(16)}:${sub.toString(16)}`)
    }
    if (!ended || !result.length) throw new Error('Incomplete RD file')
    return result
  },
}
