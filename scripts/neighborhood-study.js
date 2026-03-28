#!/usr/bin/env node
// Comprehensive neighborhood algorithm study
// 1. Compute macroscopic features for each neighborhood
// 2. Run all algorithms on each (N=3 and N=5)
// 3. Split into training/test sets
// 4. Find correlations between features and winning algorithm
// 5. Validate predictions on test set

const fs = require("fs");

// === Core functions ===
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
            endA: {lat:f.latitude,lon:f.longitude}, endB: {lat:l.latitude,lon:l.longitude},
            centroidLat: addrs.reduce((s,a)=>s+a.latitude,0)/addrs.length,
            centroidLon: addrs.reduce((s,a)=>s+a.longitude,0)/addrs.length });
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

// === Chaining algorithms ===
function chainNN(streets, startIdx) {
    if (streets.length <= 1) return streets.length ? [{orderedAddrs: streets[0].addrs}] : [];
    const remaining = new Set(streets.map((_,i)=>i));
    const chain = []; let ci = startIdx; remaining.delete(ci);
    let s = streets[ci]; chain.push({orderedAddrs:s.addrs});
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
        remaining.delete(ni); s=streets[ni];
        chain.push({orderedAddrs: nr ? [...s.addrs].reverse() : s.addrs});
        eLat=nr?s.endA.lat:s.endB.lat; eLon=nr?s.endA.lon:s.endB.lon;
    }
    return chain;
}

function chainRH(streets, startIdx) {
    if (streets.length <= 1) return streets.length ? [{orderedAddrs: streets[0].addrs}] : [];
    function bear(lat1,lon1,lat2,lon2) {
        const toRad=d=>d*Math.PI/180, toDeg=r=>r*180/Math.PI;
        const dLon=toRad(lon2-lon1);
        const y=Math.sin(dLon)*Math.cos(toRad(lat2));
        const x=Math.cos(toRad(lat1))*Math.sin(toRad(lat2))-Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(dLon);
        return (toDeg(Math.atan2(y,x))+360)%360;
    }
    const remaining = new Set(streets.map((_,i)=>i));
    const chain = []; let ci=startIdx; remaining.delete(ci);
    let s=streets[ci]; chain.push({orderedAddrs:s.addrs});
    let eLat=s.endB.lat, eLon=s.endB.lon;
    let heading=bear(s.endA.lat,s.endA.lon,s.endB.lat,s.endB.lon);
    while (remaining.size > 0) {
        let bi=-1, bs=Infinity, br=false;
        for (const idx of remaining) {
            const st=streets[idx];
            const dA=haversine(eLat,eLon,st.endA.lat,st.endA.lon);
            const bA=bear(eLat,eLon,st.endA.lat,st.endA.lon);
            const tA=(bA-heading+360)%360; const sA=dA+tA*0.5;
            const dB=haversine(eLat,eLon,st.endB.lat,st.endB.lon);
            const bB=bear(eLat,eLon,st.endB.lat,st.endB.lon);
            const tB=(bB-heading+360)%360; const sB=dB+tB*0.5;
            if (sA<bs) {bs=sA;bi=idx;br=false;}
            if (sB<bs) {bs=sB;bi=idx;br=true;}
        }
        remaining.delete(bi); s=streets[bi];
        chain.push({orderedAddrs: br?[...s.addrs].reverse():s.addrs});
        if (br) { eLat=s.endA.lat;eLon=s.endA.lon;heading=bear(s.endB.lat,s.endB.lon,s.endA.lat,s.endA.lon); }
        else { eLat=s.endB.lat;eLon=s.endB.lon;heading=bear(s.endA.lat,s.endA.lon,s.endB.lat,s.endB.lon); }
    }
    return chain;
}

function sliceChain(chain, n, total) {
    const target = Math.ceil(total/n);
    const buckets = Array.from({length:n},()=>[]);
    let bi=0, c=0;
    for (const e of chain) for (const a of e.orderedAddrs) { buckets[bi].push(a); c++; if (c>=target&&bi<n-1){bi++;c=0;} }
    return buckets;
}

