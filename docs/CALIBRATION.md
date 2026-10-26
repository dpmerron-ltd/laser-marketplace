# Initial cut calibration

Open **Calibration tests** in the laser app. `npm run build` generates the downloadable packs automatically; `npm run calibration` regenerates them without building the app. The output is in `public/calibration/v1/`, with a combined ZIP, four material ZIPs, illustrated HTML guides, SVG/DXF drawings, manifests and JSON results templates. Generated files are ignored by Git; the generator and geometry are versioned.

**These are geometry-only templates, not runnable DSP files.** The current machine is a simulation profile with an unknown controller and nominal bed dimensions. Before generating native trials we need the machine make/model, exact DSP/controller model and firmware, tube wattage, usable bed, origin/orientation, lens/focus procedure, supplier power/current limits and suitable starting cut/marking ranges. A different DSP family needs its own adapter; the experimental Ruida encoder is not a universal DSP format. Nothing in the calibration pack changes a machine or enables live upload.

Settings depend on machine model and wattage as well as material. Supplier starting values are a basis for testing, not an automatic approval. See [Epilog’s material-settings guidance](https://support.epiloglaser.com/material-settings/). Varying one parameter at a time helps isolate its effect; see [Trotec’s parameter-testing guidance](https://www.troteclaser.com/en-gb/helpcenter/materials/laser-parameter/laser-parameter-basics-settings). Do not copy another manufacturer's percentage-speed values into this system's **mm/s** field.

## Test sequence

| Test | Purpose | Compensation |
| --- | --- | --- |
| 01 orientation | Asymmetric scored X/Y marks, 100 mm horizontal and 50 mm vertical | None |
| 02 pilot P1 | One 20 mm coupon with straight edges, a radius-4 corner and a 6 mm hole | None |
| 03 A1–C3 | Three speeds × three power levels; individual files allow isolated trials | None |
| 04 K1–K3 | Three nominal 20 mm plug/hole pairs for X/Y kerf and repeatability | **Zero** |
| 05 fit comb | Eight open-ended slots and a mating strip used edge-on | **Zero** |
| 06 V1 | 50 × 30 mm part, 10 mm circle and 10 × 10 mm square hole | Measured kerf applied **once** when preparing the later job |

The complete matrix and its individual cell files are alternatives, not separate mandatory runs. Column 1 is the fastest reviewed speed, column 3 the slowest; row A is the lowest reviewed power and row C the highest. The actual values remain blank. Confirm minimum and maximum DSP power together; corner/minimum power affects small coupons. Keep passes, focus, air assist and pulse/frequency settings recorded and consistent.

Every path has a cut or score layer, with red cuts and blue score labels. Labels are open vector strokes, so no font installation or raster engraving is needed. The files contain no background rectangles, border cuts, live text or embedded machine settings. Import at 100% in millimetres and inspect all layers. Importing the whole matrix as one ordinary catalogue design does **not** assign different settings to each cell. Initial native test files will need per-cell settings once the hardware is known.

Slot widths start at nominal thickness minus 0.50 mm, in 0.10 mm steps through nominal plus 0.20 mm. Actual plywood/MDF thickness can differ. `calibrationTests(material, measuredThickness)` can regenerate geometry around a measured thickness; keep that revised manifest with the result. The default downloadable pack uses nominal 3/6 mm and is labelled accordingly. Fit clearance is separate from kerf: for a raw uncompensated slot, approximate clearance is drawn slot width + measured kerf − actual material thickness.

## Measurements and photos

For each material (P3/P6/M3/M6), record supplier/batch, thickness at three points, exact speed in mm/s, min/max power, passes, lens/focus and air assist. Photograph the whole front, the back in the same orientation, and edges/corners with test IDs visible. Report which coupons separated without force. Photograph or transcribe calliper readings, and identify the selected fit slot and its feel. The included HTML guide doubles as a printable worksheet; `results-template.json` keeps the same data with each pack.

For every K1–K3 pair measure the plug and its corresponding hole on the **same face**, in X and Y, away from corners. Do not sand the measuring edges. The full kerf for an axis is `(hole − plug) / 2`; the centre-line dimension is `(hole + plug) / 2`, nominally 20 mm. Repeat on the back if taper is visible. The calculator reports median X/Y kerf and a median combined candidate. It flags more than 0.05 mm X/Y or repeat variation and more than 0.1 mm centre-line error. These are review thresholds, not acceptance specifications or automatic axis-calibration instructions.

Photos alone cannot establish sub-millimetre kerf or prove cut-through. A short 20 mm measurement is also insufficient evidence to change axis steps; check scale/orientation with the longer marks and the machine supplier's calibration procedure if results disagree. The calculator deliberately does not write profiles or approve production settings.

After reviewing photos and measurements, select candidate cut/score settings and kerf for that exact material/machine. Prepare a fresh compensated V1 cut, verify dimensions and fit, then update the versioned material profile. Saved production jobs keep their previous snapshots. Machine focus, bed consistency and controller commissioning remain separate physical checks; this pack emits no automatic Z/focus, homing, upload or start commands.

The geometry tests validate all paths, check bounds and roundtrip each SVG/DXF through the real importer. They also check raw kerf dimensions and the planner's single compensation on the validation part. Native encoder tests remain offline evidence; actual file acceptance and output must be checked on the user's controller.
