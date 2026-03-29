#!/usr/bin/env node
// Study IV: Constrained assignment — synthesis of Studies I-III
//
// Hard constraints (discovered across Studies I-III):
//   1. Walkable contiguity: each ESW's segments form a walk-ordered chain
//   2. Walking quality: productive/total walk ratio >= Q_MIN per ESW
//   3. Full coverage: every segment assigned to exactly one ESW
//
// Objective: minimize max finish-time spread (max T_k - min T_k)
// Secondary: minimize max T_k
//
// Method:
//   1. Initialize with Study I's chain+slice (satisfies constraints 1 & 3)
//   2. Evaluate with Study II's time metric (including huddle walk-to-first)
//   3. Constrained SA: boundary transfers that maintain walking quality >= Q_MIN
//   4. Compare with unconstrained Studies I-III

const fs = require("fs");
const path = require("path");

const T_ASSESS = parseFloat(process.env.T_ASSESS || "5"); // min/address
const SPEED = 83.33; // m/min (5 km/h)
const Q_MIN = parseFloat(process.env.Q_MIN || "0.50"); // walking quality floor (50%)

console.log(`Study IV: Constrained assignment (t_assess=${T_ASSESS}min, Q_MIN=${(Q_MIN*100).toFixed(0)}%)\n`);

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

// Distance precomputation
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

