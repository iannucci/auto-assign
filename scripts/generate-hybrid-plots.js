#!/usr/bin/env node
// Generate before/after Voronoi+hybrid map data for paper illustration
// Uses Classic Communities N=3 (2.7% improvement, clear visual)

const fs = require("fs");
const path = require("path");
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "network-extract.json"), "utf8"));
const dataDir = path.join(__dirname, "..", "data");

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

// Use Palo Alto Central (N=3) — 145 addrs, 11 segs, 9.4% improvement
// Actually let's use Classic Communities N=3 which has clearer rebalancing
const HOOD = "Classic Communities";
const N = 3;

const hoodAddrs = data.addresses.filter(a => a.neighborhood === HOOD);
const segIds = new Set();
for (const a of hoodAddrs) { const sid = gidToSeg.get(a.gid); if (sid !== undefined && segById.has(sid)) segIds.add(sid); }
const segs = [...segIds].map(id => segById.get(id));
console.log(`${HOOD}: ${hoodAddrs.length} addrs, ${segs.length} segs`);

// Segment adjacency for connectivity check
const nodeToSegs = new Map();
for (const s of data.segments) {
    for (const nid of [s.startNode, s.endNode]) {
        if (!nodeToSegs.has(nid)) nodeToSegs.set(nid, []);
        nodeToSegs.get(nid).push(s.id);
    }
}
const segAdj = new Map();
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

function wouldDisconnect(cellSegIds, removeId) {
    const remaining = new Set(cellSegIds);
    remaining.delete(removeId);
    if (remaining.size <= 1) return remaining.size === 0;
    const start = remaining.values().next().value;
    const visited = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
        const cur = queue.shift();
        for (const neighbor of (segAdj.get(cur) || [])) {
            if (remaining.has(neighbor) && !visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
        }
    }
    return visited.size < remaining.size;
}

// Build Voronoi
const centroids = segs.map(s => segCentroid(s));
const sorted = [...segs].map((s, i) => ({ s, lat: centroids[i].lat })).sort((a, b) => a.lat - b.lat);
const totalA = sorted.reduce((s2, x) => s2 + (x.s.addressCount || 0), 0);
let seedNodes = [];
let cumA = 0, nextBound = totalA / (2 * N);
for (const item of sorted) {
    cumA += item.s.addressCount || 0;
    if (cumA >= nextBound && seedNodes.length < N) { seedNodes.push(item.s.startNode); nextBound += totalA / N; }
}
while (seedNodes.length < N) seedNodes.push(sorted[Math.floor(seedNodes.length * sorted.length / N)].s.startNode);

