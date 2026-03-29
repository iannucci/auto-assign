#!/usr/bin/env node
// Study III-B: Voronoi + boundary-transfer hybrid
//
// 1. Start with Voronoi cells (rough geographic partition)
// 2. Transfer boundary segments between cells to balance time
// 3. Maintain contiguity: only transfer if cell remains connected
// 4. Within each cell: NN chain ordering

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

function segCentroid(seg) {
    const pl = seg.polyline;
    return { lat: pl.reduce((s, p) => s + p[0], 0) / pl.length,
             lon: pl.reduce((s, p) => s + p[1], 0) / pl.length };
}

// Build segment adjacency (which segments share intersection nodes)
const segAdj = new Map(); // segId -> Set<segId>
const nodeToSegs = new Map();
for (const s of data.segments) {
    for (const nid of [s.startNode, s.endNode]) {
        if (!nodeToSegs.has(nid)) nodeToSegs.set(nid, []);
        nodeToSegs.get(nid).push(s.id);
    }
}
for (const [nid, sids] of nodeToSegs) {
    for (let i = 0; i < sids.length; i++) {
        for (let j = i + 1; j < sids.length; j++) {
            if (!segAdj.has(sids[i])) segAdj.set(sids[i], new Set());
            if (!segAdj.has(sids[j])) segAdj.set(sids[j], new Set());
            segAdj.get(sids[i]).add(sids[j]);
            segAdj.get(sids[j]).add(sids[i]);
        }
    }
}

// Check if removing a segment from a cell disconnects it
function wouldDisconnect(cellSegIds, removeId) {
    const remaining = new Set(cellSegIds);
    remaining.delete(removeId);
    if (remaining.size <= 1) return remaining.size === 0; // removing last = disconnect; removing to leave 1 = OK

    // BFS from any remaining segment
    const start = remaining.values().next().value;
    const visited = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
        const cur = queue.shift();
        for (const neighbor of (segAdj.get(cur) || [])) {
            if (remaining.has(neighbor) && !visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push(neighbor);
            }
        }
    }
    return visited.size < remaining.size; // disconnected if not all reachable
}

