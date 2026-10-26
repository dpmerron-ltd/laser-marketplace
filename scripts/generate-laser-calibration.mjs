import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { calibrationZip } from './calibration-zip.mjs'

const root = resolve('public/calibration/v1')
await build({ entryPoints: ['src/laser/calibration.ts'], outfile: 'dist-workshop/calibration-lib.mjs', platform: 'node', target: 'node22', bundle: true, packages: 'external', format: 'esm' })
const { calibrationMaterials, calibrationTests, calibrationSvg, calibrationDxf, calibrationVersion } = await import(pathToFileURL(resolve('dist-workshop/calibration-lib.mjs')).href)
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const json = v => JSON.stringify(v, null, 2) + '\n'
const instructions = `LASER MARKETPLACE — INITIAL CALIBRATION PACK v1

STATUS: GEOMETRY ONLY. These SVG/DXF drawings contain no runnable power/speed
settings and are not DSP machine files. Controller model, tube wattage, usable
bed, lens/focus procedure and supplier limits must be confirmed before encoding.
The current app is configured for simulation; no LightBurn is required.

Red / CUT_* layers: closed cut contours. Blue / SCORE_*: open marking strokes.
Labels are vectors, not fonts. Never treat a preview border as a cutting path.
All dimensions are millimetres. Import at 100%; disable auto-fit, duplicate lines,
double passes and driver compensation. Review every layer. SVG/DXF does not
automatically assign the matrix's per-cell power and speed.

ORDER OF WORK
1. Verify machine origin, orientation, physical frame/extent and supplier focus
   procedure. Use the 100 mm X and 50 mm Y score marks with reviewed marking
   settings. They are not automatic focus or machine-axis calibration commands.
2. Cut ONE pilot coupon on fresh offcut using a supplier-based starting range.
   Keep air assist, extraction, lens/focus and passes recorded and consistent.
3. Test A1–C3 separately initially. Columns are fast/middle/slow; rows are
   low/middle/high power. Fill the actual settings before a test. Change one
   variable at a time and stop escalating once the edge/cut quality is unsuitable.
   The complete grid and individual cell files are alternative layouts.
4. At the winning setting, cut K1–K3 with ZERO kerf compensation. Keep plugs and
   holes paired. On the SAME FACE measure plug X, hole X, plug Y, hole Y away
   from corners. Kerf = (hole - plug)/2 in each axis. The mean of hole and plug
   gives the path centre-line size, expected 20 mm. Repeat on the back for taper.
5. Cut the fit comb with ZERO compensation. Insert the mating strip edge-on;
   its uncut broad faces define thickness. Nominal 3/6 mm can differ. If no slot
   gives a useful fit, regenerate around the measured thickness. Fit clearance
   and laser kerf are separate values.
6. Cut V1 with the measured kerf applied ONCE by the planner: outside outwards,
   holes inwards, each by half the kerf. Check the 50 x 30 mm outside, 10 mm round
   hole and 10 x 10 mm square hole. Repeat a small coupon at representative bed
   positions after the usable bed is known. Do not enable production approval
   until a fresh compensated validation cut and the actual controller agree.

PHOTOS / RESULTS TO RETURN
For each material identify P3, P6, M3 or M6, the run date and file/test ID. Send:
- A straight-on front photo of the whole trial area with IDs visible.
- A back photo in the same orientation, and close-ups of an edge and corners.
- Which coupons separated cleanly without pushing; scorch/char and any flare-up.
- Calliper readings (or clear photos of the display) for actual thickness at
  three points, K1–K3 plug/hole X/Y, and the final validation dimensions.
- A fit-comb photo with chosen slot and snug/sliding/loose description.
- Exact speed in mm/s, min/max power %, passes, lens, focus, air assist and any
  controller pulse/frequency settings; material supplier and batch.
Photographs show quality but cannot establish sub-millimetre kerf or prove full
cut-through on their own. Keep tested settings tied to this machine and batch.

Operate enclosed and supervised with the machine's extraction, air assist and
cooling procedures. Use laser-suitable stock; stop for sustained flame. Follow
the supplier's rated tube/current limit rather than assuming 100% is acceptable.
This pack does not change machine configuration, home axes or start the laser.

References:
https://www.troteclaser.com/en-gb/helpcenter/materials/laser-parameter/laser-parameter-basics-settings
https://support.epiloglaser.com/material-settings/
`
const style = `body{font:15px/1.55 system-ui;color:#1d2939;background:#f5f6fa;margin:0}main{max-width:1100px;margin:auto;padding:36px}h1{font-size:34px;letter-spacing:-1px}h2{font-size:23px}p{max-width:85ch}.notice{padding:18px;border-left:4px solid #c76e46;background:#fff0e7}.card{background:white;padding:24px;margin:24px 0;border:1px solid #d9dfe8;border-radius:12px;break-inside:avoid}.previews{display:grid;grid-template-columns:1fr 1fr;gap:16px}.previews img{width:100%;max-height:300px;object-fit:contain;border:1px solid #eee}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #ddd}a{color:#945131}code{background:#f3f3f3;padding:2px 5px}li{margin:7px 0}.write{height:28px}.badge{font:12px monospace;background:#e9edf5;padding:5px}small{color:#566274}@media(max-width:700px){main{padding:16px}.previews{grid-template-columns:1fr}}@media print{body{background:white}main{padding:0}.card{border:0;border-top:1px solid #aaa;border-radius:0;padding:12px 0}a{color:inherit}.no-print{display:none}h1{font-size:26px}}`
const head = title => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${style}</style></head><body><main>`
const all = [['START-HERE.txt', instructions]]
mkdirSync(root, { recursive: true })
for (const material of calibrationMaterials) {
  const tests = calibrationTests(material), files = []
  for (const test of tests) {
    files.push([test.id + '.svg', calibrationSvg(test)], [test.id + '.dxf', calibrationDxf(test)])
    if (!test.id.startsWith('03-cell-')) files.push([test.id + '-preview.svg', calibrationSvg(test).replace('Geometry only.', 'Visual reference only; use the separate cut drawing.').replaceAll('stroke-width="0.05"', 'stroke-width="0.4"')])
  }
  const results = {
    schema: 'laser-calibration-results/v1', packVersion: calibrationVersion, materialId: material.id, label: material.code,
    status: 'not-run', machine: { makeModel: '', controllerModelFirmware: '', tubeRatedWatts: null, bedWidthMm: null, bedHeightMm: null, lens: '', focusProcedure: '', focusOffsetMm: null, originAndOrientation: '', supplierPowerCurrentLimit: '', controllerFrequencyOrPulseSettings: '' },
    stock: { supplier: '', batch: '', nominalThicknessMm: material.thickness, measuredThicknessMm: [null, null, null] },
    markingSettings: { speedMmS: null, minPowerPercent: null, maxPowerPercent: null, passes: null, airAssist: null },
    trials: ['P1', ...tests.find(t => t.id === '03-cut-matrix').cells.map(c => c.id)].map(id => ({ id, date: '', speedMmS: null, minPowerPercent: null, maxPowerPercent: null, passes: null, focusOffsetMm: null, airAssist: null, cutThroughWithoutForce: null, edgeChar: '', cornerQuality: '', underside: '', notes: '', photoFiles: [] })),
    winningTrial: '', kerfCompensationDuringMeasurementMm: 0,
    kerfMeasurements: ['K1', 'K2', 'K3'].map(id => ({ id, face: 'top', plugX: null, holeX: null, plugY: null, holeY: null, photoFiles: [] })),
    fit: { drawnSlotWidthsMm: tests.find(t => t.id === '05-fit-comb').slotWidths, chosenSlot: null, feel: '', photoFiles: [] },
    validation: { appliedKerfMm: null, outerX: null, outerY: null, roundHoleX: null, roundHoleY: null, squareHoleX: null, squareHoleY: null, notes: '', photoFiles: [] },
    profileApproved: false,
  }
  files.push(['results-template.json', json(results)], ['START-HERE.txt', instructions])
  const hashes = Object.fromEntries(files.map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')]))
  const packId = `${material.code}-v1-${createHash('sha256').update(json(hashes)).digest('hex').slice(0, 10)}`
  const manifest = { schema: calibrationVersion, packId, material, units: 'mm', machineRunnable: false, controllerSettings: null, stockRectangleIsNotCut: true, tests: tests.map(({ paths, ...test }) => ({ ...test, paths, compensation: test.id === '06-validation' ? 'Apply measured kerf once when preparing the later validation job; geometry has no offset' : 'none', cutSettings: null, scoreSettings: null })), hashes }
  files.push(['manifest.json', json(manifest)])
  let html = head(`${material.name} — calibration`)
  html += `<a class="no-print" href="../index.html">All materials</a><p class="badge">${packId}</p><h1>${escape(material.name)} · initial cut tests</h1><p class="notice"><strong>Geometry prepared · machine settings pending.</strong> SVG/DXF files have millimetre paths and vector labels, but no power/speed settings. They are not runnable DSP files. Confirm the controller, wattage and supplier limits before preparing a machine job.</p><p><a href="../${material.id}.zip">Download this material pack</a> · <a href="START-HERE.txt">Full procedure and photo checklist</a> · <a href="results-template.json">Results template</a></p><p>Red = cut. Blue = score. Labels carry <strong>${material.code}</strong>. Keep a separate marking setting; score labels before cutting. All drawings use 100% scale. Preview edges are not cut borders.</p>`
  for (const test of tests.filter(t => !t.id.startsWith('03-cell-'))) {
    html += `<section class="card"><h2>${escape(test.title)}</h2><p>${escape(test.instructions)}</p><div class="previews"><img src="${test.id}.svg" alt="${escape(test.title)}"><div><p><strong>Suggested stock area: ${test.width} × ${test.height} mm</strong></p><ul>${test.measurements.map(m => `<li>${escape(m)}</li>`).join('')}</ul><p><a href="${test.id}.svg">SVG drawing</a> · <a href="${test.id}.dxf">DXF drawing</a></p></div></div>${test.slotWidths ? `<table><tr><th>Slot</th>${test.slotWidths.map((_, i) => `<th>${i + 1}</th>`).join('')}</tr><tr><th>Drawn mm</th>${test.slotWidths.map(w => `<td>${w.toFixed(2)}</td>`).join('')}</tr></table>` : ''}</section>`
  }
  html += `<section class="card"><h2>Trial record — ${material.code}</h2><p>Columns 1 / 2 / 3 = fast / middle / slow. Rows A / B / C = low / middle / high power. Values are unset until reviewed for this machine. Initial individual trials use fresh offcuts.</p><table><thead><tr><th>ID / file</th><th>Speed mm/s</th><th>Min / max %</th><th>Passes</th><th>Cut-through / char / photo</th></tr></thead><tbody>${results.trials.map(r => `<tr class="write"><td>${r.id === 'P1' ? 'P1 pilot' : `<a href="03-cell-${r.id}.svg">${r.id} SVG</a> / <a href="03-cell-${r.id}.dxf">DXF</a>`}</td><td></td><td></td><td></td><td></td></tr>`).join('')}</tbody></table><p>Stock thickness (three points): ______ / ______ / ______ mm · Supplier / batch: __________________</p><p>Lens / focus / air assist / pulse settings: ___________________________________________________</p><table><tr><th>Pair</th><th>Plug X</th><th>Hole X</th><th>Plug Y</th><th>Hole Y</th></tr>${['K1', 'K2', 'K3'].map(id => `<tr class="write"><td>${id}</td><td></td><td></td><td></td><td></td></tr>`).join('')}</table><p>Measure the same face. Kerf = (hole − plug) / 2. Use the app’s <strong>Calibration tests</strong> calculator to check repeatability. Photos alone cannot measure kerf accurately.</p><p>Chosen fit slot / feel: ___________________ · Winning trial: __________ · Final validation dimensions: ___________________</p></section></main></body></html>`
  // Preview strokes are thicker for legibility; downloadable cut geometry stays unchanged.
  for (const test of tests) html = html.replace(`src="${test.id}.svg"`, `src="${test.id}-preview.svg"`)
  // Each material archive is self-contained when extracted on its own.
  html = html.replace('<a class="no-print" href="../index.html">All materials</a>', '').replace(`<a href="../${material.id}.zip">Download this material pack</a> · `, '')
  files.push(['index.html', html])
  const directory = join(root, material.id); mkdirSync(directory, { recursive: true })
  for (const [name, content] of files) { writeFileSync(join(directory, name), content); all.push([`${material.id}/${name}`, content]) }
  const materialArchive = calibrationZip(files)
  writeFileSync(join(root, material.id + '.zip'), materialArchive)
  all.push([material.id + '.zip', materialArchive])
}
const index = head('Laser Marketplace — initial calibration pack') + `<p class="badge">${calibrationVersion}</p><h1>Find the settings. Measure the cut.</h1><p class="notice"><strong>Initial geometry pack — machine details required.</strong> No runnable controller files or guessed cutting presets are included. We need the controller model, tube wattage, usable bed and supplier starting settings to prepare the machine-specific trials.</p><p>Six staged tests for each of the four materials, nine individual matrix coupons, vector labels, SVG + DXF, measurement sheets and a results template.</p><p><a href="initial-calibration-pack.zip">Download all four material packs</a> · <a href="START-HERE.txt">Read the procedure</a></p>${calibrationMaterials.map(m => `<section class="card"><h2>${escape(m.name)} <span class="badge">${m.code}</span></h2><p><a href="${m.id}/index.html">Preview tests & measurement sheet</a> · <a href="${m.id}.zip">Download ${m.code} pack</a></p></section>`).join('')}<section class="card"><h2>What to send back</h2><p>Front and back photos with test IDs visible; close-ups of the cut edges; which pieces dropped free; actual material thickness and the paired plug/hole calliper readings; chosen fit slot; exact settings used. Keep each material and test run separate.</p><p>We can then choose a candidate cut setting, calculate kerf, prepare a compensated validation cut and update the appropriate material profile after that result is checked.</p></section></main></body></html>`
writeFileSync(join(root, 'index.html'), index); writeFileSync(join(root, 'START-HERE.txt'), instructions)
const offlineIndex = index.replace('<a href="initial-calibration-pack.zip">Download all four material packs</a> · ', '')
all.push(['index.html', offlineIndex]); writeFileSync(join(root, 'initial-calibration-pack.zip'), calibrationZip(all))
console.log(`Generated calibration drawings and records for ${calibrationMaterials.length} materials in ${root}. No machine-executable files generated.`)