// ============================================================
// Chain construction (from Study I)
// ============================================================
function chainNN(segs, startIdx) {
    if (segs.length === 0) return [];
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

// 2-opt on chain (from Study I)
function twoOptImprove(chain) {
    if (chain.length < 4) return chain;
    let current = [...chain];
    function transitionBetween(a, b) {
        const segA = segById.get(a.segId), segB = segById.get(b.segId);
        const exitNode = a.exitPort < 2 ? segA.startNode : segA.endNode;
        const entryNode = b.entryPort < 2 ? segB.startNode : segB.endNode;
        return nodeDist(exitNode, entryNode);
    }
    for (let pass = 0; pass < 200; pass++) {
        let improved = false;
        for (let i = 1; i < current.length - 1; i++) {
            for (let j = i + 1; j < current.length; j++) {
                const costBefore = transitionBetween(current[i-1], current[i]) +
                    (j + 1 < current.length ? transitionBetween(current[j], current[j+1]) : 0);
                const reversed = [];
                for (let k = j; k >= i; k--) {
                    const e = current[k]; const seg = segById.get(e.segId);
                    const newEntry = e.exitPort, newExit = e.entryPort;
                    reversed.push({ segId: e.segId, entryPort: newEntry, exitPort: newExit,
                        segCost: seg.costMatrix[newEntry][newExit], transitionCost: 0 });
                }
                const costAfter = transitionBetween(current[i-1], reversed[0]) +
                    (j + 1 < current.length ? transitionBetween(reversed[reversed.length-1], current[j+1]) : 0);
                let segDelta = 0;
                for (let k = 0; k < reversed.length; k++) segDelta += reversed[k].segCost - current[i+k].segCost;
                if (costAfter + segDelta < costBefore - 0.1) {
                    for (let k = 0; k < reversed.length; k++) current[i+k] = reversed[k];
                    for (let k = Math.max(1, i); k <= Math.min(j+1, current.length-1); k++)
                        current[k].transitionCost = transitionBetween(current[k-1], current[k]);
                    improved = true;
                }
            }
        }
        if (!improved) break;
    }
    current[0].transitionCost = 0;
    for (let k = 1; k < current.length; k++)
        current[k].transitionCost = transitionBetween(current[k-1], current[k]);
    return current;
}

// ============================================================
// Time and quality evaluation
// ============================================================
function evalPartition(part, huddleNode) {
    if (part.length === 0) return { time: 0, addrs: 0, walkDist: 0, prodDist: 0, unprodDist: 0, walkQuality: 1.0 };
    const firstSeg = segById.get(part[0].segId);
    const firstNode = part[0].entryPort < 2 ? firstSeg.startNode : firstSeg.endNode;
    const walkToFirst = nodeDist(huddleNode, firstNode);
    let prod = 0, unprod = 0, addrs = 0;
    for (const e of part) {
        prod += e.segCost; unprod += e.transitionCost;
        addrs += segById.get(e.segId)?.addressCount || 0;
    }
    const totalWalk = walkToFirst + prod + unprod;
    return {
        time: totalWalk / SPEED + addrs * T_ASSESS,
        addrs, walkDist: totalWalk, prodDist: prod, unprodDist: unprod + walkToFirst,
        walkQuality: totalWalk > 0 ? prod / totalWalk : 1.0
    };
}

function evalAllPartitions(parts, huddleNode) {
    const evals = parts.map(p => evalPartition(p, huddleNode));
    const times = evals.map(e => e.time);
    const maxTime = Math.max(...times);
    const minTime = Math.min(...times.filter(t => t > 0));
    return {
        evals,
        maxTime,
        spread: maxTime - (minTime || 0),
        avgWalkQuality: evals.reduce((s, e) => s + e.walkQuality, 0) / evals.length,
        minWalkQuality: Math.min(...evals.filter(e => e.addrs > 0).map(e => e.walkQuality)),
        feasible: evals.every(e => e.addrs === 0 || e.walkQuality >= Q_MIN)
    };
}

// ============================================================
// Constrained SA: boundary transfers with walking quality floor
// ============================================================
function constrainedSA(initialParts, huddleNode, maxIter = 1000) {
    let current = initialParts.map(p => [...p]);
    let currentEval = evalAllPartitions(current, huddleNode);
    let bestParts = current.map(p => [...p]);
    let bestSpread = currentEval.spread;
    let bestMaxTime = currentEval.maxTime;

    const n = current.length;
    let T = currentEval.spread * 0.5 || 10;
    const Tf = 0.01;
    const alpha = Math.pow(Tf / Math.max(T, 0.1), 1 / maxIter);
    let accepted = 0, rejected_quality = 0, improved = 0;

    for (let iter = 0; iter < maxIter; iter++) {
        // Find heaviest and lightest ESWs
        const times = current.map(p => evalPartition(p, huddleNode).time);
        const heavyIdx = times.indexOf(Math.max(...times));
        const lightIdx = times.indexOf(Math.min(...times.filter(t => t > 0)));
        if (heavyIdx === lightIdx) break;

        // Try moving last segment of heavy ESW to light ESW
        if (current[heavyIdx].length <= 1) { T *= alpha; continue; }

        // Try both ends of the heavy partition (first or last segment)
        const tryPositions = [current[heavyIdx].length - 1]; // last
        if (current[heavyIdx].length > 2) tryPositions.push(0); // first

        let bestMove = null, bestDelta = Infinity;

        for (const pos of tryPositions) {
            const seg = current[heavyIdx][pos];
            // Try adding to light ESW (at beginning or end)
            for (const insertPos of [0, current[lightIdx].length]) {
                const newHeavy = [...current[heavyIdx]];
                newHeavy.splice(pos, 1);
                const newLight = [...current[lightIdx]];
                newLight.splice(insertPos, 0, seg);

                // Recompute transition costs for modified partitions
                if (newHeavy.length > 0) {
                    newHeavy[0].transitionCost = 0;
                    for (let k = 1; k < newHeavy.length; k++) {
                        const prev = segById.get(newHeavy[k-1].segId);
                        const cur = segById.get(newHeavy[k].segId);
                        const exitNode = newHeavy[k-1].exitPort < 2 ? prev.startNode : prev.endNode;
                        const entryNode = newHeavy[k].entryPort < 2 ? cur.startNode : cur.endNode;
                        newHeavy[k] = { ...newHeavy[k], transitionCost: nodeDist(exitNode, entryNode) };
                    }
                }
                newLight[0] = { ...newLight[0], transitionCost: 0 };
                for (let k = 1; k < newLight.length; k++) {
                    const prev = segById.get(newLight[k-1].segId);
                    const cur = segById.get(newLight[k].segId);
                    const exitNode = newLight[k-1].exitPort < 2 ? prev.startNode : prev.endNode;
                    const entryNode = newLight[k].entryPort < 2 ? cur.startNode : cur.endNode;
                    newLight[k] = { ...newLight[k], transitionCost: nodeDist(exitNode, entryNode) };
                }

                // Check walking quality constraint
                const heavyEval = evalPartition(newHeavy, huddleNode);
                const lightEval = evalPartition(newLight, huddleNode);
                if (newHeavy.length > 0 && heavyEval.walkQuality < Q_MIN) { rejected_quality++; continue; }
                if (lightEval.walkQuality < Q_MIN) { rejected_quality++; continue; }

                // Compute new spread
                const newTimes = times.map((t, i) =>
                    i === heavyIdx ? heavyEval.time : i === lightIdx ? lightEval.time : t);
                const newSpread = Math.max(...newTimes) - Math.min(...newTimes.filter(t => t > 0));
                const newMax = Math.max(...newTimes);

                // Score: primarily spread, secondarily maxTime
                const oldScore = currentEval.spread * 2 + currentEval.maxTime;
                const newScore = newSpread * 2 + newMax;
                const delta = newScore - oldScore;

                if (delta < bestDelta) {
                    bestDelta = delta;
                    bestMove = { pos, insertPos, heavyIdx, lightIdx, newHeavy, newLight, newSpread, newMax };
                }
            }
        }

        if (bestMove && (bestDelta < 0 || Math.random() < Math.exp(-bestDelta / T))) {
            current[bestMove.heavyIdx] = bestMove.newHeavy;
            current[bestMove.lightIdx] = bestMove.newLight;
            currentEval = evalAllPartitions(current, huddleNode);
            accepted++;
            if (currentEval.spread < bestSpread ||
                (currentEval.spread === bestSpread && currentEval.maxTime < bestMaxTime)) {
                bestSpread = currentEval.spread;
                bestMaxTime = currentEval.maxTime;
                bestParts = current.map(p => [...p]);
                improved++;
            }
        }

        T *= alpha;
    }

    return { parts: bestParts, accepted, rejected_quality, improved };
}

// ============================================================
// Run Study IV
// ============================================================
const hoodAddrs = new Map();
for (const a of data.addresses) {
    if (!hoodAddrs.has(a.neighborhood)) hoodAddrs.set(a.neighborhood, []);
    hoodAddrs.get(a.neighborhood).push(a);
}

function getHoodSegments(hood) {
    const addrs = hoodAddrs.get(hood) || [];
    const segIds = new Set();
    for (const a of addrs) { const sid = gidToSeg.get(a.gid); if (sid !== undefined && segById.has(sid)) segIds.add(sid); }
    return [...segIds].map(id => segById.get(id));
}

// Load Study I results for comparison
let s1Results = [];
try { s1Results = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "segment-study-results.json"), "utf8")); } catch(e) {}
const s1Map = new Map();
for (const r of s1Results) s1Map.set(`${r.hood}:${r.n}`, r);

