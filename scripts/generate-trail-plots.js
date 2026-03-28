#!/usr/bin/env node
// Generate per-ESW trail map data files for LaTeX pgfplots
// Blue lines = within-segment walking, Red lines = inter-segment transitions

const fs = require("fs");
const path = require("path");

const trails = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "trail-data.json"), "utf8"));
const dataDir = path.join(__dirname, "..", "data");

for (const trail of trails) {
    const hood = trail.hood.replace(/[^a-zA-Z]/g, "").toLowerCase();
    const prefix = `${hood}-esw${trail.esw}`;

    // Blue: within-segment polylines
    const bluePts = ["lon lat"];
    for (const seg of trail.segments) {
        for (const pt of seg.polyline) {
            bluePts.push(`${pt[1]} ${pt[0]}`);
        }
        bluePts.push(""); // blank line separates segments (pgfplots treats as gap)
    }
    fs.writeFileSync(path.join(dataDir, `${prefix}-segments.dat`), bluePts.join("\n") + "\n");

    // Red: transition lines (straight lines between segment endpoints)
    const redPts = ["lon lat"];
    for (const trans of trail.transitions) {
        redPts.push(`${trans.from[1]} ${trans.from[0]}`);
        redPts.push(`${trans.to[1]} ${trans.to[0]}`);
        redPts.push(""); // gap
    }
    fs.writeFileSync(path.join(dataDir, `${prefix}-transitions.dat`), redPts.join("\n") + "\n");

    // All address points for this ESW
    const pts = ["lon lat"];
    for (const seg of trail.segments) {
        // Centroid of segment as point
        const pl = seg.polyline;
        const midIdx = Math.floor(pl.length / 2);
        pts.push(`${pl[midIdx][1]} ${pl[midIdx][0]}`);
    }
    fs.writeFileSync(path.join(dataDir, `${prefix}-points.dat`), pts.join("\n") + "\n");

    console.log(`${trail.hood} ESW ${trail.esw}: ${trail.segments.length} segments, ${trail.transitions.length} transitions`);
}

// Also generate a combined all-addresses background for each neighborhood
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "network-extract.json"), "utf8"));
const hoodAddrs = new Map();
for (const a of data.addresses) {
    if (!hoodAddrs.has(a.neighborhood)) hoodAddrs.set(a.neighborhood, []);
    hoodAddrs.get(a.neighborhood).push(a);
}

const hoodsNeeded = new Set(trails.map(t => t.hood));
for (const hood of hoodsNeeded) {
    const addrs = hoodAddrs.get(hood) || [];
    const hoodKey = hood.replace(/[^a-zA-Z]/g, "").toLowerCase();
    const bgPts = ["lon lat"];
    for (const a of addrs) bgPts.push(`${a.lon} ${a.lat}`);
    fs.writeFileSync(path.join(dataDir, `${hoodKey}-all-addrs.dat`), bgPts.join("\n") + "\n");
    console.log(`${hood}: ${addrs.length} background addresses`);
}

console.log("\nDone generating trail plot data.");
