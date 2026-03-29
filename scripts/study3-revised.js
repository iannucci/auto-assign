#!/usr/bin/env node
// Study III Revised: Voronoi with balanced seeds + Euclidean assignment
// + straddling segment reassignment + NN chain within cells
//
// Improvements over original Study III:
// 1. Greedy hill-climbing seed search (not just Lloyd's)
// 2. Euclidean distance for cell assignment (consistent with partition lines)
// 3. Straddling segments reassigned wholly to one cell
// 4. Exhaustive seed search for small neighborhoods (≤41 nodes)

const fs = require("fs");
const path = require("path");

const T_ASSESS = parseFloat(process.env.T_ASSESS || "5");
const SPEED = 83.33;

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "network-extract.json"), "utf8"));
const fireData = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "fire-stations.json"), "utf8"));

const segById = new Map();
for (const s of data.segments) segById.set(s.id, s);
const gidToSeg = new Map();
for (const snap of data.addressSnapping) gidToSeg.set(snap.gid, snap.segmentId);

// Road network for Dijkstra (intra-cell routing)
const allSegs = [...data.segments, ...(data.roadSegments || [])];
const nodeAdj = new Map();
for (const s of allSegs) {
    const sn = s.startNode, en = s.endNode;
    if (sn === en) continue;
    if (!nodeAdj.has(sn)) nodeAdj.set(sn, []);
    if (!nodeAdj.has(en)) nodeAdj.set(en, []);
    nodeAdj.get(sn).push({ to: en, dist: s.distance });
    nodeAdj.get(en).push({ to: sn, dist: s.distance });
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

// Precompute Dijkstra distances for intra-cell routing
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

// Assign segments to Voronoi cells using Euclidean distance
// with straddling segment reassignment
function assignCells(segs, centroids, seeds) {
    const N = seeds.length;
    const cells = Array.from({ length: N }, () => []);
    for (let si = 0; si < segs.length; si++) {
        const seg = segs[si];
        const c = centroids[si];
        let bestK = 0, bestDist = Infinity;
        for (let k = 0; k < N; k++) {
            const d = eucDist(c.lat, c.lon, seeds[k].lat, seeds[k].lon);
            if (d < bestDist) { bestDist = d; bestK = k; }
        }
        // Check straddling
        const pl = seg.polyline;
        if (pl.length >= 2) {
            let startK = 0, endK = 0, sBest = Infinity, eBest = Infinity;
            for (let k = 0; k < N; k++) {
                const ds = eucDist(pl[0][0], pl[0][1], seeds[k].lat, seeds[k].lon);
                const de = eucDist(pl[pl.length-1][0], pl[pl.length-1][1], seeds[k].lat, seeds[k].lon);
                if (ds < sBest) { sBest = ds; startK = k; }
                if (de < eBest) { eBest = de; endK = k; }
            }
            if (startK !== endK) bestK = startK; // reassign straddler
        }
        cells[bestK].push(si);
    }
    return cells;
}

// Compute address count imbalance
function imbalance(cells, segs) {
    const counts = cells.map(c => c.reduce((s, si) => s + (segs[si].addressCount || 0), 0));
    const target = counts.reduce((s, c) => s + c, 0) / cells.length;
    return { counts, imb: counts.reduce((s, c) => s + Math.abs(c - target), 0) };
}

// NN chain within a cell (using road-network Dijkstra for transitions)
function chainCell(cellSegIndices, segs) {
    if (cellSegIndices.length === 0) return { time: 0, addrs: 0, walkDist: 0, prodDist: 0, walkQuality: 1 };
    const cellSegs = cellSegIndices.map(si => segs[si]);
    let totalProd = 0, totalUnprod = 0, totalAddrs = 0;
    const used = new Set();
    let curNode = cellSegs[0].startNode; // start from first segment

    for (let step = 0; step < cellSegs.length; step++) {
        let bestIdx = -1, bestCost = Infinity, bestEntry = {};
        for (let i = 0; i < cellSegs.length; i++) {
            if (used.has(i)) continue;
            const seg = cellSegs[i];
            for (let ep = 0; ep < 4; ep++) {
                const entryNode = ep < 2 ? seg.startNode : seg.endNode;
                const trans = nodeDist(curNode, entryNode);
                for (let xp = 0; xp < 4; xp++) {
                    const sc = seg.costMatrix[ep][xp];
                    if (sc === Infinity) continue;
                    if (trans + sc < bestCost) {
                        bestCost = trans + sc; bestIdx = i;
                        bestEntry = { ep, xp, trans, sc };
                    }
                }
            }
        }
        if (bestIdx < 0) break;
        used.add(bestIdx);
        totalProd += bestEntry.sc;
        totalUnprod += bestEntry.trans;
        totalAddrs += cellSegs[bestIdx].addressCount || 0;
        curNode = bestEntry.xp < 2 ? cellSegs[bestIdx].startNode : cellSegs[bestIdx].endNode;
    }

    const totalWalk = totalProd + totalUnprod;
    return {
        time: totalWalk / SPEED + totalAddrs * T_ASSESS,
        addrs: totalAddrs, walkDist: totalWalk, prodDist: totalProd,
        walkQuality: totalWalk > 0 ? totalProd / totalWalk : 1
    };
}

// ============================================================
// Main study
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

console.log("Study III Revised: Balanced Euclidean Voronoi\n");
console.log("Neighborhood          | Addrs | Segs | N | Addrs/Cell     | MaxTime | Spread  | WalkQual");
console.log("----------------------|-------|------|---|----------------|---------|---------|--------");

const allResults = [];
const selected = [...hoodAddrs.entries()]
    .filter(([name, addrs]) => (addrs.length >= 50 && addrs.length <= 700) || name === "Fairmeadow")
    .sort((a, b) => a[1].length - b[1].length);

for (const [hood, addrs] of selected) {
    const segs = getHoodSegments(hood);
    if (segs.length < 3) continue;

    const centroids = segs.map(s => segCentroid(s));
    const nodeCoords = new Map();
    for (const s of segs) {
        if (!nodeCoords.has(s.startNode)) nodeCoords.set(s.startNode, { lat: s.polyline[0][0], lon: s.polyline[0][1] });
        if (!nodeCoords.has(s.endNode)) nodeCoords.set(s.endNode, { lat: s.polyline[s.polyline.length-1][0], lon: s.polyline[s.polyline.length-1][1] });
    }
    const nodeList = [...nodeCoords.keys()];

    // Precompute Dijkstra for intra-cell routing
    const hoodNodes = new Set();
    for (const s of segs) { hoodNodes.add(s.startNode); hoodNodes.add(s.endNode); }
    precomputeDistances(hoodNodes);

    for (const n of [3, 5]) {
        const totalA = segs.reduce((s, seg) => s + (seg.addressCount || 0), 0);

        // Find balanced seeds
        let bestSeeds = null, bestImb = Infinity;

        if (nodeList.length <= 41 && n === 3) {
            // Exhaustive search for small neighborhoods
            for (let i = 0; i < nodeList.length; i++) {
                for (let j = i+1; j < nodeList.length; j++) {
                    for (let k = j+1; k < nodeList.length; k++) {
                        const seeds = [nodeCoords.get(nodeList[i]), nodeCoords.get(nodeList[j]), nodeCoords.get(nodeList[k])];
                        const cells = assignCells(segs, centroids, seeds);
                        const { imb } = imbalance(cells, segs);
                        if (imb < bestImb) { bestImb = imb; bestSeeds = seeds; }
                    }
                }
            }
        } else {
            // Greedy hill-climbing with random restarts
            for (let restart = 0; restart < 10; restart++) {
                // Initialize seeds spread along longer axis
                const lats = centroids.map(c => c.lat), lons = centroids.map(c => c.lon);
                const latRange = Math.max(...lats) - Math.min(...lats);
                const lonRange = Math.max(...lons) - Math.min(...lons);
                const sorted = [...segs].map((s, i) => ({ s, c: centroids[i] }))
                    .sort((a, b) => latRange > lonRange ? a.c.lat - b.c.lat : a.c.lon - b.c.lon);

                let seeds;
                if (restart === 0) {
                    // Spread evenly
                    seeds = Array.from({ length: n }, (_, i) =>
                        ({ ...sorted[Math.floor((i + 0.5) * sorted.length / n)].c }));
                } else {
                    // Random
                    const shuffled = [...sorted].sort(() => Math.random() - 0.5);
                    seeds = Array.from({ length: n }, (_, i) =>
                        ({ ...shuffled[Math.floor((i + 0.5) * shuffled.length / n)].c }));
                }

                // Lloyd's + greedy per-seed improvement
                for (let iter = 0; iter < 20; iter++) {
                    const cells = assignCells(segs, centroids, seeds);
                    // Move to centroid
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
                            const candIdx = Math.floor(Math.random() * nodeList.length);
                            const candCoord = nodeCoords.get(nodeList[candIdx]);
                            const testSeeds = seeds.map((s, i) => i === k ? candCoord : s);
                            const cells = assignCells(segs, centroids, testSeeds);
                            const { imb } = imbalance(cells, segs);
                            if (imb < bestImb) { bestImb = imb; bestSeeds = [...testSeeds]; seeds[k] = candCoord; improved = true; }
                        }
                    }
                    if (!improved) break;
                }

                const cells = assignCells(segs, centroids, seeds);
                const { imb } = imbalance(cells, segs);
                if (imb < bestImb || !bestSeeds) { bestImb = imb; bestSeeds = [...seeds]; }
            }
        }

        // Evaluate with best seeds
        const cells = assignCells(segs, centroids, bestSeeds);
        const cellResults = cells.map(c => chainCell(c, segs));
        const maxTime = Math.max(...cellResults.map(r => r.time));
        const minTime = Math.min(...cellResults.filter(r => r.addrs > 0).map(r => r.time));
        const spread = maxTime - minTime;
        const avgWQ = cellResults.reduce((s, r) => s + r.walkQuality, 0) / n;
        const addrDist = cellResults.map(r => r.addrs).join("/");

        const pad = (s, w) => String(s).padEnd(w);
        console.log(
            `${pad(hood, 22)}| ${pad(addrs.length, 5)} | ${pad(segs.length, 4)} | ${n} | ` +
            `${pad(addrDist, 14)} | ${pad(maxTime.toFixed(0) + "min", 7)} | ${pad(spread.toFixed(0) + "min", 7)} | ${(avgWQ*100).toFixed(0)}%`
        );

        allResults.push({
            hood, addrs: addrs.length, segs: segs.length, n,
            addrCounts: cellResults.map(r => r.addrs),
            maxTime, spread, avgWalkQuality: avgWQ,
            times: cellResults
        });
    }
    console.log("");
}

