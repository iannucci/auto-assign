#!/usr/bin/env node
// Simulated Annealing experiment for the foothill problem
// Tests whether SA can escape local optima that greedy chain construction gets trapped in
//
// Approach: Start from best greedy solution (chain order), then apply SA with perturbation
// moves that swap/shift street positions in the chain. The chain is then re-sliced into
// N buckets and scored.

const fs = require("fs");

// === Core functions (shared with neighborhood-study.js) ===
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function extractStreetName(a) { return (a||"").replace(/^\d+[A-Za-z\/]*\s+/,"").trim()||a; }
function houseNum(a) { const m = (a.street_address||"").match(/^(\d+)/); return m ? parseInt(m[1]) : 0; }

function sortUTurn(addrs) {
    if (addrs.length <= 2) return addrs;
    const evens = addrs.filter(a => houseNum(a) % 2 === 0).sort((a,b) => houseNum(a) - houseNum(b));
    const odds = addrs.filter(a => houseNum(a) % 2 !== 0).sort((a,b) => houseNum(b) - houseNum(a));
    return [...evens, ...odds];
}

function buildStreets(addresses) {
    const m = new Map();
    for (const a of addresses) { const s = extractStreetName(a.street_address); if (!m.has(s)) m.set(s,[]); m.get(s).push(a); }
    const streets = [];
    for (const [name, addrs] of m) {
        const sorted = sortUTurn(addrs);
        const f = sorted[0], l = sorted[sorted.length-1];
        streets.push({ name, addrs: sorted,
            endA: {lat:f.latitude,lon:f.longitude}, endB: {lat:l.latitude,lon:l.longitude} });
    }
    return streets;
}

function walkDist(addrs) {
    let t = 0;
    for (let i = 1; i < addrs.length; i++)
        t += haversine(addrs[i-1].latitude, addrs[i-1].longitude, addrs[i].latitude, addrs[i].longitude);
    return t;
}

function maxWalk(buckets) { return Math.max(...buckets.map(b => walkDist(b))); }
function totalWalk(buckets) { return buckets.reduce((s,b) => s + walkDist(b), 0); }

// === Chain algorithms ===
function chainNN(streets, startIdx) {
    if (streets.length <= 1) return streets.length ? [0] : [];
    const remaining = new Set(streets.map((_,i)=>i));
    const order = []; let ci = startIdx; remaining.delete(ci);
    order.push(ci);
    let s = streets[ci];
    let eLat = s.endB.lat, eLon = s.endB.lon;
    while (remaining.size > 0) {
        let ni=-1, nd=Infinity, nr=false;
        for (const idx of remaining) {
            const st = streets[idx];
            const dA = haversine(eLat,eLon,st.endA.lat,st.endA.lon);
            const dB = haversine(eLat,eLon,st.endB.lat,st.endB.lon);
            if (dA < nd) {nd=dA;ni=idx;nr=false;}
            if (dB < nd) {nd=dB;ni=idx;nr=true;}
        }
        remaining.delete(ni);
        order.push(nr ? -(ni+1) : ni); // negative = reversed
        s = streets[ni];
        eLat = nr ? s.endA.lat : s.endB.lat;
        eLon = nr ? s.endA.lon : s.endB.lon;
    }
    return order;
}

// Convert chain order (indices, negative = reversed) to address buckets
function chainToBuckets(streets, chainOrder, n) {
    const allAddrs = [];
    for (const idx of chainOrder) {
        const si = idx < 0 ? -(idx+1) : idx;
        const addrs = streets[si].addrs;
        if (idx < 0) allAddrs.push(...[...addrs].reverse());
        else allAddrs.push(...addrs);
    }
    const target = Math.ceil(allAddrs.length / n);
    const buckets = Array.from({length:n}, ()=>[]);
    let bi = 0, c = 0;
    for (const a of allAddrs) {
        buckets[bi].push(a);
        c++;
        if (c >= target && bi < n-1) { bi++; c = 0; }
    }
    return buckets;
}

// Score a chain ordering (lower = better)
function scoreChain(streets, chainOrder, n, totalAddrs) {
    const buckets = chainToBuckets(streets, chainOrder, n);
    const mw = maxWalk(buckets);
    const tw = totalWalk(buckets);
    // Balance penalty
    const targetCount = totalAddrs / n;
    let imbalance = 0;
    for (const b of buckets) imbalance += Math.abs(b.length - targetCount);
    return 2 * mw + tw + 5000 * imbalance / targetCount;
}