console.log("Neighborhood          | Addrs | N | S1 MaxWk | S4 Spread | S4 MaxTime | S4 WQ-min | Feasible | SA stats");
console.log("----------------------|-------|---|----------|-----------|------------|-----------|----------|----------");

const allResults = [];
const selected = [...hoodAddrs.entries()]
    .filter(([name, addrs]) => (addrs.length >= 50 && addrs.length <= 350) || name === "Fairmeadow")
    .sort((a, b) => a[1].length - b[1].length);

for (const [hood, addrs] of selected) {
    const segs = getHoodSegments(hood);
    if (segs.length < 3) continue;

    const fmAssign = fireData.neighborhoodAssignments.find(a => a.hood === hood);
    if (!fmAssign) continue;

    const hoodNodes = new Set();
    for (const s of segs) { hoodNodes.add(s.startNode); hoodNodes.add(s.endNode); }

    // Find huddle node
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
    hoodNodes.add(huddleNode);
    precomputeDistances(hoodNodes);

    for (const n of [3, 5]) {
        // Step 1: Build best chain+slice from Study I (try multiple starts + 2-opt)
        const maxStarts = Math.min(segs.length, 15);
        let bestChain = null, bestChainScore = Infinity;
        for (let si = 0; si < maxStarts; si++) {
            const idx = Math.floor(si * segs.length / maxStarts);
            const chain = chainNN(segs, idx);
            const improved = twoOptImprove(chain);
            const parts = sliceChain(improved, n);
            const ev = evalAllPartitions(parts, huddleNode);
            const score = ev.spread * 2 + ev.maxTime;
            if (score < bestChainScore) { bestChainScore = score; bestChain = improved; }
        }

        const initialParts = sliceChain(bestChain, n);
        const initialEval = evalAllPartitions(initialParts, huddleNode);

        // Step 2: Constrained SA
        const sa = constrainedSA(initialParts, huddleNode, 2000);
        const finalEval = evalAllPartitions(sa.parts, huddleNode);

        // Study I comparison
        const s1key = `${hood}:${n}`;
        const s1r = s1Map.get(s1key);
        const s1MaxWalk = s1r ? (() => {
            const keyMap = { ChainNN:'chainNN', ChainRH:'chainRH', Bisect:'bisect', TwoOpt:'twoOpt' };
            const best = s1r.results[keyMap[s1r.winner]];
            return best ? Math.round(best.maxWalk) : 'N/A';
        })() : 'N/A';

        const pad = (s, w) => String(s).padEnd(w);
        console.log(
            `${pad(hood, 22)}| ${pad(addrs.length, 5)} | ${n} | ` +
            `${pad(s1MaxWalk + 'm', 8)} | ` +
            `${pad(finalEval.spread.toFixed(0) + 'min', 9)} | ` +
            `${pad(finalEval.maxTime.toFixed(0) + 'min', 10)} | ` +
            `${pad((finalEval.minWalkQuality * 100).toFixed(0) + '%', 9)} | ` +
            `${pad(finalEval.feasible ? 'YES' : 'NO', 8)} | ` +
            `${sa.accepted}acc ${sa.rejected_quality}rej ${sa.improved}imp`
        );

        allResults.push({
            hood, addrs: addrs.length, segs: segs.length, n,
            initial: { spread: initialEval.spread, maxTime: initialEval.maxTime,
                       minWalkQuality: initialEval.minWalkQuality, feasible: initialEval.feasible },
            final: { spread: finalEval.spread, maxTime: finalEval.maxTime,
                     minWalkQuality: finalEval.minWalkQuality, feasible: finalEval.feasible,
                     evals: finalEval.evals.map(e => ({ time: e.time, addrs: e.addrs, walkQuality: e.walkQuality })) },
            sa: { accepted: sa.accepted, rejected_quality: sa.rejected_quality, improved: sa.improved }
        });
    }
    console.log("");
}

