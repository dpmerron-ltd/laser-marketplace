import { useState } from 'react'
import { analyseKerf, calibrationMaterials, calibrationVersion, type KerfMeasurement } from './calibration'

const blank = () => Array.from({ length: 3 }, () => ({ plugX: '', holeX: '', plugY: '', holeY: '' }))
const fields = ['plugX', 'holeX', 'plugY', 'holeY'] as const
const captions = { plugX: 'Plug X', holeX: 'Hole X', plugY: 'Plug Y', holeY: 'Hole Y' }
export default function CalibrationPage() {
  const base = import.meta.env.BASE_URL + 'calibration/v1/'
  const [materialId, setMaterialId] = useState<string>(calibrationMaterials[0].id), [readings, setReadings] = useState(blank)
  const [result, setResult] = useState<ReturnType<typeof analyseKerf> | null>(null), [error, setError] = useState('')
  const samples = (): KerfMeasurement[] => readings.map(r => Object.fromEntries(fields.map(f => [f, r[f].trim() === '' ? NaN : Number(r[f])])) as unknown as KerfMeasurement)
  function calculate() { try { setResult(analyseKerf(samples())); setError('') } catch (e) { setResult(null); setError(e instanceof Error ? e.message : 'Check measurements') } }
  function save() {
    if (!result) return
    const blob = new Blob([JSON.stringify({ schema: 'laser-kerf-observations/v1', packVersion: calibrationVersion, materialId, face: 'top', compensationDuringMeasurementMm: 0, samples: samples(), analysis: result, profileApproved: false }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = `${materialId}-kerf-readings.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <>
    <div className="laser-title"><div><span className="laser-eyebrow">CALIBRATION / FIRST CUTS</span><h1>Measure before production.</h1><p>Labelled trials for 3 mm and 6 mm plywood and MDF, followed by a compensated validation cut.</p></div><a className="laser-button primary" href={base + 'initial-calibration-pack.zip'} download>Download all test drawings</a></div>
    <div className="laser-notice"><strong>Drawings prepared · machine settings still required</strong><p>These SVG/DXF files contain geometry and labels, with no power/speed presets. Confirm the laser model, controller, tube wattage, bed and supplier starting settings before generating runnable controller files. No LightBurn step is required.</p></div>
    <div className="laser-material-library">{calibrationMaterials.map(m => <section className="laser-card" key={m.id}><span className="laser-eyebrow">{m.code}</span><h2>{m.name}</h2><p>Orientation, pilot cut, nine trials, kerf, slot fit and final dimensions.</p><p><a href={base + m.id + '/index.html'} target="_blank" rel="noreferrer">Preview & measurement sheet</a></p><a className="laser-button" href={base + m.id + '.zip'} download>Download {m.code} pack</a></section>)}</div>
    <section className="laser-card"><h2>Run in stages</h2><ol><li>Confirm origin, scale and focus using the machine supplier’s procedure.</li><li>Start with one pilot, then individual speed/power trials on fresh stock.</li><li>At the chosen setting, cut K1–K3 with <strong>zero kerf compensation</strong>. Measure each plug and its hole.</li><li>Check slot fit against actual sheet thickness, then cut V1 with measured kerf applied once.</li></ol><p>Send front/back photos with IDs visible, edge close-ups, which pieces separated without force, exact settings and calliper readings. Photos help assess quality; measurements determine kerf.</p><a href={base + 'START-HERE.txt'} target="_blank" rel="noreferrer">Full procedure and photo checklist</a></section>
    <section className="laser-card"><h2>Kerf from three plug / hole pairs</h2><p>Measure the <strong>same top face</strong> of each 20 mm pair, away from corners. Use millimetres. This calculator only analyses observations; it does not approve or change a production profile.</p>
      <label className="laser-field"><span>Test material</span><select value={materialId} onChange={e => { setMaterialId(e.target.value); setReadings(blank()); setResult(null); setError('') }}>{calibrationMaterials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <div className="laser-calibration-table"><table><thead><tr><th>Pair</th>{fields.map(f => <th key={f}>{captions[f]} mm</th>)}</tr></thead><tbody>{readings.map((r, i) => <tr key={i}><th>K{i + 1}</th>{fields.map(f => <td key={f}><input type="number" step="0.01" min="18" max="22" aria-label={`K${i + 1} ${captions[f]}`} value={r[f]} onChange={e => { const value = e.target.value; setReadings(old => old.map((v, j) => i === j ? { ...v, [f]: value } : v)); setResult(null); setError('') }}/></td>)}</tr>)}</tbody></table></div>
      <p>Kerf = (hole − plug) ÷ 2. Centre-line size = (hole + plug) ÷ 2.</p><button onClick={calculate}>Calculate measured kerf</button>
      {error && <p role="alert" className="laser-notice error">{error}</p>}
      {result && <div className="laser-notice"><h3>Candidate kerf: {result.kerfMm.toFixed(3)} mm</h3><p>X: {result.kerfX.toFixed(3)} mm · Y: {result.kerfY.toFixed(3)} mm. Median centre-line size: {result.centreX.toFixed(3)} × {result.centreY.toFixed(3)} mm (nominal 20 × 20).</p>{result.warnings.map(w => <p key={w}>{w}</p>)}<p>Review thresholds: 0.05 mm kerf variation and 0.1 mm centre-line error. These flag measurements for investigation, not machine acceptance tolerances. Validate with a fresh compensated cut before approving settings.</p><button onClick={save}>Download measurements for review</button></div>}
    </section>
  </>
}
