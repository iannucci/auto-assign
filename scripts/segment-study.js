#!/usr/bin/env node
// Segment-based assignment study using road-network-constrained walking distances
// and per-segment cost matrices.
//
// Loads network-extract.json (produced by extract-network-data.js on sitrep)
// Runs assignment algorithms on each neighborhood, outputs results and trail data.

const fs = require("fs");
const path = require("path");

// ============================================================
// Load data
// ============================================================
console.log("Loading network data...");
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "network-extract.json"), "utf8"));
console.log(`  ${data.segments.length} segments with addresses, ${data.addresses.length} addresses`);

// Build lookup maps
const segById = new Map();
for (const s of data.segments) segById.set(s.id, s);

// Map gid -> address
const addrByGid = new Map();
for (const a of data.addresses) addrByGid.set(a.gid, a);

// Map gid -> segmentId
const gidToSeg = new Map();
for (const snap of data.addressSnapping) gidToSeg.set(snap.gid, snap.segmentId);

// Map segmentId -> [gids]
const segGids = new Map();
for (const snap of data.addressSnapping) {
    if (!segGids.has(snap.segmentId)) segGids.set(snap.segmentId, []);
    segGids.get(snap.segmentId).push(snap.gid);
}

// ============================================================
// Build inter-segment distance graph (Dijkstra between intersections)
// ============================================================
// For the study, we use a simplified model: transition cost between two
// segments sharing a node = 0 (same intersection). For segments NOT sharing
// a node, we use the road-network shortest path between their endpoints.
//
// Build adjacency: nodeId -> [{segId, whichEnd:'start'|'end'}]
const nodeToSegPorts = new Map();
for (const s of data.segments) {
    for (const [nid, end] of [[s.startNode, "start"], [s.endNode, "end"]]) {
        if (!nodeToSegPorts.has(nid)) nodeToSegPorts.set(nid, []);
        nodeToSegPorts.get(nid).push({ segId: s.id, end });
    }
}
// Also include road segments (no addresses) for routing
for (const rs of data.roadSegments || []) {
    for (const [nid, end] of [[rs.startNode, "start"], [rs.endNode, "end"]]) {
        if (!nodeToSegPorts.has(nid)) nodeToSegPorts.set(nid, []);
        nodeToSegPorts.get(nid).push({ segId: rs.id, end, isRoad: true });
    }
}

// Build node-to-node adjacency from ALL segments (with and without addresses)
// Store polylines so Dijkstra can reconstruct road-following paths
const allSegs = [...data.segments, ...(data.roadSegments || [])];
const nodeAdj = new Map(); // nodeId -> [{toNode, dist, polyline}]
for (const s of allSegs) {
    const sn = s.startNode, en = s.endNode;
    if (sn === en) continue;
    if (!nodeAdj.has(sn)) nodeAdj.set(sn, []);
    if (!nodeAdj.has(en)) nodeAdj.set(en, []);
    const pl = s.polyline || [];
    nodeAdj.get(sn).push({ to: en, dist: s.distance, polyline: pl });
    nodeAdj.get(en).push({ to: sn, dist: s.distance, polyline: [...pl].reverse() });
}

// Single-source Dijkstra returning distances AND predecessor info for path reconstruction
function dijkstraAll(startNode, maxDist = 10000) {
    const dist = new Map([[startNode, 0]]);
    const prev = new Map(); // nodeId -> {from, polyline}
    const visited = new Set();
    const queue = [{ node: startNode, d: 0 }];
    while (queue.length > 0) {
        let minIdx = 0;
        for (let i = 1; i < queue.length; i++) {
            if (queue[i].d < queue[minIdx].d) minIdx = i;
        }
        const { node, d } = queue[minIdx];
        queue[minIdx] = queue[queue.length - 1];
        queue.pop();

        if (visited.has(node)) continue;
        visited.add(node);

        for (const edge of (nodeAdj.get(node) || [])) {
            const nd = d + edge.dist;
            if (nd > maxDist) continue;
            if (nd < (dist.get(edge.to) ?? Infinity)) {
                dist.set(edge.to, nd);
                prev.set(edge.to, { from: node, polyline: edge.polyline });
                queue.push({ node: edge.to, d: nd });
            }
        }
    }
    return { dist, prev };
}

