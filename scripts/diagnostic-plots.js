#!/usr/bin/env node
// Diagnostic plots to verify:
// 1. Sub-segment geometry and cost matrix correctness
// 2. Road-following inter-segment paths (with turns at intersections)
// 3. Zigzag vs U-turn decision on a real segment
//
// Outputs GeoJSON files for visual inspection and .dat files for LaTeX

const fs = require("fs");
const path = require("path");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "network-extract.json"), "utf8"));
const dataDir = path.join(__dirname, "..", "data");

const segById = new Map();
for (const s of data.segments) segById.set(s.id, s);

const gidToSnap = new Map();
for (const snap of data.addressSnapping) gidToSnap.set(snap.gid, snap);

const addrByGid = new Map();
for (const a of data.addresses) addrByGid.set(a.gid, a);

// Build road network adjacency from ALL segments (with and without addresses)
const allSegs = [...data.segments, ...(data.roadSegments || [])];
const nodeAdj = new Map(); // nodeId -> [{toNode, dist, segPolyline}]
const nodeCoords = new Map();

// Extract node coords from address-bearing segments
for (const s of data.segments) {
    const pl = s.polyline;
    nodeCoords.set(s.startNode, { lat: pl[0][0], lon: pl[0][1] });
    nodeCoords.set(s.endNode, { lat: pl[pl.length-1][0], lon: pl[pl.length-1][1] });
}

for (const s of allSegs) {
    const sn = s.startNode, en = s.endNode;
    if (sn === en) continue;
    if (!nodeAdj.has(sn)) nodeAdj.set(sn, []);
    if (!nodeAdj.has(en)) nodeAdj.set(en, []);
    // Store the polyline so we can reconstruct the path
    const pl = s.polyline || [];
    nodeAdj.get(sn).push({ to: en, dist: s.distance, polyline: pl });
    nodeAdj.get(en).push({ to: sn, dist: s.distance, polyline: [...pl].reverse() });
}

// Dijkstra that returns both distance AND the path (sequence of nodes + polyline segments)
function dijkstraPath(startNode, endNode, maxDist = 10000) {
    if (startNode === endNode) return { dist: 0, path: [], polyline: [] };
    const dist = new Map([[startNode, 0]]);
    const prev = new Map(); // nodeId -> {fromNode, polyline}
    const visited = new Set();
    const queue = [{ node: startNode, d: 0 }];

    while (queue.length > 0) {
        let minIdx = 0;
        for (let i = 1; i < queue.length; i++) if (queue[i].d < queue[minIdx].d) minIdx = i;
        const { node, d } = queue[minIdx];
        queue[minIdx] = queue[queue.length - 1]; queue.pop();
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

    if (!dist.has(endNode)) return { dist: Infinity, path: [], polyline: [] };

    // Reconstruct path
    const pathNodes = [endNode];
    const polylines = [];
    let cur = endNode;
    while (prev.has(cur)) {
        const p = prev.get(cur);
        pathNodes.push(p.from);
        polylines.push(p.polyline);
        cur = p.from;
    }
    pathNodes.reverse();
    polylines.reverse();

    // Flatten polylines into one continuous polyline
    const fullPoly = [];
    for (const pl of polylines) {
        for (let i = 0; i < pl.length; i++) {
            if (fullPoly.length === 0 || i > 0) fullPoly.push(pl[i]);
        }
    }

    return { dist: dist.get(endNode), path: pathNodes, polyline: fullPoly };
}

// ============================================================
// DIAGNOSTIC 1: Pick a segment with addresses on both sides, show sub-segments
// ============================================================
console.log("=== DIAGNOSTIC 1: Sub-segment visualization ===");

// Find a good Fairmeadow segment with addresses on both sides
const fmAddrs = data.addresses.filter(a => a.neighborhood === "Fairmeadow");
const fmGids = new Set(fmAddrs.map(a => a.gid));
const fmSegIds = new Set();
for (const snap of data.addressSnapping) {
    if (fmGids.has(snap.gid)) fmSegIds.add(snap.segmentId);
}

let bestSeg = null;
for (const sid of fmSegIds) {
    const seg = segById.get(sid);
    if (!seg || !seg.traversalInfo) continue;
    if (seg.traversalInfo.runs > 1 && seg.addressCount >= 6 && seg.addressCount <= 20) {
        if (!bestSeg || seg.addressCount > bestSeg.addressCount) bestSeg = seg;
    }
}

if (bestSeg) {
    console.log(`Segment ${bestSeg.id}: "${bestSeg.name}", ${bestSeg.addressCount} addrs, D=${bestSeg.distance.toFixed(1)}m, runs=${bestSeg.traversalInfo.runs}`);

    // Get addresses on this segment with their sides
    const segSnaps = data.addressSnapping.filter(s => s.segmentId === bestSeg.id);
    const leftAddrs = [], rightAddrs = [];
    for (const snap of segSnaps) {
        const addr = addrByGid.get(snap.gid);
        if (!addr) continue;
        const entry = { gid: snap.gid, lat: addr.lat, lon: addr.lon, t: snap.t, address: addr.street_address };
        if (snap.side === "left") leftAddrs.push(entry);
        else rightAddrs.push(entry);
    }
    leftAddrs.sort((a, b) => a.t - b.t);
    rightAddrs.sort((a, b) => a.t - b.t);

    console.log(`  Left side (${leftAddrs.length}): ${leftAddrs.map(a => a.address).join(", ")}`);
    console.log(`  Right side (${rightAddrs.length}): ${rightAddrs.map(a => a.address).join(", ")}`);

    // Write segment centerline
    const clPts = ["lon lat"];
    for (const pt of bestSeg.polyline) clPts.push(`${pt[1]} ${pt[0]}`);
    fs.writeFileSync(path.join(dataDir, "diag1-centerline.dat"), clPts.join("\n") + "\n");

    // Write left-side addresses
    const lPts = ["lon lat label"];
    for (const a of leftAddrs) lPts.push(`${a.lon} ${a.lat} ${a.address.split(" ")[0]}`);
    fs.writeFileSync(path.join(dataDir, "diag1-left-addrs.dat"), lPts.join("\n") + "\n");

    // Write right-side addresses
    const rPts = ["lon lat label"];
    for (const a of rightAddrs) rPts.push(`${a.lon} ${a.lat} ${a.address.split(" ")[0]}`);
    fs.writeFileSync(path.join(dataDir, "diag1-right-addrs.dat"), rPts.join("\n") + "\n");

    // Show cost matrix
    console.log("  Cost matrix:");
    console.log("         S_L    S_R    E_L    E_R");
    const labels = ["S_L", "S_R", "E_L", "E_R"];
    for (let i = 0; i < 4; i++) {
        const row = bestSeg.costMatrix[i].map(v => v === Infinity ? "  Inf" : v.toFixed(0).padStart(6));
        console.log(`  ${labels[i]}  ${row.join(" ")}`);
    }

    // Cheapest port pair
    let cheapest = Infinity, cheapIn = 0, cheapOut = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        if (bestSeg.costMatrix[i][j] < cheapest) {
            cheapest = bestSeg.costMatrix[i][j];
            cheapIn = i; cheapOut = j;
        }
    }
    console.log(`  Cheapest: ${labels[cheapIn]} -> ${labels[cheapOut]} = ${cheapest.toFixed(1)}m`);
}

