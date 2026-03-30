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

// Write straight partition lines as 3 RAYS from the circumcenter.
// For N=3, the three perpendicular bisectors meet at the circumcenter
// of the three seeds. Each Voronoi edge is a ray from the circumcenter
// extending outward (away from the third seed).
const ax = bestSeeds[0].lon, ay = bestSeeds[0].lat;
const bx = bestSeeds[1].lon, by = bestSeeds[1].lat;
const cx = bestSeeds[2].lon, cy = bestSeeds[2].lat;
const D2 = 2 * (ax*(by-cy) + bx*(cy-ay) + cx*(ay-by));
const ccLon = ((ax*ax+ay*ay)*(by-cy) + (bx*bx+by*by)*(cy-ay) + (cx*cx+cy*cy)*(ay-by)) / D2;
const ccLat = ((ax*ax+ay*ay)*(cx-bx) + (bx*bx+by*by)*(ax-cx) + (cx*cx+cy*cy)*(bx-ax)) / D2;
console.log("Circumcenter:", ccLon.toFixed(6), ccLat.toFixed(6));

const linePts = ["lon lat"];
for (let i = 0; i < N; i++) {
    const j = (i + 1) % N, k = (i + 2) % N;
    // Bisector between seeds i and j: perpendicular to (si→sj), passes through circumcenter
    const dLat = bestSeeds[j].lat - bestSeeds[i].lat;
    const dLon = bestSeeds[j].lon - bestSeeds[i].lon;
    const len = Math.sqrt(dLat * dLat + dLon * dLon);
    // Perpendicular direction: (-dLon, dLat) / len
    let perpLat = -dLon / len, perpLon = dLat / len;
    // Orient away from seed k
    const toK_lat = bestSeeds[k].lat - ccLat, toK_lon = bestSeeds[k].lon - ccLon;
    if (perpLat * toK_lat + perpLon * toK_lon > 0) { perpLat = -perpLat; perpLon = -perpLon; }
    // Ray from circumcenter outward
    const ext = 0.015;
    linePts.push(`${ccLon} ${ccLat}`);
    linePts.push(`${ccLon + perpLon * ext} ${ccLat + perpLat * ext}`);
    linePts.push("");
}
fs.writeFileSync(path.join(dataDir, "voronoi-fm-bal-straight-lines.dat"), linePts.join("\n") + "\n");

console.log("Voronoi FM balanced data regenerated.");