// Precompute distance matrix; only store prev maps for small neighborhoods (< 300 nodes)
let distMatrix = null;  // Map<nodeId, Map<nodeId, dist>>
let prevMatrix = null;  // Map<nodeId, Map<nodeId, {from, polyline}>> (null for large hoods)

function precomputeDistances(nodeIds, maxDist = 10000) {
    distMatrix = new Map();
    const storePaths = nodeIds.size < 300; // Only store path data for small neighborhoods
    prevMatrix = storePaths ? new Map() : null;
    for (const nid of nodeIds) {
        const result = dijkstraAll(nid, maxDist);
        distMatrix.set(nid, result.dist);
        if (storePaths) prevMatrix.set(nid, result.prev);
    }
}

function nodeDist(n1, n2) {
    if (n1 === n2) return 0;
    return distMatrix?.get(n1)?.get(n2) ?? Infinity;
}

// Reconstruct the road-following polyline from n1 to n2
function nodePathPolyline(n1, n2) {
    if (n1 === n2) return [];

    // If prev matrix is available, use it
    if (prevMatrix) {
        const prev = prevMatrix.get(n1);
        if (!prev || !prev.has(n2)) return [];
        const segments = [];
        let cur = n2;
        while (prev.has(cur) && cur !== n1) {
            const p = prev.get(cur);
            segments.push(p.polyline);
            cur = p.from;
        }
        segments.reverse();
        const poly = [];
        for (const pl of segments) {
            for (let i = 0; i < pl.length; i++) {
                if (poly.length === 0 || i > 0) poly.push(pl[i]);
            }
        }
        return poly;
    }

    // Fallback: on-demand single-pair Dijkstra with path reconstruction
    const result = dijkstraAll(n1, 10000);
    if (!result.prev.has(n2)) return [];
    const segments = [];
    let cur = n2;
    while (result.prev.has(cur) && cur !== n1) {
        const p = result.prev.get(cur);
        segments.push(p.polyline);
        cur = p.from;
    }
    segments.reverse();
    const poly = [];
    for (const pl of segments) {
        for (let i = 0; i < pl.length; i++) {
            if (poly.length === 0 || i > 0) poly.push(pl[i]);
        }
    }
    return poly;
}

// ============================================================
// Haversine (for centroid calculations)
// ============================================================
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function segCentroid(seg) {
    const pl = seg.polyline;
    const lat = pl.reduce((s, p) => s + p[0], 0) / pl.length;
    const lon = pl.reduce((s, p) => s + p[1], 0) / pl.length;
    return { lat, lon };
}

// ============================================================
// Algorithms (operating on segments with cost matrices)
// ============================================================

// Nearest-neighbor chain on segments
// Returns ordered list of {segId, entryPort, exitPort, segCost, transitionCost}
function chainNN(segs, startIdx) {
    if (segs.length === 0) return [];
    const remaining = new Set(segs.map((_, i) => i));
    const chain = [];

    let ci = startIdx;
    remaining.delete(ci);
    let s = segs[ci];
    // Start: pick cheapest through-traversal
    let bestExit = 2, bestCost = s.costMatrix[0][2]; // default S_L -> E_L
    for (let ep = 0; ep < 4; ep++) {
        for (let xp = 0; xp < 4; xp++) {
            if (ep === xp && s.startNode !== s.endNode) continue; // skip same-end for non-cul-de-sac unless out-and-back makes sense
            if (s.costMatrix[ep][xp] < bestCost) {
                bestCost = s.costMatrix[ep][xp];
                bestExit = xp;
            }
        }
    }
    chain.push({ segId: s.id, entryPort: 0, exitPort: bestExit, segCost: bestCost, transitionCost: 0 });

    while (remaining.size > 0) {
        const lastSeg = segById.get(chain[chain.length - 1].segId);
        const lastExit = chain[chain.length - 1].exitPort;
        const exitNode = lastExit < 2 ? lastSeg.startNode : lastSeg.endNode;

        let bestIdx = -1, bestTotal = Infinity, bestEP = 0, bestXP = 0, bestTrans = 0, bestSC = 0;

        for (const idx of remaining) {
            const cand = segs[idx];
            // Try all entry ports
            for (let ep = 0; ep < 4; ep++) {
                const entryNode = ep < 2 ? cand.startNode : cand.endNode;
                const trans = nodeDist(exitNode, entryNode);
                // Try all exit ports
                for (let xp = 0; xp < 4; xp++) {
                    const sc = cand.costMatrix[ep][xp];
                    if (sc === Infinity) continue;
                    const total = trans + sc;
                    if (total < bestTotal) {
                        bestTotal = total;
                        bestIdx = idx;
                        bestEP = ep;
                        bestXP = xp;
                        bestTrans = trans;
                        bestSC = sc;
                    }
                }
            }
        }

        if (bestIdx < 0) break;
        remaining.delete(bestIdx);
        chain.push({
            segId: segs[bestIdx].id,
            entryPort: bestEP, exitPort: bestXP,
            segCost: bestSC, transitionCost: bestTrans
        });
    }
    return chain;
}

