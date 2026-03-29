#!/usr/bin/env node
// Generate side-by-side comparison trail data for all three studies on Fairmeadow
// For the paper's cross-study comparison figure

const fs = require("fs");
const path = require("path");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "network-extract.json"), "utf8"));
const fireData = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "fire-stations.json"), "utf8"));
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

// Get Fairmeadow segments
const hoodAddrs = new Map();
for (const a of data.addresses) {
    if (!hoodAddrs.has(a.neighborhood)) hoodAddrs.set(a.neighborhood, []);
    hoodAddrs.get(a.neighborhood).push(a);
}
const fmAddrList = hoodAddrs.get("Fairmeadow");
const fmSegIds = new Set();
for (const a of fmAddrList) { const sid = gidToSeg.get(a.gid); if (sid !== undefined && segById.has(sid)) fmSegIds.add(sid); }
const segs = [...fmSegIds].map(id => segById.get(id));

// Precompute distances
const hoodNodes = new Set();
for (const s of segs) { hoodNodes.add(s.startNode); hoodNodes.add(s.endNode); }
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
function distLookup(n1, n2) { return n1 === n2 ? 0 : (distMap.get(n1)?.get(n2) ?? Infinity); }

// Multi-source Dijkstra for Voronoi
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

const N = 3;

// === Run Voronoi on Fairmeadow ===
// Use address-balanced seed initialization
const centroids = segs.map(s => segCentroid(s));
const lats = centroids.map(c => c.lat);
const sorted = [...segs].map((s, i) => ({ s, lat: centroids[i].lat })).sort((a, b) => a.lat - b.lat);
const totalA = sorted.reduce((s, x) => s + (x.s.addressCount || 0), 0);
let seedNodes = [];
let cumA = 0, nextBound = totalA / (2 * N);
for (const item of sorted) {
    cumA += item.s.addressCount || 0;
    if (cumA >= nextBound && seedNodes.length < N) {
        seedNodes.push(item.s.startNode);
        nextBound += totalA / N;
    }
}
while (seedNodes.length < N) seedNodes.push(sorted[Math.floor(seedNodes.length * sorted.length / N)].s.startNode);

// Run Voronoi with Lloyd's
for (let iter = 0; iter < 20; iter++) {
    const nodeAssign = multiSourceDijkstra(seedNodes);
    const cells = Array.from({ length: N }, () => []);
    for (const seg of segs) {
        const a1 = nodeAssign.get(seg.startNode);
        const a2 = nodeAssign.get(seg.endNode);
        const a = (a1 && a2) ? (a1.dist <= a2.dist ? a1 : a2) : a1 || a2;
        if (a) cells[a.seedIdx].push(seg);
    }

    // Move seeds to address-weighted centroids
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
        const cLat = latS / tw, cLon = lonS / tw;
        let bestN = seedNodes[k], bestD = Infinity;
        for (const [nid, coord] of nodeCoords) {
            const d = Math.abs(coord.lat - cLat) + Math.abs(coord.lon - cLon);
            if (d < bestD) { bestD = d; bestN = nid; }
        }
        newSeeds[k] = bestN;
    }
    if (newSeeds.every((s, i) => s === seedNodes[i])) break;
    seedNodes = newSeeds;
}

// Final Voronoi assignment
const finalAssign = multiSourceDijkstra(seedNodes);
const voronoiCells = Array.from({ length: N }, () => []);
for (const seg of segs) {
    const a1 = finalAssign.get(seg.startNode);
    const a2 = finalAssign.get(seg.endNode);
    const a = (a1 && a2) ? (a1.dist <= a2.dist ? a1 : a2) : a1 || a2;
    if (a) voronoiCells[a.seedIdx].push(seg);
}

// Write Voronoi colored segments (each ESW a different color)
const colors = ['0', '1', '2'];
for (let k = 0; k < N; k++) {
    const pts = ["lon lat"];
    for (const seg of voronoiCells[k]) {
        for (const pt of seg.polyline) pts.push(`${pt[1]} ${pt[0]}`);
        pts.push("");
    }
    fs.writeFileSync(path.join(dataDir, `voronoi-fm-esw${k}.dat`), pts.join("\n") + "\n");
}

// Write seed points
const nodeCoords = new Map();
for (const s of segs) {
    if (!nodeCoords.has(s.startNode)) nodeCoords.set(s.startNode, { lat: s.polyline[0][0], lon: s.polyline[0][1] });
    if (!nodeCoords.has(s.endNode)) nodeCoords.set(s.endNode, { lat: s.polyline[s.polyline.length-1][0], lon: s.polyline[s.polyline.length-1][1] });
}
const seedPts = ["lon lat"];
for (const nid of seedNodes) {
    const c = nodeCoords.get(nid);
    if (c) seedPts.push(`${c.lon} ${c.lat}`);
}
fs.writeFileSync(path.join(dataDir, "voronoi-fm-seeds.dat"), seedPts.join("\n") + "\n");

// Print stats
console.log("Voronoi Fairmeadow N=3:");
for (let k = 0; k < N; k++) {
    const addrs = voronoiCells[k].reduce((s, seg) => s + (seg.addressCount || 0), 0);
    console.log(`  Cell ${k}: ${voronoiCells[k].length} segs, ${addrs} addrs`);
}

// === Also write Study I colored segments for comparison ===
// Study I: load trail data (already has per-ESW segments)
// Just need colored segment polylines per ESW
const trails = JSON.parse(fs.readFileSync(path.join(dataDir, "trail-data.json"), "utf8"));
const fmTrails = trails.filter(t => t.hood === "Fairmeadow");
for (const trail of fmTrails) {
    // Already have fairmeadow-esw{0,1,2}-segments.dat from Study I
    console.log(`Study I ESW ${trail.esw}: ${trail.segments.length} segs`);
}

console.log("\nVoronoi data saved to data/voronoi-fm-*.dat");
