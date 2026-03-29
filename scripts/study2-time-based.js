#!/usr/bin/env node
// Study II: Time-based assignment from fire station huddle points
// Implements BFS, DFS, and SA post-processing with the time metric:
//   T_k = (d_road(H, first_k) + W_k^prod + W_k^unprod) / speed + |P_k| * t_assess
//
// Also runs Study I's oracle (chain+slice) with the time metric for comparison.

const fs = require("fs");
const path = require("path");

const T_ASSESS = parseFloat(process.env.T_ASSESS || "5"); // minutes per address
const SPEED = 83.33; // m/min (5 km/h)

console.log(`Study II: t_assess=${T_ASSESS} min, speed=${SPEED} m/min (${(SPEED*60/1000).toFixed(0)} km/h)`);

// ============================================================
// Load data
// ============================================================
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "network-extract.json"), "utf8"));
const fireData = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "fire-stations.json"), "utf8"));

const segById = new Map();
for (const s of data.segments) segById.set(s.id, s);

const gidToSeg = new Map();
for (const snap of data.addressSnapping) gidToSeg.set(snap.gid, snap.segmentId);

// ============================================================
// Road network adjacency (with polylines for path reconstruction)
// ============================================================
const allSegs = [...data.segments, ...(data.roadSegments || [])];
const nodeAdj = new Map();
for (const s of allSegs) {
    const sn = s.startNode, en = s.endNode;
    if (sn === en) continue;
    if (!nodeAdj.has(sn)) nodeAdj.set(sn, []);
    if (!nodeAdj.has(en)) nodeAdj.set(en, []);
    const pl = s.polyline || [];
    nodeAdj.get(sn).push({ to: en, dist: s.distance, polyline: pl });
    nodeAdj.get(en).push({ to: sn, dist: s.distance, polyline: [...pl].reverse() });
}

