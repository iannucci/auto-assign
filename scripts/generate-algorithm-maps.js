#!/usr/bin/env node
// Generate per-algorithm Fairmeadow N=3 assignment maps
// Each algorithm gets a .dat file per ESW (colored segments)
// plus a transition file (red dashed)

const fs = require("fs");
const path = require("path");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "network-extract.json"), "utf8"));
const fireData = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "fire-stations.json"), "utf8"));
const dataDir = path.join(__dirname, "..", "data");

const segById = new Map();
for (const s of data.segments) segById.set(s.id, s);
const gidToSeg = new Map();
for (const snap of data.addressSnapping) gidToSeg.set(snap.gid, snap.segmentId);

const allSegsArr = [...data.segments, ...(data.roadSegments || [])];
const nodeAdj = new Map();
for (const s of allSegsArr) {
    const sn = s.startNode, en = s.endNode;
    if (sn === en) continue;
    if (!nodeAdj.has(sn)) nodeAdj.set(sn, []);
    if (!nodeAdj.has(en)) nodeAdj.set(en, []);
    nodeAdj.get(sn).push({ to: en, dist: s.distance });
    nodeAdj.get(en).push({ to: sn, dist: s.distance });
}

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

// Load unified results to get the partitions
// Actually, we need to RE-RUN each algorithm to get the actual segment assignments
// The unified results only store metrics, not the partition data

// Let me use the same algorithm implementations from unified-simulation.js
// but save the partition assignments

let distMatrix = null;
function precomputeDistances(nodeIds) {
    distMatrix = new Map();
    for (const nid of nodeIds) {
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
        distMatrix.set(nid, dist);
    }
}
function nodeDist(n1, n2) {
    if (n1 === n2) return 0;
    return distMatrix?.get(n1)?.get(n2) ?? Infinity;
}

// Get Fairmeadow segments
const fmAddrs = data.addresses.filter(a => a.neighborhood === "Fairmeadow");
const fmSegIds = new Set();
for (const a of fmAddrs) { const sid = gidToSeg.get(a.gid); if (sid !== undefined && segById.has(sid)) fmSegIds.add(sid); }
const segs = [...fmSegIds].map(id => segById.get(id));
const centroids = segs.map(s => segCentroid(s));

// Precompute distances
const hoodNodes = new Set();
for (const s of segs) { hoodNodes.add(s.startNode); hoodNodes.add(s.endNode); }

// Find huddle
const fmAssign = fireData.neighborhoodAssignments.find(a => a.hood === "Fairmeadow");
let huddleNode = null, huddleDist = Infinity;
for (const nid of hoodNodes) {
    for (const s of segs) {
        let lat, lon;
        if (s.startNode === nid) { lat = s.polyline[0][0]; lon = s.polyline[0][1]; }
        else if (s.endNode === nid) { lat = s.polyline[s.polyline.length-1][0]; lon = s.polyline[s.polyline.length-1][1]; }
        else continue;
        const d = eucDist(lat, lon, fmAssign.stationLat, fmAssign.stationLon);
        if (d < huddleDist) { huddleDist = d; huddleNode = nid; }
        break;
    }
}
hoodNodes.add(huddleNode);
precomputeDistances(hoodNodes);

const N = 3;

// ============================================================
// Algorithm implementations (abbreviated from unified-simulation.js)
// ============================================================
function chainNN(segs, startIdx) {
    const remaining = new Set(segs.map((_, i) => i));
    const chain = [];
    let ci = startIdx; remaining.delete(ci);
    let s = segs[ci];
    chain.push({ segId: s.id, entryPort: 0, exitPort: 2, segCost: s.costMatrix[0][2], transitionCost: 0 });
    while (remaining.size > 0) {
        const last = chain[chain.length - 1];
        const lastSeg = segById.get(last.segId);
        const exitNode = last.exitPort < 2 ? lastSeg.startNode : lastSeg.endNode;
        let bestIdx = -1, bestTotal = Infinity, bestEP = 0, bestXP = 0, bestTrans = 0, bestSC = 0;
        for (const idx of remaining) {
            const cand = segs[idx];
            for (let ep = 0; ep < 4; ep++) {
                const entryNode = ep < 2 ? cand.startNode : cand.endNode;
                const trans = nodeDist(exitNode, entryNode);
                for (let xp = 0; xp < 4; xp++) {
                    const sc = cand.costMatrix[ep][xp];
                    if (sc === Infinity) continue;
                    if (trans + sc < bestTotal) { bestTotal = trans + sc; bestIdx = idx; bestEP = ep; bestXP = xp; bestTrans = trans; bestSC = sc; }
                }
            }
        }
        if (bestIdx < 0) break;
        remaining.delete(bestIdx);
        chain.push({ segId: segs[bestIdx].id, entryPort: bestEP, exitPort: bestXP, segCost: bestSC, transitionCost: bestTrans });
    }
    return chain;
}

