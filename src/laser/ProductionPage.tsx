import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShoppingBag } from 'lucide-react'
import { workshopApi as api } from './client'
import type { ProductionView, ShopifyStatus } from './productionTypes'
import type { QueueJob } from './model'
import SheetPreview from './SheetPreview'
import DeadSpaceEditor from './DeadSpaceEditor'
import { layoutSheets } from './deadSpace'

interface Props { online: boolean; busy: boolean; run: (action: () => Promise<void>) => Promise<void>; onReleased: (job: QueueJob) => Promise<void>; onOpenJob: (id: string) => Promise<void>; onSaveCatalogue: () => Promise<void> }
export default function ProductionPage({ online, busy, run, onReleased, onOpenJob, onSaveCatalogue }: Props) {
  const [view, setView] = useState<ProductionView | null>(null), [status, setStatus] = useState<ShopifyStatus | null>(null), [loadError, setLoadError] = useState('')
  const [sheetChoices, setSheetChoices] = useState<Record<string, number>>({}), [cancelNotes, setCancelNotes] = useState<Record<string, string>>({})
  const reload = useCallback(async () => { const [nextView, nextStatus] = await Promise.all([api<ProductionView>('production'), api<ShopifyStatus>('shopify/status')]); setView(nextView); setStatus(nextStatus); setLoadError('') }, [])
  useEffect(() => {
    if (!online) return
    let alive = true
    const refresh = async () => { try { const [nextView, nextStatus] = await Promise.all([api<ProductionView>('production'), api<ShopifyStatus>('shopify/status')]); if (alive) { setView(nextView); setStatus(nextStatus); setLoadError('') } } catch (e) { if (alive) setLoadError(e instanceof Error ? e.message : 'Cannot load production beds') } }
    void refresh(); const interval = setInterval(refresh, 8000)
    return () => { alive = false; clearInterval(interval) }
  }, [online])
  return <>
    <div className="laser-title"><div><span className="laser-eyebrow">SHOPIFY / PRODUCTION BEDS</span><h1>Orders become production beds.</h1><p>Matching SKUs are nested automatically, with a separate batch for each material and thickness.</p></div><button disabled={!online || busy} onClick={() => void run(async () => { await onSaveCatalogue(); await reload() })}>Save catalogue to workshop</button></div>
    {!online && <div className="laser-notice">Start the workshop service to connect Shopify and prepare production beds.</div>}
    {loadError && <div role="alert" className="laser-notice error">{loadError}</div>}
    <section className="laser-card laser-shopify-connection"><div className="laser-title"><div><h2><ShoppingBag size={19}/> Shopify <span className={'laser-badge ' + (status?.lastSuccess && !status.error ? 'approved' : '')}>{!status?.configured ? 'Setup required' : status.error ? 'Needs attention' : status.syncing ? 'Syncing' : status.lastSuccess ? 'Connected' : 'Ready to connect'}</span></h2><p>{status?.shop ?? 'No store connected to this workshop'}</p></div><button disabled={!online || !status?.configured || busy || status.syncing} onClick={() => void run(async () => { await api('shopify/sync', 'POST', {}); await reload() })}><RefreshCw size={15}/>Sync now</button></div>
      {status?.configured ? <><label className="laser-check"><input type="checkbox" checked={status.enabled} disabled={busy} onChange={e => { const enabled = e.target.checked; void run(async () => { setStatus(await api<ShopifyStatus>('shopify/automation', 'PUT', { enabled })) }) }}/>Automatically check Shopify every {status.pollSeconds} seconds</label><p className="laser-muted">Last successful sync: {status.lastSuccess ? new Date(status.lastSuccess).toLocaleString() : 'Not yet synced'}. Paid, unfulfilled orders only; test orders are excluded.</p></> : <div className="laser-notice"><strong>Connect your store on the workshop computer</strong><p>Add the store’s myshopify.com address and read-orders app credentials to <code>.env.workshop</code>, then restart the workshop service. Credentials stay on that computer.</p><p>Assign a material to each matching SKU and save the approved catalogue here. Incoming orders will then appear automatically.</p></div>}
      {status?.error && <div role="alert" className="laser-notice error">{status.error}</div>}
    </section>
    <div className="laser-production-summary"><strong>{view?.batches.reduce((n, b) => n + b.plan.sheets.length, 0) ?? 0} draft beds</strong><span>{view?.orders.filter(o => o.status === 'on_bed').length ?? 0} orders on beds</span><span>{view?.orders.filter(o => o.status === 'held').length ?? 0} orders held for review</span></div>
    {!view?.batches.length && <div className="laser-empty"><h2>No draft beds waiting</h2><p>Approved SKU matches will arrive here automatically. Orders with missing drawings, material assignments or cutting settings appear in the review list below.</p></div>}
    {view?.batches.map(batch => {
      const layoutKey = `${batch.materialId}-${batch.layoutSlot}`
      const sheets = layoutSheets(batch.plan), sheet = sheets.find(s => s.number === sheetChoices[layoutKey]) ?? sheets[0]
      return <section className="laser-card laser-production-batch" key={batch.id}><div className="laser-title"><div><span className="laser-eyebrow">DRAFT · FILLS AUTOMATICALLY</span><h2>{batch.materialName}</h2><p>{batch.componentCount} components · {batch.plan.sheets.length} beds · {batch.orderNames.join(', ')}</p></div><button className="primary" disabled={busy || !status?.configured || status.syncing} onClick={() => void run(async () => { const job = await api<QueueJob>(`production/batches/${batch.id}/release`, 'POST', {}); await onReleased(job); await reload() })}>Release {batch.plan.sheets.length === 1 ? 'bed' : `${batch.plan.sheets.length} beds`} to queue</button></div>
        <div className="laser-toolbar"><label className="laser-field"><span>Production bed</span><select value={sheet.number} onChange={e => setSheetChoices(v => ({ ...v, [layoutKey]: Number(e.target.value) }))}>{sheets.map(s => <option key={s.number} value={s.number}>Bed {s.number} · {s.placements.length ? `${s.placements.length} components` : 'unused — no cutting file'}</option>)}</select></label><span>{sheet.width} × {sheet.height} mm · {batch.thickness} mm stock</span></div><SheetPreview sheet={sheet} machine={batch.plan.request.machine}/>
        <DeadSpaceEditor key={`${batch.id}-${sheet.number}`} sheet={sheet} spacing={batch.plan.request.material.spacing} busy={busy || !!status?.syncing} onChange={async zones => {
          let failure: unknown
          await run(async () => {
            try {
              const next = await api<ProductionView>(`production/batches/${batch.id}/sheets/${sheet.number}/dead-spaces`, 'PUT', { zones })
              setSheetChoices(v => ({ ...v, [layoutKey]: sheet.number }))
              setView(next)
            } catch (e) { failure = e; throw e }
          })
          if (failure) throw failure
        }}/>
        <p className="laser-muted">New orders can fill these draft beds while keeping their dead spaces. Release freezes this batch and its files; no laser motion is started.</p>
      </section>
    })}
    <section className="laser-card laser-order-inbox"><h2>Shopify order tracking</h2>{!view?.orders.length ? <p className="laser-muted">No orders have been synced yet.</p> : view.orders.map(order => <article key={order.key} className="laser-order-record"><div className="laser-toolbar"><strong>{order.name}</strong><span className={'laser-badge ' + (['on_bed', 'released'].includes(order.status) ? 'approved' : '')}>{order.status.replaceAll('_', ' ')}</span><span>{order.shop}</span></div><p>{order.lines.map(l => `${l.sku || 'Missing SKU'} × ${l.quantity}${l.allocated ? ` (${l.allocated} released)` : ''}`).join(' · ')}</p>{order.issues.map(issue => <p key={issue} className="laser-muted">{issue}</p>)}
      <div className="laser-downloads">{order.jobIds.map(id => <button key={id} onClick={() => void run(() => onOpenJob(id))}>View job {id.slice(0, 8)}</button>)}</div>
      {order.status === 'held' && order.jobIds.length > 0 && <details><summary>Resolve an unstarted batch</summary><p>Cancel only if the batch has never been staged or started. Other orders sharing that batch return to draft beds automatically.</p><label className="laser-field"><span>Review note for {order.name}</span><input value={cancelNotes[order.key] ?? ''} onChange={e => setCancelNotes(n => ({ ...n, [order.key]: e.target.value }))}/></label><div className="laser-downloads">{order.jobIds.map(id => <button key={id} disabled={busy || !cancelNotes[order.key]?.trim()} onClick={() => void run(async () => { await api(`production/jobs/${id}/cancel`, 'POST', { note: cancelNotes[order.key] }); await reload() })}>Cancel unstarted {id.slice(0, 8)} & replan</button>)}</div></details>}
    </article>)}</section>
  </>
}
