#!/usr/bin/env node
// Unified simulation: all algorithms × all neighborhoods × all metrics
//
// Algorithms:
//   1. Chain+Slice (NN) — nearest-neighbor chain, slice at count boundaries
//   2. Right-Hand Rule — directional-bias chain, slice at count boundaries
//   3. 2-Opt — NN chain + 2-opt local search, then slice
//   4. Recursive Bisection — geographic split, NN chain within each partition
//   5. Voronoi + Balanced Seeds — Euclidean Voronoi with greedy seed search
//   6. BFS from Huddle — round-robin assignment from fire station fan-out
//   7. DFS from Huddle — sequential assignment from fire station fan-out
//   8. SA Post-Processing — boundary transfers on BFS result
//   5b. Voronoi + Boundary Transfer — balanced seeds + contiguity-preserving transfers
//   9. Oracle — best of algorithms 1-5 by scoring function
//
// Metrics (computed for every algorithm × neighborhood × N):
//   M1. Walk quality: productive / total walking (per ESW min, avg)
//   M2. Time spread: max T_k - min T_k (minutes, at t_assess=5min)
//   M3. Productive/unproductive decomposition: total km of each
//
// Neighborhoods (5 diverse):
//   Palo Alto Central, Fairmeadow, Community Center, Research Park, Southgate
//
// N values: 3, 5, 7, 10

const fs = require("fs");
const path = require("path");

const T_ASSESS = 5; // min per address
const SPEED = 83.33; // m/min (5 km/h)

console.log("Unified Simulation");
console.log("t_assess=" + T_ASSESS + "min, speed=" + (SPEED*60/1000).toFixed(0) + "km/h\n");

// ============================================================
// Load data
// ============================================================
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "network-extract.json"), "utf8"));
const fireData = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "fire-stations.json"), "utf8"));

const segById = new Map();
for (const s of data.segments) segById.set(s.id, s);
const gidToSeg = new Map();
for (const snap of data.addressSnapping) gidToSeg.set(snap.gid, snap.segmentId);

// Road network
const allSegsArr = [...data.segments, ...(data.roadSegments || [])];
const nodeAdj = new Map();
for (const s of allSegsArr) {
    const sn = s.startNode, en = s.endNode;
    if (sn === en) continue;
    if (!nodeAdj.has(sn)) nodeAdj.set(sn, []);
    if (!nodeAdj.has(en)) nodeAdj.set(en, []);
    nodeAdj.get(sn).push({ to: en, dist: s.distance });
    nodeAdj.get(en).push({ to: sn, dist: s.distance });
}

// ============================================================
// Distance infrastructure
// ============================================================
let distMatrix = null;

function precomputeDistances(nodeIds) {
    distMatrix = new Map();
    for (const nid of nodeIds) {
        const dist = new Map([[nid, 0]]);
        const visited = new Set();
        const queue = [{ node: nid, d: 0 }];
        while (queue.length > 0) {
            let mi = 0;
            for (let i = 1; i < queue.length; i++) if (queue[i].d < queue[mi].d) mi = i;
            const { node, d } = queue[mi];
            queue[mi] = queue[queue.length - 1]; queue.pop();
            if (visited.has(node)) continue;
            visited.add(node);
            for (const edge of (nodeAdj.get(node) || [])) {
                const nd = d + edge.dist;
                if (nd > 15000) continue;
                if (nd < (dist.get(edge.to) ?? Infinity)) {
                    dist.set(edge.to, nd);
                    queue.push({ node: edge.to, d: nd });
                }
            }
        }
        distMatrix.set(nid, dist);
    }
}

function nodeDist(n1, n2) {
    if (n1 === n2) return 0;
    return distMatrix?.get(n1)?.get(n2) ?? Infinity;
}

function eucDist(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * 111000;
    const dLon = (lon2 - lon1) * 111000 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
}

function segCentroid(seg) {
    const pl = seg.polyline;
    return { lat: pl.reduce((s, p) => s + p[0], 0) / pl.length,
             lon: pl.reduce((s, p) => s + p[1], 0) / pl.length };
}