function sliceChain(chain, n) {
    const totalAddrs = chain.reduce((s, e) => s + (segById.get(e.segId)?.addressCount || 0), 0);
    const target = Math.ceil(totalAddrs / n);
    const parts = Array.from({ length: n }, () => []);
    let pi = 0, count = 0;
    for (const e of chain) {
        parts[pi].push(e);
        count += segById.get(e.segId)?.addressCount || 0;
        if (count >= target && pi < n - 1) { pi++; count = 0; }
    }
    return parts;
}

function twoOptImprove(chain) {
    if (chain.length < 4) return chain;
    let current = [...chain];
    function tb(a, b) {
        const sA = segById.get(a.segId), sB = segById.get(b.segId);
        return nodeDist(a.exitPort < 2 ? sA.startNode : sA.endNode, b.entryPort < 2 ? sB.startNode : sB.endNode);
    }
    for (let pass = 0; pass < 100; pass++) {
        let improved = false;
        for (let i = 1; i < current.length - 1; i++) {
            for (let j = i + 1; j < current.length; j++) {
                const cb = tb(current[i-1], current[i]) + (j+1 < current.length ? tb(current[j], current[j+1]) : 0);
                const rev = [];
                for (let k = j; k >= i; k--) {
                    const e = current[k]; const seg = segById.get(e.segId);
                    rev.push({ segId: e.segId, entryPort: e.exitPort, exitPort: e.entryPort, segCost: seg.costMatrix[e.exitPort][e.entryPort], transitionCost: 0 });
                }
                const ca = tb(current[i-1], rev[0]) + (j+1 < current.length ? tb(rev[rev.length-1], current[j+1]) : 0);
                let sd = 0; for (let k = 0; k < rev.length; k++) sd += rev[k].segCost - current[i+k].segCost;
                if (ca + sd < cb - 0.1) {
                    for (let k = 0; k < rev.length; k++) current[i+k] = rev[k];
                    for (let k = Math.max(1,i); k <= Math.min(j+1, current.length-1); k++) current[k].transitionCost = tb(current[k-1], current[k]);
                    improved = true;
                }
            }
        }
        if (!improved) break;
    }
    current[0].transitionCost = 0;
    for (let k = 1; k < current.length; k++) current[k].transitionCost = tb(current[k-1], current[k]);
    return current;
}

function bisectSegments(segs, n) {
    if (n <= 1 || segs.length <= 1) return [segs];
    const cents = segs.map(s => segCentroid(s));
    const lats = cents.map(c => c.lat), lons = cents.map(c => c.lon);
    const indexed = segs.map((s, i) => ({ s, c: cents[i] }));
    indexed.sort((a, b) => (Math.max(...lats)-Math.min(...lats)) > (Math.max(...lons)-Math.min(...lons)) ? a.c.lat - b.c.lat : a.c.lon - b.c.lon);
    const totalA = segs.reduce((sum, s) => sum + (s.addressCount || 0), 0);
    const lN = Math.ceil(n/2), rN = n - lN;
    const targetLeft = Math.round(totalA * lN / n);
    let cumA = 0, sp = 0;
    for (let i = 0; i < indexed.length; i++) { cumA += indexed[i].s.addressCount || 0; if (cumA >= targetLeft) { sp = i+1; break; } }
    if (sp === 0) sp = 1; if (sp >= indexed.length) sp = indexed.length - 1;
    return [...bisectSegments(indexed.slice(0, sp).map(x => x.s), lN), ...bisectSegments(indexed.slice(sp).map(x => x.s), rN)];
}

