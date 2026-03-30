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

// Lloyd's + greedy seed search (same as unified simulation)
let bestSeeds = null, bestImb = Infinity;
for (let restart = 0; restart < 10; restart++) {
    const sorted = [...segs].map((s, i) => ({ s, c: centroids[i] }))
        .sort((a, b) => restart === 0 ? a.c.lat - b.c.lat : Math.random() - 0.5);
    let seeds = Array.from({ length: N }, (_, i) => ({ ...sorted[Math.floor((i + 0.5) * sorted.length / N)].c }));

    for (let iter = 0; iter < 20; iter++) {
        const cells = assignCells(seeds); let converged = true;
        for (let k = 0; k < N; k++) {
            if (cells[k].length === 0) continue;
            let tw = 0, latS = 0, lonS = 0;
            for (const si of cells[k]) { const c = centroids[si]; const w = segs[si].addressCount || 1; latS += c.lat*w; lonS += c.lon*w; tw += w; }
            const nl = latS/tw, no = lonS/tw;
            if (Math.abs(nl - seeds[k].lat) > 1e-6 || Math.abs(no - seeds[k].lon) > 1e-6) converged = false;
            seeds[k] = { lat: nl, lon: no };
        }
        if (converged) break;
    }

    for (let gi = 0; gi < 10; gi++) {
        let improved = false;
        for (let k = 0; k < N; k++) {
            for (let c = 0; c < 50; c++) {
                const candCoord = nodeCoords.get(nodeList[Math.floor(Math.random() * nodeList.length)]);
                const testSeeds = seeds.map((s, i) => i === k ? candCoord : s);
                const imb = cellImbalance(assignCells(testSeeds));
                if (imb < bestImb) { bestImb = imb; bestSeeds = [...testSeeds]; seeds[k] = candCoord; improved = true; }
            }
        }
        if (!improved) break;
    }
    const imb = cellImbalance(assignCells(seeds));
    if (imb < bestImb || !bestSeeds) { bestImb = imb; bestSeeds = [...seeds]; }
}

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
const linePts = ["lon lat"];
for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
        const s1 = bestSeeds[i], s2 = bestSeeds[j];
        const midLat = (s1.lat + s2.lat) / 2, midLon = (s1.lon + s2.lon) / 2;
        const dLat = s2.lat - s1.lat, dLon = s2.lon - s1.lon;
        // Perpendicular direction (rotated 90 degrees)
        const ext = 0.02; // extend far enough for pgfplots to clip
        linePts.push(`${midLon - dLat * ext / Math.sqrt(dLat*dLat + dLon*dLon) * (dLon >= 0 ? 1 : -1)} ${midLat + dLon * ext / Math.sqrt(dLat*dLat + dLon*dLon) * (dLon >= 0 ? 1 : -1)}`);
        linePts.push(`${midLon + dLat * ext / Math.sqrt(dLat*dLat + dLon*dLon) * (dLon >= 0 ? 1 : -1)} ${midLat - dLon * ext / Math.sqrt(dLat*dLat + dLon*dLon) * (dLon >= 0 ? 1 : -1)}`);
        linePts.push("");
    }
}
fs.writeFileSync(path.join(dataDir, "voronoi-fm-bal-straight-lines.dat"), linePts.join("\n") + "\n");

console.log("Voronoi FM balanced data regenerated.");