// ============================================================
// Unified evaluation: compute all 3 metrics for a partition
// ============================================================
function evaluate(partitions, huddleNode) {
    const eswResults = partitions.map(part => {
        if (part.length === 0) return { time: 0, addrs: 0, prodDist: 0, unprodDist: 0, walkDist: 0, walkQuality: 1 };

        const firstSeg = segById.get(part[0].segId);
        const firstNode = part[0].entryPort < 2 ? firstSeg.startNode : firstSeg.endNode;
        const walkToFirst = huddleNode ? nodeDist(huddleNode, firstNode) : 0;

        let prod = 0, unprod = 0, addrs = 0;
        for (const e of part) {
            prod += e.segCost;
            unprod += e.transitionCost;
            addrs += segById.get(e.segId)?.addressCount || 0;
        }
        const totalWalk = walkToFirst + prod + unprod;
        const walkQuality = totalWalk > 0 ? prod / totalWalk : 1;
        const time = totalWalk / SPEED + addrs * T_ASSESS;

        return { time, addrs, prodDist: prod, unprodDist: unprod + walkToFirst, walkDist: totalWalk, walkQuality };
    });

    const times = eswResults.map(e => e.time);
    const activeResults = eswResults.filter(e => e.addrs > 0);
    const maxTime = Math.max(...times);
    const minTime = activeResults.length > 0 ? Math.min(...activeResults.map(e => e.time)) : 0;

    return {
        perEsw: eswResults,
        // M1: Walk quality
        minWalkQuality: activeResults.length > 0 ? Math.min(...activeResults.map(e => e.walkQuality)) : 1,
        avgWalkQuality: activeResults.length > 0 ? activeResults.reduce((s, e) => s + e.walkQuality, 0) / activeResults.length : 1,
        // M2: Time spread
        maxTime,
        timeSpread: maxTime - minTime,
        // M3: Productive/unproductive decomposition
        totalProd: eswResults.reduce((s, e) => s + e.prodDist, 0),
        totalUnprod: eswResults.reduce((s, e) => s + e.unprodDist, 0),
        totalWalk: eswResults.reduce((s, e) => s + e.walkDist, 0),
        totalAddrs: eswResults.reduce((s, e) => s + e.addrs, 0),
        addrCounts: eswResults.map(e => e.addrs)
    };
}

// ============================================================
// Algorithm 1: Chain+Slice (NN)
// ============================================================
function chainNN(segs, startIdx) {
    if (segs.length === 0) return [];
    const remaining = new Set(segs.map((_, i) => i));
    const chain = [];
    let ci = startIdx; remaining.delete(ci);
    let s = segs[ci];
    chain.push({ segId: s.id, entryPort: 0, exitPort: 2, segCost: s.costMatrix[0][2], transitionCost: 0 });
    while (remaining.size > 0) {
        const last = chain[chain.length - 1];
        const lastSeg = segById.get(last.segId);
        const exitNode = last.exitPort < 2 ? lastSeg.startNode : lastSeg.endNode;
        let bestIdx = -1, bestTotal = Infinity, bestEP = 0, bestXP = 0, bestTrans = 0, bestSC = 0;
        for (const idx of remaining) {
            const cand = segs[idx];
            for (let ep = 0; ep < 4; ep++) {
                const entryNode = ep < 2 ? cand.startNode : cand.endNode;
                const trans = nodeDist(exitNode, entryNode);
                for (let xp = 0; xp < 4; xp++) {
                    const sc = cand.costMatrix[ep][xp];
                    if (sc === Infinity) continue;
                    if (trans + sc < bestTotal) { bestTotal = trans + sc; bestIdx = idx; bestEP = ep; bestXP = xp; bestTrans = trans; bestSC = sc; }
                }
            }
        }
        if (bestIdx < 0) break;
        remaining.delete(bestIdx);
        chain.push({ segId: segs[bestIdx].id, entryPort: bestEP, exitPort: bestXP, segCost: bestSC, transitionCost: bestTrans });
    }
    return chain;
}

function sliceChain(chain, n) {
    const totalAddrs = chain.reduce((s, e) => s + (segById.get(e.segId)?.addressCount || 0), 0);
    const target = Math.ceil(totalAddrs / n);
    const parts = Array.from({ length: n }, () => []);
    let pi = 0, count = 0;
    for (const e of chain) {
        parts[pi].push(e);
        count += segById.get(e.segId)?.addressCount || 0;
        if (count >= target && pi < n - 1) { pi++; count = 0; }
    }
    return parts;
}

function runChainNN(segs, n) {
    const maxStarts = Math.min(segs.length, 15);
    let bestParts = null, bestScore = Infinity;
    for (let si = 0; si < maxStarts; si++) {
        const idx = Math.floor(si * segs.length / maxStarts);
        const chain = chainNN(segs, idx);
        const parts = sliceChain(chain, n);
        const ev = evaluate(parts, null);
        const score = 2 * ev.maxTime + ev.totalWalk / SPEED + 5000 * ev.timeSpread;
        if (score < bestScore) { bestScore = score; bestParts = parts; }
    }
    return bestParts;
}

