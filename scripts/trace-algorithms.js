#!/usr/bin/env node
// Trace BFS, DFS, and SA step by step on a small neighborhood
// Outputs step-by-step data for paper illustrations

const fs = require("fs");
const path = require("path");

const T_ASSESS = 5; // min per address
const SPEED = 83.33; // m/min

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "network-extract.json"), "utf8"));
const fireData = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "fire-stations.json"), "utf8"));

const segById = new Map();
for (const s of data.segments) segById.set(s.id, s);
const gidToSeg = new Map();
for (const snap of data.addressSnapping) gidToSeg.set(snap.gid, snap.segmentId);

// Road network
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

let distMatrix = null;
function dijkstraAll(startNode, maxDist = 15000) {
    const dist = new Map([[startNode, 0]]);
    const visited = new Set();
    const queue = [{ node: startNode, d: 0 }];
    while (queue.length > 0) {
        let mi = 0;
        for (let i = 1; i < queue.length; i++) if (queue[i].d < queue[mi].d) mi = i;
        const { node, d } = queue[mi];
        queue[mi] = queue[queue.length - 1]; queue.pop();
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
function precomputeDistances(nodeIds) {
    distMatrix = new Map();
    for (const nid of nodeIds) distMatrix.set(nid, dijkstraAll(nid));
}
function nodeDist(n1, n2) {
    if (n1 === n2) return 0;
    return distMatrix?.get(n1)?.get(n2) ?? Infinity;
}

function segCentroid(seg) {
    const pl = seg.polyline;
    return { lat: pl.reduce((s, p) => s + p[0], 0) / pl.length,
             lon: pl.reduce((s, p) => s + p[1], 0) / pl.length };
}

function eswTime(segments, huddleNode) {
    if (segments.length === 0) return { time: 0, addrs: 0 };
    const firstSeg = segById.get(segments[0].segId);
    const firstNode = segments[0].entryPort < 2 ? firstSeg.startNode : firstSeg.endNode;
    const walkToFirst = nodeDist(huddleNode, firstNode);
    let prod = 0, unprod = 0, addrs = 0;
    for (const e of segments) {
        prod += e.segCost; unprod += e.transitionCost;
        addrs += segById.get(e.segId)?.addressCount || 0;
    }
    return { time: (walkToFirst + prod + unprod) / SPEED + addrs * T_ASSESS, addrs, walkDist: walkToFirst + prod + unprod };
}

// Use Greater Miranda (14 segments, small enough to trace)
const hoodAddrs = new Map();
for (const a of data.addresses) {
    if (!hoodAddrs.has(a.neighborhood)) hoodAddrs.set(a.neighborhood, []);
    hoodAddrs.get(a.neighborhood).push(a);
}

const hood = "Greater Miranda";
const addrs = hoodAddrs.get(hood);
const segIds = new Set();
for (const a of addrs) { const sid = gidToSeg.get(a.gid); if (sid !== undefined && segById.has(sid)) segIds.add(sid); }
const segs = [...segIds].map(id => segById.get(id));

console.log(`${hood}: ${addrs.length} addresses, ${segs.length} segments`);

// Precompute
const hoodNodes = new Set();
for (const s of segs) { hoodNodes.add(s.startNode); hoodNodes.add(s.endNode); }

// Find huddle node (nearest to fire station)
const assignment = fireData.neighborhoodAssignments.find(a => a.hood === hood);
let huddleNode = null, huddleDist = Infinity;
for (const nid of hoodNodes) {
    for (const s of segs) {
        let lat, lon;
        if (s.startNode === nid) { lat = s.polyline[0][0]; lon = s.polyline[0][1]; }
        else if (s.endNode === nid) { lat = s.polyline[s.polyline.length-1][0]; lon = s.polyline[s.polyline.length-1][1]; }
        else continue;
        const R = 6371000, toRad = d => d * Math.PI / 180;
        const dLat = toRad(lat - assignment.stationLat), dLon = toRad(lon - assignment.stationLon);
        const a = Math.sin(dLat/2)**2 + Math.cos(toRad(assignment.stationLat))*Math.cos(toRad(lat))*Math.sin(dLon/2)**2;
        const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        if (d < huddleDist) { huddleDist = d; huddleNode = nid; }
        break;
    }
}
hoodNodes.add(huddleNode);
precomputeDistances(hoodNodes);

const N = 3;
console.log(`N=${N}, huddle node=${huddleNode}\n`);

// Label segments with short names
const segLabels = new Map();
for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const name = s.name || `seg${i}`;
    const shortName = name.length > 15 ? name.substring(0, 12) + "..." : name;
    segLabels.set(s.id, `S${i}(${shortName},${s.addressCount}a)`);
}

function bestPortPair(seg, fromNode) {
    let bestEP = 0, bestXP = 2, bestCost = Infinity;
    for (let ep = 0; ep < 4; ep++) {
        const entryNode = ep < 2 ? seg.startNode : seg.endNode;
        const trans = nodeDist(fromNode, entryNode);
        for (let xp = 0; xp < 4; xp++) {
            const sc = seg.costMatrix[ep][xp];
            if (sc === Infinity) continue;
            if (trans + sc < bestCost) { bestCost = trans + sc; bestEP = ep; bestXP = xp; }
        }
    }
    return { entryPort: bestEP, exitPort: bestXP, segCost: seg.costMatrix[bestEP][bestXP], transitionCost: nodeDist(fromNode, bestEP < 2 ? seg.startNode : seg.endNode) };
}

// ============================================================
// BFS TRACE
// ============================================================
console.log("=== BFS Trace (Round-Robin from Huddle) ===\n");

const bfsAssignments = Array.from({ length: N }, () => []);
const bfsFrontiers = Array.from({ length: N }, () => huddleNode);
const bfsRemaining = new Set(segs.map((_, i) => i));
let round = 0;

while (bfsRemaining.size > 0) {
    round++;
    console.log(`Round ${round}:`);
    for (let k = 0; k < N && bfsRemaining.size > 0; k++) {
        let bestIdx = -1, bestTime = Infinity, bestEntry = {};
        for (const idx of bfsRemaining) {
            const seg = segs[idx];
            const pp = bestPortPair(seg, bfsFrontiers[k]);
            const marginal = (pp.transitionCost + pp.segCost) / SPEED + (seg.addressCount || 0) * T_ASSESS;
            if (marginal < bestTime) { bestTime = marginal; bestIdx = idx; bestEntry = pp; }
        }
        if (bestIdx < 0) break;
        bfsRemaining.delete(bestIdx);
        bfsAssignments[k].push({ segId: segs[bestIdx].id, ...bestEntry });
        const seg = segs[bestIdx];
        bfsFrontiers[k] = bestEntry.exitPort < 2 ? seg.startNode : seg.endNode;
        const et = eswTime(bfsAssignments[k], huddleNode);
        console.log(`  ESW ${k+1}: + ${segLabels.get(seg.id)} → time=${et.time.toFixed(0)}min (${et.addrs} addrs)`);
    }
    console.log();
}

console.log("BFS Final:");
for (let k = 0; k < N; k++) {
    const et = eswTime(bfsAssignments[k], huddleNode);
    console.log(`  ESW ${k+1}: ${et.addrs} addrs, ${et.time.toFixed(0)}min, walk=${et.walkDist.toFixed(0)}m`);
}
const bfsMax = Math.max(...bfsAssignments.map(a => eswTime(a, huddleNode).time));
const bfsSpread = Math.max(...bfsAssignments.map(a => eswTime(a, huddleNode).time)) - Math.min(...bfsAssignments.map(a => eswTime(a, huddleNode).time));
console.log(`  Max time: ${bfsMax.toFixed(0)}min, spread: ${bfsSpread.toFixed(0)}min\n`);

// ============================================================
// DFS TRACE
// ============================================================
console.log("=== DFS Trace (One ESW at a Time) ===\n");

const totalProd = segs.reduce((s, seg) => {
    const minCost = Math.min(...seg.costMatrix.flat().filter(v => v < Infinity));
    return s + minCost;
}, 0);
const totalAddrs = segs.reduce((s, seg) => s + (seg.addressCount || 0), 0);
const targetTime = (totalProd / SPEED + totalAddrs * T_ASSESS) / N;
console.log(`Target time per ESW: ${targetTime.toFixed(0)}min\n`);

const dfsAssignments = Array.from({ length: N }, () => []);
const dfsRemaining = new Set(segs.map((_, i) => i));

for (let k = 0; k < N; k++) {
    console.log(`Building ESW ${k+1}:`);
    let frontier = huddleNode;
    let eswT = 0;

    while (dfsRemaining.size > 0) {
        if (k === N - 1) {
            // Last ESW: take everything
            while (dfsRemaining.size > 0) {
                let bestIdx = -1, bestCost = Infinity, bestEntry = {};
                for (const idx of dfsRemaining) {
                    const pp = bestPortPair(segs[idx], frontier);
                    if (pp.transitionCost + pp.segCost < bestCost) {
                        bestCost = pp.transitionCost + pp.segCost; bestIdx = idx; bestEntry = pp;
                    }
                }
                if (bestIdx < 0) break;
                dfsRemaining.delete(bestIdx);
                dfsAssignments[k].push({ segId: segs[bestIdx].id, ...bestEntry });
                frontier = bestEntry.exitPort < 2 ? segs[bestIdx].startNode : segs[bestIdx].endNode;
                const et = eswTime(dfsAssignments[k], huddleNode);
                console.log(`  + ${segLabels.get(segs[bestIdx].id)} → time=${et.time.toFixed(0)}min (last ESW, must take all)`);
            }
            break;
        }

        let bestIdx = -1, bestCost = Infinity, bestEntry = {}, bestMarginal = 0;
        for (const idx of dfsRemaining) {
            const seg = segs[idx];
            const pp = bestPortPair(seg, frontier);
            if (pp.transitionCost + pp.segCost < bestCost) {
                bestCost = pp.transitionCost + pp.segCost; bestIdx = idx; bestEntry = pp;
                bestMarginal = (pp.transitionCost + pp.segCost) / SPEED + (seg.addressCount || 0) * T_ASSESS;
            }
        }
        if (bestIdx < 0) break;

        if (eswT + bestMarginal > targetTime * 1.1 && dfsAssignments[k].length > 0) {
            console.log(`  STOP: would exceed target (${(eswT + bestMarginal).toFixed(0)} > ${(targetTime * 1.1).toFixed(0)})\n`);
            break;
        }

        dfsRemaining.delete(bestIdx);
        dfsAssignments[k].push({ segId: segs[bestIdx].id, ...bestEntry });
        frontier = bestEntry.exitPort < 2 ? segs[bestIdx].startNode : segs[bestIdx].endNode;
        eswT += bestMarginal;
        const et = eswTime(dfsAssignments[k], huddleNode);
        console.log(`  + ${segLabels.get(segs[bestIdx].id)} → time=${et.time.toFixed(0)}min`);
    }
}

console.log("\nDFS Final:");
for (let k = 0; k < N; k++) {
    const et = eswTime(dfsAssignments[k], huddleNode);
    console.log(`  ESW ${k+1}: ${et.addrs} addrs, ${et.time.toFixed(0)}min, walk=${et.walkDist.toFixed(0)}m`);
}
const dfsMax = Math.max(...dfsAssignments.map(a => eswTime(a, huddleNode).time));
const dfsSpread = Math.max(...dfsAssignments.map(a => eswTime(a, huddleNode).time)) - Math.min(...dfsAssignments.map(a => eswTime(a, huddleNode).time));
console.log(`  Max time: ${dfsMax.toFixed(0)}min, spread: ${dfsSpread.toFixed(0)}min\n`);

// ============================================================
// SA TRACE (on BFS result)
// ============================================================
console.log("=== SA Trace (Improving BFS) ===\n");

let saCurrent = bfsAssignments.map(a => [...a]);
let saCurrentTimes = saCurrent.map(a => eswTime(a, huddleNode).time);
let saCurrentMax = Math.max(...saCurrentTimes);
console.log(`Starting from BFS: max=${saCurrentMax.toFixed(0)}min, times=[${saCurrentTimes.map(t => t.toFixed(0)).join(", ")}]\n`);

let T = saCurrentMax * 0.1;
const Tf = 0.1;
const maxIter = 200;
const alpha = Math.pow(Tf / T, 1 / maxIter);
let accepted = 0, improved = 0;

for (let iter = 0; iter < maxIter; iter++) {
    const avgTime = saCurrentTimes.reduce((s, t) => s + t, 0) / N;
    const heavyEsws = saCurrentTimes.map((t, i) => ({ i, t })).filter(x => x.t > avgTime * 0.9);
    if (heavyEsws.length === 0) break;
    const fromEsw = heavyEsws[Math.floor(Math.random() * heavyEsws.length)].i;
    if (saCurrent[fromEsw].length <= 1) continue;

    const segIdx = saCurrent[fromEsw].length - 1;
    const seg = saCurrent[fromEsw][segIdx];
    let toEsw = Math.floor(Math.random() * (N - 1));
    if (toEsw >= fromEsw) toEsw++;

    const newFrom = [...saCurrent[fromEsw]]; newFrom.splice(segIdx, 1);
    const newTo = [...saCurrent[toEsw], seg];
    const newFromTime = eswTime(newFrom, huddleNode).time;
    const newToTime = eswTime(newTo, huddleNode).time;
    const newMax = Math.max(...saCurrentTimes.map((t, i) => i === fromEsw ? newFromTime : i === toEsw ? newToTime : t));
    const delta = newMax - saCurrentMax;

    const accept = delta < 0 || Math.random() < Math.exp(-delta / T);
    if (accept) {
        const movedSeg = segLabels.get(seg.segId);
        if (delta < -1) { // Only log significant improvements
            console.log(`Iter ${iter}: Move ${movedSeg} from ESW${fromEsw+1}→ESW${toEsw+1}`);
            console.log(`  Before: [${saCurrentTimes.map(t => t.toFixed(0)).join(", ")}] max=${saCurrentMax.toFixed(0)}min`);
        }
        saCurrent[fromEsw] = newFrom;
        saCurrent[toEsw] = newTo;
        saCurrentTimes[fromEsw] = newFromTime;
        saCurrentTimes[toEsw] = newToTime;
        saCurrentMax = newMax;
        accepted++;
        if (delta < -1) {
            console.log(`  After:  [${saCurrentTimes.map(t => t.toFixed(0)).join(", ")}] max=${saCurrentMax.toFixed(0)}min (Δ=${delta.toFixed(0)}min)`);
            improved++;
            console.log();
        }
    }
    T *= alpha;
}

console.log(`SA completed: ${accepted} accepted, ${improved} improved`);
console.log(`SA Final:`);
for (let k = 0; k < N; k++) {
    const et = eswTime(saCurrent[k], huddleNode);
    console.log(`  ESW ${k+1}: ${et.addrs} addrs, ${et.time.toFixed(0)}min, segs=[${saCurrent[k].map(e => segLabels.get(e.segId)).join(", ")}]`);
}
const saMax = Math.max(...saCurrent.map(a => eswTime(a, huddleNode).time));
console.log(`  Max time: ${saMax.toFixed(0)}min (was ${bfsMax.toFixed(0)}min from BFS, ${((bfsMax-saMax)/bfsMax*100).toFixed(1)}% improvement)`);

// ============================================================
// Write segment centroid data for map figures
// ============================================================
const dataDir = path.join(__dirname, "..", "data");

// All segment centroids with labels
const centPts = ["lon lat label addrs"];
for (let i = 0; i < segs.length; i++) {
    const c = segCentroid(segs[i]);
    centPts.push(`${c.lon} ${c.lat} S${i} ${segs[i].addressCount}`);
}
fs.writeFileSync(path.join(dataDir, "trace-segments.dat"), centPts.join("\n") + "\n");

// Huddle point
const hCoord = (() => {
    for (const s of segs) {
        if (s.startNode === huddleNode) return { lat: s.polyline[0][0], lon: s.polyline[0][1] };
        if (s.endNode === huddleNode) return { lat: s.polyline[s.polyline.length-1][0], lon: s.polyline[s.polyline.length-1][1] };
    }
})();
fs.writeFileSync(path.join(dataDir, "trace-huddle.dat"), `lon lat\n${hCoord.lon} ${hCoord.lat}\n`);

// BFS assignment colors (which ESW each segment belongs to)
const bfsColors = ["lon lat esw"];
for (let k = 0; k < N; k++) {
    for (const e of bfsAssignments[k]) {
        const c = segCentroid(segById.get(e.segId));
        bfsColors.push(`${c.lon} ${c.lat} ${k}`);
    }
}
fs.writeFileSync(path.join(dataDir, "trace-bfs-assign.dat"), bfsColors.join("\n") + "\n");

// DFS assignment colors
const dfsColors = ["lon lat esw"];
for (let k = 0; k < N; k++) {
    for (const e of dfsAssignments[k]) {
        const c = segCentroid(segById.get(e.segId));
        dfsColors.push(`${c.lon} ${c.lat} ${k}`);
    }
}
fs.writeFileSync(path.join(dataDir, "trace-dfs-assign.dat"), dfsColors.join("\n") + "\n");

// SA assignment colors
const saColors = ["lon lat esw"];
for (let k = 0; k < N; k++) {
    for (const e of saCurrent[k]) {
        const c = segCentroid(segById.get(e.segId));
        saColors.push(`${c.lon} ${c.lat} ${k}`);
    }
}
fs.writeFileSync(path.join(dataDir, "trace-sa-assign.dat"), saColors.join("\n") + "\n");

console.log("\nTrace data saved to data/trace-*.dat");
