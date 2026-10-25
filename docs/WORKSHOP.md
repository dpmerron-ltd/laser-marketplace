# Local workshop service

Run `npm run build` followed by `npm run workshop` with Node 22.12+. The built app and API are served at `http://127.0.0.1:4318`. The service binds to `127.0.0.1` only. `LASER_WORKSHOP_PORT` and `LASER_WORKSHOP_DATA` optionally override the port and storage directory. Vite's development proxy targets 4318 by default; update that proxy if using a different port.

One process owns a data directory. A PID lock prevents competing processes; stale locks from a dead process are reclaimed. Jobs are assembled in a temporary directory then renamed into place. Their artifact files are immutable through the API, while state updates use atomic replacement. A service restart changes in-progress transfers/runs to `needs_reconciliation`. Corrupt artifacts are rejected rather than regenerated in place.

The server requires the `X-Laser-Client: laser-marketplace` header for every API request, validates Host and Origin, rejects cross-site browser requests, and provides no CORS permission. This is a single-user local service; the header is a CSRF boundary, not a user authentication credential. Do not expose it through port forwarding or a public reverse proxy. A future remote connector needs its own authenticated API and outward polling agent.

## Order intake

In Workshop queue, click **Save catalogue to workshop** to save the current machine, material and design revisions. All designs and the active material must be approved to prepare an order. An SKU identifies one vector component in this first version. Multiple line items may carry different order references and are nested together on the configured stock. Multi-component product BOMs and mixed-material grouping are future additions.

```bash
curl http://127.0.0.1:4318/workshop-api/orders \
  -H 'X-Laser-Client: laser-marketplace' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-1042' \
  --data '{"reference":"ORDER-1042","lines":[{"sku":"TAG-60-1","quantity":12}]}'
```

This resolves the saved SKU revision, checks approval/settings/geometry, nests the quantity, emits and validates all controller files, freezes the snapshots and adds the job as `ready`. It does not stage or run hardware. The same key and same resolved snapshot return the original job. Reusing a key with changed input or a changed catalogue snapshot is rejected for review instead of creating a duplicate. Use a new key for a genuinely new production request.

`POST /workshop-api/jobs` accepts a complete `JobRequest` (see `src/laser/model.ts`) when an integration already has the approved snapshots. Both endpoints require an idempotency key containing 1–120 letters, digits, underscores or hyphens. Incoming requests are capped at 8 MB, batches at 500 components, and geometry expansion at 250,000 vertices. The planner recomputes geometry on the service; it does not accept client-supplied machine bytes or placements.

## Endpoints

Every route below is relative to `/workshop-api/`. Mutation bodies are JSON.

| Method / route | Result |
| --- | --- |
| `GET health` | Local service and disabled live-upload status |
| `GET/PUT workspace` | Load/save catalogue and active profiles |
| `POST orders` | Resolve SKU quantities and prepare an immutable job |
| `POST jobs` | Prepare a complete snapshot request |
| `GET jobs` | Persistent queue and inspection quantities |
| `GET jobs/:id` | One job, sheet states and audit history |
| `GET jobs/:id/plan` | Verified original neutral plan |
| `GET jobs/:id/manifest` | Encoder version and SHA-256 file hashes |
| `GET jobs/:id/artifacts/:filename` | Original verified artifact bytes |
| `POST jobs/:id/sheets/:number/actions` | Explicit sheet state transition |
| `POST jobs/:id/replacements` | Idempotently prepare rejected quantities after inspection |

Action bodies use `action` and an operator `note` where required:

- `stage`: available for simulation only; checks every artifact and persists the transfer outcome.
- `record-start`: staged → running. Records an operator observation; it sends no start command.
- `record-finish`: running → awaiting_inspection. Does not credit any parts.
- `inspect`: requires `accepted` and `rejected` instance-ID arrays accounting for every component exactly once, then marks inspection complete. Counts are available in the queue response; no fulfilment system is updated.
- `reconcile`: needs_reconciliation → explicit `resolution` of ready, staged or awaiting_inspection, with an explanatory note.

A completed sheet may include rejected components. `replacements` uses only the rejected quantities and the original approved snapshots; repeated calls return the same replacement job. Replacement jobs can themselves be inspected and replaced.

Native Ruida jobs stay ready for export and qualification. The app cannot claim a physical run occurred while no live integration exists. Simulation exercises the whole lifecycle explicitly as simulation.

## Storage and deployment

`.workshop/<job-id>/` contains a plan, native/simulation sheet files, source-layout and decoded previews, cutting list, printable label HTML, a hash manifest, and a separate status/audit file. Workspace and runtime data are gitignored. Keep backups of `.workshop/`; browser catalogue drafts need a separate workspace export or a saved workshop catalogue.

The filesystem provides atomic updates for ordinary process interruption. Power-loss durability and disk-level tamper resistance are not guarantees of this prototype. Unknown/corrupt state blocks normal operation and needs operator recovery from backups. It is not a replicated database or a multi-user production service.
