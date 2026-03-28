#!/usr/bin/env node
// Generate single-worker chain traversal data for NN and RH on Fairmeadow
// Shows segment polylines (blue) and inter-segment transitions (red)
// connecting segment endpoints — NOT centroids.

const fs = require("fs");
const path = require("path");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "network-extract.json"), "utf8"));
const segById = new Map();
for (const s of data.segments) segById.set(s.id, s);

const gidToSeg = new Map();
for (const snap of data.addressSnapping) gidToSeg.set(snap.gid, snap.segmentId);

// Get Fairmeadow segments
const fmGids = new Set(data.addresses.filter(a => a.neighborhood === "Fairmeadow").map(a => a.gid));
const fmSegIds = new Set();
for (const gid of fmGids) { const sid = gidToSeg.get(gid); if (sid !== undefined) fmSegIds.add(sid); }
const fmSegs = [...fmSegIds].map(id => segById.get(id)).filter(Boolean);

console.log(`Fairmeadow: ${fmSegs.length} segments`);

// Build adjacency for Dijkstra
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

function dijkstraAll(startNode, maxDist = 10000) {
    const dist = new Map([[startNode, 0]]);
    const visited = new Set();
    const queue = [{ node: startNode, d: 0 }];
    while (queue.length > 0) {
        let minIdx = 0;
        for (let i = 1; i < queue.length; i++) if (queue[i].d < queue[minIdx].d) minIdx = i;
        const { node, d } = queue[minIdx];
        queue[minIdx] = queue[queue.length - 1]; queue.pop();
        if (visited.has(node)) continue;
        visited.add(node);
        for (const edge of (nodeAdj.get(node) || [])) {
            const nd = d + edge.dist;
            if (nd > maxDist) continue;
            if (nd < (dist.get(edge.to) ?? Infinity)) {
                dist.set(edge.to, nd);
                queue.push({ node: edge.to, d: nd });
            }
        }
    }
    return dist;
}

// Precompute distances for Fairmeadow nodes
const fmNodes = new Set();
for (const s of fmSegs) { fmNodes.add(s.startNode); fmNodes.add(s.endNode); }
console.log(`Precomputing distances for ${fmNodes.size} nodes...`);
const distMatrix = new Map();
for (const nid of fmNodes) distMatrix.set(nid, dijkstraAll(nid));
function nodeDist(n1, n2) { return n1 === n2 ? 0 : (distMatrix.get(n1)?.get(n2) ?? Infinity); }

// NN chain (single worker, all segments)
function chainNN(segs, startIdx) {
    const remaining = new Set(segs.map((_, i) => i));
    const chain = [];
    let ci = startIdx; remaining.delete(ci);
    let s = segs[ci];
    // Start with through-traversal
    let exitPort = 2; // E side
    chain.push({ seg: s, entryPort: 0, exitPort: 2 });

    while (remaining.size > 0) {
        const lastSeg = chain[chain.length - 1].seg;
        const lastExit = chain[chain.length - 1].exitPort;
        const exitNode = lastExit < 2 ? lastSeg.startNode : lastSeg.endNode;

        let bestIdx = -1, bestTotal = Infinity, bestEP = 0, bestXP = 2;
        for (const idx of remaining) {
            const cand = segs[idx];
            for (const [ep, entryNode] of [[0, cand.startNode], [2, cand.endNode]]) {
                const trans = nodeDist(exitNode, entryNode);
                const xp = ep === 0 ? 2 : 0; // through-traversal
                const total = trans + cand.distance;
                if (total < bestTotal) { bestTotal = total; bestIdx = idx; bestEP = ep; bestXP = xp; }
            }
        }
        if (bestIdx < 0) break;
        remaining.delete(bestIdx);
        chain.push({ seg: segs[bestIdx], entryPort: bestEP, exitPort: bestXP });
    }
    return chain;
}

