import type { Machine, Point, Settings, Sheet } from '../model'
export interface Motion { to: Point; burn: boolean; settings: Settings }
export interface ControllerAdapter {
  id: Machine['controller']; version: string; label: string; extension: string; liveUpload: boolean
  compile(sheet: Sheet, machine: Machine): Uint8Array
  inspect(bytes: Uint8Array): Motion[]
}
export function motions(sheet: Sheet, machine: Machine): Motion[] {
  const result: Motion[] = []
  const transform = (p: Point) => ({ x: machine.mirrorX ? machine.bedWidth - p.x : p.x, y: machine.mirrorY ? machine.bedHeight - p.y : p.y })
  for (const path of sheet.paths) for (let pass = 0; pass < path.settings.passes; pass++) {
    const settings = { ...path.settings, passes: 1 }
    result.push({ to: transform(path.points[0]), burn: false, settings })
    for (const p of path.points.slice(1)) result.push({ to: transform(p), burn: true, settings })
    if (path.closed) result.push({ to: transform(path.points[0]), burn: true, settings })
  }
  return result
}
export function compareMotions(expected: Motion[], actual: Motion[]) {
  if (expected.length !== actual.length) throw new Error('Controller output has a different number of movements')
  expected.forEach((e, i) => {
    const a = actual[i]
    if (e.burn !== a.burn || Math.abs(e.to.x - a.to.x) > .0011 || Math.abs(e.to.y - a.to.y) > .0011 || Math.abs(e.settings.speedMmS - a.settings.speedMmS) > .0011 || Math.abs(e.settings.minPower - a.settings.minPower) > .007 || Math.abs(e.settings.maxPower - a.settings.maxPower) > .007 || e.settings.airAssist !== a.settings.airAssist) throw new Error(`Controller output differs from the plan at movement ${i + 1}`)
  })
}