// Compute the walk distance of transitions between streets in a chain
// This is the inter-street distance only (intra-street is fixed)
function chainTransitionDist(streets, chainOrder) {
    let total = 0;
    for (let i = 1; i < chainOrder.length; i++) {
        const prevIdx = chainOrder[i-1];
        const prevSi = prevIdx < 0 ? -(prevIdx+1) : prevIdx;
        const prevS = streets[prevSi];
        // Exit point of previous street
        const prevExit = prevIdx < 0
            ? {lat: prevS.endA.lat, lon: prevS.endA.lon}
            : {lat: prevS.endB.lat, lon: prevS.endB.lon};

        const curIdx = chainOrder[i];
        const curSi = curIdx < 0 ? -(curIdx+1) : curIdx;
        const curS = streets[curSi];
        // Entry point of current street
        const curEntry = curIdx < 0
            ? {lat: curS.endB.lat, lon: curS.endB.lon}
            : {lat: curS.endA.lat, lon: curS.endA.lon};

        total += haversine(prevExit.lat, prevExit.lon, curEntry.lat, curEntry.lon);
    }
    return total;
}

// === Simulated Annealing ===
// Perturbation moves on the chain order:
// 1. Swap two random positions
// 2. Reverse a random subsequence (2-opt style)
// 3. Move one street to a different position
// Each street can be traversed in either direction (toggle sign)

function saOptimize(streets, initialChain, n, totalAddrs, options = {}) {
    const {
        maxIter = 50000,
        T0 = 5000,        // initial temperature
        Tf = 1,            // final temperature
        coolRate = null,   // computed from T0, Tf, maxIter if null
    } = options;

    const alpha = coolRate || Math.pow(Tf / T0, 1 / maxIter);

    let chain = [...initialChain];
    let score = scoreChain(streets, chain, n, totalAddrs);
    let bestChain = [...chain];
    let bestScore = score;
    let T = T0;
    let accepted = 0, improved = 0;

    for (let iter = 0; iter < maxIter; iter++) {
        // Generate neighbor
        const candidate = [...chain];
        const moveType = Math.random();

        if (moveType < 0.35) {
            // Swap two positions
            const i = Math.floor(Math.random() * candidate.length);
            let j = Math.floor(Math.random() * (candidate.length - 1));
            if (j >= i) j++;
            [candidate[i], candidate[j]] = [candidate[j], candidate[i]];
        } else if (moveType < 0.65) {
            // Reverse a subsequence (2-opt)
            let i = Math.floor(Math.random() * candidate.length);
            let j = Math.floor(Math.random() * candidate.length);
            if (i > j) [i, j] = [j, i];
            // Reverse segment and flip each street's direction
            const seg = candidate.slice(i, j + 1).reverse().map(idx => {
                // Flip direction: positive -> negative, negative -> positive
                return idx >= 0 ? -(idx + 1) : -(idx + 1);
            });
            for (let k = i; k <= j; k++) candidate[k] = seg[k - i];
        } else if (moveType < 0.85) {
            // Move one street to a different position
            const from = Math.floor(Math.random() * candidate.length);
            const to = Math.floor(Math.random() * candidate.length);
            const [item] = candidate.splice(from, 1);
            candidate.splice(to, 0, item);
        } else {
            // Toggle direction of one street
            const i = Math.floor(Math.random() * candidate.length);
            candidate[i] = candidate[i] >= 0 ? -(candidate[i] + 1) : -(candidate[i] + 1);
        }

        const candidateScore = scoreChain(streets, candidate, n, totalAddrs);
        const delta = candidateScore - score;

        if (delta < 0 || Math.random() < Math.exp(-delta / T)) {
            chain = candidate;
            score = candidateScore;
            accepted++;
            if (score < bestScore) {
                bestScore = score;
                bestChain = [...chain];
                improved++;
            }
        }

        T *= alpha;
    }

    return { chain: bestChain, score: bestScore, accepted, improved };
}

// === Bisect (for comparison) ===
function bisect(addresses, n) {
    if (n <= 1) return [addresses];
    const lats = addresses.map(a=>a.latitude), lons = addresses.map(a=>a.longitude);
    const sorted = [...addresses].sort((a,b) =>
        (Math.max(...lats)-Math.min(...lats))>(Math.max(...lons)-Math.min(...lons))
            ? a.latitude-b.latitude : a.longitude-b.longitude);
    const lN=Math.ceil(n/2), rN=n-lN, sp=Math.round(sorted.length*lN/n);
    return [...bisect(sorted.slice(0,sp),lN), ...bisect(sorted.slice(sp),rN)];
}

// === Load data ===
const raw = fs.readFileSync("/tmp/neighborhoods/all_addresses.csv", "utf8").trim().split("\n");
const neighborhoods = new Map();
for (const line of raw) {
    const [hood, gid, sa, lat, lon] = line.split("|");
    if (!neighborhoods.has(hood)) neighborhoods.set(hood, []);
    neighborhoods.get(hood).push({ gid: parseInt(gid), street_address: sa, latitude: parseFloat(lat), longitude: parseFloat(lon) });
}

// Select a representative sample of neighborhoods
const testHoods = [...neighborhoods.entries()]
    .filter(([_, addrs]) => addrs.length >= 50 && addrs.length <= 6000)
    .sort((a, b) => a[1].length - b[1].length);

