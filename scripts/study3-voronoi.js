#!/usr/bin/env node
// Study III: Road-network Voronoi partitioning
//
// Each ESW's territory is a Voronoi cell — the set of segments closer
// to that ESW's seed point than to any other seed. Using road-network
// (Dijkstra) distances, not Euclidean, so cells follow street connectivity.
//
// Guarantees geographic contiguity by construction.
// Lloyd's iteration adjusts seeds to balance time.

const fs = require("fs");
const path = require("path");

const T_ASSESS = parseFloat(process.env.T_ASSESS || "5");
const SPEED = 83.33; // m/min

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "network-extract.json"), "utf8"));
const fireData = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "fire-stations.json"), "utf8"));

const segById = new Map();
for (const s of data.segments) segById.set(s.id, s);
const gidToSeg = new Map();
for (const snap of data.addressSnapping) gidToSeg.set(snap.gid, snap.segmentId);

// Road network adjacency
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

// Multi-source Dijkstra: assigns each node to the nearest seed
// Returns Map<nodeId, {seedIdx, dist}>
function multiSourceDijkstra(seedNodes, allNodes, maxDist = 15000) {
    const assignment = new Map(); // nodeId -> {seedIdx, dist}
    const visited = new Set();
    const queue = [];

    for (let i = 0; i < seedNodes.length; i++) {
        const nid = seedNodes[i];
        assignment.set(nid, { seedIdx: i, dist: 0 });
        queue.push({ node: nid, d: 0, seedIdx: i });
    }

    while (queue.length > 0) {
        let mi = 0;
        for (let i = 1; i < queue.length; i++) if (queue[i].d < queue[mi].d) mi = i;
        const { node, d, seedIdx } = queue[mi];
        queue[mi] = queue[queue.length - 1]; queue.pop();

        if (visited.has(node)) continue;
        visited.add(node);

        for (const edge of (nodeAdj.get(node) || [])) {
            const nd = d + edge.dist;
            if (nd > maxDist) continue;
            const existing = assignment.get(edge.to);
            if (!existing || nd < existing.dist) {
                assignment.set(edge.to, { seedIdx, dist: nd });
                queue.push({ node: edge.to, d: nd, seedIdx });
            }
        }
    }
    return assignment;
}

// Assign segments to Voronoi cells based on their midpoint node
function assignSegmentsToCells(segs, seedNodes, nodeAssignment) {
    const cells = Array.from({ length: seedNodes.length }, () => []);
    for (const seg of segs) {
        // Use the segment's start node for assignment
        // (could also use midpoint; start is simpler and deterministic)
        const a1 = nodeAssignment.get(seg.startNode);
        const a2 = nodeAssignment.get(seg.endNode);
        // Assign to the cell of the closer endpoint
        const assignment = (a1 && a2) ? (a1.dist <= a2.dist ? a1 : a2) :
                           a1 ? a1 : a2;
        if (assignment) {
            cells[assignment.seedIdx].push(seg);
        }
    }
    return cells;
}

// Build NN chain within a cell
function chainNN(segs, distLookup) {
    if (segs.length === 0) return [];
    if (segs.length === 1) {
        const s = segs[0];
        const minCost = Math.min(...s.costMatrix.flat().filter(v => v < Infinity));
        return [{ segId: s.id, entryPort: 0, exitPort: 2, segCost: s.costMatrix[0][2], transitionCost: 0 }];
    }

    // Try a few starts
    let bestChain = null, bestCost = Infinity;
    const maxStarts = Math.min(segs.length, 5);
    for (let si = 0; si < maxStarts; si++) {
        const startIdx = Math.floor(si * segs.length / maxStarts);
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
                    const trans = distLookup(exitNode, entryNode);
                    for (let xp = 0; xp < 4; xp++) {
                        const sc = cand.costMatrix[ep][xp];
                        if (sc === Infinity) continue;
                        if (trans + sc < bestTotal) {
                            bestTotal = trans + sc; bestIdx = idx; bestEP = ep; bestXP = xp;
                            bestTrans = trans; bestSC = sc;
                        }
                    }
                }
            }
            if (bestIdx < 0) break;
            remaining.delete(bestIdx);
            chain.push({ segId: segs[bestIdx].id, entryPort: bestEP, exitPort: bestXP, segCost: bestSC, transitionCost: bestTrans });
        }

        const cost = chain.reduce((s, e) => s + e.segCost + e.transitionCost, 0);
        if (cost < bestCost) { bestCost = cost; bestChain = chain; }
    }
    return bestChain || [];
}