// Right-hand rule chain
function chainRH(segs, startIdx) {
    if (segs.length === 0) return [];
    const remaining = new Set(segs.map((_, i) => i));
    const chain = [];

    function bearing(lat1, lon1, lat2, lon2) {
        const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
        const dLon = toRad(lon2 - lon1);
        const y = Math.sin(dLon) * Math.cos(toRad(lat2));
        const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
                  Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
        return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }

    let ci = startIdx;
    remaining.delete(ci);
    let s = segs[ci];
    const c = segCentroid(s);
    // Default: enter at S, exit at E (through-traversal)
    chain.push({ segId: s.id, entryPort: 0, exitPort: 2, segCost: s.costMatrix[0][2], transitionCost: 0 });

    let heading = 0;
    if (s.polyline.length >= 2) {
        const p0 = s.polyline[0], p1 = s.polyline[s.polyline.length - 1];
        heading = bearing(p0[0], p0[1], p1[0], p1[1]);
    }

    while (remaining.size > 0) {
        const lastSeg = segById.get(chain[chain.length - 1].segId);
        const lastExit = chain[chain.length - 1].exitPort;
        const exitNode = lastExit < 2 ? lastSeg.startNode : lastSeg.endNode;
        const exitPl = lastSeg.polyline;
        const exitLat = lastExit < 2 ? exitPl[0][0] : exitPl[exitPl.length-1][0];
        const exitLon = lastExit < 2 ? exitPl[0][1] : exitPl[exitPl.length-1][1];

        let bestIdx = -1, bestScore = Infinity, bestEP = 0, bestXP = 0, bestTrans = 0, bestSC = 0;

        for (const idx of remaining) {
            const cand = segs[idx];
            for (let ep = 0; ep < 4; ep++) {
                const entryNode = ep < 2 ? cand.startNode : cand.endNode;
                const trans = nodeDist(exitNode, entryNode);
                const entryPl = cand.polyline;
                const entryLat = ep < 2 ? entryPl[0][0] : entryPl[entryPl.length-1][0];
                const entryLon = ep < 2 ? entryPl[0][1] : entryPl[entryPl.length-1][1];
                const bear = bearing(exitLat, exitLon, entryLat, entryLon);
                const turn = (bear - heading + 360) % 360;

                for (let xp = 0; xp < 4; xp++) {
                    const sc = cand.costMatrix[ep][xp];
                    if (sc === Infinity) continue;
                    const score = trans + turn * 0.5 + sc * 0.1; // weight: distance + turn + segment cost
                    if (score < bestScore) {
                        bestScore = score;
                        bestIdx = idx;
                        bestEP = ep;
                        bestXP = xp;
                        bestTrans = trans;
                        bestSC = sc;
                    }
                }
            }
        }

        if (bestIdx < 0) break;
        remaining.delete(bestIdx);
        const cand = segs[bestIdx];
        chain.push({
            segId: cand.id, entryPort: bestEP, exitPort: bestXP,
            segCost: bestSC, transitionCost: bestTrans
        });

        // Update heading
        const pl = cand.polyline;
        if (pl.length >= 2) {
            if (bestXP < 2) { // exiting at S end
                heading = bearing(pl[pl.length-1][0], pl[pl.length-1][1], pl[0][0], pl[0][1]);
            } else { // exiting at E end
                heading = bearing(pl[0][0], pl[0][1], pl[pl.length-1][0], pl[pl.length-1][1]);
            }
        }
    }
    return chain;
}

