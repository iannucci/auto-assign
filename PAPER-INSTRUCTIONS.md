# Auto-Assign Paper: Author Instructions

This document captures all of the author's instructions for the IEEE paper on geographic address assignment optimization. It is sufficiently detailed to reproduce the paper as it stands.

## Paper Identity

- **Title:** Geographic Address Assignment Optimization for Emergency Services Workers
- **Author:** Bob Iannucci, Iannucci Wireless Systems Engineering, Palo Alto, CA
- **Format:** IEEE conference (`\documentclass[conference]{IEEEtran}`)
- **Repository:** `iannucci/auto-assign`

## Section Structure

The paper follows this exact section order:

1. **Introduction** — problem statement, three key insights, contributions list (C1–C8)
2. **Problem Formulation** — road network model, cost matrix, walking distance, general constraints (hoisted here, not per-algorithm), data description
3. **Three Metrics** — walk quality, time spread, productive-distance invariant; each with "why it matters to individuals" and "why it matters to the response"
4. **The Neighborhoods** — five diverse Palo Alto neighborhoods with OSM maps and descriptions
5. **Algorithms** — one subsection per algorithm, each with full description, pseudocode or complexity, and a Fairmeadow N=3 colored map
6. **Simulation Methodology** — data pipeline, distance computation, parameters, test matrix
7. **Results** — master comparison tables, scaling, visualizations, trail figures, overhead decomposition, time-based analysis with worked examples, Voronoi analysis, constraint tension analysis
8. **Discussion** — when each algorithm wins, cross-study comparison table, productive-distance invariant, walk-ordered vs geographic, recommended practice (4 steps), limitations
9. **Related Work**
10. **Conclusion and Future Work** — per-contribution evidence (C1–C8), future directions

## General Constraints (Hoisted)

These apply to ALL algorithms and evaluations. They belong in Problem Formulation, not in individual algorithm sections:

- **Whole-segment assignment:** Each segment assigned to exactly one ESW. No splitting.
- **Shared starting location (huddle point):** All ESWs begin at the neighborhood intersection nearest to the serving fire station. Walk from huddle to first segment is included in total distance/time. ESWs are transported to the huddle by vehicle.
- **Street-constrained walking:** ESWs must follow the road network. No jumping over houses. All inter-segment distances use Dijkstra shortest paths.
- **Assessment time:** t_assess = 5 min/address. Walking speed v = 5 km/h. Assessment time dominates walking by ~8x.

## The Three Metrics

Each metric has a description, why it matters to individuals, and why it matters to the overall response:

1. **Walk quality** = productive / (productive + unproductive). Below 50% is operationally unacceptable.
2. **Time spread** = max finish time − min finish time. The straggler determines when the NPC has complete data.
3. **Productive-distance invariant** — productive walking is constant across algorithms (±5%). Only unproductive walking can be optimized. This is the paper's deepest insight.

## The Five Neighborhoods

Selected for maximum geometric diversity:

| Abbrev | Name | Addrs | Segs | Character |
|--------|------|-------|------|-----------|
| PAC | Palo Alto Central | 145 | 11 | Dense commercial |
| FM | Fairmeadow | 307 | 43 | Cul-de-sacs |
| CC | Community Center | 489 | 117 | Regular grid |
| RP | Research Park | 584 | 289 | Sparse campus |
| SG | Southgate | 268 | 44 | Elongated |

## The Nine Algorithms

Each algorithm section must include:
- Full description of how the algorithm works
- **Pseudocode** (every algorithm gets its own `algorithm` environment)
- Complexity analysis
- A Fairmeadow N=3 map showing 3 ESWs' segments in blue/red/green with address count splits in the title

The algorithms: Chain+Slice (NN), Right-Hand Rule, 2-Opt, Recursive Bisection, Voronoi with Balanced Seeds, BFS from Huddle, DFS from Huddle, SA Post-Processing, Oracle. Plus Random as a baseline.

## Simulation Parameters

- 10 algorithms × 5 neighborhoods × N ∈ {3, 5, 7, 10} = 200 test cases
- t_assess = 5 min/address
- Walking speed = 5 km/h (83.33 m/min)
- Huddle points from 6 Palo Alto Fire Department stations, assigned by centroid proximity
- Huddle walk-to-first included for ALL algorithms in evaluation (not just BFS/DFS)
- All distances use road-network Dijkstra, never haversine

## Content That Must Be Preserved

The following hard-won content must NOT be deleted in any restructuring:

- **Cost matrix worked example** (150m segment, 8 addresses, full 4×4 matrix)
- **Real segment example** (Starr King Circle, 243m, 19 addresses, Fig with side classification)
- **Zigzag vs U-turn analysis** with Roosevelt Circle figure (81% savings)
- **Road-following transitions figure** (Roosevelt Circle to East Meadow Drive, 540m road vs 346m straight)
- **Chain comparison figure** (NN vs RH single-worker trails on Fairmeadow)
- **Voronoi Lloyd's vs balanced seeds figure** (Fairmeadow, 121/103/88 vs 104/102/106)
- **Midtown before/after figure** (straight Voronoi lines vs segment-reassigned boundary)
- **Walking trail figures** (Fairmeadow and Crescent Park, 3-panel per-ESW trails)
- **DFS trail figure** with huddle point (Fairmeadow, time metric)
- **SA worked example** (Greater Miranda, two-move backtracking trace table)
- **Overhead decomposition** analysis (Fairmeadow ρ=1.60, Monroe Park ρ=2.77)
- **Cross-study comparison table** (Oracle vs Voronoi on 5 neighborhoods, ΔUnprod column)
- **Scoring function** (2·W_max + W_total + 5000·imbalance)
- **Recommended practice** (4 concrete steps: transport, oracle, check spread, brief ESWs)
- **Per-contribution conclusion** (C1–C8, each with specific evidence)
- **Constraint tension analysis** (only 6% feasible at Q_min=50%)

## Figures: Rules and Standards

### Neighborhood Maps
- Use **OpenStreetMap screenshots** (fetched via tile server), NOT pgfplots dot plots
- Script: `scripts/fetch-osm-maps.py` fetches tiles and composites them
- Images stored in `figures/osm-{name}.png`
- Include OSM attribution in caption: "Map data © OpenStreetMap contributors"
- No longitude/latitude axes on ANY map figure — shape matters, not coordinates

### Per-Algorithm Maps
- Each algorithm section includes a Fairmeadow N=3 map
- Three ESWs colored blue, red, green
- Address counts in figure title (e.g., "Chain+Slice on Fairmeadow (106/107/99)")
- Gray background dots for all addresses
- `ticks=none` on all map axes

### Voronoi Figures
- **Must set explicit axis limits** (xmin/xmax/ymin/ymax) matching the neighborhood bbox
- Without this, the Voronoi partition lines extend far beyond the data and pgfplots auto-zooms out, shrinking the neighborhood to a tiny cluster
- Orange lines for Voronoi partition boundaries
- Black diamonds for seed points
- The Lloyd's vs balanced seeds comparison is a key figure

### Trail Figures
- Blue = productive walking (within segments)
- Red dashed = unproductive transitions (between segments)
- Green diamond = huddle point, green dashed = walk from huddle
- All transition paths must follow roads (Dijkstra paths), NOT straight lines
- Gray dots for all addresses as background

### Color Rules

**Exercise purposefulness in color selection:**
- Use the SAME color key across all panels of a multi-panel figure
- Colors must reflect semantic meaning: red = bad/unproductive, blue or green = good/productive
- Use full-strength colors, not washed-out variants (e.g., `unprodred` not `unprodred!50`)
- Ensure strong visual contrast between stacked/adjacent elements
- Do not invent new color assignments when existing ones work

**Defined colors:**
- `prodblue` (RGB 31,119,180) — productive walking
- `unprodred` (RGB 214,39,40) — unproductive walking
- `idealgreen` (RGB 34,139,34) — theoretical ideal, huddle point
- `voronoiorange` (RGB 255,127,14) — Voronoi boundaries only

### Text in Captions
- **Never use `\textcolor` to colorize color names.** Everybody knows "orange" denotes the color orange. Write "Blue = productive" not `\textcolor{prodblue}{Blue} = productive`.

## Tables

- **Do not create tables that run off the page.** Split wide tables into multiple single-column tables rather than one wide table spanning both columns.
- Walk quality table and time spread table are separate (not combined into one 21-column monster).
- The cross-study comparison table (Oracle vs Voronoi) is a `table*` (full width) because it has many columns.

## Key Findings to Emphasize

1. **No single algorithm dominates.** The winner depends on neighborhood geometry.
2. **The productive-distance invariant** — algorithms can only reduce waste, not work.
3. **Walk quality matters more than time.** ESWs reject assignments with excessive purposeless walking.
4. **Seed placement matters more than assignment metric** for Voronoi.
5. **The constraints are in fundamental tension** — resolution is operational (drive vs walk to neighborhood), not algorithmic.
6. **The oracle** reduces worst-case walk by 37% vs random, completes in <1s.

## Data Pipeline

- OpenStreetMap data imported via `osm2pgsql` from Geofabrik California PBF (1.3 GB)
- Filtered to Palo Alto bounding box
- 64,482 segments from 54,854 intersections; 7,430 have addresses
- 41,854 addresses snapped (median 22.9m snap distance)
- Cost matrices precomputed from address positions and street widths
- Dijkstra shortest paths precomputed within each neighborhood (2–31s)
- Fire stations: 6 Palo Alto stations, assigned to neighborhoods by centroid proximity

## Task Separation

The work is divided into two independent tasks:
- **Task I (Structure):** Reorganize sections, figures, tables — no simulation reruns. DONE.
- **Task II (Simulation):** Rerun simulations with any parameter changes, update all data-dependent content. PENDING.

## Process Rules

- **Commit and push after every change.** Do not accumulate uncommitted work.
- **Never delete content when restructuring.** Reorganize, don't rewrite from scratch.
- **Do not create the paper from memory.** Always read the existing file before modifying.
