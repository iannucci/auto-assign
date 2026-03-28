#!/usr/bin/env node
// Test harness for auto-assign algorithms
// Usage: node test-autoassign.js <csv_file> <num_esws>

const fs = require("fs");

// Load address data from psql CSV (gid|street_address|lat|lon)
function loadAddresses(file) {
    return fs.readFileSync(file, "utf8").trim().split("\n").map(line => {
        const [gid, street_address, lat, lon] = line.split("|");
        return { gid: parseInt(gid), street_address, latitude: parseFloat(lat), longitude: parseFloat(lon) };
    });
}

// ============================================================================
// COPY OF ALGORITHM CODE (same as assignment-map.js)
// ============================================================================

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function extractStreetName(address) {
    return (address || "").replace(/^\d+[A-Za-z\/]*\s+/, "").trim() || address;
}

function sortAlongStreet(addrs) {
    if (addrs.length <= 2) return addrs;
    let maxDist = 0, a0 = 0, a1 = 1;
    for (let i = 0; i < addrs.length; i++) {
        for (let j = i + 1; j < addrs.length; j++) {
            const d = haversine(addrs[i].latitude, addrs[i].longitude, addrs[j].latitude, addrs[j].longitude);
            if (d > maxDist) { maxDist = d; a0 = i; a1 = j; }
        }
    }
    const axisLat = addrs[a1].latitude - addrs[a0].latitude;
    const axisLon = addrs[a1].longitude - addrs[a0].longitude;
    return [...addrs].sort((a, b) => {
        const projA = (a.latitude - addrs[a0].latitude) * axisLat + (a.longitude - addrs[a0].longitude) * axisLon;
        const projB = (b.latitude - addrs[a0].latitude) * axisLat + (b.longitude - addrs[a0].longitude) * axisLon;
        return projA - projB;
    });
}

function buildStreets(addresses) {
    const streetMap = new Map();
    for (const addr of addresses) {
        const street = extractStreetName(addr.street_address);
        if (!streetMap.has(street)) streetMap.set(street, []);
        streetMap.get(street).push(addr);
    }
    const streets = [];
    for (const [name, addrs] of streetMap) {
        const sorted = sortAlongStreet(addrs);
        const first = sorted[0], last = sorted[sorted.length - 1];
        const centroidLat = addrs.reduce((s, a) => s + a.latitude, 0) / addrs.length;
        const centroidLon = addrs.reduce((s, a) => s + a.longitude, 0) / addrs.length;
        streets.push({ name, addrs: sorted,
            endA: { lat: first.latitude, lon: first.longitude },
            endB: { lat: last.latitude, lon: last.longitude },
            centroidLat, centroidLon });
    }
    return streets;
}

function chainStreetsByEndpoints(streets, startIdx = 0) {
    if (streets.length === 0) return [];
    if (streets.length === 1) return [{ orderedAddrs: streets[0].addrs }];
    const remaining = new Set(streets.map((_, i) => i));
    const chain = [];
    let currentIdx = startIdx;
    remaining.delete(currentIdx);
    let s = streets[currentIdx];
    chain.push({ orderedAddrs: s.addrs });
    let exitLat = s.endB.lat, exitLon = s.endB.lon;
    while (remaining.size > 0) {
        let nearestIdx = -1, nearestDist = Infinity, nearestReverse = false;
        for (const idx of remaining) {
            const st = streets[idx];
            const dA = haversine(exitLat, exitLon, st.endA.lat, st.endA.lon);
            const dB = haversine(exitLat, exitLon, st.endB.lat, st.endB.lon);
            if (dA < nearestDist) { nearestDist = dA; nearestIdx = idx; nearestReverse = false; }
            if (dB < nearestDist) { nearestDist = dB; nearestIdx = idx; nearestReverse = true; }
        }
        remaining.delete(nearestIdx);
        s = streets[nearestIdx];
        chain.push({ orderedAddrs: nearestReverse ? [...s.addrs].reverse() : s.addrs });
        exitLat = nearestReverse ? s.endA.lat : s.endB.lat;
        exitLon = nearestReverse ? s.endA.lon : s.endB.lon;
    }
    return chain;
}