// Summary and comparison with original Study III
console.log("=== Summary ===");
const wqs = allResults.map(r => r.avgWalkQuality);
console.log("Walk quality: avg=" + (wqs.reduce((s,v)=>s+v,0)/wqs.length*100).toFixed(0) + "%, min=" + (Math.min(...wqs)*100).toFixed(0) + "%, max=" + (Math.max(...wqs)*100).toFixed(0) + "%");
const spreads = allResults.map(r => r.spread);
console.log("Time spread: avg=" + (spreads.reduce((s,v)=>s+v,0)/spreads.length).toFixed(0) + "min, max=" + Math.max(...spreads).toFixed(0) + "min");

// Compare with original
try {
    const orig = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "study3-results.json"), "utf8"));
    console.log("\nComparison with original Study III:");
    const origWQ = orig.map(r => r.avgWalkQuality);
    const origSpread = orig.map(r => r.spread);
    console.log("  Original: WQ avg=" + (origWQ.reduce((s,v)=>s+v,0)/origWQ.length*100).toFixed(0) + "%, spread avg=" + (origSpread.reduce((s,v)=>s+v,0)/origSpread.length).toFixed(0) + "min");
    console.log("  Revised:  WQ avg=" + (wqs.reduce((s,v)=>s+v,0)/wqs.length*100).toFixed(0) + "%, spread avg=" + (spreads.reduce((s,v)=>s+v,0)/spreads.length).toFixed(0) + "min");
} catch(e) {}

const resultsPath = path.join(__dirname, "..", "data", "study3-revised-results.json");
fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
console.log("\nResults saved to " + resultsPath);
