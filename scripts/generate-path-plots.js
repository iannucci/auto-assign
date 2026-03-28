#!/usr/bin/env node
// Generate path data for U-turn vs zig-zag and right-hand vs NN chain visualizations

const fs = require("fs");

function loadAddresses(file) {
    return fs.readFileSync(file, "utf8").trim().split("\n").map(line => {
        const [gid, sa, lat, lon] = line.split("|");
        return { gid: parseInt(gid), street_address: sa, latitude: parseFloat(lat), longitude: parseFloat(lon) };
    });
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function extractStreetName(a) { return (a||"").replace(/^\d+[A-Za-z\/]*\s+/,"").trim()||a; }
function houseNum(a) { const m = (a.street_address||"").match(/^(\d+)/); return m ? parseInt(m[1]) : 0; }

// Write a path file: ordered lon/lat for drawing connected lines
function writePath(filename, addrs) {
    const lines = ["lon lat"];
    for (const a of addrs) lines.push(`${a.longitude} ${a.latitude}`);
    fs.writeFileSync(filename, lines.join("\n") + "\n");
}

// === U-turn vs numeric ordering on a single street ===
const fm = loadAddresses("data/fairmeadow_addresses.csv");
const streetMap = new Map();
for (const a of fm) {
    const s = extractStreetName(a.street_address);
    if (!streetMap.has(s)) streetMap.set(s, []);
    streetMap.get(s).push(a);
}

// Pick a good street with 20+ addresses
let bestStreet = null;
for (const [name, addrs] of streetMap) {
    if (addrs.length >= 20 && (!bestStreet || addrs.length > bestStreet[1].length)) {
        bestStreet = [name, addrs];
    }
}

if (bestStreet) {
    const [name, addrs] = bestStreet;
    console.log(`Street for U-turn demo: ${name} (${addrs.length} addresses)`);

    // Numeric order (zig-zag)
    const numeric = [...addrs].sort((a,b) => houseNum(a) - houseNum(b));
    writePath("data/street-zigzag.dat", numeric);

    // U-turn order
    const evens = addrs.filter(a => houseNum(a) % 2 === 0).sort((a,b) => houseNum(a) - houseNum(b));
    const odds = addrs.filter(a => houseNum(a) % 2 !== 0).sort((a,b) => houseNum(b) - houseNum(a));
    writePath("data/street-uturn.dat", [...evens, ...odds]);

    // Also write points for scatter overlay
    const pts = ["lon lat label"];
    for (const a of addrs) pts.push(`${a.longitude} ${a.latitude} ${houseNum(a)}`);
    fs.writeFileSync("data/street-points.dat", pts.join("\n") + "\n");
}

// === Right-hand vs NN chain on Fairmeadow ===
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
        streets.push({ name, addrs: sorted, endA:{lat:f.latitude,lon:f.longitude}, endB:{lat:l.latitude,lon:l.longitude} });
    }
    return streets;
}

function chainNN(streets, startIdx) {
    if (streets.length <= 1) return streets.length ? [{orderedAddrs:streets[0].addrs}] : [];
    const remaining = new Set(streets.map((_,i)=>i));
    const chain = []; let ci=startIdx; remaining.delete(ci);
    let s=streets[ci]; chain.push({orderedAddrs:s.addrs});
    let eLat=s.endB.lat, eLon=s.endB.lon;
    while (remaining.size > 0) {
        let ni=-1,nd=Infinity,nr=false;
        for (const idx of remaining) { const st=streets[idx];
            const dA=haversine(eLat,eLon,st.endA.lat,st.endA.lon);
            const dB=haversine(eLat,eLon,st.endB.lat,st.endB.lon);
            if(dA<nd){nd=dA;ni=idx;nr=false;} if(dB<nd){nd=dB;ni=idx;nr=true;} }
        remaining.delete(ni); s=streets[ni];
        chain.push({orderedAddrs: nr?[...s.addrs].reverse():s.addrs});
        eLat=nr?s.endA.lat:s.endB.lat; eLon=nr?s.endA.lon:s.endB.lon;
    }
    return chain;
}

function chainRH(streets, startIdx) {
    if (streets.length <= 1) return streets.length ? [{orderedAddrs:streets[0].addrs}] : [];
    function bear(lat1,lon1,lat2,lon2) {
        const toRad=d=>d*Math.PI/180,toDeg=r=>r*180/Math.PI;
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
        let bi=-1,bs=Infinity,br=false;
        for (const idx of remaining) { const st=streets[idx];
            const dA=haversine(eLat,eLon,st.endA.lat,st.endA.lon);
            const bA=bear(eLat,eLon,st.endA.lat,st.endA.lon); const tA=(bA-heading+360)%360; const sA=dA+tA*0.5;
            const dB=haversine(eLat,eLon,st.endB.lat,st.endB.lon);
            const bB=bear(eLat,eLon,st.endB.lat,st.endB.lon); const tB=(bB-heading+360)%360; const sB=dB+tB*0.5;
            if(sA<bs){bs=sA;bi=idx;br=false;} if(sB<bs){bs=sB;bi=idx;br=true;} }
        remaining.delete(bi); s=streets[bi];
        chain.push({orderedAddrs: br?[...s.addrs].reverse():s.addrs});
        if(br){eLat=s.endA.lat;eLon=s.endA.lon;heading=bear(s.endB.lat,s.endB.lon,s.endA.lat,s.endA.lon);}
        else{eLat=s.endB.lat;eLon=s.endB.lon;heading=bear(s.endA.lat,s.endA.lon,s.endB.lat,s.endB.lon);}
    }
    return chain;
}

const fmStreets = buildStreets(fm);

// NN chain path (centroids only, for cleaner visualization)
const nnChain = chainNN(fmStreets, 0);
const nnCentroids = nnChain.map(e => {
    const addrs = e.orderedAddrs;
    return { longitude: addrs.reduce((s,a)=>s+a.longitude,0)/addrs.length,
             latitude: addrs.reduce((s,a)=>s+a.latitude,0)/addrs.length };
});
writePath("data/fm-nn-path.dat", nnCentroids);

// RH chain path (centroids)
const rhChain = chainRH(fmStreets, 0);
const rhCentroids = rhChain.map(e => {
    const addrs = e.orderedAddrs;
    return { longitude: addrs.reduce((s,a)=>s+a.longitude,0)/addrs.length,
             latitude: addrs.reduce((s,a)=>s+a.latitude,0)/addrs.length };
});
writePath("data/fm-rh-path.dat", rhCentroids);

// All addresses as background scatter
const bgPts = ["lon lat"];
for (const a of fm) bgPts.push(`${a.longitude} ${a.latitude}`);
fs.writeFileSync("data/fm-all-points.dat", bgPts.join("\n") + "\n");

console.log("Generated path data files");
