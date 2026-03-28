#!/usr/bin/env node
// Generate TikZ-compatible data files showing assignment results
// Outputs .dat files with columns: lon lat cluster
// Usage: node generate-plots.js

const fs = require("fs");

// Copy core algorithm functions from test-autoassign.js
function loadAddresses(file) {
    return fs.readFileSync(file, "utf8").trim().split("\n").map(line => {
        const [gid, street_address, lat, lon] = line.split("|");
        return { gid: parseInt(gid), street_address, latitude: parseFloat(lat), longitude: parseFloat(lon) };
    });
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function extractStreetName(address) {
    return (address || "").replace(/^\d+[A-Za-z\/]*\s+/, "").trim() || address;
}

function sortAlongStreet(addrs) {
    if (addrs.length <= 2) return addrs;
    let maxDist = 0, a0 = 0, a1 = 1;
    for (let i = 0; i < addrs.length; i++)
        for (let j = i + 1; j < addrs.length; j++) {
            const d = haversine(addrs[i].latitude, addrs[i].longitude, addrs[j].latitude, addrs[j].longitude);
            if (d > maxDist) { maxDist = d; a0 = i; a1 = j; }
        }
    const axisLat = addrs[a1].latitude - addrs[a0].latitude;
    const axisLon = addrs[a1].longitude - addrs[a0].longitude;
    return [...addrs].sort((a, b) => {
        const pA = (a.latitude - addrs[a0].latitude) * axisLat + (a.longitude - addrs[a0].longitude) * axisLon;
        const pB = (b.latitude - addrs[a0].latitude) * axisLat + (b.longitude - addrs[a0].longitude) * axisLon;
        return pA - pB;
    });
}

function buildStreets(addresses) {
    const m = new Map();
    for (const a of addresses) {
        const s = extractStreetName(a.street_address);
        if (!m.has(s)) m.set(s, []);
        m.get(s).push(a);
    }
    const streets = [];
    for (const [name, addrs] of m) {
        const sorted = sortAlongStreet(addrs);
        const f = sorted[0], l = sorted[sorted.length - 1];
        const cLat = addrs.reduce((s, a) => s + a.latitude, 0) / addrs.length;
        const cLon = addrs.reduce((s, a) => s + a.longitude, 0) / addrs.length;
        streets.push({ name, addrs: sorted, endA: { lat: f.latitude, lon: f.longitude }, endB: { lat: l.latitude, lon: l.longitude }, centroidLat: cLat, centroidLon: cLon });
    }
    return streets;
}

function chainStreetsByEndpoints(streets, startIdx = 0) {
    if (streets.length === 0) return [];
    if (streets.length === 1) return [{ orderedAddrs: streets[0].addrs }];
    const remaining = new Set(streets.map((_, i) => i));
    const chain = [];
    let ci = startIdx; remaining.delete(ci);
    let s = streets[ci]; chain.push({ orderedAddrs: s.addrs });
    let eLat = s.endB.lat, eLon = s.endB.lon;
    while (remaining.size > 0) {
        let ni = -1, nd = Infinity, nr = false;
        for (const idx of remaining) {
            const st = streets[idx];
            const dA = haversine(eLat, eLon, st.endA.lat, st.endA.lon);
            const dB = haversine(eLat, eLon, st.endB.lat, st.endB.lon);
            if (dA < nd) { nd = dA; ni = idx; nr = false; }
            if (dB < nd) { nd = dB; ni = idx; nr = true; }
        }
        remaining.delete(ni); s = streets[ni];
        chain.push({ orderedAddrs: nr ? [...s.addrs].reverse() : s.addrs });
        eLat = nr ? s.endA.lat : s.endB.lat;
        eLon = nr ? s.endA.lon : s.endB.lon;
    }
    return chain;
}

// Strategies
function chainSlice(streets, n, total, start) {
    const chain = chainStreetsByEndpoints(streets, start);
    const target = Math.ceil(total / n);
    const buckets = Array.from({ length: n }, () => []);
    let bi = 0, c = 0;
    for (const e of chain) for (const a of e.orderedAddrs) {
        buckets[bi].push(a); c++;
        if (c >= target && bi < n - 1) { bi++; c = 0; }
    }
    return buckets;
}

function bisect(addresses, n) {
    if (n <= 1) return [addresses];
    const lats = addresses.map(a => a.latitude);
    const lons = addresses.map(a => a.longitude);
    const sorted = [...addresses].sort((a, b) =>
        (Math.max(...lats) - Math.min(...lats)) > (Math.max(...lons) - Math.min(...lons))
            ? a.latitude - b.latitude : a.longitude - b.longitude);
    const lN = Math.ceil(n / 2), rN = n - lN;
    const sp = Math.round(sorted.length * lN / n);
    return [...bisect(sorted.slice(0, sp), lN), ...bisect(sorted.slice(sp), rN)];
}

function kmeans(streets, n) {
    const centroids = [];
    for (let i = 0; i < n; i++) {
        const idx = Math.floor(i * streets.length / n);
        centroids.push({ lat: streets[idx].centroidLat, lon: streets[idx].centroidLon });
    }
    let asgn = new Array(streets.length).fill(0);
    for (let iter = 0; iter < 20; iter++) {
        let changed = false;
        for (let i = 0; i < streets.length; i++) {
            let bC = 0, bD = Infinity;
            for (let c = 0; c < n; c++) {
                const d = haversine(streets[i].centroidLat, streets[i].centroidLon, centroids[c].lat, centroids[c].lon);
                if (d < bD) { bD = d; bC = c; }
            }
            if (asgn[i] !== bC) { asgn[i] = bC; changed = true; }
        }
        if (!changed) break;
        for (let c = 0; c < n; c++) {
            let sL = 0, sN = 0, sW = 0;
            for (let i = 0; i < streets.length; i++) {
                if (asgn[i] === c) { const w = streets[i].addrs.length; sL += streets[i].centroidLat * w; sN += streets[i].centroidLon * w; sW += w; }
            }
            if (sW > 0) { centroids[c].lat = sL / sW; centroids[c].lon = sN / sW; }
        }
    }
    const buckets = Array.from({ length: n }, () => []);
    for (let c = 0; c < n; c++) {
        const cs = streets.filter((_, i) => asgn[i] === c);
        for (const s of cs) for (const a of s.addrs) buckets[c].push(a);
    }
    return buckets;
}

// Generate .dat file: lon lat cluster
function writeDat(filename, buckets) {
    let lines = ["lon lat cluster"];
    for (let c = 0; c < buckets.length; c++) {
        for (const a of buckets[c]) {
            lines.push(`${a.longitude} ${a.latitude} ${c}`);
        }
    }
    fs.writeFileSync(filename, lines.join("\n") + "\n");
    const counts = buckets.map(b => b.length);
    console.log(`  ${filename}: ${counts.join(", ")} (${counts.reduce((a, b) => a + b, 0)} total)`);
}

// Generate plots for Fairmeadow
const fm = loadAddresses("data/fairmeadow_addresses.csv");
const fmStreets = buildStreets(fm);
console.log("Fairmeadow (3 ESWs):");
writeDat("data/fm-kmeans.dat", kmeans(fmStreets, 3));
writeDat("data/fm-chain.dat", chainSlice(fmStreets, 3, fm.length, 0));
writeDat("data/fm-bisect.dat", bisect(fm, 3));

// Midtown
const mt = loadAddresses("data/midtown_addresses.csv");
const mtStreets = buildStreets(mt);
console.log("Midtown (3 ESWs):");
writeDat("data/mt-kmeans.dat", kmeans(mtStreets, 3));
writeDat("data/mt-chain.dat", chainSlice(mtStreets, 3, mt.length, 0));
writeDat("data/mt-bisect.dat", bisect(mt, 3));

console.log("Done. .dat files written to data/");