// Dijkstra: single-source distances + predecessors
function dijkstraAll(startNode, maxDist = 15000) {
    const dist = new Map([[startNode, 0]]);
    const prev = new Map();
    const visited = new Set();
    const queue = [{ node: startNode, d: 0 }];
    while (queue.length > 0) {
        let mi = 0;
        for (let i = 1; i < queue.length; i++) if (queue[i].d < queue[mi].d) mi = i;
        const { node, d } = queue[mi];
        queue[mi] = queue[queue.length - 1]; queue.pop();
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

let distMatrix = null;
function precomputeDistances(nodeIds, maxDist = 15000) {
    distMatrix = new Map();
    for (const nid of nodeIds) {
        distMatrix.set(nid, dijkstraAll(nid, maxDist).dist);
    }
}
function nodeDist(n1, n2) {
    if (n1 === n2) return 0;
    return distMatrix?.get(n1)?.get(n2) ?? Infinity;
}

// ============================================================
// Time calculation
// ============================================================
function eswTime(segments, huddleNode) {
    if (segments.length === 0) return { time: 0, walkTime: 0, assessTime: 0, addrs: 0, walkDist: 0 };

    // Walk from huddle to first segment entry
    const firstSeg = segById.get(segments[0].segId);
    const firstEntry = segments[0].entryPort;
    const firstNode = firstEntry < 2 ? firstSeg.startNode : firstSeg.endNode;
    const walkToFirst = nodeDist(huddleNode, firstNode);

    // Within-assignment walking
    let prodDist = 0, unprodDist = 0, totalAddrs = 0;
    for (const e of segments) {
        prodDist += e.segCost;
        unprodDist += e.transitionCost;
        totalAddrs += segById.get(e.segId)?.addressCount || 0;
    }

    const totalWalkDist = walkToFirst + prodDist + unprodDist;
    const walkTime = totalWalkDist / SPEED;
    const assessTime = totalAddrs * T_ASSESS;
    return { time: walkTime + assessTime, walkTime, assessTime, addrs: totalAddrs, walkDist: totalWalkDist, walkToFirst };
}

// ============================================================
// BFS: Round-robin assignment from huddle
// ============================================================
function assignBFS(segs, n, huddleNode) {
    const assignments = Array.from({ length: n }, () => []);
    const frontiers = Array.from({ length: n }, () => huddleNode); // current exit node per ESW
    const times = Array.from({ length: n }, () => 0);
    const addrCounts = Array.from({ length: n }, () => 0);
    const remaining = new Set(segs.map((_, i) => i));

    while (remaining.size > 0) {
        for (let k = 0; k < n && remaining.size > 0; k++) {
            // Find best segment for ESW k
            let bestIdx = -1, bestTime = Infinity, bestEntry = {}, bestTrans = 0;

            for (const idx of remaining) {
                const seg = segs[idx];
                for (let ep = 0; ep < 4; ep++) {
                    const entryNode = ep < 2 ? seg.startNode : seg.endNode;
                    const trans = nodeDist(frontiers[k], entryNode);
                    for (let xp = 0; xp < 4; xp++) {
                        const sc = seg.costMatrix[ep][xp];
                        if (sc === Infinity) continue;
                        const marginalWalk = (trans + sc) / SPEED;
                        const marginalAssess = (seg.addressCount || 0) * T_ASSESS;
                        const marginalTime = marginalWalk + marginalAssess;
                        if (marginalTime < bestTime) {
                            bestTime = marginalTime;
                            bestIdx = idx;
                            bestEntry = { entryPort: ep, exitPort: xp, segCost: sc, transitionCost: trans };
                        }
                    }
                }
            }

            if (bestIdx < 0) break;
            remaining.delete(bestIdx);
            const seg = segs[bestIdx];
            assignments[k].push({ segId: seg.id, ...bestEntry });
            frontiers[k] = bestEntry.exitPort < 2 ? seg.startNode : seg.endNode;
            times[k] += bestTime;
            addrCounts[k] += seg.addressCount || 0;
        }
    }

    return assignments;
}

// ============================================================
// DFS: Build one ESW at a time
// ============================================================
function assignDFS(segs, n, huddleNode) {
    // Estimate target time
    const totalProd = segs.reduce((s, seg) => {
        const minCost = Math.min(...seg.costMatrix.flat().filter(v => v < Infinity));
        return s + minCost;
    }, 0);
    const totalAddrs = segs.reduce((s, seg) => s + (seg.addressCount || 0), 0);
    const targetTime = (totalProd / SPEED + totalAddrs * T_ASSESS) / n;

    const assignments = Array.from({ length: n }, () => []);
    const remaining = new Set(segs.map((_, i) => i));

    for (let k = 0; k < n && remaining.size > 0; k++) {
        let frontier = huddleNode;
        let eswTime = 0;

        while (remaining.size > 0) {
            // For last ESW, take everything remaining
            if (k === n - 1) {
                // Greedily add all remaining by nearest
                while (remaining.size > 0) {
                    let bestIdx = -1, bestTotal = Infinity, bestEntry = {};
                    for (const idx of remaining) {
                        const seg = segs[idx];
                        for (let ep = 0; ep < 4; ep++) {
                            const entryNode = ep < 2 ? seg.startNode : seg.endNode;
                            const trans = nodeDist(frontier, entryNode);
                            for (let xp = 0; xp < 4; xp++) {
                                const sc = seg.costMatrix[ep][xp];
                                if (sc === Infinity) continue;
                                if (trans + sc < bestTotal) {
                                    bestTotal = trans + sc;
                                    bestIdx = idx;
                                    bestEntry = { entryPort: ep, exitPort: xp, segCost: sc, transitionCost: trans };
                                }
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

            // Find best next segment
            let bestIdx = -1, bestTotal = Infinity, bestEntry = {}, bestMarginal = 0;
            for (const idx of remaining) {
                const seg = segs[idx];
                for (let ep = 0; ep < 4; ep++) {
                    const entryNode = ep < 2 ? seg.startNode : seg.endNode;
                    const trans = nodeDist(frontier, entryNode);
                    for (let xp = 0; xp < 4; xp++) {
                        const sc = seg.costMatrix[ep][xp];
                        if (sc === Infinity) continue;
                        if (trans + sc < bestTotal) {
                            bestTotal = trans + sc;
                            bestIdx = idx;
                            bestEntry = { entryPort: ep, exitPort: xp, segCost: sc, transitionCost: trans };
                            bestMarginal = (trans + sc) / SPEED + (seg.addressCount || 0) * T_ASSESS;
                        }
                    }
                }
            }

            if (bestIdx < 0) break;

            // Would adding this exceed target time?
            if (eswTime + bestMarginal > targetTime * 1.1 && assignments[k].length > 0) {
                break; // Move to next ESW
            }

            remaining.delete(bestIdx);
            assignments[k].push({ segId: segs[bestIdx].id, ...bestEntry });
            frontier = bestEntry.exitPort < 2 ? segs[bestIdx].startNode : segs[bestIdx].endNode;
            eswTime += bestMarginal;
        }
    }

    return assignments;
}

// ============================================================
// SA post-processing: boundary transfers
// ============================================================
function saImprove(assignments, huddleNode, maxIter = 500) {
    let current = assignments.map(a => [...a]);
    let currentTimes = current.map(a => eswTime(a, huddleNode).time);
    let currentMax = Math.max(...currentTimes);
    let bestMax = currentMax;
    let bestAssignment = current.map(a => [...a]);

    let T = currentMax * 0.1; // initial temperature
    const Tf = 0.1;
    const alpha = Math.pow(Tf / T, 1 / maxIter);

    for (let iter = 0; iter < maxIter; iter++) {
        // Pick a random ESW with above-average time
        const avgTime = currentTimes.reduce((s, t) => s + t, 0) / current.length;
        const heavyEsws = currentTimes.map((t, i) => ({ i, t })).filter(x => x.t > avgTime * 0.9);
        if (heavyEsws.length === 0) break;
        const fromEsw = heavyEsws[Math.floor(Math.random() * heavyEsws.length)].i;

        if (current[fromEsw].length <= 1) continue;

        // Pick a segment to transfer (last or random boundary segment)
        const segIdx = current[fromEsw].length - 1; // last segment
        const seg = current[fromEsw][segIdx];

        // Pick a random other ESW to receive
        let toEsw = Math.floor(Math.random() * (current.length - 1));
        if (toEsw >= fromEsw) toEsw++;

        // Try the transfer
        const newFrom = [...current[fromEsw]];
        newFrom.splice(segIdx, 1);
        const newTo = [...current[toEsw], seg];

        const newFromTime = eswTime(newFrom, huddleNode).time;
        const newToTime = eswTime(newTo, huddleNode).time;
        const newMax = Math.max(
            ...currentTimes.map((t, i) => i === fromEsw ? newFromTime : i === toEsw ? newToTime : t)
        );

        const delta = newMax - currentMax;
        if (delta < 0 || Math.random() < Math.exp(-delta / T)) {
            current[fromEsw] = newFrom;
            current[toEsw] = newTo;
            currentTimes[fromEsw] = newFromTime;
            currentTimes[toEsw] = newToTime;
            currentMax = newMax;
            if (currentMax < bestMax) {
                bestMax = currentMax;
                bestAssignment = current.map(a => [...a]);
            }
        }
        T *= alpha;
    }
    return bestAssignment;
}

// ============================================================
// Study I oracle (for time-metric comparison)
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
    for (const e of chain) { parts[pi].push(e); count += segById.get(e.segId)?.addressCount || 0; if (count >= target && pi < n - 1) { pi++; count = 0; } }
    return parts;
}

// ============================================================
// Run Study II
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

// Find nearest road node to a fire station
function nearestNode(lat, lon) {
    let bestNode = null, bestDist = Infinity;
    for (const s of data.segments) {
        for (const [nid, pl] of [[s.startNode, s.polyline[0]], [s.endNode, s.polyline[s.polyline.length - 1]]]) {
            const R = 6371000, toRad = d => d * Math.PI / 180;
            const dLat = toRad(pl[0] - lat), dLon = toRad(pl[1] - lon);
            const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat))*Math.cos(toRad(pl[0]))*Math.sin(dLon/2)**2;
            const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            if (d < bestDist) { bestDist = d; bestNode = nid; }
        }
    }
    return bestNode;
}

// Precompute fire station nodes
const stationNodes = new Map();
for (const st of fireData.stations) {
    stationNodes.set(st.id, nearestNode(st.lat, st.lon));
}

console.log("\n=== Study II Results ===\n");
console.log("Neighborhood          | Addrs | Segs | N | Strategy     | MaxTime | TimeSpread | Addrs/ESW      | WalkToFirst");
console.log("----------------------|-------|------|---|--------------|---------|------------|----------------|------------");

const allResults = [];

const selected = [...hoodAddrs.entries()]
    .filter(([name, addrs]) => (addrs.length >= 50 && addrs.length <= 200) || name === "Fairmeadow")
    .sort((a, b) => a[1].length - b[1].length);

for (const [hood, addrs] of selected) {
    const segs = getHoodSegments(hood);
    if (segs.length < 3) continue;

    // Find this neighborhood's fire station
    const assignment = fireData.neighborhoodAssignments.find(a => a.hood === hood);
    if (!assignment) continue;
    const stationNode = stationNodes.get(assignment.station);
    if (!stationNode) continue;

    // The huddle point is NOT the fire station — it's the fan-out point
    // where ESWs diverge into the neighborhood. This is the neighborhood
    // intersection node nearest to the fire station (the point where the
    // approach road meets the neighborhood's segment network).
    const hoodNodes = new Set();
    for (const s of segs) { hoodNodes.add(s.startNode); hoodNodes.add(s.endNode); }

    // Find nearest neighborhood node to fire station (by haversine, since
    // we haven't precomputed Dijkstra yet and the station may be outside
    // the neighborhood's road network)
    let huddleNode = null, huddleDist = Infinity;
    for (const nid of hoodNodes) {
        // Get node coords from any segment that uses this node
        for (const s of segs) {
            let lat, lon;
            if (s.startNode === nid) { lat = s.polyline[0][0]; lon = s.polyline[0][1]; }
            else if (s.endNode === nid) { lat = s.polyline[s.polyline.length-1][0]; lon = s.polyline[s.polyline.length-1][1]; }
            else continue;
            const R = 6371000, toRad = d => d * Math.PI / 180;
            const dLat = toRad(lat - assignment.stationLat), dLon = toRad(lon - assignment.stationLon);
            const a = Math.sin(dLat/2)**2 + Math.cos(toRad(assignment.stationLat))*Math.cos(toRad(lat))*Math.sin(dLon/2)**2;
            const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            if (d < huddleDist) { huddleDist = d; huddleNode = nid; }
            break;
        }
    }
    if (!huddleNode) continue;

    // Precompute distances within neighborhood (including fan-out point)
    hoodNodes.add(huddleNode); // already in set, but explicit
    precomputeDistances(hoodNodes);

    for (const n of [3, 5]) {
        const results = {};

        // BFS
        const bfsParts = assignBFS(segs, n, huddleNode);
        const bfsTimes = bfsParts.map(p => eswTime(p, huddleNode));
        results.bfs = { times: bfsTimes, maxTime: Math.max(...bfsTimes.map(t => t.time)) };

        // DFS
        const dfsParts = assignDFS(segs, n, huddleNode);
        const dfsTimes = dfsParts.map(p => eswTime(p, huddleNode));
        results.dfs = { times: dfsTimes, maxTime: Math.max(...dfsTimes.map(t => t.time)) };

        // SA on BFS
        const saParts = saImprove(bfsParts, huddleNode);
        const saTimes = saParts.map(p => eswTime(p, huddleNode));
        results.bfs_sa = { times: saTimes, maxTime: Math.max(...saTimes.map(t => t.time)) };

        // Study I oracle (chain+slice) evaluated with time metric
        let bestChainMax = Infinity, bestChainParts = null;
        const maxStarts = Math.min(segs.length, 10);
        for (let si = 0; si < maxStarts; si++) {
            const chain = chainNN(segs, Math.floor(si * segs.length / maxStarts));
            const parts = sliceChain(chain, n);
            const times = parts.map(p => eswTime(p, huddleNode));
            const maxT = Math.max(...times.map(t => t.time));
            if (maxT < bestChainMax) { bestChainMax = maxT; bestChainParts = parts; }
        }
        const chainTimes = bestChainParts.map(p => eswTime(p, huddleNode));
        results.chainSlice = { times: chainTimes, maxTime: Math.max(...chainTimes.map(t => t.time)) };

        // Find winner
        const candidates = [
            { name: "BFS", r: results.bfs },
            { name: "DFS", r: results.dfs },
            { name: "BFS+SA", r: results.bfs_sa },
            { name: "Chain(S1)", r: results.chainSlice },
        ];
        const best = candidates.sort((a, b) => a.r.maxTime - b.r.maxTime)[0];

        const pad = (s, w) => String(s).padEnd(w);
        for (const { name, r } of candidates) {
            const mark = name === best.name ? "*" : " ";
            const spread = Math.max(...r.times.map(t => t.time)) - Math.min(...r.times.map(t => t.time));
            const addrDist = r.times.map(t => t.addrs).join("/");
            const avgW2F = (r.times.reduce((s, t) => s + (t.walkToFirst || 0), 0) / n).toFixed(0);
            console.log(
                `${pad(hood, 22)}| ${pad(addrs.length, 5)} | ${pad(segs.length, 4)} | ${n} | ${pad(name + mark, 12)} | ` +
                `${pad(r.maxTime.toFixed(0) + "min", 7)} | ${pad(spread.toFixed(0) + "min", 10)} | ${pad(addrDist, 14)} | ${avgW2F}m`
            );
        }

        allResults.push({
            hood, addrs: addrs.length, segs: segs.length, n,
            station: assignment.stationName, results, winner: best.name,
            bestMaxTime: best.r.maxTime
        });

        console.log("");
    }
}

// Summary
console.log("\n=== Summary ===");
const winCounts = {};
for (const r of allResults) { winCounts[r.winner] = (winCounts[r.winner] || 0) + 1; }
console.log("Winner counts:", JSON.stringify(winCounts), "total:", allResults.length);

// Time balance: how much does SA improve BFS?
const saImprovements = allResults.filter(r => r.results.bfs_sa && r.results.bfs).map(r =>
    (r.results.bfs.maxTime - r.results.bfs_sa.maxTime) / r.results.bfs.maxTime
);
if (saImprovements.length > 0) {
    console.log(`SA improvement over BFS: avg=${(saImprovements.reduce((s,v)=>s+v,0)/saImprovements.length*100).toFixed(1)}%`);
}

// How different is Study II from Study I?
const s2vss1 = allResults.filter(r => r.results.bfs_sa && r.results.chainSlice).map(r =>
    (r.results.chainSlice.maxTime - r.results.bfs_sa.maxTime) / r.results.chainSlice.maxTime
);
if (s2vss1.length > 0) {
    console.log(`BFS+SA vs Chain(S1): avg improvement=${(s2vss1.reduce((s,v)=>s+v,0)/s2vss1.length*100).toFixed(1)}%`);
}

// Save trail data for Fairmeadow (for comparison with Study I Fig 7)
const fmResult = allResults.find(r => r.hood === "Fairmeadow" && r.n === 3);
if (fmResult) {
    // Find the winning partitions
    const winnerKey = fmResult.winner === "Chain(S1)" ? "chainSlice" :
                      fmResult.winner === "BFS+SA" ? "bfs_sa" :
                      fmResult.winner === "DFS" ? "dfs" : "bfs";
    // We need the actual partitions, not just times. Re-run the winner.
    // For simplicity, use the BFS+SA result (most interesting for Study II)
    const fmSegs = getHoodSegments("Fairmeadow");
    const fmAssignment = fireData.neighborhoodAssignments.find(a => a.hood === "Fairmeadow");
    const fmHoodNodes = new Set();
    for (const s of fmSegs) { fmHoodNodes.add(s.startNode); fmHoodNodes.add(s.endNode); }
    let fmHuddleNode = null, fmHuddleDist = Infinity;
    for (const nid of fmHoodNodes) {
        for (const s of fmSegs) {
            let lat, lon;
            if (s.startNode === nid) { lat = s.polyline[0][0]; lon = s.polyline[0][1]; }
            else if (s.endNode === nid) { lat = s.polyline[s.polyline.length-1][0]; lon = s.polyline[s.polyline.length-1][1]; }
            else continue;
            const R = 6371000, toRad = d => d * Math.PI / 180;
            const dLat = toRad(lat - fmAssignment.stationLat), dLon = toRad(lon - fmAssignment.stationLon);
            const a2 = Math.sin(dLat/2)**2 + Math.cos(toRad(fmAssignment.stationLat))*Math.cos(toRad(lat))*Math.sin(dLon/2)**2;
            const d = R * 2 * Math.atan2(Math.sqrt(a2), Math.sqrt(1 - a2));
            if (d < fmHuddleDist) { fmHuddleDist = d; fmHuddleNode = nid; }
            break;
        }
    }
    fmHoodNodes.add(fmHuddleNode);
    precomputeDistances(fmHoodNodes);

    // Run DFS (the Study II winner) for trail data
    const dfsParts = assignDFS(fmSegs, 3, fmHuddleNode);
    // Also save huddle point
    const dataDir = path.join(__dirname, "..", "data");
    // Find huddle coords
    let huddleLat, huddleLon;
    for (const s of fmSegs) {
        if (s.startNode === fmHuddleNode) { huddleLat = s.polyline[0][0]; huddleLon = s.polyline[0][1]; break; }
        if (s.endNode === fmHuddleNode) { huddleLat = s.polyline[s.polyline.length-1][0]; huddleLon = s.polyline[s.polyline.length-1][1]; break; }
    }
    fs.writeFileSync(path.join(dataDir, "fairmeadow-s2-huddle.dat"), `lon lat\n${huddleLon} ${huddleLat}\n`);

    // Walk-from-huddle lines for each ESW
    for (let esw = 0; esw < dfsParts.length; esw++) {
        if (dfsParts[esw].length === 0) continue;
        const firstSeg = segById.get(dfsParts[esw][0].segId);
        const firstEntry = dfsParts[esw][0].entryPort;
        const firstPl = firstSeg.polyline;
        const firstPt = firstEntry < 2 ? firstPl[0] : firstPl[firstPl.length-1];
        fs.writeFileSync(path.join(dataDir, `fairmeadow-s2-esw${esw}-fromhuddle.dat`),
            `lon lat\n${huddleLon} ${huddleLat}\n${firstPt[1]} ${firstPt[0]}\n`);
    }

    const saParts = dfsParts; // Use DFS result (winner)
    for (let esw = 0; esw < saParts.length; esw++) {
        // Segment polylines (blue)
        const segPts = ["lon lat"];
        for (const entry of saParts[esw]) {
            const seg = segById.get(entry.segId);
            if (!seg) continue;
            const pl = entry.entryPort < 2 ? seg.polyline : [...seg.polyline].reverse();
            for (const pt of pl) segPts.push(`${pt[1]} ${pt[0]}`);
            segPts.push("");
        }
        fs.writeFileSync(path.join(dataDir, `fairmeadow-s2-esw${esw}-segments.dat`), segPts.join("\n") + "\n");

        // Transition polylines (red) - just endpoints since we don't have prev matrix here
        const transPts = ["lon lat"];
        for (let i = 1; i < saParts[esw].length; i++) {
            const prev = segById.get(saParts[esw][i-1].segId);
            const curr = segById.get(saParts[esw][i].segId);
            if (!prev || !curr) continue;
            const prevExit = saParts[esw][i-1].exitPort;
            const currEntry = saParts[esw][i].entryPort;
            const exitPt = prevExit < 2 ? prev.polyline[0] : prev.polyline[prev.polyline.length-1];
            const entryPt = currEntry < 2 ? curr.polyline[0] : curr.polyline[curr.polyline.length-1];
            transPts.push(`${exitPt[1]} ${exitPt[0]}`);
            transPts.push(`${entryPt[1]} ${entryPt[0]}`);
            transPts.push("");
        }
        fs.writeFileSync(path.join(dataDir, `fairmeadow-s2-esw${esw}-transitions.dat`), transPts.join("\n") + "\n");
    }

    const s2Times = saParts.map(p => eswTime(p, fmHuddleNode));
    console.log("\nFairmeadow Study II (BFS+SA, N=3) trail data saved:");
    for (let k = 0; k < 3; k++) {
        console.log(`  ESW ${k+1}: ${s2Times[k].addrs} addrs, ${s2Times[k].time.toFixed(0)}min, ${saParts[k].length} segs`);
    }
}

// Save
const resultsPath = path.join(__dirname, "..", "data", "study2-results.json");
fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
console.log(`\nResults saved to ${resultsPath}`);