// Lloyd's
for (let iter = 0; iter < 20; iter++) {
    const nodeAssign = multiSourceDijkstra(seedNodes);
    const cells = Array.from({ length: N }, () => []);
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
    for (let k = 0; k < N; k++) {
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

// Final Voronoi (BEFORE boundary transfer)
const finalAssign = multiSourceDijkstra(seedNodes);
const beforeCells = Array.from({ length: N }, () => []);
for (const seg of segs) {
    const a1 = finalAssign.get(seg.startNode), a2 = finalAssign.get(seg.endNode);
    const a = (a1 && a2) ? (a1.dist <= a2.dist ? a1 : a2) : a1 || a2;
    if (a) beforeCells[a.seedIdx].push(seg);
}

const beforeAddrs = beforeCells.map(c => c.reduce((s, seg) => s + (seg.addressCount || 0), 0));
console.log("BEFORE:", beforeAddrs.join("/"));

// Write BEFORE data
const colors = ["prodblue", "unprodred", "idealgreen"];
for (let k = 0; k < N; k++) {
    const pts = ["lon lat"];
    for (const seg of beforeCells[k]) {
        for (const pt of seg.polyline) pts.push(`${pt[1]} ${pt[0]}`);
        pts.push("");
    }
    fs.writeFileSync(path.join(dataDir, `hybrid-before-cell${k}.dat`), pts.join("\n") + "\n");
}

// Write all addresses as background
const bgPts = ["lon lat"];
for (const a of hoodAddrs) bgPts.push(`${a.lon} ${a.lat}`);
fs.writeFileSync(path.join(dataDir, "hybrid-all-addrs.dat"), bgPts.join("\n") + "\n");

// Boundary transfer (same logic as study3b)
const segCell = new Map();
const cellSets = beforeCells.map(c => new Set(c.map(s => s.id)));
for (let k = 0; k < N; k++) { for (const seg of beforeCells[k]) segCell.set(seg.id, k); }

const T_ASSESS = 5, SPEED = 83.33;
function cellTime(cellSegIds) {
    const addrs = [...cellSegIds].reduce((s, id) => s + (segById.get(id)?.addressCount || 0), 0);
    const dist = [...cellSegIds].reduce((s, id) => s + (segById.get(id)?.distance || 0), 0);
    return dist / SPEED + addrs * T_ASSESS;
}

let transfers = [];
for (let transferIter = 0; transferIter < 200; transferIter++) {
    const times = cellSets.map(set => cellTime(set));
    const maxTime = Math.max(...times);
    const heavyIdx = times.indexOf(maxTime);
    let bestTransfer = null, bestImprovement = 0;

    for (const segId of cellSets[heavyIdx]) {
        const neighbors = segAdj.get(segId) || new Set();
        let adjacentCells = new Set();
        for (const nid of neighbors) { const nc = segCell.get(nid); if (nc !== undefined && nc !== heavyIdx) adjacentCells.add(nc); }
        if (adjacentCells.size === 0) continue;
        if (wouldDisconnect(cellSets[heavyIdx], segId)) continue;

        for (const targetCell of adjacentCells) {
            const newHeavySet = new Set(cellSets[heavyIdx]); newHeavySet.delete(segId);
            const newTargetSet = new Set(cellSets[targetCell]); newTargetSet.add(segId);
            const newMax = Math.max(cellTime(newHeavySet), cellTime(newTargetSet),
                ...times.filter((_, i) => i !== heavyIdx && i !== targetCell));
            const improvement = maxTime - newMax;
            if (improvement > bestImprovement) {
                bestImprovement = improvement;
                bestTransfer = { segId, from: heavyIdx, to: targetCell };
            }
        }
    }

    if (!bestTransfer || bestImprovement < 0.5) break;
    cellSets[bestTransfer.from].delete(bestTransfer.segId);
    cellSets[bestTransfer.to].add(bestTransfer.segId);
    segCell.set(bestTransfer.segId, bestTransfer.to);
    transfers.push(bestTransfer);
}

const afterAddrs = cellSets.map(set => [...set].reduce((s, id) => s + (segById.get(id)?.addressCount || 0), 0));
console.log("AFTER:", afterAddrs.join("/"));
console.log("Transfers:", transfers.length);
for (const t of transfers) {
    const seg = segById.get(t.segId);
    console.log(`  ${seg?.name || 'seg' + t.segId} (${seg?.addressCount}a): cell ${t.from} → cell ${t.to}`);
}

// Write AFTER data
for (let k = 0; k < N; k++) {
    const pts = ["lon lat"];
    for (const segId of cellSets[k]) {
        const seg = segById.get(segId);
        if (!seg) continue;
        for (const pt of seg.polyline) pts.push(`${pt[1]} ${pt[0]}`);
        pts.push("");
    }
    fs.writeFileSync(path.join(dataDir, `hybrid-after-cell${k}.dat`), pts.join("\n") + "\n");
}

// Write transferred segments highlighted
const transferPts = ["lon lat"];
for (const t of transfers) {
    const seg = segById.get(t.segId);
    if (!seg) continue;
    for (const pt of seg.polyline) transferPts.push(`${pt[1]} ${pt[0]}`);
    transferPts.push("");
}
fs.writeFileSync(path.join(dataDir, "hybrid-transferred.dat"), transferPts.join("\n") + "\n");

// Write seed points
const nodeCoords = new Map();
for (const s of segs) {
    if (!nodeCoords.has(s.startNode)) nodeCoords.set(s.startNode, { lat: s.polyline[0][0], lon: s.polyline[0][1] });
    if (!nodeCoords.has(s.endNode)) nodeCoords.set(s.endNode, { lat: s.polyline[s.polyline.length-1][0], lon: s.polyline[s.polyline.length-1][1] });
}
const seedPts = ["lon lat"];
for (const nid of seedNodes) { const c = nodeCoords.get(nid); if (c) seedPts.push(`${c.lon} ${c.lat}`); }
fs.writeFileSync(path.join(dataDir, "hybrid-seeds.dat"), seedPts.join("\n") + "\n");

console.log("Data saved to data/hybrid-*.dat");