// Write partition data
function writePartition(prefix, parts) {
    const colors = ["prodblue", "unprodred", "idealgreen"];
    for (let k = 0; k < parts.length; k++) {
        const pts = ["lon lat"];
        for (const entry of parts[k]) {
            const seg = segById.get(entry.segId);
            if (!seg) continue;
            for (const pt of seg.polyline) pts.push(`${pt[1]} ${pt[0]}`);
            pts.push("");
        }
        fs.writeFileSync(path.join(dataDir, `alg-${prefix}-esw${k}.dat`), pts.join("\n") + "\n");
    }
    const addrCounts = parts.map(p => p.reduce((s, e) => s + (segById.get(e.segId)?.addressCount || 0), 0));
    console.log(`  ${prefix}: ${addrCounts.join("/")}`);
}

console.log("Generating Fairmeadow N=3 maps for each algorithm:\n");

// 1. ChainNN
const maxStarts = Math.min(segs.length, 15);
let bestNN = null, bestNNScore = Infinity;
for (let si = 0; si < maxStarts; si++) {
    const chain = chainNN(segs, Math.floor(si * segs.length / maxStarts));
    const parts = sliceChain(chain, N);
    const score = parts.reduce((s, p) => s + p.reduce((s2, e) => s2 + e.segCost + e.transitionCost, 0), 0);
    if (score < bestNNScore) { bestNNScore = score; bestNN = parts; }
}
writePartition("chainnn", bestNN);

// 2. ChainRH
function chainRH(segs, startIdx) {
    function bearing(lat1, lon1, lat2, lon2) {
        const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
        const dLon = toRad(lon2 - lon1);
        const y = Math.sin(dLon) * Math.cos(toRad(lat2));
        const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
        return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }
    const remaining = new Set(segs.map((_, i) => i));
    const chain = [];
    let ci = startIdx; remaining.delete(ci);
    let s = segs[ci];
    chain.push({ segId: s.id, entryPort: 0, exitPort: 2, segCost: s.costMatrix[0][2], transitionCost: 0 });
    let heading = s.polyline.length >= 2 ? bearing(s.polyline[0][0], s.polyline[0][1], s.polyline[s.polyline.length-1][0], s.polyline[s.polyline.length-1][1]) : 0;
    while (remaining.size > 0) {
        const last = chain[chain.length - 1];
        const lastSeg = segById.get(last.segId);
        const exitNode = last.exitPort < 2 ? lastSeg.startNode : lastSeg.endNode;
        const exitPl = lastSeg.polyline;
        const exitLat = last.exitPort < 2 ? exitPl[0][0] : exitPl[exitPl.length-1][0];
        const exitLon = last.exitPort < 2 ? exitPl[0][1] : exitPl[exitPl.length-1][1];
        let bestIdx = -1, bestScore = Infinity, bestEP = 0, bestXP = 0, bestTrans = 0, bestSC = 0;
        for (const idx of remaining) {
            const cand = segs[idx];
            for (let ep = 0; ep < 4; ep++) {
                const entryNode = ep < 2 ? cand.startNode : cand.endNode;
                const trans = nodeDist(exitNode, entryNode);
                const entryPl = cand.polyline;
                const entryLat = ep < 2 ? entryPl[0][0] : entryPl[entryPl.length-1][0];
                const entryLon = ep < 2 ? entryPl[0][1] : entryPl[entryPl.length-1][1];
                const bear = bearing(exitLat, exitLon, entryLat, entryLon);
                const turn = (bear - heading + 360) % 360;
                for (let xp = 0; xp < 4; xp++) {
                    const sc = cand.costMatrix[ep][xp];
                    if (sc === Infinity) continue;
                    const score = trans + turn * 0.5 + sc * 0.1;
                    if (score < bestScore) { bestScore = score; bestIdx = idx; bestEP = ep; bestXP = xp; bestTrans = trans; bestSC = sc; }
                }
            }
        }
        if (bestIdx < 0) break;
        remaining.delete(bestIdx);
        const cand = segs[bestIdx];
        chain.push({ segId: cand.id, entryPort: bestEP, exitPort: bestXP, segCost: bestSC, transitionCost: bestTrans });
        const pl = cand.polyline;
        heading = bestXP < 2 ? bearing(pl[pl.length-1][0], pl[pl.length-1][1], pl[0][0], pl[0][1]) : bearing(pl[0][0], pl[0][1], pl[pl.length-1][0], pl[pl.length-1][1]);
    }
    return chain;
}
let bestRH = null, bestRHScore = Infinity;
for (let si = 0; si < maxStarts; si++) {
    const chain = chainRH(segs, Math.floor(si * segs.length / maxStarts));
    const parts = sliceChain(chain, N);
    const score = parts.reduce((s, p) => s + p.reduce((s2, e) => s2 + e.segCost + e.transitionCost, 0), 0);
    if (score < bestRHScore) { bestRHScore = score; bestRH = parts; }
}
writePartition("chainrh", bestRH);

