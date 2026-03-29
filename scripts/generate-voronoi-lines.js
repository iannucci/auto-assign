#!/usr/bin/env node
// Generate Voronoi cell boundary LINES for Midtown
// These are the actual partition edges — points on roads where the
// Dijkstra distance to two different seeds is equal.

const fs = require("fs");
const path = require("path");
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "network-extract.json"), "utf8"));

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

function segCentroid(seg) {
    const pl = seg.polyline;
    return { lat: pl.reduce((s, p) => s + p[0], 0) / pl.length,
             lon: pl.reduce((s, p) => s + p[1], 0) / pl.length };
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Midtown segments
const mtAddrs = data.addresses.filter(a => a.neighborhood === "Midtown");
const mtSegIds = new Set();
for (const a of mtAddrs) { const sid = gidToSeg.get(a.gid); if (sid !== undefined && segById.has(sid)) mtSegIds.add(sid); }
const segs = [...mtSegIds].map(id => segById.get(id));
const nodeCoords = new Map();
for (const s of segs) {
    if (!nodeCoords.has(s.startNode)) nodeCoords.set(s.startNode, { lat: s.polyline[0][0], lon: s.polyline[0][1] });
    if (!nodeCoords.has(s.endNode)) nodeCoords.set(s.endNode, { lat: s.polyline[s.polyline.length-1][0], lon: s.polyline[s.polyline.length-1][1] });
}
const nodeList = [...nodeCoords.keys()];

// Find balanced seeds (same greedy approach as before)
const N = 3;
const totalA = segs.reduce((s, seg) => s + (seg.addressCount || 0), 0);
const centroids = segs.map(s => segCentroid(s));
const sorted = [...segs].map((s, i) => ({ s, lat: centroids[i].lat })).sort((a, b) => a.lat - b.lat);
let seedNodes = [];
let cumA = 0, nextBound = totalA / (2 * N);
for (const item of sorted) {
    cumA += item.s.addressCount || 0;
    if (cumA >= nextBound && seedNodes.length < N) { seedNodes.push(item.s.startNode); nextBound += totalA / N; }
}
while (seedNodes.length < N) seedNodes.push(sorted[Math.floor(seedNodes.length * sorted.length / N)].s.startNode);

function evalSeeds(seeds) {
    const na = multiSourceDijkstra(seeds);
    const counts = Array(N).fill(0);
    for (const seg of segs) {
        const a1 = na.get(seg.startNode), a2 = na.get(seg.endNode);
        const a = (a1 && a2) ? (a1.dist <= a2.dist ? a1 : a2) : a1 || a2;
        if (a) counts[a.seedIdx] += seg.addressCount || 0;
    }
    const target = totalA / N;
    return { counts, imbalance: counts.reduce((s, c) => s + Math.abs(c - target), 0), na };
}

// Greedy hill-climbing for balanced seeds
let best = evalSeeds(seedNodes);
for (let iter = 0; iter < 20; iter++) {
    let improved = false;
    for (let k = 0; k < N; k++) {
        for (let c = 0; c < 100; c++) {
            const candNode = nodeList[Math.floor(Math.random() * nodeList.length)];
            if (seedNodes.includes(candNode)) continue;
            const testSeeds = [...seedNodes]; testSeeds[k] = candNode;
            const result = evalSeeds(testSeeds);
            if (result.imbalance < best.imbalance) { best = result; seedNodes[k] = candNode; improved = true; }
        }
    }
    if (!improved || best.imbalance < 30) break;
}
console.log("Seeds balanced:", best.counts.join("/"));

// Now compute boundary crossing points on ALL road edges within the Midtown bbox
const nodeAssign = best.na;
const boundaryPoints = [];

// Get Midtown bbox
const mtLats = mtAddrs.map(a => a.lat), mtLons = mtAddrs.map(a => a.lon);
const bbox = {
    minLat: Math.min(...mtLats) - 0.002, maxLat: Math.max(...mtLats) + 0.002,
    minLon: Math.min(...mtLons) - 0.002, maxLon: Math.max(...mtLons) + 0.002
};

for (const s of allSegs) {
    const sn = s.startNode, en = s.endNode;
    if (sn === en) continue;
    const a1 = nodeAssign.get(sn), a2 = nodeAssign.get(en);
    if (!a1 || !a2) continue;
    if (a1.seedIdx === a2.seedIdx) continue;

    const pl = s.polyline || [];
    if (pl.length < 2) continue;

    // Check if within Midtown bbox
    const midLat = (pl[0][0] + pl[pl.length-1][0]) / 2;
    const midLon = (pl[0][1] + pl[pl.length-1][1]) / 2;
    if (midLat < bbox.minLat || midLat > bbox.maxLat || midLon < bbox.minLon || midLon > bbox.maxLon) continue;

    // Boundary at t = (dQ + L - dP) / (2L)
    const L = s.distance;
    const t = (a2.dist + L - a1.dist) / (2 * L);
    if (t < 0 || t > 1) continue;

    // Interpolate along polyline
    let cumDist = 0;
    const targetDist = t * L;
    for (let i = 0; i < pl.length - 1; i++) {
        const edgeDist = haversine(pl[i][0], pl[i][1], pl[i+1][0], pl[i+1][1]);
        if (cumDist + edgeDist >= targetDist) {
            const frac = edgeDist > 0 ? (targetDist - cumDist) / edgeDist : 0;
            const lat = pl[i][0] + frac * (pl[i+1][0] - pl[i][0]);
            const lon = pl[i][1] + frac * (pl[i+1][1] - pl[i][1]);
            boundaryPoints.push({ lat, lon, cells: [a1.seedIdx, a2.seedIdx].sort().join("-") });
            break;
        }
        cumDist += edgeDist;
    }
}

console.log("Boundary points:", boundaryPoints.length);

// Group by cell pair, sort to form connected lines
const cellPairs = new Map();
for (const bp of boundaryPoints) {
    if (!cellPairs.has(bp.cells)) cellPairs.set(bp.cells, []);
    cellPairs.get(bp.cells).push(bp);
}

// Write Voronoi boundary lines
// For each pair, sort points by angle from the midpoint of the two seeds
// to form a connected boundary curve
const dataDir = path.join(__dirname, "..", "data");
const linePts = ["lon lat"];

for (const [pair, points] of cellPairs) {
    const [c1, c2] = pair.split("-").map(Number);
    // Midpoint between the two seeds
    const s1 = nodeCoords.get(seedNodes[c1]), s2 = nodeCoords.get(seedNodes[c2]);
    const midLat = (s1.lat + s2.lat) / 2, midLon = (s1.lon + s2.lon) / 2;

    // Sort by angle from midpoint
    points.sort((a, b) => {
        const angA = Math.atan2(a.lat - midLat, a.lon - midLon);
        const angB = Math.atan2(b.lat - midLat, b.lon - midLon);
        return angA - angB;
    });

    // Connect with nearest-neighbor ordering for cleaner lines
    const ordered = [points[0]];
    const remaining = new Set(points.slice(1));
    while (remaining.size > 0) {
        const last = ordered[ordered.length - 1];
        let nearest = null, nearestDist = Infinity;
        for (const p of remaining) {
            const d = Math.abs(p.lat - last.lat) + Math.abs(p.lon - last.lon);
            if (d < nearestDist) { nearestDist = d; nearest = p; }
        }
        ordered.push(nearest);
        remaining.delete(nearest);
    }

    for (const p of ordered) linePts.push(`${p.lon} ${p.lat}`);
    linePts.push(""); // gap between pairs
    console.log(`  ${pair}: ${points.length} points`);
}

fs.writeFileSync(path.join(dataDir, "midtown-voronoi-lines.dat"), linePts.join("\n") + "\n");
console.log("Voronoi boundary lines saved.");