// Slice a chain into N partitions by address count
function sliceChain(chain, n) {
    const totalAddrs = chain.reduce((s, e) => s + (segById.get(e.segId)?.addressCount || 0), 0);
    const target = Math.ceil(totalAddrs / n);
    const partitions = Array.from({ length: n }, () => []);
    let pi = 0, count = 0;
    for (const entry of chain) {
        partitions[pi].push(entry);
        count += segById.get(entry.segId)?.addressCount || 0;
        if (count >= target && pi < n - 1) { pi++; count = 0; }
    }
    return partitions;
}

// Recursive geographic bisection on segments
function bisectSegments(segs, n) {
    if (n <= 1 || segs.length <= 1) return [segs];
    const centroids = segs.map(s => segCentroid(s));
    const lats = centroids.map(c => c.lat), lons = centroids.map(c => c.lon);
    const latRange = Math.max(...lats) - Math.min(...lats);
    const lonRange = Math.max(...lons) - Math.min(...lons);

    const indexed = segs.map((s, i) => ({ s, c: centroids[i] }));
    indexed.sort((a, b) => latRange > lonRange ? a.c.lat - b.c.lat : a.c.lon - b.c.lon);

    // Split by address count, not segment count
    const totalAddrs = segs.reduce((sum, s) => sum + (s.addressCount || 0), 0);
    const lN = Math.ceil(n / 2), rN = n - lN;
    const targetLeft = Math.round(totalAddrs * lN / n);
    let cumAddrs = 0, splitIdx = 0;
    for (let i = 0; i < indexed.length; i++) {
        cumAddrs += indexed[i].s.addressCount || 0;
        if (cumAddrs >= targetLeft) { splitIdx = i + 1; break; }
    }
    if (splitIdx === 0) splitIdx = 1;
    if (splitIdx >= indexed.length) splitIdx = indexed.length - 1;

    const leftSegs = indexed.slice(0, splitIdx).map(x => x.s);
    const rightSegs = indexed.slice(splitIdx).map(x => x.s);
    return [...bisectSegments(leftSegs, lN), ...bisectSegments(rightSegs, rN)];
}

// Score a set of partitions
function scorePartitions(partitions) {
    const walks = partitions.map(part => {
        let productive = 0, unproductive = 0;
        for (const e of part) {
            productive += e.segCost;
            unproductive += e.transitionCost;
        }
        return { productive, unproductive, total: productive + unproductive,
                 addrs: part.reduce((s, e) => s + (segById.get(e.segId)?.addressCount || 0), 0) };
    });
    const maxWalk = Math.max(...walks.map(w => w.total));
    const totalWalk = walks.reduce((s, w) => s + w.total, 0);
    const totalProd = walks.reduce((s, w) => s + w.productive, 0);
    const totalUnprod = walks.reduce((s, w) => s + w.unproductive, 0);
    const targetCount = walks.reduce((s, w) => s + w.addrs, 0) / walks.length;
    const imbalance = walks.reduce((s, w) => s + Math.abs(w.addrs - targetCount), 0) / targetCount;
    const score = 2 * maxWalk + totalWalk + 5000 * imbalance;
    return { walks, maxWalk, totalWalk, totalProd, totalUnprod, score, imbalance };
}

// Run NN chain on a partition (for bisect post-processing)
function chainPartition(segs) {
    if (segs.length === 0) return [];
    // Try a few starts, pick best
    const maxStarts = Math.min(segs.length, 10);
    let bestChain = null, bestCost = Infinity;
    for (let si = 0; si < maxStarts; si++) {
        const idx = Math.floor(si * segs.length / maxStarts);
        const chain = chainNN(segs, idx);
        const cost = chain.reduce((s, e) => s + e.segCost + e.transitionCost, 0);
        if (cost < bestCost) { bestCost = cost; bestChain = chain; }
    }
    return bestChain || [];
}