function bisect(addresses, n) {
    if (n <= 1) return [addresses];
    const lats = addresses.map(a=>a.latitude), lons = addresses.map(a=>a.longitude);
    const sorted = [...addresses].sort((a,b) =>
        (Math.max(...lats)-Math.min(...lats))>(Math.max(...lons)-Math.min(...lons))
            ? a.latitude-b.latitude : a.longitude-b.longitude);
    const lN=Math.ceil(n/2), rN=n-lN, sp=Math.round(sorted.length*lN/n);
    return [...bisect(sorted.slice(0,sp),lN), ...bisect(sorted.slice(sp),rN)];
}

// === Macroscopic features ===
function computeFeatures(addresses, streets) {
    const lats = addresses.map(a=>a.latitude);
    const lons = addresses.map(a=>a.longitude);
    const latRange = Math.max(...lats) - Math.min(...lats);
    const lonRange = Math.max(...lons) - Math.min(...lons);

    // Aspect ratio (how rectangular vs square)
    const aspect = Math.max(latRange, lonRange) / (Math.min(latRange, lonRange) || 0.0001);

    // Address density (addresses per hectare, roughly)
    const areaDeg2 = latRange * lonRange;
    const areaM2 = areaDeg2 * 111000 * 111000 * Math.cos((Math.min(...lats) + latRange/2) * Math.PI / 180);
    const density = addresses.length / (areaM2 / 10000); // per hectare

    // Average addresses per street
    const avgPerStreet = addresses.length / streets.length;

    // Street curvature: ratio of street endpoint distance to street centroid-to-centroid avg distance
    // High curvature = circular streets (endpoints close together relative to street length)
    let totalEndpointDist = 0, totalStreetSpan = 0;
    for (const s of streets) {
        const epDist = haversine(s.endA.lat, s.endA.lon, s.endB.lat, s.endB.lon);
        totalEndpointDist += epDist;
        // Span: max distance between any two addresses on the street
        let maxSpan = 0;
        for (let i = 0; i < s.addrs.length; i++)
            for (let j = i+1; j < s.addrs.length; j++) {
                const d = haversine(s.addrs[i].latitude, s.addrs[i].longitude, s.addrs[j].latitude, s.addrs[j].longitude);
                if (d > maxSpan) maxSpan = d;
            }
        totalStreetSpan += maxSpan;
    }
    const curvature = totalStreetSpan > 0 ? totalEndpointDist / totalStreetSpan : 1;
    // curvature near 1 = straight streets, << 1 = curved/circular

    // Grid regularity: what fraction of streets are roughly N-S or E-W oriented
    let axisAligned = 0;
    for (const s of streets) {
        if (s.addrs.length < 3) continue;
        const bearing = Math.atan2(s.endB.lon - s.endA.lon, s.endB.lat - s.endA.lat) * 180 / Math.PI;
        const normBearing = ((bearing % 180) + 180) % 180; // 0-180
        // Within 20 degrees of N-S (0/180) or E-W (90)
        if (normBearing < 20 || normBearing > 160 || (normBearing > 70 && normBearing < 110)) {
            axisAligned++;
        }
    }
    const gridRegularity = axisAligned / streets.length;

    return {
        addressCount: addresses.length,
        streetCount: streets.length,
        aspect,
        density,
        avgPerStreet,
        curvature,
        gridRegularity
    };
}

// === Run algorithms ===
function runAlgorithms(addresses, streets, n) {
    const results = {};

    // Bisect
    const biBuckets = bisect(addresses, n).map(bucket => {
        const bs = buildStreets(bucket);
        const chain = chainNN(bs, 0);
        return chain.flatMap(e => e.orderedAddrs);
    });
    results.bisect = maxWalk(biBuckets);

    // Best NN chain (sample up to 30 starts for speed on large neighborhoods)
    let bestNN = Infinity;
    const maxStarts = Math.min(streets.length, 30);
    for (let s = 0; s < maxStarts; s++) {
        const idx = Math.floor(s * streets.length / maxStarts);
        const chain = chainNN(streets, idx);
        const buckets = sliceChain(chain, n, addresses.length);
        const mw = maxWalk(buckets);
        if (mw < bestNN) bestNN = mw;
    }
    results.chainNN = bestNN;

    // Best RH chain (sample up to 30 starts)
    let bestRH = Infinity;
    for (let s = 0; s < maxStarts; s++) {
        const idx = Math.floor(s * streets.length / maxStarts);
        const chain = chainRH(streets, idx);
        const buckets = sliceChain(chain, n, addresses.length);
        const mw = maxWalk(buckets);
        if (mw < bestRH) bestRH = mw;
    }
    results.chainRH = bestRH;

    // Winner
    const best = Math.min(results.bisect, results.chainNN, results.chainRH);
    results.winner = best === results.bisect ? "bisect" :
                     best === results.chainNN ? "chainNN" : "chainRH";
    results.bestMax = best;

    return results;
}