// ============================================================
// Algorithm 2: Right-Hand Rule Chain
// ============================================================
function chainRH(segs, startIdx) {
    if (segs.length === 0) return [];
    function bearing(lat1, lon1, lat2, lon2) {
        const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
        const dLon = toRad(lon2 - lon1);
        const y = Math.sin(dLon) * Math.cos(toRad(lat2));
        const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
        return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }
    const remaining = new Set(segs.map((_, i) => i));
    const chain = [];
    let ci = startIdx; remaining.delete(ci);
    let s = segs[ci];
    chain.push({ segId: s.id, entryPort: 0, exitPort: 2, segCost: s.costMatrix[0][2], transitionCost: 0 });
    let heading = 0;
    if (s.polyline.length >= 2) {
        heading = bearing(s.polyline[0][0], s.polyline[0][1], s.polyline[s.polyline.length-1][0], s.polyline[s.polyline.length-1][1]);
    }
    while (remaining.size > 0) {
        const last = chain[chain.length - 1];
        const lastSeg = segById.get(last.segId);
        const exitNode = last.exitPort < 2 ? lastSeg.startNode : lastSeg.endNode;
        const exitPl = lastSeg.polyline;
        const exitLat = last.exitPort < 2 ? exitPl[0][0] : exitPl[exitPl.length-1][0];
        const exitLon = last.exitPort < 2 ? exitPl[0][1] : exitPl[exitPl.length-1][1];

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
                    const score = trans + turn * 0.5 + sc * 0.1;
                    if (score < bestScore) { bestScore = score; bestIdx = idx; bestEP = ep; bestXP = xp; bestTrans = trans; bestSC = sc; }
                }
            }
        }
        if (bestIdx < 0) break;
        remaining.delete(bestIdx);
        const cand = segs[bestIdx];
        chain.push({ segId: cand.id, entryPort: bestEP, exitPort: bestXP, segCost: bestSC, transitionCost: bestTrans });
        const pl = cand.polyline;
        if (bestXP < 2) heading = bearing(pl[pl.length-1][0], pl[pl.length-1][1], pl[0][0], pl[0][1]);
        else heading = bearing(pl[0][0], pl[0][1], pl[pl.length-1][0], pl[pl.length-1][1]);
    }
    return chain;
}

function runChainRH(segs, n) {
    const maxStarts = Math.min(segs.length, 15);
    let bestParts = null, bestScore = Infinity;
    for (let si = 0; si < maxStarts; si++) {
        const idx = Math.floor(si * segs.length / maxStarts);
        const chain = chainRH(segs, idx);
        const parts = sliceChain(chain, n);
        const ev = evaluate(parts, null);
        const score = 2 * ev.maxTime + ev.totalWalk / SPEED + 5000 * ev.timeSpread;
        if (score < bestScore) { bestScore = score; bestParts = parts; }
    }
    return bestParts;
}

// ============================================================
// Algorithm 3: 2-Opt Local Search
// ============================================================
function twoOptImprove(chain) {
    if (chain.length < 4) return chain;
    let current = [...chain];
    function transitionBetween(a, b) {
        const segA = segById.get(a.segId), segB = segById.get(b.segId);
        const exitNode = a.exitPort < 2 ? segA.startNode : segA.endNode;
        const entryNode = b.entryPort < 2 ? segB.startNode : segB.endNode;
        return nodeDist(exitNode, entryNode);
    }
    for (let pass = 0; pass < 200; pass++) {
        let improved = false;
        for (let i = 1; i < current.length - 1; i++) {
            for (let j = i + 1; j < current.length; j++) {
                const costBefore = transitionBetween(current[i-1], current[i]) +
                    (j + 1 < current.length ? transitionBetween(current[j], current[j+1]) : 0);
                const reversed = [];
                for (let k = j; k >= i; k--) {
                    const e = current[k]; const seg = segById.get(e.segId);
                    reversed.push({ segId: e.segId, entryPort: e.exitPort, exitPort: e.entryPort,
                        segCost: seg.costMatrix[e.exitPort][e.entryPort], transitionCost: 0 });
                }
                const costAfter = transitionBetween(current[i-1], reversed[0]) +
                    (j + 1 < current.length ? transitionBetween(reversed[reversed.length-1], current[j+1]) : 0);
                let segDelta = 0;
                for (let k = 0; k < reversed.length; k++) segDelta += reversed[k].segCost - current[i+k].segCost;
                if (costAfter + segDelta < costBefore - 0.1) {
                    for (let k = 0; k < reversed.length; k++) current[i+k] = reversed[k];
                    for (let k = Math.max(1, i); k <= Math.min(j+1, current.length-1); k++)
                        current[k].transitionCost = transitionBetween(current[k-1], current[k]);
                    improved = true;
                }
            }
        }
        if (!improved) break;
    }
    current[0].transitionCost = 0;
    for (let k = 1; k < current.length; k++)
        current[k].transitionCost = transitionBetween(current[k-1], current[k]);
    return current;
}

function runTwoOpt(segs, n) {
    const maxStarts = Math.min(segs.length, 15);
    let bestParts = null, bestScore = Infinity;
    for (let si = 0; si < maxStarts; si++) {
        const idx = Math.floor(si * segs.length / maxStarts);
        const chain = chainNN(segs, idx);
        const improved = twoOptImprove(chain);
        const parts = sliceChain(improved, n);
        const ev = evaluate(parts, null);
        const score = 2 * ev.maxTime + ev.totalWalk / SPEED + 5000 * ev.timeSpread;
        if (score < bestScore) { bestScore = score; bestParts = parts; }
    }
    return bestParts;
}

