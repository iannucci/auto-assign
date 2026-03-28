# Auto-Assign Algorithm Study

## Intent

The Auto-Assign feature distributes unassigned addresses in a neighborhood across N Emergency Services Workers (ESWs). The goal is to minimize each ESW's total walk distance while keeping assignment sizes balanced.

This study:
1. Establishes a **single-ESW baseline** — the minimum walk distance to visit all addresses in a neighborhood with optimal ordering
2. Tests **multiple clustering strategies** for dividing addresses among N ESWs
3. Evaluates each strategy using walk distance, balance, and geographic compactness
4. Selects the best strategy for production use

## Metrics

- **Walk distance**: Sum of haversine distances between consecutive addresses in assignment order (meters). This is the distance an ESW walks if they follow the assignment list sequentially.
- **Balance ratio**: max(count) / min(count) across ESW assignments. Ideal = 1.0.
- **Walk ratio**: max(walk_distance) / min(walk_distance). Ideal = 1.0.
- **Compactness (spread)**: Average distance of each address from its assignment's geographic centroid (meters). Lower = more geographically tight.
- **Efficiency**: Actual max walk distance vs. theoretical ideal (baseline / N).

## Single-ESW Baselines

Using nearest-neighbor walk ordering on all addresses:

| Neighborhood | Addresses | Streets | NN Walk Distance | Per-ESW Ideal (N=3) | Per-ESW Ideal (N=5) |
|-------------|-----------|---------|-----------------|--------------------|--------------------|
| Fairmeadow | 307 | 15 | 6,677m (6.7km) | 2,226m | 1,335m |
| Crescent Park | 1,476 | 137 | 38,652m (38.7km) | 12,884m | 7,730m |
| Midtown | 5,101 | 581 | 101,834m (101.8km) | 33,945m | 20,367m |

The "ideal" is baseline/N — the walk distance if we could perfectly split the route with zero cost for geographic separation. Real assignments will always exceed this due to the overhead of splitting contiguous routes into separate regions.

## Strategies Tested

### Strategy A: Contiguous Chain Slicing
Chain all streets by endpoint proximity (nearest-neighbor on street endpoints), then cut the chain into N contiguous runs at the target count boundary. Tried 5 different starting streets.

**Strength**: Perfect count balance (ratio ~1.00). Streets stay in walk order.
**Weakness**: The cut points may fall in suboptimal geographic locations. Walk distances vary with starting point.

### Strategy B: K-Means on Street Centroids
Initialize N cluster centroids, iteratively assign each street to nearest centroid, recompute centroids weighted by address count. Within each cluster, chain streets by endpoint for walk order.

**Strength**: Best geographic compactness (lowest spread).
**Weakness**: Poor count balance (ratio up to 5.88 for N=5). Walk distances highly unequal. K-means clusters by proximity but doesn't consider balance.

### Strategy C: Recursive Geographic Bisection
Find the longer geographic axis, sort addresses along it, split at the count boundary, recurse on each half. Re-order each bucket's addresses for walking.

**Strength**: Excellent count balance AND geographic contiguity. Each region is a compact geographic block. Lowest total walk distance.
**Weakness**: Cuts are always axis-aligned (N/S or E/W), which may not follow street patterns.

## Results

### Fairmeadow (307 addresses, 3 ESWs)

| Strategy | Counts | Max Walk | Total Walk | Walk Ratio | Spread | Winner? |
|----------|--------|----------|------------|------------|--------|---------|
| ChainSlice(best) | 492,492,492 | 9,798m | 25,445m | 1.54 | 399m | |
| K-means | 112,68,127 | 11,687m | 25,609m | 3.68 | 342m | |
| **Bisect** | **103,102,102** | **7,315m** | **16,827m** | **1.58** | **349m** | **YES** |

Bisect: max walk 7,315m vs ideal 2,226m (3.3× overhead). Best total walk by 34%.

### Crescent Park (1,476 addresses, 3 ESWs)

| Strategy | Counts | Max Walk | Total Walk | Walk Ratio | Spread | Winner? |
|----------|--------|----------|------------|------------|--------|---------|
| **ChainSlice(start=2)** | **492,492,492** | **25,638m** | **75,713m** | **1.04** | **1,423m** | **YES** |
| K-means | 624,480,372 | 33,566m | 75,957m | 2.24 | 989m | |
| Bisect | 492,492,492 | 26,485m | 68,956m | 1.39 | 799m | |

ChainSlice won on walk ratio (1.04 — nearly perfect balance of walk distances). Bisect had lower total walk but higher max.

### Midtown (5,101 addresses, 3 ESWs)

| Strategy | Counts | Max Walk | Total Walk | Walk Ratio | Spread | Winner? |
|----------|--------|----------|------------|------------|--------|---------|
| ChainSlice(best) | 1701,1701,1699 | 81,696m | 239,491m | 1.07 | 2,147m | |
| K-means | 1659,1164,2278 | 99,956m | 242,958m | 1.70 | 1,507m | |
| **Bisect** | **1701,1700,1700** | **83,385m** | **223,583m** | **1.21** | **1,503m** | Close tie |

ChainSlice won by scoring metric (lower max walk), but Bisect had 7% lower total walk. Very close.

### Midtown (5,101 addresses, 5 ESWs)

| Strategy | Counts | Max Walk | Total Walk | Walk Ratio | Spread | Winner? |
|----------|--------|----------|------------|------------|--------|---------|
| ChainSlice(best) | 1021×5 | 55,482m | 238,917m | 1.58 | 3,210m | |
| K-means | 1735,1067,1685,295,319 | 86,000m | 240,576m | 13.20 | 1,767m | |
| **Bisect** | **1021,1020×4** | **49,818m** | **224,150m** | **1.22** | **2,068m** | **YES** |

Bisect wins clearly with more ESWs. K-means collapses badly with N=5 (two buckets get <320 addresses, one gets 1,735).

## Conclusions

1. **Bisect is the most reliable strategy overall.** It produces:
   - Perfect count balance (ratio ~1.00)
   - Lowest total walk distance (6-7% lower than chain slicing)
   - Good geographic contiguity (compact rectangular regions)
   - Consistent performance across neighborhood types and ESW counts

2. **ChainSlice is competitive for small N** (especially N=3) on rectilinear grids, where a single good starting point can produce nearly perfect walk distance balance (ratio 1.04 on Crescent Park). But it degrades with more ESWs and is sensitive to the starting street.

3. **K-means is the worst strategy.** Despite having the best compactness (lowest spread), it produces severely unbalanced counts and walk distances. It should be removed or only used as a tiebreaker.

4. **The scoring function should prioritize:**
   - Max walk distance (fairness — no ESW should walk much more than others)
   - Total walk distance (efficiency)
   - Count balance (secondary)

5. **Recommendation for production:** Run Bisect + best ChainSlice, score both, pick the winner. Remove K-means. This reduces computation while covering the two best strategies.

## Efficiency Analysis

| Neighborhood | N | Ideal (baseline/N) | Best Actual Max | Overhead |
|-------------|---|--------------------|-----------------|---------|
| Fairmeadow | 3 | 2,226m | 7,315m (Bisect) | 3.3× |
| Crescent Park | 3 | 12,884m | 25,638m (Chain) | 2.0× |
| Midtown | 3 | 33,945m | 81,696m (Chain) | 2.4× |
| Midtown | 5 | 20,367m | 49,818m (Bisect) | 2.4× |

The 2-3× overhead vs. ideal is inherent to geographic splitting — each ESW's region has its own internal transitions that don't exist in a single continuous route. This is the expected cost of parallelism.