// ============================================================
// DIAGNOSTIC 2: Road-following path between two non-adjacent segments
// ============================================================
console.log("\n=== DIAGNOSTIC 2: Road-following inter-segment path ===");

// Pick two Fairmeadow segments that are NOT adjacent (don't share an intersection)
const fmSegs = [...fmSegIds].map(id => segById.get(id)).filter(Boolean);
const adjPairs = new Set();
for (const adj of data.segmentAdjacency) {
    adjPairs.add(`${adj.segA}:${adj.segB}`);
    adjPairs.add(`${adj.segB}:${adj.segA}`);
}

let seg1 = null, seg2 = null, bestPathDist = 0;
for (let i = 0; i < fmSegs.length && !seg1; i++) {
    for (let j = i + 1; j < fmSegs.length; j++) {
        const si = fmSegs[i], sj = fmSegs[j];
        if (adjPairs.has(`${si.id}:${sj.id}`)) continue; // skip adjacent
        if (si.addressCount < 3 || sj.addressCount < 3) continue;
        // Find path
        const result = dijkstraPath(si.endNode, sj.startNode);
        if (result.dist > 200 && result.dist < 800 && result.path.length >= 4) {
            seg1 = si; seg2 = sj;
            bestPathDist = result.dist;
            break;
        }
    }
}

