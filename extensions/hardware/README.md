# Hardware artifact extension

The read-only `hardware` tool lets Pi find and inspect schematic, assembly, PCB, fabrication, firmware-configuration, and PDF artifacts without requiring a repository layout or prescribed filenames. Discovery starts at the current working directory by default and classifies files from content. Explicit `root` and `paths` arguments can narrow or override discovery.

The tool is enabled by the managed `IEM-Firmware` preset. Run `/preset IEM-Firmware`, then ask Pi to discover or investigate the hardware. It does not preload artifact contents into model context.

## Evidence rules

The tool keeps evidence domains separate:

1. A parsed schematic netlist is the authority for logical connectivity.
2. A semantic PCB export describes PCB objects and assigned PCB nets.
3. IPC-D-356 independently describes manufactured/test connectivity.
4. Gerber and Excellon describe fabrication geometry, not design intent.
5. BOM and pick-and-place files provide metadata and assembly evidence.
6. PDF text and renders are visual/search hints, never connectivity facts.
7. Traversal through a two-terminal passive is an explicitly labeled inference.

A model should report parsed facts, deterministic violations, visual hints, and diagnostic hypotheses separately. Missing or conflicting evidence remains unknown.

## Supported formats

| Format | Support | Capability |
|---|---|---|
| PDF | Supported through `pdfinfo`, `pdftotext`, and `pdftoppm` | Metadata, text search, page render |
| Protel/Altium text netlist | Supported | Components, pins, explicit schematic nets |
| CSV/TSV BOM | Supported | Values, footprints, variants/DNP metadata where exported |
| CSV/TSV pick-and-place | Supported | Position, rotation, and side |
| Gerber RS-274X/X2-like text | Inspection supported | Units, coordinate format, aperture/feature summary; optional `gerbv` rendering |
| Excellon drill | Inspection supported | Units, tools, and hole summary |
| IPC-D-356 | Experimental until validated against a team Altium export | Manufactured connectivity |
| IPC-2581 | Experimental subset until validated against a team Altium export | Components, positions, and logical PCB net records |
| ODB++ archive | Detection only | Reported as unsupported for semantic queries |
| STM32CubeMX `.ioc` | Supported metadata subset | MCU identity and GPIO-label comparison hints |
| JSON design manifest | Supported | Reviewed required/forbidden connection checks |
| YAML design manifest | Detection only | Reported as unsupported; use JSON |

The parser deliberately disables claims for constructs it cannot represent. In particular, BOMs and PDFs never create nets. IPC-D-356 and IPC-2581 remain marked `experimental` until representative exports from the team's Altium version are added as fixtures.

## Actions

All paths are relative to Pi's current working directory and cannot escape it.

- `discover`: recursively find and classify artifacts. Optional: `root`, `offset`, `limit`, `maxFiles`, `maxDepth`, `maxMegabytes`.
- `inspect`: parse selected artifacts and summarize their contents and capability matrix.
- `status`: show capabilities, missing domains, parser diagnostics, and PDF metadata.
- `search`: search component metadata, net names, and extractable PDF text. Requires `query`.
- `component`: exact normalized designator lookup. Requires `query` such as `U3`.
- `net`: exact normalized net lookup. Requires `query` such as `CAN1_TX`.
- `neighbors`: one-hop explicit schematic connectivity from a component.
- `trace`: bounded schematic traversal. Optional `depth`; set `traversePassives` only when inferred traversal is useful.
- `location`: show explicit placement/PCB coordinates for a reference.
- `render`: render a PDF page or Gerber file. Optional `query` selects a path substring; `page` defaults to 1.
- `compare`: compare schematic, PCB, manufactured, BOM, placement, and CubeMX evidence when available.
- `check`: run deterministic checks over represented data, including an optional JSON manifest's required and forbidden connections.

Except for `discover`, actions accept one of:

- `paths`: an explicit list of artifacts;
- `setId`: a handle returned by `discover` in the current session and working directory; or
- `root`: discover and use recognized artifacts below that location.

Use explicit `paths` whenever discovery reports an ambiguous set. Results support `offset` and `limit` and are capped to Pi's normal output limits.

## Example workflows

### Find arbitrary hardware files

```json
{"action":"discover","root":".","limit":100}
```

Use a returned set handle:

```json
{"action":"status","setId":"hw-0123456789ab"}
```

Or bypass grouping entirely:

```json
{"action":"inspect","paths":["board/rev-c-export.net","release/assy.csv","drawings/main.pdf"]}
```

### Look up and trace a component

```json
{"action":"component","paths":["exports/design.net","exports/bom.csv"],"query":"U7"}
{"action":"neighbors","paths":["exports/design.net"],"query":"U7","limit":100}
{"action":"trace","paths":["exports/design.net"],"query":"U7","depth":3,"traversePassives":true}
```

The final call labels any traversal across an R/C/L/FB component as inference.

### Search and render a schematic

```json
{"action":"search","paths":["docs/oddly named drawing.pdf"],"query":"PRECHARGE_COMPLETE"}
{"action":"render","paths":["docs/oddly named drawing.pdf"],"page":6}
```

PDF matches and images are visual hints. A PDF-only project has no supported logical-connectivity capability.

### Compare design domains

```json
{"action":"compare","paths":["design.net","board.xml","board.356","bom.csv","pick-place.csv","controller.ioc"]}
{"action":"check","paths":["design.net","board.xml","board.356","bom.csv","pick-place.csv"]}
```

Comparisons report both sides of conflicts. They do not silently select one artifact as correct across different evidence domains.

### Triage a hardware/firmware symptom

For an unresponsive SPI device, ask Pi to:

1. Discover likely artifacts.
2. Inspect status to confirm logical connectivity is available.
3. Look up the device and MCU components.
4. Trace chip-select, clock, MOSI, MISO, interrupt, power, and reset nets.
5. Compare exact CubeMX GPIO labels when available.
6. Render the relevant schematic pages for notes and visual context.
7. Run deterministic checks.
8. Present hypotheses separately, citing supporting and contradicting evidence and suggesting measurements at explicit pins or test points.

### Optional design-intent manifest

A JSON file can add reviewed, deterministic connection expectations without affecting parsed connectivity:

```json
{
  "hardware": {
    "requiredConnections": [{"ref":"U1","pin":"4","net":"CAN_TX"}],
    "forbiddenConnections": [{"ref":"J1","pin":"8","net":"HV+"}]
  }
}
```

Include the manifest in `paths` and run `check`. Each record requires string `ref`, `pin`, and `net` fields and may have a `note`. Netlist facts remain authoritative; the manifest supplies requirements, not connections.

## Cache and dependencies

Detailed parsing is lazy and cached in memory for the Pi session. Extracted PDF text is cached under the operating system temporary directory at `pi-hardware-cache/`, keyed by parser version and content hash. Renders use temporary `pi-hardware-render-*` directories. No generated index, text, image, OCR, or database is written to the project.

PDF actions require Poppler commands (`pdfinfo`, `pdftotext`, and `pdftoppm`) on `PATH`. Gerber rendering additionally requires `gerbv`; inspection works without it. Missing optional commands produce explicit errors instead of changing the evidence level.

## Export guidance

For full review, use a repeatable Altium OutJob to export, where available:

- schematic PDF and Protel text netlist;
- BOM and pick-and-place CSV;
- IPC-D-356;
- Gerber X2 plus NC drill;
- IPC-2581 or another documented semantic PCB exchange format.

Record board revision, variant, Altium version, export date, and source revision near the artifacts when practical. No specific directory or filename is required.