// === Load data ===
const raw = fs.readFileSync("/tmp/neighborhoods/all_addresses.csv", "utf8").trim().split("\n");
const neighborhoods = new Map();
for (const line of raw) {
    const [hood, gid, sa, lat, lon] = line.split("|");
    if (!neighborhoods.has(hood)) neighborhoods.set(hood, []);
    neighborhoods.get(hood).push({ gid: parseInt(gid), street_address: sa, latitude: parseFloat(lat), longitude: parseFloat(lon) });
}

// Filter to neighborhoods with 50+ addresses
const validHoods = [...neighborhoods.entries()].filter(([_, addrs]) => addrs.length >= 50);
console.log(`${validHoods.length} neighborhoods with 50+ addresses\n`);

// === Compute features and run algorithms ===
const allResults = [];
for (const [name, addresses] of validHoods) {
    if (addresses.length > 6000) continue; // Skip Los Altos (12K) — too slow for exhaustive

    const streets = buildStreets(addresses);
    if (streets.length < 3) continue;

    const features = computeFeatures(addresses, streets);
    const r3 = runAlgorithms(addresses, streets, 3);
    const r5 = runAlgorithms(addresses, streets, 5);

    allResults.push({ name, features, r3, r5 });
    process.stderr.write(`.`);
}
process.stderr.write(`\n`);

console.log(`Analyzed ${allResults.length} neighborhoods\n`);

// === Print feature table ===
console.log("=== Features & Winners ===\n");
console.log("Neighborhood            | Addrs | Streets | Aspect | Density | Avg/St | Curv  | Grid  | Win(3) | Win(5)");
console.log("------------------------|-------|---------|--------|---------|--------|-------|-------|--------|-------");
for (const r of allResults) {
    const f = r.features;
    console.log(`${r.name.padEnd(24)}| ${String(f.addressCount).padStart(5)} | ${String(f.streetCount).padStart(7)} | ${f.aspect.toFixed(2).padStart(6)} | ${f.density.toFixed(1).padStart(7)} | ${f.avgPerStreet.toFixed(1).padStart(6)} | ${f.curvature.toFixed(2).padStart(5)} | ${f.gridRegularity.toFixed(2).padStart(5)} | ${r.r3.winner.padStart(6)} | ${r.r5.winner.padStart(6)}`);
}

// === Split into training (70%) and test (30%) sets ===
const shuffled = [...allResults].sort(() => Math.random() - 0.5);
const splitIdx = Math.floor(shuffled.length * 0.7);
const training = shuffled.slice(0, splitIdx);
const test = shuffled.slice(splitIdx);

console.log(`\n=== Training set: ${training.length} neighborhoods, Test set: ${test.length} neighborhoods ===\n`);

// === Find correlations in training set ===
// For each feature, compute the average value when each algorithm wins
const features = ["addressCount", "streetCount", "aspect", "density", "avgPerStreet", "curvature", "gridRegularity"];
const algorithms = ["bisect", "chainNN", "chainRH"];

for (const n of [3, 5]) {
    console.log(`\n--- N=${n}: Average feature values by winning algorithm (training set) ---\n`);
    console.log("Feature         | " + algorithms.map(a => a.padStart(10)).join(" | "));
    console.log("----------------|" + algorithms.map(() => "-----------").join("|"));

    for (const feat of features) {
        const avgs = algorithms.map(algo => {
            const matches = training.filter(r => (n === 3 ? r.r3 : r.r5).winner === algo);
            if (matches.length === 0) return "  N/A     ";
            const avg = matches.reduce((s, r) => s + r.features[feat], 0) / matches.length;
            return `${avg.toFixed(2).padStart(8)} (${String(matches.length).padStart(2)})`;
        });
        console.log(`${feat.padEnd(16)}| ${avgs.join(" | ")}`);
    }
}