// ============================================================
// Algorithm 4: Recursive Bisection
// ============================================================
function bisectSegments(segs, n) {
    if (n <= 1 || segs.length <= 1) return [segs];
    const centroids = segs.map(s => segCentroid(s));
    const lats = centroids.map(c => c.lat), lons = centroids.map(c => c.lon);
    const latRange = Math.max(...lats) - Math.min(...lats);
    const lonRange = Math.max(...lons) - Math.min(...lons);
    const indexed = segs.map((s, i) => ({ s, c: centroids[i] }));
    indexed.sort((a, b) => latRange > lonRange ? a.c.lat - b.c.lat : a.c.lon - b.c.lon);
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
    return [...bisectSegments(indexed.slice(0, splitIdx).map(x => x.s), lN),
            ...bisectSegments(indexed.slice(splitIdx).map(x => x.s), rN)];
}

function runBisect(segs, n) {
    const groups = bisectSegments(segs, n);
    const parts = groups.map(group => {
        if (group.length === 0) return [];
        const maxStarts = Math.min(group.length, 5);
        let bestChain = null, bestCost = Infinity;
        for (let si = 0; si < maxStarts; si++) {
            const chain = chainNN(group, Math.floor(si * group.length / maxStarts));
            const cost = chain.reduce((s, e) => s + e.segCost + e.transitionCost, 0);
            if (cost < bestCost) { bestCost = cost; bestChain = chain; }
        }
        return bestChain || [];
    });
    return parts;
}

// ============================================================
// Algorithm 5: Voronoi + Balanced Seeds
// ============================================================
function runVoronoi(segs, n) {
    const centroids = segs.map(s => segCentroid(s));
    const nodeCoords = new Map();
    for (const s of segs) {
        if (!nodeCoords.has(s.startNode)) nodeCoords.set(s.startNode, { lat: s.polyline[0][0], lon: s.polyline[0][1] });
        if (!nodeCoords.has(s.endNode)) nodeCoords.set(s.endNode, { lat: s.polyline[s.polyline.length-1][0], lon: s.polyline[s.polyline.length-1][1] });
    }
    const nodeList = [...nodeCoords.keys()];
    const totalA = segs.reduce((s, seg) => s + (seg.addressCount || 0), 0);

    function assignCells(seeds) {
        const cells = Array.from({ length: n }, () => []);
        for (let si = 0; si < segs.length; si++) {
            const seg = segs[si]; const c = centroids[si];
            let bestK = 0, bestDist = Infinity;
            for (let k = 0; k < n; k++) {
                const d = eucDist(c.lat, c.lon, seeds[k].lat, seeds[k].lon);
                if (d < bestDist) { bestDist = d; bestK = k; }
            }
            const pl = seg.polyline;
            if (pl.length >= 2) {
                let startK = 0, endK = 0, sBest = Infinity, eBest = Infinity;
                for (let k = 0; k < n; k++) {
                    const ds = eucDist(pl[0][0], pl[0][1], seeds[k].lat, seeds[k].lon);
                    const de = eucDist(pl[pl.length-1][0], pl[pl.length-1][1], seeds[k].lat, seeds[k].lon);
                    if (ds < sBest) { sBest = ds; startK = k; }
                    if (de < eBest) { eBest = de; endK = k; }
                }
                if (startK !== endK) bestK = startK;
            }
            cells[bestK].push(si);
        }
        return cells;
    }

    function cellImbalance(cells) {
        const counts = cells.map(c => c.reduce((s, si) => s + (segs[si].addressCount || 0), 0));
        const target = totalA / n;
        return counts.reduce((s, c) => s + Math.abs(c - target), 0);
    }

    // Initialize + Lloyd's + greedy search
    let bestSeeds = null, bestImb = Infinity;
    for (let restart = 0; restart < 10; restart++) {
        const lats = centroids.map(c => c.lat);
        const sorted = [...segs].map((s, i) => ({ s, c: centroids[i] }))
            .sort((a, b) => restart === 0 ? a.c.lat - b.c.lat : Math.random() - 0.5);
        let seeds = Array.from({ length: n }, (_, i) => ({ ...sorted[Math.floor((i + 0.5) * sorted.length / n)].c }));

        // Lloyd's
        for (let iter = 0; iter < 20; iter++) {
            const cells = assignCells(seeds);
            let converged = true;
            for (let k = 0; k < n; k++) {
                if (cells[k].length === 0) continue;
                let tw = 0, latS = 0, lonS = 0;
                for (const si of cells[k]) { const c = centroids[si]; const w = segs[si].addressCount || 1; latS += c.lat*w; lonS += c.lon*w; tw += w; }
                const nl = latS/tw, no = lonS/tw;
                if (Math.abs(nl - seeds[k].lat) > 1e-6 || Math.abs(no - seeds[k].lon) > 1e-6) converged = false;
                seeds[k] = { lat: nl, lon: no };
            }
            if (converged) break;
        }

        // Greedy per-seed improvement
        for (let gIter = 0; gIter < 10; gIter++) {
            let improved = false;
            for (let k = 0; k < n; k++) {
                for (let c = 0; c < 50; c++) {
                    const candCoord = nodeCoords.get(nodeList[Math.floor(Math.random() * nodeList.length)]);
                    const testSeeds = seeds.map((s, i) => i === k ? candCoord : s);
                    const cells = assignCells(testSeeds);
                    const imb = cellImbalance(cells);
                    if (imb < bestImb) { bestImb = imb; bestSeeds = [...testSeeds]; seeds[k] = candCoord; improved = true; }
                }
            }
            if (!improved) break;
        }

        const cells = assignCells(seeds);
        const imb = cellImbalance(cells);
        if (imb < bestImb || !bestSeeds) { bestImb = imb; bestSeeds = [...seeds]; }
    }

    // Build NN chains within each cell
    const cells = assignCells(bestSeeds);
    const parts = cells.map(cell => {
        const cellSegs = cell.map(si => segs[si]);
        if (cellSegs.length === 0) return [];
        const maxStarts = Math.min(cellSegs.length, 5);
        let bestChain = null, bestCost = Infinity;
        for (let si = 0; si < maxStarts; si++) {
            const chain = chainNN(cellSegs, Math.floor(si * cellSegs.length / maxStarts));
            const cost = chain.reduce((s, e) => s + e.segCost + e.transitionCost, 0);
            if (cost < bestCost) { bestCost = cost; bestChain = chain; }
        }
        return bestChain || [];
    });
    return parts;
}