// Evaluate a cell's time (simple: total walk + assessment)
function cellTime(cellSegs, distMap, huddleNode) {
    if (cellSegs.length === 0) return { time: 0, addrs: 0, walkDist: 0, prodDist: 0 };
    // Build NN chain within cell
    let totalProd = 0, totalUnprod = 0, totalAddrs = 0;
    const used = new Set();
    let curNode = huddleNode;

    // Greedy NN within cell
    const segList = [...cellSegs];
    const chain = [];
    while (chain.length < segList.length) {
        let bestIdx = -1, bestCost = Infinity, bestEntry = {};
        for (let i = 0; i < segList.length; i++) {
            if (used.has(i)) continue;
            const seg = segList[i];
            for (let ep = 0; ep < 4; ep++) {
                const entryNode = ep < 2 ? seg.startNode : seg.endNode;
                const trans = distMap(curNode, entryNode);
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
        const seg = segList[bestIdx];
        totalProd += bestEntry.sc;
        totalUnprod += bestEntry.trans;
        totalAddrs += seg.addressCount || 0;
        curNode = bestEntry.xp < 2 ? seg.startNode : seg.endNode;
        chain.push(bestIdx);
    }

    const firstSeg = segList[chain[0]];
    const walkToFirst = distMap(huddleNode, firstSeg.startNode);

    const totalWalk = walkToFirst + totalProd + totalUnprod;
    return {
        time: totalWalk / SPEED + totalAddrs * T_ASSESS,
        addrs: totalAddrs,
        walkDist: totalWalk,
        prodDist: totalProd,
        walkQuality: totalProd / Math.max(totalWalk, 1)
    };
}

// Multi-source Dijkstra
function multiSourceDijkstra(seedNodes) {
    const assignment = new Map();
    const visited = new Set();
    const queue = [];
    for (let i = 0; i < seedNodes.length; i++) {
        assignment.set(seedNodes[i], { seedIdx: i, dist: 0 });
        queue.push({ node: seedNodes[i], d: 0, seedIdx: i });
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
            if (nd > 15000) continue;
            const existing = assignment.get(edge.to);
            if (!existing || nd < existing.dist) {
                assignment.set(edge.to, { seedIdx, dist: nd });
                queue.push({ node: edge.to, d: nd, seedIdx });
            }
        }
    }
    return assignment;
}

// ============================================================
// Main
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

console.log(`Study III-B: Voronoi + boundary transfer (t_assess=${T_ASSESS}min)\n`);
console.log("Neighborhood          | Addrs | Segs | N | V-Max  | V-Spread | V-WQ  | H-Max  | H-Spread | H-WQ  | Improve");
console.log("----------------------|-------|------|---|--------|----------|-------|--------|----------|-------|--------");

const allResults = [];
const selected = [...hoodAddrs.entries()]
    .filter(([name, addrs]) => (addrs.length >= 50 && addrs.length <= 350) || name === "Fairmeadow")
    .sort((a, b) => a[1].length - b[1].length);

for (const [hood, addrs] of selected) {
    const segs = getHoodSegments(hood);
    if (segs.length < 3) continue;

    const fmAssign = fireData.neighborhoodAssignments.find(a => a.hood === hood);
    if (!fmAssign) continue;

    // Precompute distances
    const hoodNodes = new Set();
    for (const s of segs) { hoodNodes.add(s.startNode); hoodNodes.add(s.endNode); }
    const localDistMap = new Map();
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
                if (nd < (dist.get(edge.to) ?? Infinity)) { dist.set(edge.to, nd); queue.push({ node: edge.to, d: nd }); }
            }
        }
        localDistMap.set(nid, dist);
    }
    function distLookup(n1, n2) { return n1 === n2 ? 0 : (localDistMap.get(n1)?.get(n2) ?? Infinity); }

    // Find huddle
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

    for (const n of [3, 5]) {
        // Initial Voronoi partition
        const centroids = segs.map(s => segCentroid(s));
        const sorted2 = [...segs].map((s, i) => ({ s, lat: centroids[i].lat })).sort((a, b) => a.lat - b.lat);
        const totalA = sorted2.reduce((s2, x) => s2 + (x.s.addressCount || 0), 0);
        let seedNodes = [];
        let cumA = 0, nextBound = totalA / (2 * n);
        for (const item of sorted2) {
            cumA += item.s.addressCount || 0;
            if (cumA >= nextBound && seedNodes.length < n) { seedNodes.push(item.s.startNode); nextBound += totalA / n; }
        }
        while (seedNodes.length < n) seedNodes.push(sorted2[Math.floor(seedNodes.length * sorted2.length / n)].s.startNode);

        // Lloyd's iteration
        for (let iter = 0; iter < 15; iter++) {
            const nodeAssign = multiSourceDijkstra(seedNodes);
            const cells = Array.from({ length: n }, () => []);
            for (const seg of segs) {
                const a1 = nodeAssign.get(seg.startNode), a2 = nodeAssign.get(seg.endNode);
                const a = (a1 && a2) ? (a1.dist <= a2.dist ? a1 : a2) : a1 || a2;
                if (a) cells[a.seedIdx].push(seg);
            }
            const nodeCoords = new Map();
            for (const s of segs) {
                if (!nodeCoords.has(s.startNode)) nodeCoords.set(s.startNode, { lat: s.polyline[0][0], lon: s.polyline[0][1] });
                if (!nodeCoords.has(s.endNode)) nodeCoords.set(s.endNode, { lat: s.polyline[s.polyline.length-1][0], lon: s.polyline[s.polyline.length-1][1] });
            }
            const newSeeds = [...seedNodes];
            for (let k = 0; k < n; k++) {
                if (cells[k].length === 0) continue;
                let tw = 0, latS = 0, lonS = 0;
                for (const seg of cells[k]) { const c = segCentroid(seg); const w = seg.addressCount || 1; latS += c.lat * w; lonS += c.lon * w; tw += w; }
                let bestN = seedNodes[k], bestD = Infinity;
                for (const [nid, coord] of nodeCoords) {
                    const d = Math.abs(coord.lat - latS/tw) + Math.abs(coord.lon - lonS/tw);
                    if (d < bestD) { bestD = d; bestN = nid; }
                }
                newSeeds[k] = bestN;
            }
            if (newSeeds.every((s, i) => s === seedNodes[i])) break;
            seedNodes = newSeeds;
        }

        // Final Voronoi cells
        const finalAssign = multiSourceDijkstra(seedNodes);
        const cells = Array.from({ length: n }, () => []);
        for (const seg of segs) {
            const a1 = finalAssign.get(seg.startNode), a2 = finalAssign.get(seg.endNode);
            const a = (a1 && a2) ? (a1.dist <= a2.dist ? a1 : a2) : a1 || a2;
            if (a) cells[a.seedIdx].push(seg);
        }

        // Evaluate Voronoi result
        const vTimes = cells.map(c => cellTime(c, distLookup, huddleNode));
        const vMax = Math.max(...vTimes.map(t => t.time));
        const vSpread = vMax - Math.min(...vTimes.map(t => t.time));
        const vWQ = vTimes.reduce((s, t) => s + t.walkQuality, 0) / n;

        // === Boundary transfer post-processing ===
        // Track which cell each segment belongs to
        const segCell = new Map(); // segId -> cellIdx
        const cellSets = cells.map(c => new Set(c.map(s => s.id))); // Set<segId> per cell
        for (let k = 0; k < n; k++) {
            for (const seg of cells[k]) segCell.set(seg.id, k);
        }

        // Iterative boundary transfer
        for (let transferIter = 0; transferIter < 200; transferIter++) {
            // Find the heaviest cell
            const times = cellSets.map(set => {
                const cellSegs = [...set].map(id => segById.get(id)).filter(Boolean);
                return cellTime(cellSegs, distLookup, huddleNode);
            });
            const maxTime = Math.max(...times.map(t => t.time));
            const heavyIdx = times.findIndex(t => t.time === maxTime);

            // Find boundary segments of the heavy cell
            // (segments adjacent to segments in another cell)
            let bestTransfer = null, bestImprovement = 0;
            for (const segId of cellSets[heavyIdx]) {
                // Check if this segment is on the boundary
                const neighbors = segAdj.get(segId) || new Set();
                let adjacentCells = new Set();
                for (const nid of neighbors) {
                    const nc = segCell.get(nid);
                    if (nc !== undefined && nc !== heavyIdx) adjacentCells.add(nc);
                }

                if (adjacentCells.size === 0) continue; // interior segment, can't transfer

                // Check if removing this segment disconnects the heavy cell
                if (wouldDisconnect(cellSets[heavyIdx], segId)) continue;

                // Try transferring to each adjacent cell
                for (const targetCell of adjacentCells) {
                    // Simulate the transfer
                    const newHeavySet = new Set(cellSets[heavyIdx]); newHeavySet.delete(segId);
                    const newTargetSet = new Set(cellSets[targetCell]); newTargetSet.add(segId);

                    const newHeavySegs = [...newHeavySet].map(id => segById.get(id)).filter(Boolean);
                    const newTargetSegs = [...newTargetSet].map(id => segById.get(id)).filter(Boolean);

                    const newHeavyTime = cellTime(newHeavySegs, distLookup, huddleNode).time;
                    const newTargetTime = cellTime(newTargetSegs, distLookup, huddleNode).time;
                    const newMax = Math.max(newHeavyTime, newTargetTime,
                        ...times.filter((_, i) => i !== heavyIdx && i !== targetCell).map(t => t.time));

                    const improvement = maxTime - newMax;
                    if (improvement > bestImprovement) {
                        bestImprovement = improvement;
                        bestTransfer = { segId, from: heavyIdx, to: targetCell };
                    }
                }
            }

            if (!bestTransfer || bestImprovement < 0.5) break; // no improving transfer found

            // Apply the transfer
            cellSets[bestTransfer.from].delete(bestTransfer.segId);
            cellSets[bestTransfer.to].add(bestTransfer.segId);
            segCell.set(bestTransfer.segId, bestTransfer.to);
        }

        // Evaluate hybrid result
        const hTimes = cellSets.map(set => {
            const cellSegs = [...set].map(id => segById.get(id)).filter(Boolean);
            return cellTime(cellSegs, distLookup, huddleNode);
        });
        const hMax = Math.max(...hTimes.map(t => t.time));
        const hSpread = hMax - Math.min(...hTimes.map(t => t.time));
        const hWQ = hTimes.reduce((s, t) => s + t.walkQuality, 0) / n;
        const improvement = ((vMax - hMax) / vMax * 100).toFixed(1);

        const pad = (s, w) => String(s).padEnd(w);
        console.log(
            `${pad(hood, 22)}| ${pad(addrs.length, 5)} | ${pad(segs.length, 4)} | ${n} | ` +
            `${pad(vMax.toFixed(0)+"m", 6)} | ${pad(vSpread.toFixed(0)+"m", 8)} | ${pad((vWQ*100).toFixed(0)+"%", 5)} | ` +
            `${pad(hMax.toFixed(0)+"m", 6)} | ${pad(hSpread.toFixed(0)+"m", 8)} | ${pad((hWQ*100).toFixed(0)+"%", 5)} | ${improvement}%`
        );

        allResults.push({
            hood, addrs: addrs.length, segs: segs.length, n,
            voronoi: { maxTime: vMax, spread: vSpread, walkQuality: vWQ, addrs: vTimes.map(t => t.addrs) },
            hybrid: { maxTime: hMax, spread: hSpread, walkQuality: hWQ, addrs: hTimes.map(t => t.addrs) },
            improvement: (vMax - hMax) / vMax
        });
    }
    console.log("");
}

// Summary
console.log("=== Summary ===");
const improvements = allResults.map(r => r.improvement);
console.log(`Boundary transfer improvement: avg=${(improvements.reduce((s,v)=>s+v,0)/improvements.length*100).toFixed(1)}%, max=${(Math.max(...improvements)*100).toFixed(1)}%`);
const hWQs = allResults.map(r => r.hybrid.walkQuality);
console.log(`Hybrid walk quality: avg=${(hWQs.reduce((s,v)=>s+v,0)/hWQs.length*100).toFixed(0)}%`);
const hSpreads = allResults.map(r => r.hybrid.spread);
console.log(`Hybrid time spread: avg=${(hSpreads.reduce((s,v)=>s+v,0)/hSpreads.length).toFixed(0)}min`);

const resultsPath = path.join(__dirname, "..", "data", "study3b-results.json");
fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
console.log(`\nResults saved to ${resultsPath}`);