// ============================================================================
// STRATEGIES
// ============================================================================

// Strategy: contiguous chain slicing
function strategyChainSlice(streets, n, totalAddrs, startIdx) {
    const chain = chainStreetsByEndpoints(streets, startIdx);
    const target = Math.ceil(totalAddrs / n);
    const buckets = Array.from({ length: n }, () => []);
    let bucketIdx = 0, count = 0;
    for (const entry of chain) {
        for (const addr of entry.orderedAddrs) {
            buckets[bucketIdx].push(addr);
            count++;
            if (count >= target && bucketIdx < n - 1) { bucketIdx++; count = 0; }
        }
    }
    return buckets;
}

// Strategy: k-means on street centroids
function strategyKmeans(streets, n) {
    if (streets.length <= n) {
        const buckets = Array.from({ length: n }, () => []);
        streets.forEach((s, i) => { for (const a of s.addrs) buckets[i % n].push(a); });
        return buckets;
    }
    const centroids = [];
    for (let i = 0; i < n; i++) {
        const idx = Math.floor(i * streets.length / n);
        centroids.push({ lat: streets[idx].centroidLat, lon: streets[idx].centroidLon });
    }
    let assignments = new Array(streets.length).fill(0);
    for (let iter = 0; iter < 20; iter++) {
        let changed = false;
        for (let i = 0; i < streets.length; i++) {
            let bestC = 0, bestD = Infinity;
            for (let c = 0; c < n; c++) {
                const d = haversine(streets[i].centroidLat, streets[i].centroidLon, centroids[c].lat, centroids[c].lon);
                if (d < bestD) { bestD = d; bestC = c; }
            }
            if (assignments[i] !== bestC) { assignments[i] = bestC; changed = true; }
        }
        if (!changed) break;
        for (let c = 0; c < n; c++) {
            let sLat = 0, sLon = 0, sW = 0;
            for (let i = 0; i < streets.length; i++) {
                if (assignments[i] === c) {
                    const w = streets[i].addrs.length;
                    sLat += streets[i].centroidLat * w; sLon += streets[i].centroidLon * w; sW += w;
                }
            }
            if (sW > 0) { centroids[c].lat = sLat / sW; centroids[c].lon = sLon / sW; }
        }
    }
    const buckets = Array.from({ length: n }, () => []);
    for (let c = 0; c < n; c++) {
        const clusterStreets = streets.filter((_, i) => assignments[i] === c);
        if (clusterStreets.length === 0) continue;
        const chain = chainStreetsByEndpoints(clusterStreets, 0);
        for (const entry of chain) for (const addr of entry.orderedAddrs) buckets[c].push(addr);
    }
    return buckets;
}

// Strategy: geographic quadrant split (recursive bisection)
function strategyBisect(addresses, n) {
    if (n <= 1) return [addresses];
    // Split into two halves along the longer axis
    const lats = addresses.map(a => a.latitude);
    const lons = addresses.map(a => a.longitude);
    const latRange = Math.max(...lats) - Math.min(...lats);
    const lonRange = Math.max(...lons) - Math.min(...lons);

    const sorted = [...addresses].sort((a, b) =>
        latRange > lonRange ? a.latitude - b.latitude : a.longitude - b.longitude
    );

    // Split sizes for balanced bisection
    const leftN = Math.ceil(n / 2);
    const rightN = n - leftN;
    const splitPoint = Math.round(sorted.length * leftN / n);

    const left = sorted.slice(0, splitPoint);
    const right = sorted.slice(splitPoint);

    // Recursively split each half, ordering within each for walking
    const leftBuckets = strategyBisect(left, leftN);
    const rightBuckets = strategyBisect(right, rightN);

    return [...leftBuckets, ...rightBuckets];
}