// ============================================================
// Algorithm 5b: Voronoi + Boundary Transfer
// ============================================================
function runVoronoiBT(segs, n, huddleNode) {
    // Start from Voronoi balanced-seeds result
    const voronoiParts = runVoronoi(segs, n);

    // Build segment adjacency from shared intersection nodes
    const segIdToIdx = new Map();
    for (let i = 0; i < segs.length; i++) segIdToIdx.set(segs[i].id, i);
    const nodeToSegIdx = new Map();
    for (let i = 0; i < segs.length; i++) {
        for (const nid of [segs[i].startNode, segs[i].endNode]) {
            if (!nodeToSegIdx.has(nid)) nodeToSegIdx.set(nid, []);
            nodeToSegIdx.get(nid).push(i);
        }
    }
    const segNeighbors = new Map();
    for (const [nid, idxs] of nodeToSegIdx) {
        for (let i = 0; i < idxs.length; i++) {
            for (let j = i + 1; j < idxs.length; j++) {
                if (!segNeighbors.has(idxs[i])) segNeighbors.set(idxs[i], new Set());
                if (!segNeighbors.has(idxs[j])) segNeighbors.set(idxs[j], new Set());
                segNeighbors.get(idxs[i]).add(idxs[j]);
                segNeighbors.get(idxs[j]).add(idxs[i]);
            }
        }
    }

    // Track which cell each segment belongs to (by segment index)
    const segToCell = new Map();
    const cellSets = voronoiParts.map((part, k) => {
        const idxs = new Set();
        for (const entry of part) {
            const idx = segIdToIdx.get(entry.segId);
            if (idx !== undefined) { idxs.add(idx); segToCell.set(idx, k); }
        }
        return idxs;
    });

    function wouldDisconnect(cellSet, removeIdx) {
        const remaining = new Set(cellSet);
        remaining.delete(removeIdx);
        if (remaining.size <= 1) return remaining.size === 0;
        const start = remaining.values().next().value;
        const visited = new Set([start]);
        const queue = [start];
        while (queue.length > 0) {
            const cur = queue.shift();
            for (const nb of (segNeighbors.get(cur) || [])) {
                if (remaining.has(nb) && !visited.has(nb)) { visited.add(nb); queue.push(nb); }
            }
        }
        return visited.size < remaining.size;
    }

    function cellTime(cellSet) {
        const addrs = [...cellSet].reduce((s, idx) => s + (segs[idx].addressCount || 0), 0);
        const dist = [...cellSet].reduce((s, idx) => s + (segs[idx].distance || 0), 0);
        return dist / SPEED + addrs * T_ASSESS;
    }

    // Boundary transfer: move segments from heaviest to lightest cell
    for (let iter = 0; iter < 200; iter++) {
        const times = cellSets.map(set => cellTime(set));
        const maxTime = Math.max(...times);
        const heavyIdx = times.indexOf(maxTime);
        let bestTransfer = null, bestImprovement = 0;

        for (const segIdx of cellSets[heavyIdx]) {
            const neighbors = segNeighbors.get(segIdx) || new Set();
            const adjacentCells = new Set();
            for (const nb of neighbors) {
                const nc = segToCell.get(nb);
                if (nc !== undefined && nc !== heavyIdx) adjacentCells.add(nc);
            }
            if (adjacentCells.size === 0) continue;
            if (wouldDisconnect(cellSets[heavyIdx], segIdx)) continue;

            for (const targetCell of adjacentCells) {
                const newHeavy = new Set(cellSets[heavyIdx]); newHeavy.delete(segIdx);
                const newTarget = new Set(cellSets[targetCell]); newTarget.add(segIdx);
                const newMax = Math.max(cellTime(newHeavy), cellTime(newTarget),
                    ...times.filter((_, i) => i !== heavyIdx && i !== targetCell));
                const improvement = maxTime - newMax;
                if (improvement > bestImprovement) {
                    bestImprovement = improvement;
                    bestTransfer = { segIdx, from: heavyIdx, to: targetCell };
                }
            }
        }

        if (!bestTransfer || bestImprovement < 0.5) break;
        cellSets[bestTransfer.from].delete(bestTransfer.segIdx);
        cellSets[bestTransfer.to].add(bestTransfer.segIdx);
        segToCell.set(bestTransfer.segIdx, bestTransfer.to);
    }

    // Build NN chains within each resulting cell
    const parts = cellSets.map(cellSet => {
        const cellSegs = [...cellSet].map(idx => segs[idx]);
        if (cellSegs.length === 0) return [];
        const maxStarts = Math.min(cellSegs.length, 5);
        let bestChain = null, bestCost = Infinity;
        for (let si = 0; si < maxStarts; si++) {
            const chain = chainNN(cellSegs, Math.floor(si * cellSegs.length / maxStarts));
            const cost = chain.reduce((s, e) => s + e.segCost + e.transitionCost, 0);
            if (cost < bestCost) { bestCost = cost; bestChain = chain; }
        }
        return bestChain || [];
    });
    return parts;
}