// 3. 2-Opt
let best2opt = null, best2optScore = Infinity;
for (let si = 0; si < maxStarts; si++) {
    const chain = twoOptImprove(chainNN(segs, Math.floor(si * segs.length / maxStarts)));
    const parts = sliceChain(chain, N);
    const score = parts.reduce((s, p) => s + p.reduce((s2, e) => s2 + e.segCost + e.transitionCost, 0), 0);
    if (score < best2optScore) { best2optScore = score; best2opt = parts; }
}
writePartition("twoopt", best2opt);

// 4. Bisect
const bisectGroups = bisectSegments(segs, N);
const bisectParts = bisectGroups.map(group => {
    if (group.length === 0) return [];
    return chainNN(group, 0);
});
writePartition("bisect", bisectParts);

// 5. BFS
const bfsParts = Array.from({ length: N }, () => []);
const bfsFrontiers = Array.from({ length: N }, () => huddleNode);
const bfsRemaining = new Set(segs.map((_, i) => i));
while (bfsRemaining.size > 0) {
    for (let k = 0; k < N && bfsRemaining.size > 0; k++) {
        let bestIdx = -1, bestCost = Infinity, bestEntry = {};
        for (const idx of bfsRemaining) {
            const seg = segs[idx];
            for (let ep = 0; ep < 4; ep++) {
                const entryNode = ep < 2 ? seg.startNode : seg.endNode;
                const trans = nodeDist(bfsFrontiers[k], entryNode);
                for (let xp = 0; xp < 4; xp++) {
                    const sc = seg.costMatrix[ep][xp];
                    if (sc === Infinity) continue;
                    if (trans + sc < bestCost) { bestCost = trans + sc; bestIdx = idx; bestEntry = { entryPort: ep, exitPort: xp, segCost: sc, transitionCost: trans }; }
                }
            }
        }
        if (bestIdx < 0) break;
        bfsRemaining.delete(bestIdx);
        bfsParts[k].push({ segId: segs[bestIdx].id, ...bestEntry });
        bfsFrontiers[k] = bestEntry.exitPort < 2 ? segs[bestIdx].startNode : segs[bestIdx].endNode;
    }
}
writePartition("bfs", bfsParts);

