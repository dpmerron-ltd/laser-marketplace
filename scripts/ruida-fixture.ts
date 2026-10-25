import { mkdirSync, writeFileSync } from 'node:fs'
import { defaultMachine, defaultMaterial, demoDesign } from '../src/laser/model'
import { planJob } from '../src/laser/planner'
import { compileSheet } from '../src/laser/controllers'
const machine = { ...defaultMachine, controller: 'ruida-rd' as const, mirrorX: true }
const plan = planJob({ reference: 'RD-INTEROP', machine, material: { ...defaultMaterial, approved: true, cut: { ...defaultMaterial.cut, passes: 2 } }, lines: [{ design: { ...demoDesign, approved: true }, quantity: 3, order: 'TEST' }] })
const result = compileSheet(plan.sheets[0], machine)
mkdirSync('dist-workshop/interop', { recursive: true })
writeFileSync('dist-workshop/interop/sample.rd', result.bytes)
writeFileSync('dist-workshop/interop/expected.json', JSON.stringify(result.decoded))
console.log(`Wrote ${result.bytes.length} RD bytes and ${result.decoded.length} movements for independent inspection`)