// === Build simple prediction rules from training set ===
// For each N, find the feature threshold that best separates winners
console.log("\n=== Prediction Rules ===\n");

for (const n of [3, 5]) {
    const key = n === 3 ? "r3" : "r5";

    // Count wins
    const wins = {};
    for (const algo of algorithms) {
        wins[algo] = training.filter(r => r[key].winner === algo).length;
    }
    console.log(`N=${n} wins in training: ${algorithms.map(a => `${a}=${wins[a]}`).join(", ")}`);

    // Try each feature as a threshold predictor
    let bestFeature = "", bestThreshold = 0, bestAccuracy = 0, bestRule = "";

    for (const feat of features) {
        const values = training.map(r => ({ val: r.features[feat], winner: r[key].winner }));
        values.sort((a, b) => a.val - b.val);

        // Try each possible threshold
        for (let i = 0; i < values.length - 1; i++) {
            const threshold = (values[i].val + values[i+1].val) / 2;

            // Simple rule: below threshold → one algo, above → another
            for (const algoBelow of algorithms) {
                for (const algoAbove of algorithms) {
                    let correct = 0;
                    for (const v of values) {
                        const predicted = v.val < threshold ? algoBelow : algoAbove;
                        if (predicted === v.winner) correct++;
                    }
                    const accuracy = correct / values.length;
                    if (accuracy > bestAccuracy) {
                        bestAccuracy = accuracy;
                        bestFeature = feat;
                        bestThreshold = threshold;
                        bestRule = `${feat} < ${threshold.toFixed(3)} → ${algoBelow}, else → ${algoAbove}`;
                    }
                }
            }
        }
    }

    console.log(`  Best single-feature rule: ${bestRule}`);
    console.log(`  Training accuracy: ${(bestAccuracy * 100).toFixed(1)}%`);

    // Test on test set
    let testCorrect = 0;
    for (const r of test) {
        const val = r.features[bestFeature];
        const predicted = val < bestThreshold ? bestRule.split("→")[1].trim().split(",")[0].trim() : bestRule.split("→")[2].trim();
        if (predicted === r[key].winner) testCorrect++;
    }
    console.log(`  Test accuracy: ${(testCorrect / test.length * 100).toFixed(1)}% (${testCorrect}/${test.length})\n`);

    // Also test: "always pick bisect" baseline
    const alwaysBisect = test.filter(r => r[key].winner === "bisect").length;
    console.log(`  Baseline (always bisect): ${(alwaysBisect / test.length * 100).toFixed(1)}%`);

    // And: "always pick the overall best" = just run all and score
    console.log(`  Oracle (run all, pick best): 100%`);
}

// === Save results for paper ===
const csvLines = ["neighborhood,addresses,streets,aspect,density,avgPerStreet,curvature,gridRegularity,winnerN3,winnerN5,bisectN3,chainNNN3,chainRHN3,bisectN5,chainNNN5,chainRHN5"];
for (const r of allResults) {
    const f = r.features;
    csvLines.push(`${r.name},${f.addressCount},${f.streetCount},${f.aspect.toFixed(3)},${f.density.toFixed(2)},${f.avgPerStreet.toFixed(1)},${f.curvature.toFixed(3)},${f.gridRegularity.toFixed(3)},${r.r3.winner},${r.r5.winner},${Math.round(r.r3.bisect)},${Math.round(r.r3.chainNN)},${Math.round(r.r3.chainRH)},${Math.round(r.r5.bisect)},${Math.round(r.r5.chainNN)},${Math.round(r.r5.chainRH)}`);
}
fs.writeFileSync("/tmp/neighborhoods/study_results.csv", csvLines.join("\n") + "\n");
console.log("\nResults saved to /tmp/neighborhoods/study_results.csv");
