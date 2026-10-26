# Shopify orders to production beds

The workshop polls Shopify every 60 seconds while it is running. Paid, open orders with unfulfilled quantities are matched to the saved design catalogue by exact variant SKU, then nested onto draft beds grouped by material profile. Orders can share a bed; a mixed-material order appears in separate material batches. No LightBurn step is involved.

## Prepare the catalogue once

1. Under **Machine & material**, configure the bed and the four profiles: plywood 3 mm, plywood 6 mm, MDF 3 mm and MDF 6 mm. Set usable stock dimensions, spacing and grain restrictions. Calibrate kerf and cut/score settings on the actual machine, then approve the relevant profiles. The supplied values are unapproved examples.
2. Under **Design library**, import each SVG/DXF, enter the Shopify variant SKU, assign its material, check the geometry and approve the revision. Matching is case-sensitive, with surrounding SKU whitespace trimmed. Each SKU currently represents one component; bundles/BOMs are not expanded.
3. Click **Save catalogue to workshop**. Browser edits do not affect automation until saved. Material edits invalidate that profile's approval; machine edits invalidate every material profile. Released jobs retain their original snapshots.

An existing single-material workspace migrates to the material library, preserving its original profile, settings and SKU assignments. Reassign those SKUs to the appropriate plywood/MDF profiles when ready.

## Connect the store

Use an installed Shopify Admin API app with `read_orders` access. No product-write, order-write or fulfilment-write permission is required. The connector uses GraphQL Admin API **2026-10** and only reads production-relevant order fields; it does not request customer names, addresses or email.

Copy `.env.workshop.example` to `.env.workshop` on the workshop computer and fill in:

```dotenv
LASER_SHOPIFY_SHOP=your-store.myshopify.com
LASER_SHOPIFY_CLIENT_ID=your-app-client-id
LASER_SHOPIFY_CLIENT_SECRET=your-app-client-secret
LASER_SHOPIFY_POLL_SECONDS=60
```

Client credentials are suitable when the app and store belong to the same Shopify organization. The app must be installed on that store; the workshop obtains and refreshes its expiring access token. Shopify documents this flow in its [client credentials guide](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant).

Alternatively, provide an already issued Admin API access token in `LASER_SHOPIFY_ACCESS_TOKEN` and omit the client ID/secret. An explicit token takes precedence and must be replaced when it expires. This integration does not implement a merchant OAuth installation flow for unrelated organizations. Keep credentials in `.env.workshop`, which is gitignored; never put them in a `VITE_` variable or a browser form. See Shopify's [credential guidance](https://shopify.dev/docs/apps/build/authentication-authorization/manage-credentials).

Restart with Node 22.12+:

```bash
npm run build
npm run workshop
```

Open **Shopify production**. The first sync starts automatically; **Sync now** is also available. The page shows connection status, last successful sync, polling control and errors. There is no public webhook URL to configure. The workshop computer needs to stay running with internet access; closed browsers do not stop background polling. Failures retry with increasing delay, up to 15 minutes.

**First sync includes existing eligible orders**, not just orders placed after setup. Check that already-produced but unfulfilled orders are correctly fulfilled/closed in Shopify before connecting. Default order access covers the last 60 days; older orders require Shopify-approved `read_all_orders` access in addition to the order scope. See Shopify's [Order access restrictions](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order).

## Daily workflow

1. A paid, open, non-test Shopify order arrives with unfulfilled quantities.
2. The next sync matches its SKUs and approved materials, then fills draft beds. Quantities use the lower of current and unfulfilled quantity, excluding removed/refunded or already-fulfilled units. Pagination is followed for orders and line items.
3. New orders join compatible draft beds. Review the preview and click **Release bed to queue** when ready. Release rechecks Shopify, freezes the current layout and files, and records allocations. A batch with several beds releases all its beds together. Repeated syncs, repeated release requests and ordinary process restarts do not duplicate allocations.
4. Load the specified material and follow the queue's stage/start/finish/inspection flow. No release action starts a laser. Live controller upload remains uncommissioned; the current lifecycle is simulated, with experimental Ruida files available for qualification.
5. Inspect parts and prepare replacements for rejects as needed. Packing and Shopify fulfilment remain manual; the connector does not change order or fulfilment status.

The app currently holds an entire order if any pending line has no matching SKU, no assigned material, an unapproved revision/profile, invalid geometry or an unsupported quantity. Other complete orders continue to fill beds. Correct the catalogue and save it to retry held orders automatically. The on-screen reason identifies the affected line.

Drafts are bounded to 5,000 components and 500,000 expanded vertices at a time; each immutable batch is capped at 500 components, 100 line entries, 50,000 source points and 250,000 expanded vertices. Large line quantities split across entries/batches. Orders beyond capacity are held until earlier batches are released or the order is split.

## Order changes and recovery

Unreleased beds rebuild when Shopify quantities or eligibility change. Released files never change: changed/cancelled/refunded/unverifiable orders put their jobs and replacement descendants on hold. The connector also rereads tracked orders that leave the paid/open search, so a cancellation does not silently disappear.

For a batch that has **never been staged or started**, enter a review note and choose **Cancel unstarted & replan**. Its allocations are released; other valid orders sharing that batch return to draft beds. A batch that has been staged, started or has an uncertain transfer requires manual reconciliation of actual work. The app does not silently regenerate it, clear that hold, or stop a running physical machine.

Shopify is rechecked before staging or recording a start for a tracked job, including replacement jobs. If verification fails, those transitions remain blocked. Finish and inspection records can still be entered offline. Pausing automatic polling does not disable these explicit verification checks or manual sync.

Back up the complete `.workshop/` directory, especially `production.json` together with its job directories. Deleting the allocation ledger can cause previously produced but still-unfulfilled Shopify orders to appear new. Credentials are separate in `.env.workshop`. This is a local, single-process production prototype; Shopify requests and local file updates are not one cross-system transaction, so last-moment changes still require operator awareness.

API behavior is covered by simulated Shopify responses and local end-to-end tests. Actual store authentication, granted scopes and its first imported order still need verification after connection. Source field definitions: [LineItem](https://shopify.dev/docs/api/admin-graphql/latest/objects/LineItem), [orders query](https://shopify.dev/docs/api/admin-graphql/latest/queries/orders).