// Summary
console.log("=== Summary ===");
const feasibleCount = allResults.filter(r => r.final.feasible).length;
console.log(`Feasible (WQ >= ${(Q_MIN*100).toFixed(0)}%): ${feasibleCount}/${allResults.length} (${(feasibleCount/allResults.length*100).toFixed(0)}%)`);

const spreads = allResults.map(r => r.final.spread);
console.log(`Spread: avg=${(spreads.reduce((s,v)=>s+v,0)/spreads.length).toFixed(0)}min, max=${Math.max(...spreads).toFixed(0)}min`);

const initSpreads = allResults.map(r => r.initial.spread);
const spreadImprovement = allResults.map(r => (r.initial.spread - r.final.spread) / Math.max(r.initial.spread, 1));
console.log(`SA spread improvement: avg=${(spreadImprovement.reduce((s,v)=>s+v,0)/spreadImprovement.length*100).toFixed(1)}%`);

const wqs = allResults.map(r => r.final.minWalkQuality);
console.log(`Min walk quality: avg=${(wqs.reduce((s,v)=>s+v,0)/wqs.length*100).toFixed(0)}%, min=${(Math.min(...wqs)*100).toFixed(0)}%`);

const resultsPath = path.join(__dirname, "..", "data", "study4-results.json");
fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
console.log(`\nResults saved to ${resultsPath}`);
