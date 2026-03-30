#!/usr/bin/env node
// Regenerate Voronoi Fairmeadow figure data (balanced seeds)
// to match the current unified simulation results.
// Produces: voronoi-fm-bal-cell{0,1,2}.dat, voronoi-fm-bal-seeds.dat,
//           voronoi-fm-bal-straight-lines.dat

const fs = require("fs");
const path = require("path");
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "network-extract.json"), "utf8"));
const dataDir = path.join(__dirname, "..", "data");

const segById = new Map();
for (const s of data.segments) segById.set(s.id, s);
const gidToSeg = new Map();
for (const snap of data.addressSnapping) gidToSeg.set(snap.gid, snap.segmentId);

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

// Fairmeadow segments
const fmAddrs = data.addresses.filter(a => a.neighborhood === "Fairmeadow");
const fmSegIds = new Set();
for (const a of fmAddrs) { const sid = gidToSeg.get(a.gid); if (sid !== undefined) fmSegIds.add(sid); }
const segs = [...fmSegIds].map(id => segById.get(id)).filter(Boolean);
const centroids = segs.map(s => segCentroid(s));
const N = 3;
const totalA = segs.reduce((s, seg) => s + (seg.addressCount || 0), 0);

const nodeCoords = new Map();
for (const s of segs) {
    if (!nodeCoords.has(s.startNode)) nodeCoords.set(s.startNode, { lat: s.polyline[0][0], lon: s.polyline[0][1] });
    if (!nodeCoords.has(s.endNode)) nodeCoords.set(s.endNode, { lat: s.polyline[s.polyline.length-1][0], lon: s.polyline[s.polyline.length-1][1] });
}
const nodeList = [...nodeCoords.keys()];

function assignCells(seeds) {
    const cells = Array.from({ length: N }, () => []);
    for (let si = 0; si < segs.length; si++) {
        const c = centroids[si]; let bestK = 0, bestD = Infinity;
        for (let k = 0; k < N; k++) { const d = eucDist(c.lat, c.lon, seeds[k].lat, seeds[k].lon); if (d < bestD) { bestD = d; bestK = k; } }
        const pl = segs[si].polyline;
        if (pl.length >= 2) {
            let sK = 0, eK = 0, sB = Infinity, eB = Infinity;
            for (let k = 0; k < N; k++) {
                const ds = eucDist(pl[0][0], pl[0][1], seeds[k].lat, seeds[k].lon);
                const de = eucDist(pl[pl.length-1][0], pl[pl.length-1][1], seeds[k].lat, seeds[k].lon);
                if (ds < sB) { sB = ds; sK = k; } if (de < eB) { eB = de; eK = k; }
            }
            if (sK !== eK) bestK = sK;
        }
        cells[bestK].push(si);
    }
    return cells;
}

function cellImbalance(cells) {
    const counts = cells.map(c => c.reduce((s, si) => s + (segs[si].addressCount || 0), 0));
    const target = totalA / N;
    return counts.reduce((s, c) => s + Math.abs(c - target), 0);
}

// Exhaustive search: Fairmeadow has few enough nodes for C(n,3)
console.log("Exhaustive search over", nodeList.length, "nodes, C(" + nodeList.length + ",3) =", nodeList.length*(nodeList.length-1)*(nodeList.length-2)/6, "combinations");
let bestSeeds = null, bestImb = Infinity;
for (let i = 0; i < nodeList.length; i++) {
    for (let j = i + 1; j < nodeList.length; j++) {
        for (let k = j + 1; k < nodeList.length; k++) {
            const seeds = [nodeCoords.get(nodeList[i]), nodeCoords.get(nodeList[j]), nodeCoords.get(nodeList[k])];
            const cells = assignCells(seeds);
            const imb = cellImbalance(cells);
            if (imb < bestImb) { bestImb = imb; bestSeeds = [...seeds]; }
        }
    }
}
console.log("Best imbalance:", bestImb);

const cells = assignCells(bestSeeds);
const addrCounts = cells.map(c => c.reduce((s, si) => s + (segs[si].addressCount || 0), 0));
console.log("Balanced seeds:", addrCounts.join("/"));

// Write cell segment data
for (let k = 0; k < N; k++) {
    const pts = ["lon lat"];
    for (const si of cells[k]) {
        const seg = segs[si];
        for (const pt of seg.polyline) pts.push(`${pt[1]} ${pt[0]}`);
        pts.push("");
    }
    fs.writeFileSync(path.join(dataDir, `voronoi-fm-bal-cell${k}.dat`), pts.join("\n") + "\n");
}

// Write seed points
const seedPts = ["lon lat"];
for (const s of bestSeeds) seedPts.push(`${s.lon} ${s.lat}`);
fs.writeFileSync(path.join(dataDir, "voronoi-fm-bal-seeds.dat"), seedPts.join("\n") + "\n");

// Write straight partition lines (perpendicular bisectors extended)
// The perpendicular bisector of seeds i,j passes through their midpoint
// and is perpendicular to the line connecting them.
// Direction: rotate (dLat, dLon) by 90 degrees → (-dLon, dLat)
const linePts = ["lon lat"];
for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
        const s1 = bestSeeds[i], s2 = bestSeeds[j];
        const midLat = (s1.lat + s2.lat) / 2, midLon = (s1.lon + s2.lon) / 2;
        const dLat = s2.lat - s1.lat, dLon = s2.lon - s1.lon;
        const len = Math.sqrt(dLat * dLat + dLon * dLon);
        // Perpendicular unit vector: (-dLon, dLat) / len
        const perpLat = -dLon / len, perpLon = dLat / len;
        const ext = 0.015; // extend far enough for pgfplots to clip
        linePts.push(`${midLon + perpLon * ext} ${midLat + perpLat * ext}`);
        linePts.push(`${midLon - perpLon * ext} ${midLat - perpLat * ext}`);
        linePts.push("");
    }
}
fs.writeFileSync(path.join(dataDir, "voronoi-fm-bal-straight-lines.dat"), linePts.join("\n") + "\n");

console.log("Voronoi FM balanced data regenerated.");