// ============================================================
// Run study per neighborhood
// ============================================================
// Group addresses by neighborhood
const hoodAddrs = new Map();
for (const a of data.addresses) {
    if (!hoodAddrs.has(a.neighborhood)) hoodAddrs.set(a.neighborhood, []);
    hoodAddrs.get(a.neighborhood).push(a);
}

// Get segments for a neighborhood
function getHoodSegments(hood) {
    const addrs = hoodAddrs.get(hood) || [];
    const segIds = new Set();
    for (const a of addrs) {
        const sid = gidToSeg.get(a.gid);
        if (sid !== undefined && segById.has(sid)) segIds.add(sid);
    }
    return [...segIds].map(id => segById.get(id));
}

console.log("\n=== Segment-Based Assignment Study ===\n");
console.log("Neighborhood          | Addrs | Segs | N | Strategy   | Max Walk | Total   | Productive | Unproductive | Score");
console.log("----------------------|-------|------|---|------------|----------|---------|------------|--------------|--------");

const allResults = [];
const trailData = []; // For map visualization

const testHoods = [...hoodAddrs.entries()]
    .filter(([_, addrs]) => addrs.length >= 50 && addrs.length <= 1500)
    .sort((a, b) => a[1].length - b[1].length);

// Sample ~8 neighborhoods across the size range
const step = Math.max(1, Math.floor(testHoods.length / 8));
const selected = [];
for (let i = 0; i < testHoods.length; i += step) selected.push(testHoods[i]);
// Ensure Fairmeadow and Crescent Park are included
for (const name of ["Fairmeadow", "Crescent Park"]) {
    if (!selected.find(([n]) => n === name)) {
        const found = testHoods.find(([n]) => n === name);
        if (found) selected.push(found);
    }
}