// ============================================================
// Algorithm 6: BFS
// ============================================================
function runBFS(segs, n, huddleNode) {
    const assignments = Array.from({ length: n }, () => []);
    const frontiers = Array.from({ length: n }, () => huddleNode);
    const remaining = new Set(segs.map((_, i) => i));

    while (remaining.size > 0) {
        for (let k = 0; k < n && remaining.size > 0; k++) {
            let bestIdx = -1, bestCost = Infinity, bestEntry = {};
            for (const idx of remaining) {
                const seg = segs[idx];
                for (let ep = 0; ep < 4; ep++) {
                    const entryNode = ep < 2 ? seg.startNode : seg.endNode;
                    const trans = nodeDist(frontiers[k], entryNode);
                    for (let xp = 0; xp < 4; xp++) {
                        const sc = seg.costMatrix[ep][xp];
                        if (sc === Infinity) continue;
                        if (trans + sc < bestCost) { bestCost = trans + sc; bestIdx = idx; bestEntry = { entryPort: ep, exitPort: xp, segCost: sc, transitionCost: trans }; }
                    }
                }
            }
            if (bestIdx < 0) break;
            remaining.delete(bestIdx);
            assignments[k].push({ segId: segs[bestIdx].id, ...bestEntry });
            frontiers[k] = bestEntry.exitPort < 2 ? segs[bestIdx].startNode : segs[bestIdx].endNode;
        }
    }
    return assignments;
}

// ============================================================
// Algorithm 7: DFS from Huddle
// ============================================================
function runDFS(segs, n, huddleNode) {
    const totalProd = segs.reduce((s, seg) => { const mc = Math.min(...seg.costMatrix.flat().filter(v => v < Infinity)); return s + mc; }, 0);
    const totalAddrs = segs.reduce((s, seg) => s + (seg.addressCount || 0), 0);
    const targetTime = (totalProd / SPEED + totalAddrs * T_ASSESS) / n;

    const assignments = Array.from({ length: n }, () => []);
    const remaining = new Set(segs.map((_, i) => i));

    for (let k = 0; k < n && remaining.size > 0; k++) {
        let frontier = huddleNode;
        let eswTime = 0;
        while (remaining.size > 0) {
            if (k === n - 1) {
                // Last ESW takes all
                while (remaining.size > 0) {
                    let bestIdx = -1, bestCost = Infinity, bestEntry = {};
                    for (const idx of remaining) {
                        const seg = segs[idx];
                        for (let ep = 0; ep < 4; ep++) {
                            const entryNode = ep < 2 ? seg.startNode : seg.endNode;
                            const trans = nodeDist(frontier, entryNode);
                            for (let xp = 0; xp < 4; xp++) {
                                const sc = seg.costMatrix[ep][xp];
                                if (sc === Infinity) continue;
                                if (trans + sc < bestCost) { bestCost = trans + sc; bestIdx = idx; bestEntry = { entryPort: ep, exitPort: xp, segCost: sc, transitionCost: trans }; }
                            }
                        }
                    }
                    if (bestIdx < 0) break;
                    remaining.delete(bestIdx);
                    assignments[k].push({ segId: segs[bestIdx].id, ...bestEntry });
                    frontier = bestEntry.exitPort < 2 ? segs[bestIdx].startNode : segs[bestIdx].endNode;
                }
                break;
            }
            let bestIdx = -1, bestCost = Infinity, bestEntry = {}, bestMarginal = 0;
            for (const idx of remaining) {
                const seg = segs[idx];
                for (let ep = 0; ep < 4; ep++) {
                    const entryNode = ep < 2 ? seg.startNode : seg.endNode;
                    const trans = nodeDist(frontier, entryNode);
                    for (let xp = 0; xp < 4; xp++) {
                        const sc = seg.costMatrix[ep][xp];
                        if (sc === Infinity) continue;
                        if (trans + sc < bestCost) { bestCost = trans + sc; bestIdx = idx; bestEntry = { entryPort: ep, exitPort: xp, segCost: sc, transitionCost: trans };
                            bestMarginal = (trans + sc) / SPEED + (seg.addressCount || 0) * T_ASSESS; }
                    }
                }
            }
            if (bestIdx < 0) break;
            if (eswTime + bestMarginal > targetTime * 1.1 && assignments[k].length > 0) break;
            remaining.delete(bestIdx);
            assignments[k].push({ segId: segs[bestIdx].id, ...bestEntry });
            frontier = bestEntry.exitPort < 2 ? segs[bestIdx].startNode : segs[bestIdx].endNode;
            eswTime += bestMarginal;
        }
    }
    return assignments;
}