if (seg1 && seg2) {
    console.log(`Segment A: "${seg1.name}" (id=${seg1.id}, ${seg1.addressCount} addrs, D=${seg1.distance.toFixed(1)}m)`);
    console.log(`Segment B: "${seg2.name}" (id=${seg2.id}, ${seg2.addressCount} addrs, D=${seg2.distance.toFixed(1)}m)`);

    const pathResult = dijkstraPath(seg1.endNode, seg2.startNode);
    console.log(`Path from A.end to B.start: ${pathResult.dist.toFixed(1)}m, ${pathResult.path.length} nodes, ${pathResult.path.length - 1} road segments (turns at intersections)`);
    console.log(`Path nodes: ${pathResult.path.join(" -> ")}`);

    // Write segment A polyline (blue)
    const aPts = ["lon lat"];
    for (const pt of seg1.polyline) aPts.push(`${pt[1]} ${pt[0]}`);
    fs.writeFileSync(path.join(dataDir, "diag2-segA.dat"), aPts.join("\n") + "\n");

    // Write segment B polyline (blue)
    const bPts = ["lon lat"];
    for (const pt of seg2.polyline) bPts.push(`${pt[1]} ${pt[0]}`);
    fs.writeFileSync(path.join(dataDir, "diag2-segB.dat"), bPts.join("\n") + "\n");

    // Write the ROAD-FOLLOWING path between them (red) - actual polyline through intersections
    const pathPts = ["lon lat"];
    for (const pt of pathResult.polyline) pathPts.push(`${pt[1]} ${pt[0]}`);
    fs.writeFileSync(path.join(dataDir, "diag2-road-path.dat"), pathPts.join("\n") + "\n");

    // For comparison, write the straight-line "jump" (gray dashed)
    const jumpPts = ["lon lat"];
    const exitPt = seg1.polyline[seg1.polyline.length - 1];
    const entryPt = seg2.polyline[0];
    jumpPts.push(`${exitPt[1]} ${exitPt[0]}`);
    jumpPts.push(`${entryPt[1]} ${entryPt[0]}`);
    fs.writeFileSync(path.join(dataDir, "diag2-straight-jump.dat"), jumpPts.join("\n") + "\n");

    // Compute haversine straight-line distance for comparison
    function haversine(lat1, lon1, lat2, lon2) {
        const R = 6371000, toRad = d => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    const straightDist = haversine(exitPt[0], exitPt[1], entryPt[0], entryPt[1]);
    console.log(`Straight-line distance: ${straightDist.toFixed(1)}m`);
    console.log(`Road-following distance: ${pathResult.dist.toFixed(1)}m`);
    console.log(`Road/straight ratio: ${(pathResult.dist / straightDist).toFixed(2)}x`);

    // Write addresses for both segments
    const aAddrs = data.addressSnapping.filter(s => s.segmentId === seg1.id);
    const bAddrs = data.addressSnapping.filter(s => s.segmentId === seg2.id);
    const aAddrPts = ["lon lat"];
    for (const snap of aAddrs) {
        const addr = addrByGid.get(snap.gid);
        if (addr) aAddrPts.push(`${addr.lon} ${addr.lat}`);
    }
    fs.writeFileSync(path.join(dataDir, "diag2-segA-addrs.dat"), aAddrPts.join("\n") + "\n");
    const bAddrPts = ["lon lat"];
    for (const snap of bAddrs) {
        const addr = addrByGid.get(snap.gid);
        if (addr) bAddrPts.push(`${addr.lon} ${addr.lat}`);
    }
    fs.writeFileSync(path.join(dataDir, "diag2-segB-addrs.dat"), bAddrPts.join("\n") + "\n");

    // Mark intersection nodes along the path
    const turnPts = ["lon lat"];
    for (const nid of pathResult.path) {
        const coord = nodeCoords.get(nid);
        if (coord) turnPts.push(`${coord.lon} ${coord.lat}`);
    }
    fs.writeFileSync(path.join(dataDir, "diag2-intersections.dat"), turnPts.join("\n") + "\n");
}

// ============================================================
// DIAGNOSTIC 3: Zigzag vs U-turn on a real segment
// ============================================================
console.log("\n=== DIAGNOSTIC 3: Zigzag vs U-turn comparison ===");

// Find a segment where zigzag and U-turn have different costs
let zigSeg = null, uturnSeg = null;
for (const seg of data.segments) {
    if (!seg.traversalInfo || seg.traversalInfo.runs <= 2) continue;
    const D = seg.distance;
    const throughMin = Math.min(
        seg.costMatrix[0][2], seg.costMatrix[0][3],
        seg.costMatrix[1][2], seg.costMatrix[1][3]);
    const uturnCost = 2 * D + 10; // approximate

    // Find one where zigzag wins clearly
    if (!zigSeg && throughMin < uturnCost * 0.8 && seg.addressCount >= 6 && seg.addressCount <= 15) {
        zigSeg = seg;
    }
    // Find one where U-turn wins clearly
    if (!uturnSeg && throughMin > uturnCost * 1.1 && seg.addressCount >= 8) {
        uturnSeg = seg;
    }
}

for (const [label, seg] of [["ZIGZAG-preferred", zigSeg], ["UTURN-preferred", uturnSeg]]) {
    if (!seg) { console.log(`  No ${label} segment found`); continue; }
    console.log(`${label}: "${seg.name}" (id=${seg.id}, ${seg.addressCount} addrs, D=${seg.distance.toFixed(1)}m, runs=${seg.traversalInfo.runs})`);

    const throughMin = Math.min(
        seg.costMatrix[0][2], seg.costMatrix[0][3],
        seg.costMatrix[1][2], seg.costMatrix[1][3]);
    const uturnCost = 2 * seg.distance + 10;
    console.log(`  Best through-traversal: ${throughMin.toFixed(1)}m`);
    console.log(`  U-turn equivalent: ${uturnCost.toFixed(1)}m`);
    console.log(`  ${throughMin < uturnCost ? "Zigzag" : "U-turn"} wins by ${Math.abs(throughMin - uturnCost).toFixed(1)}m (${(Math.abs(throughMin - uturnCost) / Math.max(throughMin, uturnCost) * 100).toFixed(1)}%)`);
}

console.log("\nDiagnostic plots saved to data/diag*.dat");