for (const [hood, addrs] of selected) {
    const segs = getHoodSegments(hood);
    if (segs.length < 3) continue;

    // Precompute distance matrix for this neighborhood's intersection nodes
    const hoodNodes = new Set();
    for (const s of segs) { hoodNodes.add(s.startNode); hoodNodes.add(s.endNode); }
    console.log(`  Precomputing distances for ${hood} (${hoodNodes.size} nodes, ${segs.length} segments)...`);
    const t0 = Date.now();
    precomputeDistances(hoodNodes);
    console.log(`  Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    for (const n of [3, 5]) {
        const results = {};

        // Strategy A: NN Chain (try multiple starts)
        const maxStarts = Math.min(segs.length, 15);
        let bestNNParts = null, bestNNScore = Infinity;
        for (let si = 0; si < maxStarts; si++) {
            const idx = Math.floor(si * segs.length / maxStarts);
            const chain = chainNN(segs, idx);
            const parts = sliceChain(chain, n);
            const sc = scorePartitions(parts);
            if (sc.score < bestNNScore) { bestNNScore = sc.score; bestNNParts = parts; }
        }
        const nnResult = scorePartitions(bestNNParts);
        results.chainNN = nnResult;

        // Strategy B: RH Chain (try multiple starts)
        let bestRHParts = null, bestRHScore = Infinity;
        for (let si = 0; si < maxStarts; si++) {
            const idx = Math.floor(si * segs.length / maxStarts);
            const chain = chainRH(segs, idx);
            const parts = sliceChain(chain, n);
            const sc = scorePartitions(parts);
            if (sc.score < bestRHScore) { bestRHScore = sc.score; bestRHParts = parts; }
        }
        const rhResult = scorePartitions(bestRHParts);
        results.chainRH = rhResult;

        // Strategy C: Bisect
        const bisectParts = bisectSegments(segs, n).map(part => chainPartition(part));
        const bisectResult = scorePartitions(bisectParts);
        results.bisect = bisectResult;

        // Find winner
        const best = [
            { name: "ChainNN", r: nnResult },
            { name: "ChainRH", r: rhResult },
            { name: "Bisect", r: bisectResult }
        ].sort((a, b) => a.r.score - b.r.score)[0];

        const pad = (s, w) => String(s).padEnd(w);
        for (const [sname, r] of [["ChainNN", nnResult], ["ChainRH", rhResult], ["Bisect", bisectResult]]) {
            const mark = sname === best.name ? "*" : " ";
            console.log(
                `${pad(hood, 22)}| ${pad(addrs.length, 5)} | ${pad(segs.length, 4)} | ${n} | ${pad(sname + mark, 10)} | ` +
                `${pad(Math.round(r.maxWalk) + "m", 8)} | ${pad(Math.round(r.totalWalk) + "m", 7)} | ` +
                `${pad(Math.round(r.totalProd) + "m", 10)} | ${pad(Math.round(r.totalUnprod) + "m", 12)} | ${Math.round(r.score)}`
            );
        }

        allResults.push({ hood, addrs: addrs.length, segs: segs.length, n, results, winner: best.name });

        // Save trail data for winner (for map visualization)
        if (n === 3 && (hood === "Fairmeadow" || hood === "Crescent Park")) {
            const winnerParts = best.name === "ChainNN" ? bestNNParts :
                                best.name === "ChainRH" ? bestRHParts : bisectParts;
            for (let esw = 0; esw < winnerParts.length; esw++) {
                const trail = { hood, strategy: best.name, esw, segments: [], transitions: [] };
                for (const entry of winnerParts[esw]) {
                    const seg = segById.get(entry.segId);
                    if (!seg) continue;
                    // Segment polyline (blue part)
                    const pl = entry.entryPort < 2 ? seg.polyline : [...seg.polyline].reverse();
                    trail.segments.push({
                        segId: seg.id, name: seg.name,
                        polyline: pl,
                        cost: entry.segCost,
                        addresses: seg.addressCount
                    });
                }
                // Transitions between segments (red part)
                for (let i = 1; i < winnerParts[esw].length; i++) {
                    const prev = segById.get(winnerParts[esw][i-1].segId);
                    const curr = segById.get(winnerParts[esw][i].segId);
                    if (!prev || !curr) continue;
                    const prevExit = winnerParts[esw][i-1].exitPort;
                    const currEntry = winnerParts[esw][i].entryPort;
                    // Get actual road-following path between exit and entry nodes
                    const exitNode = prevExit < 2 ? prev.startNode : prev.endNode;
                    const entryNode = currEntry < 2 ? curr.startNode : curr.endNode;
                    const roadPoly = nodePathPolyline(exitNode, entryNode);
                    trail.transitions.push({
                        polyline: roadPoly.length > 0 ? roadPoly : [
                            prevExit < 2 ? prev.polyline[0] : prev.polyline[prev.polyline.length-1],
                            currEntry < 2 ? curr.polyline[0] : curr.polyline[curr.polyline.length-1]
                        ],
                        cost: winnerParts[esw][i].transitionCost
                    });
                }
                trailData.push(trail);
            }
        }

        console.log(""); // blank line between neighborhoods
    }
}

// ============================================================
// Summary
// ============================================================
console.log("\n=== Summary ===");
const winCounts = { ChainNN: { 3: 0, 5: 0 }, ChainRH: { 3: 0, 5: 0 }, Bisect: { 3: 0, 5: 0 } };
for (const r of allResults) winCounts[r.winner][r.n]++;
console.log("Winner counts:");
for (const [name, counts] of Object.entries(winCounts)) {
    console.log(`  ${name}: N=3: ${counts[3]}, N=5: ${counts[5]}`);
}

// Productive vs unproductive analysis
const prodRatios = allResults.map(r => {
    const best = r.results[r.winner.charAt(0).toLowerCase() === 'c' ?
        (r.winner === 'ChainNN' ? 'chainNN' : 'chainRH') : 'bisect'];
    return { hood: r.hood, n: r.n, ratio: best.totalUnprod / best.totalWalk };
});
const avgUnprodRatio = prodRatios.reduce((s, r) => s + r.ratio, 0) / prodRatios.length;
console.log(`\nAverage unproductive walking ratio: ${(avgUnprodRatio * 100).toFixed(1)}%`);

// ============================================================
// Save trail data for visualization
// ============================================================
const trailPath = path.join(__dirname, "..", "data", "trail-data.json");
fs.writeFileSync(trailPath, JSON.stringify(trailData, null, 2));
console.log(`\nTrail data saved to ${trailPath} (${trailData.length} ESW trails)`);

// Save results summary
const resultsPath = path.join(__dirname, "..", "data", "segment-study-results.json");
fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
console.log(`Results saved to ${resultsPath}`);

console.log("\nDone.");