// ============================================================
// Algorithm 8: SA Post-Processing (on BFS)
// ============================================================
function runBFSplusSA(segs, n, huddleNode) {
    const bfsParts = runBFS(segs, n, huddleNode);
    let current = bfsParts.map(p => [...p]);
    let currentEval = evaluate(current, huddleNode);
    let bestParts = current.map(p => [...p]);
    let bestMax = currentEval.maxTime;

    let T = currentEval.timeSpread * 0.5 || 10;
    const alpha = Math.pow(0.01 / Math.max(T, 0.1), 1 / 500);

    for (let iter = 0; iter < 500; iter++) {
        const times = current.map(p => evaluate([p], huddleNode).maxTime);
        const heavyIdx = times.indexOf(Math.max(...times));
        if (current[heavyIdx].length <= 1) { T *= alpha; continue; }
        const segIdx = current[heavyIdx].length - 1;
        const seg = current[heavyIdx][segIdx];
        let toEsw = Math.floor(Math.random() * (n - 1));
        if (toEsw >= heavyIdx) toEsw++;

        const newFrom = [...current[heavyIdx]]; newFrom.splice(segIdx, 1);
        const newTo = [...current[toEsw], seg];
        const candidate = current.map((p, i) => i === heavyIdx ? newFrom : i === toEsw ? newTo : p);
        const candEval = evaluate(candidate, huddleNode);
        const delta = candEval.maxTime - currentEval.maxTime;

        if (delta < 0 || Math.random() < Math.exp(-delta / T)) {
            current = candidate;
            currentEval = candEval;
            if (currentEval.maxTime < bestMax) { bestMax = currentEval.maxTime; bestParts = current.map(p => [...p]); }
        }
        T *= alpha;
    }
    return bestParts;
}

// ============================================================
// Algorithm 9: Oracle (best of 1-5)
// ============================================================
function runOracle(segs, n) {
    const candidates = [
        { name: "ChainNN", parts: runChainNN(segs, n) },
        { name: "ChainRH", parts: runChainRH(segs, n) },
        { name: "TwoOpt", parts: runTwoOpt(segs, n) },
        { name: "Bisect", parts: runBisect(segs, n) },
    ];
    let best = null, bestScore = Infinity;
    for (const c of candidates) {
        const ev = evaluate(c.parts, null);
        const score = 2 * ev.maxTime + ev.totalWalk / SPEED + 5000 * ev.timeSpread;
        if (score < bestScore) { bestScore = score; best = c; }
    }
    return { parts: best.parts, winner: best.name };
}


// ============================================================
// Random baseline: shuffle segments, slice, NN chain within each
// ============================================================
function runRandom(segs, n, iterations = 30) {
    let bestParts = null, bestScore = Infinity;
    for (let iter = 0; iter < iterations; iter++) {
        const shuffled = [...segs];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const totalAddrs = shuffled.reduce((s, seg) => s + (seg.addressCount || 0), 0);
        const target = Math.ceil(totalAddrs / n);
        const groups = Array.from({ length: n }, () => []);
        let gi = 0, count = 0;
        for (const seg of shuffled) {
            groups[gi].push(seg);
            count += seg.addressCount || 0;
            if (count >= target && gi < n - 1) { gi++; count = 0; }
        }
        const parts = groups.map(group => {
            if (group.length === 0) return [];
            const chain = chainNN(group, 0);
            return chain;
        });
        const ev = evaluate(parts, null);
        const score = 2 * ev.maxTime + ev.totalWalk / SPEED + 5000 * ev.timeSpread;
        if (score < bestScore) { bestScore = score; bestParts = parts; }
    }
    return bestParts;
}

// ============================================================
// Run unified simulation
// ============================================================
const hoodAddrs = new Map();
for (const a of data.addresses) {
    if (!hoodAddrs.has(a.neighborhood)) hoodAddrs.set(a.neighborhood, []);
    hoodAddrs.get(a.neighborhood).push(a);
}