// 6. DFS
const totalA = segs.reduce((s, seg) => s + (seg.addressCount || 0), 0);
const totalProd = segs.reduce((s, seg) => { const mc = Math.min(...seg.costMatrix.flat().filter(v => v < Infinity)); return s + mc; }, 0);
const targetTime = (totalProd / 83.33 + totalA * 5) / N;
const dfsParts = Array.from({ length: N }, () => []);
const dfsRemaining = new Set(segs.map((_, i) => i));
for (let k = 0; k < N && dfsRemaining.size > 0; k++) {
    let frontier = huddleNode, eswTime = 0;
    while (dfsRemaining.size > 0) {
        if (k === N - 1) {
            while (dfsRemaining.size > 0) {
                let bestIdx = -1, bestCost = Infinity, bestEntry = {};
                for (const idx of dfsRemaining) {
                    const seg = segs[idx];
                    for (let ep = 0; ep < 4; ep++) {
                        const trans = nodeDist(frontier, ep < 2 ? seg.startNode : seg.endNode);
                        for (let xp = 0; xp < 4; xp++) { const sc = seg.costMatrix[ep][xp]; if (sc !== Infinity && trans + sc < bestCost) { bestCost = trans + sc; bestIdx = idx; bestEntry = { entryPort: ep, exitPort: xp, segCost: sc, transitionCost: trans }; } }
                    }
                }
                if (bestIdx < 0) break;
                dfsRemaining.delete(bestIdx);
                dfsParts[k].push({ segId: segs[bestIdx].id, ...bestEntry });
                frontier = bestEntry.exitPort < 2 ? segs[bestIdx].startNode : segs[bestIdx].endNode;
            }
            break;
        }
        let bestIdx = -1, bestCost = Infinity, bestEntry = {}, bestMarginal = 0;
        for (const idx of dfsRemaining) {
            const seg = segs[idx];
            for (let ep = 0; ep < 4; ep++) {
                const trans = nodeDist(frontier, ep < 2 ? seg.startNode : seg.endNode);
                for (let xp = 0; xp < 4; xp++) { const sc = seg.costMatrix[ep][xp]; if (sc !== Infinity && trans + sc < bestCost) { bestCost = trans + sc; bestIdx = idx; bestEntry = { entryPort: ep, exitPort: xp, segCost: sc, transitionCost: trans }; bestMarginal = (trans + sc) / 83.33 + (seg.addressCount || 0) * 5; } }
            }
        }
        if (bestIdx < 0) break;
        if (eswTime + bestMarginal > targetTime * 1.1 && dfsParts[k].length > 0) break;
        dfsRemaining.delete(bestIdx);
        dfsParts[k].push({ segId: segs[bestIdx].id, ...bestEntry });
        frontier = bestEntry.exitPort < 2 ? segs[bestIdx].startNode : segs[bestIdx].endNode;
        eswTime += bestMarginal;
    }
}
writePartition("dfs", dfsParts);

// 7. Random (best of 30)
let bestRand = null, bestRandScore = Infinity;
for (let iter = 0; iter < 30; iter++) {
    const shuffled = [...segs];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const target = Math.ceil(totalA / N);
    const groups = Array.from({ length: N }, () => []);
    let gi = 0, count = 0;
    for (const seg of shuffled) { groups[gi].push(seg); count += seg.addressCount || 0; if (count >= target && gi < N - 1) { gi++; count = 0; } }
    const parts = groups.map(g => g.length > 0 ? chainNN(g, 0) : []);
    const score = parts.reduce((s, p) => s + p.reduce((s2, e) => s2 + e.segCost + e.transitionCost, 0), 0);
    if (score < bestRandScore) { bestRandScore = score; bestRand = parts; }
}
writePartition("random", bestRand);