function strategyBisectWithWalkOrder(streets, addresses, n) {
    const rawBuckets = strategyBisect(addresses, n);
    // Re-order each bucket's addresses for walking
    return rawBuckets.map(bucket => {
        const bucketStreets = buildStreets(bucket);
        const chain = chainStreetsByEndpoints(bucketStreets, 0);
        return chain.flatMap(e => e.orderedAddrs);
    });
}

// ============================================================================
// SCORING
// ============================================================================

function walkDistance(addrs) {
    let total = 0;
    for (let i = 1; i < addrs.length; i++) {
        total += haversine(addrs[i-1].latitude, addrs[i-1].longitude, addrs[i].latitude, addrs[i].longitude);
    }
    return total;
}

function scoreBuckets(buckets, label) {
    const distances = buckets.map(b => walkDistance(b));
    const counts = buckets.map(b => b.length);
    const totalDist = distances.reduce((s, d) => s + d, 0);
    const maxDist = Math.max(...distances);
    const minDist = Math.min(...distances.filter(d => d > 0));
    const maxCount = Math.max(...counts);
    const minCount = Math.min(...counts);

    // Compactness: avg distance from centroid per bucket
    let totalSpread = 0;
    for (const addrs of buckets) {
        if (addrs.length === 0) continue;
        const cLat = addrs.reduce((s, a) => s + a.latitude, 0) / addrs.length;
        const cLon = addrs.reduce((s, a) => s + a.longitude, 0) / addrs.length;
        let spread = 0;
        for (const a of addrs) spread += haversine(cLat, cLon, a.latitude, a.longitude);
        totalSpread += spread / addrs.length;
    }

    console.log(`  ${label}:`);
    console.log(`    Counts: ${counts.join(", ")} (ratio ${(maxCount/minCount).toFixed(2)})`);
    console.log(`    Walk distances (m): ${distances.map(d => Math.round(d)).join(", ")}`);
    console.log(`    Total walk: ${Math.round(totalDist)}m, Max: ${Math.round(maxDist)}m, Ratio: ${(maxDist/minDist).toFixed(2)}`);
    console.log(`    Avg spread: ${Math.round(totalSpread)}m`);

    return { totalDist, maxDist, ratio: maxDist/minDist, spread: totalSpread, counts, label };
}

// ============================================================================
// MAIN
// ============================================================================

const file = process.argv[2] || "/tmp/midtown_addresses.csv";
const numEsws = parseInt(process.argv[3]) || 3;

const addresses = loadAddresses(file);
const streets = buildStreets(addresses);
const neighborhood = file.includes("midtown") ? "Midtown" : file.includes("crescent") ? "Crescent Park" : file.includes("fairmeadow") ? "Fairmeadow" : "Unknown";

console.log(`\n=== ${neighborhood}: ${addresses.length} addresses, ${streets.length} streets, ${numEsws} ESWs ===\n`);

const results = [];

// Chain slice from multiple starts
for (let s = 0; s < Math.min(streets.length, 5); s++) {
    const buckets = strategyChainSlice(streets, numEsws, addresses.length, s);
    results.push(scoreBuckets(buckets, `ChainSlice(start=${s})`));
}

// K-means
const kmBuckets = strategyKmeans(streets, numEsws);
results.push(scoreBuckets(kmBuckets, "K-means"));

// Bisect
const biBuckets = strategyBisectWithWalkOrder(streets, addresses, numEsws);
results.push(scoreBuckets(biBuckets, "Bisect"));

// Pick best by combined metric: minimize max walk distance + penalize imbalance
console.log(`\n--- Rankings ---`);
results.sort((a, b) => {
    const scoreA = a.maxDist + a.spread * 2 + (a.ratio - 1) * 5000;
    const scoreB = b.maxDist + b.spread * 2 + (b.ratio - 1) * 5000;
    return scoreA - scoreB;
});
results.forEach((r, i) => {
    console.log(`  ${i+1}. ${r.label} — max walk ${Math.round(r.maxDist)}m, spread ${Math.round(r.spread)}m, count ratio ${r.ratio.toFixed(2)}`);
});
console.log(`\n  Winner: ${results[0].label}`);