function getHoodSegments(hood) {
    const addrs = hoodAddrs.get(hood) || [];
    const segIds = new Set();
    for (const a of addrs) { const sid = gidToSeg.get(a.gid); if (sid !== undefined && segById.has(sid)) segIds.add(sid); }
    return [...segIds].map(id => segById.get(id));
}

const NEIGHBORHOODS = ["Palo Alto Central", "Fairmeadow", "Community Center", "Research Park", "Southgate"];
const N_VALUES = [3, 5, 7, 10];

const allResults = [];

for (const hood of NEIGHBORHOODS) {
    const segs = getHoodSegments(hood);
    if (segs.length < 3) { console.log("SKIP " + hood); continue; }

    // Precompute distances
    const hoodNodes = new Set();
    for (const s of segs) { hoodNodes.add(s.startNode); hoodNodes.add(s.endNode); }

    // Find huddle node
    const fmAssign = fireData.neighborhoodAssignments.find(a => a.hood === hood);
    let huddleNode = null;
    if (fmAssign) {
        let huddleDist = Infinity;
        for (const nid of hoodNodes) {
            for (const s of segs) {
                let lat, lon;
                if (s.startNode === nid) { lat = s.polyline[0][0]; lon = s.polyline[0][1]; }
                else if (s.endNode === nid) { lat = s.polyline[s.polyline.length-1][0]; lon = s.polyline[s.polyline.length-1][1]; }
                else continue;
                const d = eucDist(lat, lon, fmAssign.stationLat, fmAssign.stationLon);
                if (d < huddleDist) { huddleDist = d; huddleNode = nid; }
                break;
            }
        }
    }
    hoodNodes.add(huddleNode);

    console.log(`\n${hood} (${hoodAddrs.get(hood).length} addrs, ${segs.length} segs)`);
    const t0 = Date.now();
    precomputeDistances(hoodNodes);
    console.log(`  Dijkstra: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    for (const n of N_VALUES) {
        console.log(`  N=${n}:`);

        const algorithms = [
            { name: "ChainNN", run: () => runChainNN(segs, n) },
            { name: "ChainRH", run: () => runChainRH(segs, n) },
            { name: "TwoOpt", run: () => runTwoOpt(segs, n) },
            { name: "Bisect", run: () => runBisect(segs, n) },
            { name: "Voronoi", run: () => runVoronoi(segs, n) },
            { name: "Voronoi+BT", run: () => runVoronoiBT(segs, n, huddleNode) },
            { name: "BFS", run: () => runBFS(segs, n, huddleNode) },
            { name: "DFS", run: () => runDFS(segs, n, huddleNode) },
            { name: "BFS+SA", run: () => runBFSplusSA(segs, n, huddleNode) },
            { name: "Random", run: () => runRandom(segs, n) },
        ];

        const results = {};
        for (const alg of algorithms) {
            const t1 = Date.now();
            const parts = alg.run();
            const elapsed = Date.now() - t1;

            const ev = evaluate(parts, huddleNode);

            results[alg.name] = {
                walkQuality: ev.avgWalkQuality,
                minWalkQuality: ev.minWalkQuality,
                totalProd: ev.totalProd,
                totalUnprod: ev.totalUnprod,
                maxWalk: Math.max(...ev.perEsw.map(e => e.walkDist)),
                maxTime: ev.maxTime,
                timeSpread: ev.timeSpread,
                addrCounts: ev.addrCounts,
                elapsed
            };

            const r = results[alg.name];
            console.log(`    ${alg.name.padEnd(10)} WQ=${(r.walkQuality*100).toFixed(0)}% prod=${(r.totalProd/1000).toFixed(1)}km unprod=${(r.totalUnprod/1000).toFixed(1)}km spread=${r.timeSpread.toFixed(0)}min addrs=${r.addrCounts.join("/")} (${elapsed}ms)`);
        }

        // Oracle
        const oracle = runOracle(segs, n);
        const oracleEv = evaluate(oracle.parts, huddleNode);
        results.Oracle = {
            walkQuality: oracleEv.avgWalkQuality,
            minWalkQuality: oracleEv.minWalkQuality,
            totalProd: oracleEv.totalProd,
            totalUnprod: oracleEv.totalUnprod,
            maxWalk: Math.max(...oracleEv.perEsw.map(e => e.walkDist)),
            maxTime: oracleEv.maxTime,
            timeSpread: oracleEv.timeSpread,
            addrCounts: oracleEv.addrCounts,
            winner: oracle.winner
        };
        const or = results.Oracle;
        console.log(`    Oracle     WQ=${(or.walkQuality*100).toFixed(0)}% prod=${(or.totalProd/1000).toFixed(1)}km unprod=${(or.totalUnprod/1000).toFixed(1)}km spread=${or.timeSpread.toFixed(0)}min winner=${or.winner}`);

        allResults.push({ hood, addrs: hoodAddrs.get(hood).length, segs: segs.length, n, results });
    }
}

// Save
const resultsPath = path.join(__dirname, "..", "data", "unified-results.json");
fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
console.log("\nResults saved to " + resultsPath);