// RH chain (single worker)
function chainRH(segs, startIdx) {
    function bearing(lat1, lon1, lat2, lon2) {
        const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
        const dLon = toRad(lon2 - lon1);
        const y = Math.sin(dLon) * Math.cos(toRad(lat2));
        const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
                  Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
        return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }
    const remaining = new Set(segs.map((_, i) => i));
    const chain = [];
    let ci = startIdx; remaining.delete(ci);
    let s = segs[ci];
    chain.push({ seg: s, entryPort: 0, exitPort: 2 });
    const pl = s.polyline;
    let heading = bearing(pl[0][0], pl[0][1], pl[pl.length-1][0], pl[pl.length-1][1]);

    while (remaining.size > 0) {
        const lastSeg = chain[chain.length - 1].seg;
        const lastExit = chain[chain.length - 1].exitPort;
        const exitNode = lastExit < 2 ? lastSeg.startNode : lastSeg.endNode;
        const exitPl = lastSeg.polyline;
        const exitLat = lastExit < 2 ? exitPl[0][0] : exitPl[exitPl.length-1][0];
        const exitLon = lastExit < 2 ? exitPl[0][1] : exitPl[exitPl.length-1][1];

        let bestIdx = -1, bestScore = Infinity, bestEP = 0, bestXP = 2;
        for (const idx of remaining) {
            const cand = segs[idx];
            for (const [ep, entryNode] of [[0, cand.startNode], [2, cand.endNode]]) {
                const trans = nodeDist(exitNode, entryNode);
                const candPl = cand.polyline;
                const entryLat = ep === 0 ? candPl[0][0] : candPl[candPl.length-1][0];
                const entryLon = ep === 0 ? candPl[0][1] : candPl[candPl.length-1][1];
                const bear = bearing(exitLat, exitLon, entryLat, entryLon);
                const turn = (bear - heading + 360) % 360;
                const xp = ep === 0 ? 2 : 0;
                const score = trans + turn * 0.5;
                if (score < bestScore) { bestScore = score; bestIdx = idx; bestEP = ep; bestXP = xp; }
            }
        }
        if (bestIdx < 0) break;
        remaining.delete(bestIdx);
        const cand = segs[bestIdx];
        chain.push({ seg: cand, entryPort: bestEP, exitPort: bestXP });
        const cPl = cand.polyline;
        if (bestXP < 2) heading = bearing(cPl[cPl.length-1][0], cPl[cPl.length-1][1], cPl[0][0], cPl[0][1]);
        else heading = bearing(cPl[0][0], cPl[0][1], cPl[cPl.length-1][0], cPl[cPl.length-1][1]);
    }
    return chain;
}

function writeChainData(chain, prefix) {
    const dataDir = path.join(__dirname, "..", "data");
    // Segment polylines (blue)
    const segLines = ["lon lat"];
    for (const entry of chain) {
        const pl = entry.entryPort < 2 ? entry.seg.polyline : [...entry.seg.polyline].reverse();
        for (const pt of pl) segLines.push(`${pt[1]} ${pt[0]}`);
        segLines.push(""); // gap between segments
    }
    fs.writeFileSync(path.join(dataDir, `${prefix}-chain-segs.dat`), segLines.join("\n") + "\n");

    // Transitions between segments (red) - connecting exit endpoint to entry endpoint
    const transLines = ["lon lat"];
    for (let i = 1; i < chain.length; i++) {
        const prev = chain[i-1];
        const curr = chain[i];
        const prevPl = prev.seg.polyline;
        const currPl = curr.seg.polyline;
        const exitPt = prev.exitPort < 2 ? prevPl[0] : prevPl[prevPl.length-1];
        const entryPt = curr.entryPort < 2 ? currPl[0] : currPl[currPl.length-1];
        transLines.push(`${exitPt[1]} ${exitPt[0]}`);
        transLines.push(`${entryPt[1]} ${entryPt[0]}`);
        transLines.push(""); // gap
    }
    fs.writeFileSync(path.join(dataDir, `${prefix}-chain-trans.dat`), transLines.join("\n") + "\n");

    console.log(`  ${prefix}: ${chain.length} segments, ${chain.length - 1} transitions`);
}

// Best NN chain (try several starts)
let bestNN = null, bestNNCost = Infinity;
for (let si = 0; si < Math.min(fmSegs.length, 15); si++) {
    const chain = chainNN(fmSegs, si);
    const cost = chain.length; // simple: all segments visited
    if (!bestNN || si === 0) { bestNN = chain; } // just use first for now
}
writeChainData(bestNN, "fm-nn");

// Best RH chain
const rhChain = chainRH(fmSegs, 0);
writeChainData(rhChain, "fm-rh");

console.log("Done.");