function segCentroid(seg) {
    const pl = seg.polyline;
    return { lat: pl.reduce((s, p) => s + p[0], 0) / pl.length,
             lon: pl.reduce((s, p) => s + p[1], 0) / pl.length };
}

function cellTime(chain, huddleNode, distLookup) {
    if (chain.length === 0) return { time: 0, addrs: 0, walkDist: 0, prodDist: 0, unprodDist: 0 };
    const firstSeg = segById.get(chain[0].segId);
    const firstNode = chain[0].entryPort < 2 ? firstSeg.startNode : firstSeg.endNode;
    const walkToFirst = distLookup(huddleNode, firstNode);

    let prod = 0, unprod = 0, addrs = 0;
    for (const e of chain) {
        prod += e.segCost; unprod += e.transitionCost;
        addrs += segById.get(e.segId)?.addressCount || 0;
    }
    const totalWalk = walkToFirst + prod + unprod;
    return {
        time: totalWalk / SPEED + addrs * T_ASSESS,
        addrs, walkDist: totalWalk, prodDist: prod, unprodDist: unprod + walkToFirst,
        walkQuality: prod / totalWalk
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
    for (const a of addrs) {
        const sid = gidToSeg.get(a.gid);
        if (sid !== undefined && segById.has(sid)) segIds.add(sid);
    }
    return [...segIds].map(id => segById.get(id));
}

console.log(`Study III: Voronoi partitioning (t_assess=${T_ASSESS}min)\n`);
console.log("Neighborhood          | Addrs | Segs | N | MaxTime | Spread  | WalkQual | Addrs/ESW      | vs S1 oracle");
console.log("----------------------|-------|------|---|---------|---------|----------|----------------|-------------");

const allResults = [];
const selected = [...hoodAddrs.entries()]
    .filter(([name, addrs]) => (addrs.length >= 50 && addrs.length <= 350) || name === "Fairmeadow")
    .sort((a, b) => a[1].length - b[1].length);

for (const [hood, addrs] of selected) {
    const segs = getHoodSegments(hood);
    if (segs.length < 3) continue;

    const fmAssign = fireData.neighborhoodAssignments.find(a => a.hood === hood);
    if (!fmAssign) continue;

    // Collect all hood nodes
    const hoodNodes = new Set();
    for (const s of segs) { hoodNodes.add(s.startNode); hoodNodes.add(s.endNode); }
    const hoodNodeList = [...hoodNodes];

    // Find huddle node
    let huddleNode = null, huddleDist = Infinity;
    for (const nid of hoodNodes) {
        for (const s of segs) {
            let lat, lon;
            if (s.startNode === nid) { lat = s.polyline[0][0]; lon = s.polyline[0][1]; }
            else if (s.endNode === nid) { lat = s.polyline[s.polyline.length-1][0]; lon = s.polyline[s.polyline.length-1][1]; }
            else continue;
            const R = 6371000, toRad = d => d * Math.PI / 180;
            const dLat = toRad(lat - fmAssign.stationLat), dLon = toRad(lon - fmAssign.stationLon);
            const a2 = Math.sin(dLat/2)**2 + Math.cos(toRad(fmAssign.stationLat))*Math.cos(toRad(lat))*Math.sin(dLon/2)**2;
            const d = R * 2 * Math.atan2(Math.sqrt(a2), Math.sqrt(1 - a2));
            if (d < huddleDist) { huddleDist = d; huddleNode = nid; }
            break;
        }
    }

    // Precompute all-pairs distances (needed for Voronoi + chain building)
    const distMap = new Map();
    for (const nid of hoodNodes) {
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
        distMap.set(nid, dist);
    }
    function distLookup(n1, n2) {
        if (n1 === n2) return 0;
        return distMap.get(n1)?.get(n2) ?? Infinity;
    }

    for (const n of [3, 5]) {
        // Initialize seeds using address-count-balanced partitioning
        // Sort segments by address-weighted position along longer axis, then
        // split at cumulative address count boundaries
        const centroids = segs.map(s => segCentroid(s));
        const lats = centroids.map(c => c.lat), lons = centroids.map(c => c.lon);
        const latRange = Math.max(...lats) - Math.min(...lats);
        const lonRange = Math.max(...lons) - Math.min(...lons);
        const sorted = [...segs].map((s, i) => ({ s, c: centroids[i] }))
            .sort((a, b) => latRange > lonRange ? a.c.lat - b.c.lat : a.c.lon - b.c.lon);

        const totalA = sorted.reduce((s, x) => s + (x.s.addressCount || 0), 0);
        let seedNodes = [];
        let cumAddrs = 0;
        let nextBound = totalA / (2 * n); // place seed at midpoint of each partition
        for (const item of sorted) {
            cumAddrs += item.s.addressCount || 0;
            if (cumAddrs >= nextBound && seedNodes.length < n) {
                seedNodes.push(item.s.startNode);
                nextBound += totalA / n;
            }
        }
        // Fill remaining seeds if needed
        while (seedNodes.length < n) {
            const idx = Math.floor(seedNodes.length * sorted.length / n);
            seedNodes.push(sorted[idx].s.startNode);
        }

        // Try multiple seed initializations: the address-balanced one + random permutations
        let globalBestMaxTime = Infinity, globalBestCells = null, globalBestChains = null;
        const seedInits = [seedNodes];
        // Add random restarts
        for (let r = 0; r < 5; r++) {
            const shuffled = [...segs];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            const randomSeeds = [];
            for (let i = 0; i < n; i++) {
                randomSeeds.push(shuffled[Math.floor((i + 0.5) * shuffled.length / n)].startNode);
            }
            seedInits.push(randomSeeds);
        }

        for (const initSeeds of seedInits) {
        seedNodes = [...initSeeds];

        // Lloyd's iteration
        let bestMaxTime = Infinity, bestCells = null, bestChains = null;

        for (let iter = 0; iter < 20; iter++) {
            // Assign nodes to nearest seed via multi-source Dijkstra
            const nodeAssignment = multiSourceDijkstra(seedNodes, hoodNodeList);

            // Assign segments to cells
            const cells = assignSegmentsToCells(segs, seedNodes, nodeAssignment);

            // Build chains within each cell
            const chains = cells.map(cell => chainNN(cell, distLookup));

            // Evaluate
            const times = chains.map(c => cellTime(c, huddleNode, distLookup));
            const maxTime = Math.max(...times.map(t => t.time));

            if (maxTime < bestMaxTime) {
                bestMaxTime = maxTime;
                bestCells = cells;
                bestChains = chains;
            }

            // Time-balanced Lloyd's: move heavy-cell seeds AWAY from their
            // centroid (to shrink the cell) and light-cell seeds TOWARD
            // nearby heavy cells (to absorb addresses)
            const avgTime = times.reduce((s, t) => s + t.time, 0) / n;
            const newSeeds = [...seedNodes];

            // Build a map from node to coords for fast lookup
            const nodeCoords = new Map();
            for (const s of segs) {
                if (!nodeCoords.has(s.startNode)) nodeCoords.set(s.startNode, { lat: s.polyline[0][0], lon: s.polyline[0][1] });
                if (!nodeCoords.has(s.endNode)) nodeCoords.set(s.endNode, { lat: s.polyline[s.polyline.length-1][0], lon: s.polyline[s.polyline.length-1][1] });
            }

            for (let k = 0; k < n; k++) {
                if (cells[k].length === 0) continue;

                // Compute address-weighted centroid of this cell
                let totalWeight = 0, latSum = 0, lonSum = 0;
                for (const seg of cells[k]) {
                    const c = segCentroid(seg);
                    const w = seg.addressCount || 1;
                    latSum += c.lat * w; lonSum += c.lon * w; totalWeight += w;
                }
                if (totalWeight === 0) continue;
                const centLat = latSum / totalWeight, centLon = lonSum / totalWeight;

                // If this cell is heavy, move seed toward cell edge (away from centroid)
                // If light, move toward centroid (standard Lloyd's)
                const timeRatio = times[k].time / avgTime;
                let targetLat, targetLon;
                if (timeRatio > 1.1) {
                    // Heavy: move seed away from centroid to shrink cell
                    const seedCoord = nodeCoords.get(seedNodes[k]);
                    if (seedCoord) {
                        targetLat = seedCoord.lat + (seedCoord.lat - centLat) * 0.3;
                        targetLon = seedCoord.lon + (seedCoord.lon - centLon) * 0.3;
                    } else {
                        targetLat = centLat; targetLon = centLon;
                    }
                } else {
                    // Normal or light: move toward centroid
                    targetLat = centLat; targetLon = centLon;
                }

                // Find nearest hood node to target
                let bestNode = seedNodes[k], bestDist = Infinity;
                for (const [nid, coord] of nodeCoords) {
                    const d = Math.abs(coord.lat - targetLat) + Math.abs(coord.lon - targetLon);
                    if (d < bestDist) { bestDist = d; bestNode = nid; }
                }
                newSeeds[k] = bestNode;
            }

            // Check convergence
            const changed = newSeeds.some((s, i) => s !== seedNodes[i]);
            seedNodes = newSeeds;
            if (!changed) break;
        }

        if (bestMaxTime < globalBestMaxTime) {
            globalBestMaxTime = bestMaxTime;
            globalBestCells = bestCells;
            globalBestChains = bestChains;
        }
        } // end seed initialization loop

        bestChains = globalBestChains;
        bestCells = globalBestCells;

        // Evaluate final result
        const finalTimes = bestChains.map(c => cellTime(c, huddleNode, distLookup));
        const maxTime = Math.max(...finalTimes.map(t => t.time));
        const minTime = Math.min(...finalTimes.map(t => t.time));
        const spread = maxTime - minTime;
        const avgWalkQuality = finalTimes.reduce((s, t) => s + (t.walkQuality || 0), 0) / n;
        const addrDist = finalTimes.map(t => t.addrs).join("/");

        // Compare with Study I oracle (load from results)
        let s1MaxWalk = "N/A";
        try {
            const s1r = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "segment-study-results.json"), "utf8"));
            const s1match = s1r.find(x => x.hood === hood && x.n === n);
            if (s1match) {
                const keyMap = { ChainNN:'chainNN', ChainRH:'chainRH', Bisect:'bisect', TwoOpt:'twoOpt' };
                const s1best = s1match.results[keyMap[s1match.winner]];
                if (s1best) s1MaxWalk = Math.round(s1best.maxWalk) + "m";
            }
        } catch(e) {}

        const pad = (s, w) => String(s).padEnd(w);
        console.log(
            `${pad(hood, 22)}| ${pad(addrs.length, 5)} | ${pad(segs.length, 4)} | ${n} | ` +
            `${pad(maxTime.toFixed(0) + "min", 7)} | ${pad(spread.toFixed(0) + "min", 7)} | ` +
            `${pad((avgWalkQuality * 100).toFixed(0) + "%", 8)} | ${pad(addrDist, 14)} | ${s1MaxWalk}`
        );

        allResults.push({
            hood, addrs: addrs.length, segs: segs.length, n,
            maxTime, spread, avgWalkQuality,
            times: finalTimes, cells: bestCells?.map(c => c.length)
        });
    }
    console.log("");
}

// Summary
console.log("=== Summary ===");
const walkQualities = allResults.map(r => r.avgWalkQuality);
console.log(`Walk quality: avg=${(walkQualities.reduce((s,v)=>s+v,0)/walkQualities.length*100).toFixed(0)}%, min=${(Math.min(...walkQualities)*100).toFixed(0)}%, max=${(Math.max(...walkQualities)*100).toFixed(0)}%`);
const spreads = allResults.map(r => r.spread);
console.log(`Time spread: avg=${(spreads.reduce((s,v)=>s+v,0)/spreads.length).toFixed(0)}min, max=${Math.max(...spreads).toFixed(0)}min`);

const resultsPath = path.join(__dirname, "..", "data", "study3-results.json");
fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
console.log(`\nResults saved to ${resultsPath}`);
