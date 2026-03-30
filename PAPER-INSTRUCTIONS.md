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
2. **Problem Formulation** — road network model, segment walking distance (definitions, TSP argument, traversal strategies, segments vs sub-segments, worked example), walking distance, general constraints, data
3. **Three Metrics** — walk quality, time spread, productive-distance invariant; each with "why it matters to individuals" and "why it matters to the response"
4. **The Neighborhoods** — five diverse Palo Alto neighborhoods with OSM maps and descriptions
5. **Algorithms** — one subsection per algorithm, each with full description, pseudocode, and a Fairmeadow N=3 colored map
6. **Simulation Methodology** — data pipeline, distance computation (all walkable road-network paths), parameters, test matrix
7. **Results** — master comparison tables, scaling, visualizations, trail figures, overhead decomposition, time-based analysis with worked examples, Voronoi analysis, constraint tension analysis
8. **Discussion** — when each algorithm wins, cross-study comparison table, productive-distance invariant, walk-ordered vs geographic, recommended practice (3 steps), limitations
9. **Related Work**
10. **Conclusion and Future Work** — per-contribution evidence (C1–C8), future directions

## General Constraints (Hoisted)

These apply to ALL algorithms and evaluations. They belong in Problem Formulation, not in individual algorithm sections:

- **Whole-segment assignment:** Each segment assigned to exactly one ESW. Justified by the empirical finding that zigzag wins on every both-side through-segment in the dataset (sub-segment decomposition would increase total walking).
- **Shared starting location (huddle point):** All ESWs begin at the neighborhood intersection nearest to the serving fire station. Walk from huddle to first segment is included in total distance/time for ALL algorithms.
- **Street-constrained walking:** ESWs must follow the road network. All distances use walkable road-network paths (Dijkstra shortest paths).
- **Assessment time:** t_assess = 5 min/address. Walking speed v = 5 km/h. Assessment time dominates walking by ~8x.

## Segment Walking Distance (Section II B)

This section has a specific structure that must be maintained:

1. **Definitions** — all terms defined before use: D, w, n, ports (S_L, S_R, E_L, E_R), t, runs (r), g_bar, sub-segment (one side of a segment; cul-de-sacs have one, through-segments have two)
2. **Traversal strategies** — through-traversal (Eq. 3) and out-and-back (Eq. 4) with equations
3. **Why Not Solve TSP per Segment?** — 1D structure reduces to choice between two monotonic strategies; through costs D + (r-1)w, out-and-back costs ~2t_n·D; through wins when (r-1)w < (2t_n - 1)D (Eq. 5); g_bar/w governs r which drives the comparison
4. **Empirical Strategy Selection** — 88% zigzag (median g_bar/w = 1.9), 12% U-turn (median g_bar/w = 0.5)
5. **Segments vs Sub-Segments** — sub-segment formulation is stronger in general, but decomposition only helps when (r-1)w ≥ D (out-and-back wins); this never occurs in the Palo Alto data; cul-de-sacs cannot be decomposed; whole segments with 4×4 matrices are optimal for this dataset
6. **Worked Example** — Starr King Circle (through, 19 addrs, 4×4 matrix) and Wright Place (cul-de-sac, 7 addrs, constrained matrix); Roosevelt Circle figure (extreme U-turn case)

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

## The Eleven Algorithms

Each algorithm section must include:
- Full description of how the algorithm works
- **Pseudocode** (every algorithm gets its own `algorithm` environment)
- A Fairmeadow N=3 map showing 3 ESWs' segments in blue/red/green with address count splits in the title

The algorithms: Chain+Slice (NN), Right-Hand Rule, 2-Opt, Recursive Bisection, Voronoi with Balanced Seeds, Voronoi + Boundary Transfer (Vor+BT), BFS, DFS, SA Post-Processing, Oracle. Plus Random as a baseline.

## Simulation Parameters

