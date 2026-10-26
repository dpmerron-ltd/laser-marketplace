# Laser Marketplace

A separate local fork of `cnc-marketplace` for generating laser cut files. The primary app now uses controller-independent vector geometry, with a local workshop queue. LightBurn is not required.

## Run

Use Node.js 22.12 or newer. No cloud account or Supabase configuration is needed for the laser workflow.

```bash
cd /Users/danmerron/Desktop/work/laser-marketplace
npm ci
npm run build
npm run workshop
```

Open **http://127.0.0.1:4318/laser-marketplace/**. The workshop binds only to the loopback interface. For development, run `npm run dev` in a second terminal and open `http://localhost:5173/laser-marketplace/`; Vite proxies workshop requests to port 4318.

## Use it

1. Import SVG/DXF or add the sample tag. Give each design its exact Shopify variant SKU and assign its material. Check dimensions, assign each path to cut, score or ignore, then approve the design revision.
2. Configure the machine and the four stock profiles: **3 mm plywood, 6 mm plywood, 3 mm MDF and 6 mm MDF**. Record measured kerf, speed, min/max power, passes, air assist, spacing and grain restrictions, then approve each calibrated material profile. Example settings are deliberately unapproved and are not production recommendations.
3. Save the catalogue to the workshop. Once [Shopify is connected](docs/SHOPIFY.md), paid, unfulfilled orders automatically fill draft beds by material and thickness. Review a draft and release it to freeze its files. You can also enter quantities manually. The planner applies kerf once, scores before cutting and cuts holes before outer contours. Inspect the planned and decoded controller previews.
4. Download per-sheet files, preview SVGs, the complete plan, cutting list and printable labels. Save the batch to the workshop queue for durable records.
5. In simulation, stage a sheet, record the operator start/finish, inspect components, and create a replacement batch for rejects. These actions do not move or fire any machine.

**Controller changes:** choose another adapter under Machine & material and approve the resulting profile revision. Designs and quantities stay usable. Existing jobs keep their original machine/profile snapshots, encoder version, artifact hashes and exact files. A new controller family requires an adapter, not a rewrite of the design or nesting workflow. See [controller integration](docs/CONTROLLERS.md).

## What works now

- Local design catalogue with SVG/DXF import, revisions, review status, workspace backup/restore and explicit units.
- **Calibration tests** page with downloadable SVG/DXF packs for all four materials: orientation, pilot, nine speed/power trial geometries, three kerf pairs, fit comb and final dimensional check. Includes photo/measurement instructions and a kerf calculator. These initial drawings have no machine-specific cutting presets; see [calibration workflow](docs/CALIBRATION.md).
- A material library with separate 3/6 mm plywood and MDF profiles, per-SKU material assignments and mixed-material order splitting. Existing single-profile workspaces migrate without losing their saved settings.
- Vector cut/score planning, contour validation, kerf compensation and rectangular sheet nesting with optional 90° rotation and grain locking.
- Simulation output and experimental native Ruida `.rd` export. Every sheet is decoded and compared against planned movements/settings before export.
- Persistent local jobs, SHA-256 artifact checks, idempotent order intake, per-machine transfer exclusion, audit history, restart reconciliation, inspection and replacement quantities.
- SKU order API using the catalogue saved from the app. See [workshop API](docs/WORKSHOP.md).
- Optional Shopify polling every 60 seconds, automatic nesting across compatible orders, persistent allocation records, duplicate prevention and review holds for missing SKUs or changes after release. See [Shopify setup and workflow](docs/SHOPIFY.md).

## Current limits

**No live controller connection is enabled.** Ruida output has passed offline round-trip and independent MeerK40t decoding checks; it has not been run on a physical controller. The exact model/firmware, axis orientation, file acceptance and upload-only transport still require commissioning. The transport boundary is implemented, with simulation available and uncommissioned hardware blocked.

The first version supports one machine with multiple material profiles, one vector component per SKU, vector cut/score and rectangular nesting. Raster engraving, shape nesting inside waste, tabs/bridges, QR selection, timed/automatic bed release, automatic Shopify fulfilment and live controller telemetry are not implemented. The local SKU API immediately freezes jobs per material; Shopify orders accumulate on draft beds until the operator releases them. No Shopify account is connected until local credentials are configured.

Browser drafts live in local storage; use **Back up workspace**. Workshop jobs, saved catalogue, Shopify order snapshots and allocation history live in `.workshop/` and survive normal service restarts. Back up this directory as a unit: losing allocation history can make old orders appear unproduced. Treat the local service as a single-user workshop tool, not an internet-facing API.

## Verification

```bash
npm test
npm run lint
npm run build
npm run build:workshop
npm run build:api
```

The optional independent Ruida decode procedure is in [CONTROLLERS.md](docs/CONTROLLERS.md). The longer target architecture and remaining phases are in [AUTOMATION.md](docs/AUTOMATION.md).

## Fork independence

This folder is its own Git repository with the original history. No GitHub repository has been created or published. The original repository is an `upstream` remote with pushing disabled; the original CNC workspace is unchanged. App/storage identifiers use the Laser Marketplace name. Deployment workflows remain manual.

The inherited CNC implementation remains in source for reference and its tests still run, but `src/main.tsx` opens the new laser app. The legacy Supabase `cnc-api` is not a laser endpoint. Its configuration and documentation are retained in [API.md](docs/API.md) and [CNC_BASELINE.md](docs/CNC_BASELINE.md). Original credentials were not copied into this fork.
