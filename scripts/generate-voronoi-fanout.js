#!/usr/bin/env node
// Generate road-following fan-out paths from huddle to each Voronoi cell's
// nearest segment, replacing the straight-line jumps.

const fs = require("fs");
const path = require("path");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "network-extract.json"), "utf8"));
const fireData = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "fire-stations.json"), "utf8"));
const dataDir = path.join(__dirname, "..", "data");

const segById = new Map();
for (const s of data.segments) segById.set(s.id, s);
const gidToSeg = new Map();
for (const snap of data.addressSnapping) gidToSeg.set(snap.gid, snap.segmentId);

// Road network with polylines
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

// Dijkstra with path reconstruction
function dijkstraPath(startNode, endNode, maxDist = 15000) {
    if (startNode === endNode) return { dist: 0, polyline: [] };
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
        if (node === endNode) break;
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
    if (!dist.has(endNode)) return { dist: Infinity, polyline: [] };
    const polylines = [];
    let cur = endNode;
    while (prev.has(cur)) {
        const p = prev.get(cur);
        polylines.push(p.polyline);
        cur = p.from;
    }
    polylines.reverse();
    const full = [];
    for (const pl of polylines) {
        for (let i = 0; i < pl.length; i++) {
            if (full.length === 0 || i > 0) full.push(pl[i]);
        }
    }
    return { dist: dist.get(endNode), polyline: full };
}

// Get Fairmeadow segments
const fmAddrs = data.addresses.filter(a => a.neighborhood === "Fairmeadow");
const fmSegIds = new Set();
for (const a of fmAddrs) { const sid = gidToSeg.get(a.gid); if (sid !== undefined && segById.has(sid)) fmSegIds.add(sid); }
const segs = [...fmSegIds].map(id => segById.get(id));

// Find huddle node
const fmAssign = fireData.neighborhoodAssignments.find(a => a.hood === "Fairmeadow");
const hoodNodes = new Set();
for (const s of segs) { hoodNodes.add(s.startNode); hoodNodes.add(s.endNode); }
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
console.log("Huddle node:", huddleNode);

// Read which segments belong to each Voronoi cell by re-running Voronoi
// (same as generate-comparison-plots.js)
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

// Initialize seeds (same as study3)
const N = 3;
const centroids = segs.map(s => segCentroid(s));
const sorted = [...segs].map((s, i) => ({ s, lat: centroids[i].lat })).sort((a, b) => a.lat - b.lat);
const totalA = sorted.reduce((s, x) => s + (x.s.addressCount || 0), 0);
let seedNodes = [];
let cumA = 0, nextBound = totalA / (2 * N);
for (const item of sorted) {
    cumA += item.s.addressCount || 0;
    if (cumA >= nextBound && seedNodes.length < N) { seedNodes.push(item.s.startNode); nextBound += totalA / N; }
}
while (seedNodes.length < N) seedNodes.push(sorted[Math.floor(seedNodes.length * sorted.length / N)].s.startNode);

// Lloyd's iteration
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

// Final assignment
const finalAssign = multiSourceDijkstra(seedNodes);
const cells = Array.from({ length: N }, () => []);
for (const seg of segs) {
    const a1 = finalAssign.get(seg.startNode), a2 = finalAssign.get(seg.endNode);
    const a = (a1 && a2) ? (a1.dist <= a2.dist ? a1 : a2) : a1 || a2;
    if (a) cells[a.seedIdx].push(seg);
}

// For each cell, find the segment endpoint nearest to the huddle and compute road-following path
for (let k = 0; k < N; k++) {
    let bestNode = null, bestDist = Infinity;
    for (const seg of cells[k]) {
        for (const nid of [seg.startNode, seg.endNode]) {
            // Use Dijkstra distance from huddle, not haversine
            const result = dijkstraPath(huddleNode, nid);
            if (result.dist < bestDist) {
                bestDist = result.dist;
                bestNode = nid;
            }
        }
    }

    if (bestNode) {
        const pathResult = dijkstraPath(huddleNode, bestNode);
        console.log(`Cell ${k}: ${cells[k].length} segs, ${cells[k].reduce((s,seg) => s + (seg.addressCount||0), 0)} addrs, fanout path ${pathResult.dist.toFixed(0)}m (${pathResult.polyline.length} points)`);

        const pts = ["lon lat"];
        for (const pt of pathResult.polyline) {
            pts.push(`${pt[1]} ${pt[0]}`);
        }
        fs.writeFileSync(path.join(dataDir, `voronoi-fm-esw${k}-fromhuddle.dat`), pts.join("\n") + "\n");
    }
}

console.log("Road-following fan-out paths saved.");