// 8. Voronoi+BT (balanced seeds + boundary transfer)
function runVoronoiBT() {
    const nodeCoords = new Map();
    for (const s of segs) {
        if (!nodeCoords.has(s.startNode)) nodeCoords.set(s.startNode, { lat: s.polyline[0][0], lon: s.polyline[0][1] });
        if (!nodeCoords.has(s.endNode)) nodeCoords.set(s.endNode, { lat: s.polyline[s.polyline.length-1][0], lon: s.polyline[s.polyline.length-1][1] });
    }
    const nodeList = [...nodeCoords.keys()];
    const totalAV = segs.reduce((s, seg) => s + (seg.addressCount || 0), 0);

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
        const target = totalAV / N;
        return counts.reduce((s, c) => s + Math.abs(c - target), 0);
    }

    // Lloyd's + greedy seed search
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

    // Boundary transfer
    const cells = assignCells(bestSeeds);
    const cellSets = cells.map(c => new Set(c));
    const segToCell = new Map();
    for (let k = 0; k < N; k++) for (const si of cellSets[k]) segToCell.set(si, k);

    // Segment adjacency
    const nodeToSegIdx = new Map();
    for (let i = 0; i < segs.length; i++) {
        for (const nid of [segs[i].startNode, segs[i].endNode]) {
            if (!nodeToSegIdx.has(nid)) nodeToSegIdx.set(nid, []);
            nodeToSegIdx.get(nid).push(i);
        }
    }
    const segNeighbors = new Map();
    for (const [nid, idxs] of nodeToSegIdx) {
        for (let i = 0; i < idxs.length; i++) for (let j = i+1; j < idxs.length; j++) {
            if (!segNeighbors.has(idxs[i])) segNeighbors.set(idxs[i], new Set());
            if (!segNeighbors.has(idxs[j])) segNeighbors.set(idxs[j], new Set());
            segNeighbors.get(idxs[i]).add(idxs[j]); segNeighbors.get(idxs[j]).add(idxs[i]);
        }
    }
    function wouldDisconnect(cellSet, removeIdx) {
        const remaining = new Set(cellSet); remaining.delete(removeIdx);
        if (remaining.size <= 1) return remaining.size === 0;
        const start = remaining.values().next().value;
        const visited = new Set([start]); const queue = [start];
        while (queue.length > 0) { const cur = queue.shift(); for (const nb of (segNeighbors.get(cur) || [])) { if (remaining.has(nb) && !visited.has(nb)) { visited.add(nb); queue.push(nb); } } }
        return visited.size < remaining.size;
    }
    function cellTime(cellSet) {
        const addrs = [...cellSet].reduce((s, idx) => s + (segs[idx].addressCount || 0), 0);
        const dist = [...cellSet].reduce((s, idx) => s + (segs[idx].distance || 0), 0);
        return dist / 83.33 + addrs * 5;
    }

    for (let iter = 0; iter < 200; iter++) {
        const times = cellSets.map(set => cellTime(set));
        const maxTime = Math.max(...times); const heavyIdx = times.indexOf(maxTime);
        let bestTransfer = null, bestImprovement = 0;
        for (const segIdx of cellSets[heavyIdx]) {
            const neighbors = segNeighbors.get(segIdx) || new Set();
            const adjacentCells = new Set();
            for (const nb of neighbors) { const nc = segToCell.get(nb); if (nc !== undefined && nc !== heavyIdx) adjacentCells.add(nc); }
            if (adjacentCells.size === 0) continue;
            if (wouldDisconnect(cellSets[heavyIdx], segIdx)) continue;
            for (const targetCell of adjacentCells) {
                const newHeavy = new Set(cellSets[heavyIdx]); newHeavy.delete(segIdx);
                const newTarget = new Set(cellSets[targetCell]); newTarget.add(segIdx);
                const newMax = Math.max(cellTime(newHeavy), cellTime(newTarget), ...times.filter((_, i) => i !== heavyIdx && i !== targetCell));
                const improvement = maxTime - newMax;
                if (improvement > bestImprovement) { bestImprovement = improvement; bestTransfer = { segIdx, from: heavyIdx, to: targetCell }; }
            }
        }
        if (!bestTransfer || bestImprovement < 0.5) break;
        cellSets[bestTransfer.from].delete(bestTransfer.segIdx);
        cellSets[bestTransfer.to].add(bestTransfer.segIdx);
        segToCell.set(bestTransfer.segIdx, bestTransfer.to);
    }

    // Build NN chains within each cell
    return cellSets.map(cellSet => {
        const cellSegs = [...cellSet].map(idx => segs[idx]);
        if (cellSegs.length === 0) return [];
        let bestChain = null, bestCost = Infinity;
        for (let si = 0; si < Math.min(cellSegs.length, 5); si++) {
            const chain = chainNN(cellSegs, Math.floor(si * cellSegs.length / Math.min(cellSegs.length, 5)));
            const cost = chain.reduce((s, e) => s + e.segCost + e.transitionCost, 0);
            if (cost < bestCost) { bestCost = cost; bestChain = chain; }
        }
        return bestChain || [];
    });
}
writePartition("voronoibt", runVoronoiBT());

// Also write background addresses
const bgPts = ["lon lat"];
for (const a of fmAddrs) bgPts.push(`${a.lon} ${a.lat}`);
fs.writeFileSync(path.join(dataDir, "alg-fm-addrs.dat"), bgPts.join("\n") + "\n");

console.log("\nAll algorithm maps generated for Fairmeadow N=3");