- 11 algorithms × 5 neighborhoods × N ∈ {3, 5, 7, 10} = 220 test cases
- t_assess = 5 min/address
- Walking speed = 5 km/h (83.33 m/min)
- Huddle points from 6 Palo Alto Fire Department stations, assigned by centroid proximity
- Huddle walk-to-first included for ALL algorithms in evaluation
- All distances use walkable road-network paths (Dijkstra), no straight-line distances

## Content That Must Be Preserved

The following hard-won content must NOT be deleted in any restructuring:

- **Starr King Circle worked example** (through-segment, 19 addresses, full 4×4 matrix with figure)
- **Wright Place worked example** (cul-de-sac, 7 addresses, constrained 4×4 matrix)
- **Zigzag vs U-turn analysis** with Roosevelt Circle figure (81% savings), g_bar/w geometric condition
- **Segments vs sub-segments analysis** — sub-segment formulation is stronger, but (r-1)w < D for all segments in dataset
- **Chain comparison figure** (NN vs RH single-worker trails on Fairmeadow)
- **Voronoi Lloyd's vs balanced seeds figure** (Fairmeadow, 121/103/88 vs balanced)
- **Midtown before/after figure** (straight Voronoi lines vs segment-reassigned boundary)
- **Walking trail figures** (Fairmeadow and Crescent Park, 3-panel per-ESW trails)
- **DFS trail figure** with huddle point (Fairmeadow, time metric)
- **SA worked example** (Greater Miranda, two-move backtracking trace table)
- **Overhead decomposition** analysis (Fairmeadow ρ=1.90)
- **Cross-study comparison table** (Oracle vs Voronoi+BT on 5 neighborhoods, ΔUnprod column)
- **Scoring function** (2·W_max + W_total + 5000·imbalance)
- **Recommended practice** (3 steps: run oracle, check spread, brief ESWs with trail maps)
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
- Without this, the Voronoi partition lines extend far beyond the data and pgfplots auto-zooms out
- Orange lines for Voronoi partition boundaries
- Black diamonds for seed points

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
- **Never use `\textcolor` to colorize color names.** Write "Blue = productive" not `\textcolor{prodblue}{Blue} = productive`.

## Tables

- **Do not create tables that run off the page.** Split wide tables into multiple single-column tables.
- Walk quality table and time spread table are separate.
- The cross-study comparison table (Oracle vs Voronoi+BT) is a `table*` (full width).

## Key Findings to Emphasize

1. **No single algorithm dominates.** The winner depends on neighborhood geometry.
2. **The productive-distance invariant** — algorithms can only reduce waste, not work.
3. **Walk quality matters more than time.** ESWs reject assignments with excessive purposeless walking.
4. **Seed placement matters more than assignment metric** for Voronoi.
5. **The constraints are in fundamental tension** — the huddle-to-first-segment walk dominates walking quality.
6. **The oracle** reduces worst-case walk by 25% vs random, completes in <1s.
7. **Sub-segment decomposition is stronger in theory** but does not arise in residential Palo Alto street geometry (zigzag universally wins).

## Data Pipeline

- OpenStreetMap data imported via `osm2pgsql` from Geofabrik California PBF (1.3 GB)
- Filtered to Palo Alto bounding box
- 64,482 segments from 54,854 intersections; 7,430 have addresses
- 41,854 addresses snapped (median 22.9m snap distance)
- Cost matrices precomputed from address positions and street widths
- Dijkstra shortest paths precomputed within each neighborhood (2–31s)
- Fire stations: 6 Palo Alto stations, assigned to neighborhoods by centroid proximity

## Process Rules

- **Commit and push after every change.** Do not accumulate uncommitted work.
- **Never delete content when restructuring.** Reorganize, don't rewrite from scratch.
- **Do not create the paper from memory.** Always read the existing file before modifying.
- **Get permission before making text changes.** Summarize proposed changes and get approval first.
- **Do not use `\textcolor` in captions.**
- **Do not recommend transporting ESWs.** The paper optimizes from the huddle point only.
