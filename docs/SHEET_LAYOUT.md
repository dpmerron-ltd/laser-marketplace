# Sheet dead space

Dead spaces are rectangular areas of a particular physical sheet that cannot contain parts, such as a defect or a previous cutout. They belong to the batch and sheet number, not to every sheet using that material profile.

## Use it

1. Prepare a manual batch, or open **Shopify production** and select a draft material batch.
2. Choose the sheet/bed that matches the stock you will load.
3. Under **Dead space**, enter a label, X/Y position and width/height in millimetres. X/Y locate the rectangle's top-left corner, measured from the stock's top-left corner before any controller mirroring.
4. Click **Add dead space & auto-nest**. The layout shows a hatched rectangle and rearranges the batch's parts around it. Use **Edit** or **Remove** to change an existing rectangle and nest again.
5. Review all resulting sheets before saving or releasing. Overflow moves onto additional sheets. If a numbered sheet cannot hold any components, it stays visible in the editor as unused, but receives no controller file or queue entry. Subsequent physical sheet numbers remain unchanged.

Use several rectangles for an irregular damaged area. Overlapping exclusions are allowed. Rectangles must have positive dimensions and fit entirely within the stock; the sheet margin still applies independently. Nesting uses compensated part bounds and keeps the material's path spacing between each part and each exclusion. Rotation and grain restrictions still apply.

Dead space excludes parts and laser-on paths. **Laser-off travel may cross it**; it is not a collision-avoidance feature for clamps or raised obstacles. Hatched rectangles and labels are preview overlays and never become controller cutting paths. The decoded view shows only the resulting toolpaths.

## Saving and automatic orders

Manual exclusions remain with the material batch while preparing quantities in the current browser session. Saving to the workshop freezes them into `plan.json` and the generated files. Unsaved manual batches, including their exclusions, are not included in the design-library workspace backup.

Shopify exclusions are saved immediately in `.workshop/production.json`. They stay with each pending material batch and numbered sheet while orders refill or rebuild its layout, including across service restarts. They represent pending physical stock, so order changes can change the parts occupying that stock. Releasing a batch consumes its pending layout; subsequent batches start with their own exclusions. Later pending batches keep their exclusions when an earlier batch is released. Catalogue changes that would remove a material or shrink its stock outside an existing exclusion are rejected until that exclusion is updated or removed.

Saved/released jobs are immutable: their original constraints, previews and controller files remain available. Replacement jobs use new stock and do not inherit defects from the original sheets. Cancelled unstarted jobs return their order quantities to production; check the chosen physical stock and mark any defects on the new drafts before release.

## API

Manual `POST /workshop-api/jobs` requests can include:

```json
{
  "sheetDeadSpaces": [
    {
      "sheetNumber": 1,
      "zones": [
        { "id": "old-cutout", "label": "Previous cutout", "x": 200, "y": 100, "width": 180, "height": 140 }
      ]
    }
  ]
}
```

The rest of the normal job request is unchanged. Existing requests without this optional property keep normal nesting behavior. Plans record each used sheet's `deadSpaces`, and skipped sheets' exclusions remain in the original request.

To replace one Shopify draft sheet's exclusions, use `PUT /workshop-api/production/batches/{batchId}/sheets/{sheetNumber}/dead-spaces` with `{ "zones": [...] }`. An empty array clears that sheet. The response is the updated production view. Edits change the batch ID; a stale edit or release is rejected, and edits cannot change released jobs. The service validates and compiles the revised plan before saving it.

Limits: 50 rectangles per sheet, 100 configured sheets and 500 rectangles per batch. The API uses the same local-origin and client-header requirements as the rest of the workshop service.