// Pick ~10 neighborhoods spanning small to large
const step = Math.max(1, Math.floor(testHoods.length / 10));
const selected = [];
for (let i = 0; i < testHoods.length; i += step) {
    selected.push(testHoods[i]);
}
// Always include Fairmeadow, Crescent Park, Midtown if present
for (const name of ["Fairmeadow", "Crescent Park", "Midtown"]) {
    if (!selected.find(([n]) => n === name)) {
        const found = testHoods.find(([n]) => n === name);
        if (found) selected.push(found);
    }
}

console.log(`Testing SA on ${selected.length} neighborhoods\n`);
console.log("Neighborhood          | Addrs | N | Greedy Max | SA Max     | SA Improve | Bisect Max | SA vs Bisect | Transitions");
console.log("----------------------|-------|---|------------|------------|------------|------------|--------------|------------");

const allResults = [];

for (const [name, addresses] of selected) {
    const streets = buildStreets(addresses);

    for (const n of [3, 5]) {
        // Best greedy NN chain (exhaustive starts)
        let bestChain = null, bestScore = Infinity, bestMax = Infinity;
        for (let s = 0; s < streets.length; s++) {
            const chain = chainNN(streets, s);
            const score = scoreChain(streets, chain, n, addresses.length);
            const buckets = chainToBuckets(streets, chain, n);
            const mw = maxWalk(buckets);
            if (score < bestScore) {
                bestScore = score;
                bestChain = chain;
                bestMax = mw;
            }
        }

        // SA optimization starting from best greedy
        const saIter = Math.min(100000, streets.length * 2000);
        const saResult = saOptimize(streets, bestChain, n, addresses.length, {
            maxIter: saIter,
            T0: bestScore * 0.3,
            Tf: 1,
        });
        const saBuckets = chainToBuckets(streets, saResult.chain, n);
        const saMax = maxWalk(saBuckets);

        // Bisect for comparison
        const biBuckets = bisect(addresses, n).map(bucket => {
            const bs = buildStreets(bucket);
            const chain = chainNN(bs, 0);
            const allAddrs = chain.flatMap(idx => {
                const si = idx < 0 ? -(idx+1) : idx;
                return idx < 0 ? [...bs[si].addrs].reverse() : bs[si].addrs;
            });
            return allAddrs.length ? allAddrs : bucket; // fallback
        });
        // Bisect uses different internal format, compute directly
        const biBucketsSimple = bisect(addresses, n).map(bucket => {
            const bs = buildStreets(bucket);
            if (bs.length === 0) return bucket;
            const chainOrder = chainNN(bs, 0);
            return chainToBuckets(bs, chainOrder, 1)[0]; // single chain
        });
        const biMax = maxWalk(biBucketsSimple);

        const greedyTransDist = chainTransitionDist(streets, bestChain);
        const saTransDist = chainTransitionDist(streets, saResult.chain);

        const improvement = ((bestMax - saMax) / bestMax * 100).toFixed(1);
        const vsBisect = ((biMax - saMax) / biMax * 100).toFixed(1);

        const row = {
            name, n, addresses: addresses.length, streets: streets.length,
            greedyMax: bestMax, saMax, biMax,
            improvement: (bestMax - saMax) / bestMax,
            saAccepted: saResult.accepted, saImproved: saResult.improved,
            greedyTransDist, saTransDist
        };
        allResults.push(row);

        const pad = (s, w) => String(s).padEnd(w);
        console.log(
            `${pad(name, 22)}| ${pad(addresses.length, 5)} | ${n} | ${pad(Math.round(bestMax)+'m', 10)} | ${pad(Math.round(saMax)+'m', 10)} | ${pad(improvement+'%', 10)} | ${pad(Math.round(biMax)+'m', 10)} | ${pad(vsBisect+'%', 12)} | ${Math.round(greedyTransDist)}→${Math.round(saTransDist)}m`
        );
    }
}

// Summary statistics
console.log("\n=== Summary ===");
const improvements = allResults.map(r => r.improvement);
const avgImprove = (improvements.reduce((s,v)=>s+v, 0) / improvements.length * 100).toFixed(1);
const maxImprove = (Math.max(...improvements) * 100).toFixed(1);
const minImprove = (Math.min(...improvements) * 100).toFixed(1);
console.log(`SA improvement over best greedy: avg=${avgImprove}%, min=${minImprove}%, max=${maxImprove}%`);

const saWins = allResults.filter(r => r.saMax < r.biMax).length;
const biWins = allResults.filter(r => r.biMax < r.saMax).length;
const ties = allResults.filter(r => Math.abs(r.saMax - r.biMax) < 1).length;
console.log(`SA vs Bisect: SA wins ${saWins}, Bisect wins ${biWins}, ties ${ties} (of ${allResults.length} cases)`);

// Evidence of foothill problem: how much does SA improve the transition distances?
const transDiffs = allResults.map(r => (r.greedyTransDist - r.saTransDist) / r.greedyTransDist);
const avgTransImprove = (transDiffs.reduce((s,v)=>s+v, 0) / transDiffs.length * 100).toFixed(1);
console.log(`SA transition distance reduction: avg=${avgTransImprove}%`);
console.log(`\nThis shows whether greedy chains get trapped in local optima for inter-street transitions.`);
