# Laser Marketplace

An independent fork of `cnc-marketplace`, created for developing laser cut file generation and a reusable design catalogue.

## Current status

This is the starting fork, including the source project's current uncommitted work. The inherited catalogue, DXF reader, sheet nesting, previews, and CNC generator are preserved. **Laser-specific file generation has not been implemented yet:** the existing generator and jobs API still produce CNC router G-code, not laser programs.

The laser workflow can build on the existing geometry and nesting code to produce dimensioned SVG/DXF cut files, separate cut and engraving operations, and add kerf compensation. Controller-specific laser G-code will need its own output implementation and machine settings.

## Run locally

Use Node.js 22.12 or newer.

```bash
cd /Users/danmerron/Desktop/work/laser-marketplace
npm ci
cp .env.example .env.local
npm run dev
```

Open the Vite URL with `/laser-marketplace/`, normally `http://localhost:5173/laser-marketplace/`.

Configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env.local` with a dedicated Supabase project before using the inherited catalogue. There is no fallback to the CNC project's backend, and the original project's environment file is not copied. Without configuration the app displays a setup notice.

## Fork independence

- This folder is a separate Git repository with the original history and its own working files and dependencies.
- No GitHub repository has been created or published. The original repository is available only as the `upstream` remote, with pushing disabled.
- App branding, package name, Vite base path, Supabase project ID, authentication storage, and project backup storage use the Laser Marketplace identity.
- Numbered duplicate files from the source workspace are preserved under `archive/inherited-duplicates/` and excluded from executable source.
- Deployment workflows are manual. Configure the fork's own `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_URL`, and frontend environment variables before deploying.
- The inherited API retains its `cnc-api` function name and CNC request contracts until the laser API is implemented. See [API documentation](docs/API.md) and [inherited CNC documentation](docs/CNC_BASELINE.md).

## Check the project

```bash
npm test
npm run lint
npm run build
npm run build:api
```
