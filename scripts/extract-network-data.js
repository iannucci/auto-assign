#!/usr/bin/env node
// Extract road network and address data from the SA/GIS databases.
// Run on sitrep.rail.com where DB access is available.
// Outputs: data/network-extract.json
//
// Uses osm2pgsql rendering tables (planet_osm_line with geometry),
// NOT the slim tables (planet_osm_ways/nodes which require --slim without --drop).
//
// Usage: DB_HOST=postgres.rail.com DB_PORT=5432 \
//        SA_DB=situational_awareness SA_USER=postgres SA_PASS=xxx \
//        GIS_DB=gis GIS_USER=postgres GIS_PASS=xxx \
//        node scripts/extract-network-data.js

const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const SA_ADDR_TABLE = process.env.SA_ADDR_TABLE || "pa_addresses";

const saPool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.SA_DB,
    user: process.env.SA_USER,
    password: process.env.SA_PASS,
});

const gisPool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.GIS_DB,
    user: process.env.GIS_USER,
    password: process.env.GIS_PASS,
});

// Palo Alto bounding box
const BOUNDS = { swLat: 37.35, swLon: -122.20, neLat: 37.48, neLon: -122.05 };

const ROAD_TYPES = [
    'motorway', 'motorway_link', 'trunk', 'trunk_link',
    'primary', 'primary_link', 'secondary', 'secondary_link',
    'tertiary', 'tertiary_link', 'residential', 'unclassified',
    'service', 'living_street'
];

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Point-to-line-segment distance
function pointToSegDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return { dist: haversine(px, py, ax, ay), t: 0 };
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projLat = ax + t * (bx - ax);
    const projLon = ay + t * (by - ay);
    return { dist: haversine(px, py, projLat, projLon), t };
}

// Which side of directed line A→B is point P on?
function sideOfLine(px, py, ax, ay, bx, by) {
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    return cross >= 0 ? "left" : "right";
}

async function main() {
    console.log("=== Extracting road network and addresses ===");

    // 1. Extract road ways with their vertex coordinates from planet_osm_line
    // osm2pgsql stores geometry in Web Mercator (3857); we transform to WGS84 (4326)
    console.log("Querying road network from planet_osm_line...");
    const roadQuery = `
        SELECT
            osm_id,
            name,
            highway,
            oneway,
            -- Extract vertices as WGS84 lat/lon arrays
            (SELECT array_agg(ST_Y(geom)) FROM (
                SELECT (ST_DumpPoints(ST_Transform(way, 4326))).geom
            ) sub) AS lats,
            (SELECT array_agg(ST_X(geom)) FROM (
                SELECT (ST_DumpPoints(ST_Transform(way, 4326))).geom
            ) sub) AS lons
        FROM planet_osm_line
        WHERE highway = ANY($1)
        AND way && ST_Transform(ST_MakeEnvelope($2, $3, $4, $5, 4326), 3857)
    `;
    const roadResult = await gisPool.query(roadQuery, [
        ROAD_TYPES, BOUNDS.swLon, BOUNDS.swLat, BOUNDS.neLon, BOUNDS.neLat
    ]);
    console.log(`  ${roadResult.rows.length} road ways found`);

    // Build node map: snap vertices to a grid (7 decimal places ≈ 1cm) to detect shared nodes
    const PRECISION = 7;
    const nodeKey = (lat, lon) => `${lat.toFixed(PRECISION)}|${lon.toFixed(PRECISION)}`;
    const nodeMap = new Map();   // key -> nodeId
    const nodeCoords = new Map(); // nodeId -> {lat, lon}
    let nextNodeId = 0;

    function getOrCreateNode(lat, lon) {
        const key = nodeKey(lat, lon);
        if (nodeMap.has(key)) return nodeMap.get(key);
        const id = nextNodeId++;
        nodeMap.set(key, id);
        nodeCoords.set(id, { lat, lon });
        return id;
    }

    // Build ways as sequences of node IDs
    const ways = [];
    for (const row of roadResult.rows) {
        if (!row.lats || !row.lons || row.lats.length < 2) continue;
        const nodeIds = [];
        for (let i = 0; i < row.lats.length; i++) {
            nodeIds.push(getOrCreateNode(row.lats[i], row.lons[i]));
        }
        ways.push({
            osmId: row.osm_id,
            name: row.name || null,
            highway: row.highway,
            oneway: row.oneway,
            nodeIds
        });
    }
    console.log(`  ${nodeCoords.size} unique nodes, ${ways.length} ways`);

    // 2. Detect intersections: nodes appearing in more than one way, or at way endpoints
    const nodeWayCount = new Map(); // nodeId -> number of ways it appears in
    for (const w of ways) {
        const seen = new Set();
        for (const nid of w.nodeIds) {
            if (!seen.has(nid)) {
                nodeWayCount.set(nid, (nodeWayCount.get(nid) || 0) + 1);
                seen.add(nid);
            }
        }
    }

    const intersections = new Set();
    for (const [nodeId, count] of nodeWayCount) {
        if (count > 1) intersections.add(nodeId);
    }
    // Also add all way endpoints
    for (const w of ways) {
        intersections.add(w.nodeIds[0]);
        intersections.add(w.nodeIds[w.nodeIds.length - 1]);
    }
    console.log(`  ${intersections.size} intersection/endpoint nodes`);

    // 3. Build segments: split each way at intersection nodes
    const segments = [];
    let segId = 0;
    for (const w of ways) {
        let segStart = 0;
        for (let i = 1; i < w.nodeIds.length; i++) {
            if (intersections.has(w.nodeIds[i]) || i === w.nodeIds.length - 1) {
                // Build segment from segStart to i
                const segNodeIds = w.nodeIds.slice(segStart, i + 1);
                const segNodes = segNodeIds.map(nid => {
                    const c = nodeCoords.get(nid);
                    return { id: nid, lat: c.lat, lon: c.lon };
                });
                let dist = 0;
                for (let j = 0; j < segNodes.length - 1; j++) {
                    dist += haversine(segNodes[j].lat, segNodes[j].lon,
                                      segNodes[j+1].lat, segNodes[j+1].lon);
                }
                if (dist > 0.5) { // Skip degenerate segments < 0.5m
                    segments.push({
                        id: segId++,
                        osmId: w.osmId,
                        name: w.name,
                        highway: w.highway,
                        startNode: segNodeIds[0],
                        endNode: segNodeIds[segNodeIds.length - 1],
                        nodes: segNodes,
                        distance: Math.round(dist * 10) / 10
                    });
                }
                segStart = i;
            }
        }
    }
    console.log(`  ${segments.length} road segments built`);

    // 4. Extract addresses
    console.log("Querying addresses...");
    const addrResult = await saPool.query(`
        SELECT gid, street_address, latitude, longitude, neighborhood
        FROM ${SA_ADDR_TABLE}
        WHERE latitude BETWEEN $1 AND $2
        AND longitude BETWEEN $3 AND $4
        ORDER BY neighborhood, street_address
    `, [BOUNDS.swLat, BOUNDS.neLat, BOUNDS.swLon, BOUNDS.neLon]);
    console.log(`  ${addrResult.rows.length} addresses found`);

    const addresses = addrResult.rows.map(r => ({
        gid: parseFloat(r.gid),
        street_address: r.street_address,
        lat: parseFloat(r.latitude),
        lon: parseFloat(r.longitude),
        neighborhood: r.neighborhood
    }));

    // 5. Snap each address to nearest road segment and determine side
    console.log("Snapping addresses to segments...");
    const addressSnapping = [];

    for (const addr of addresses) {
        let bestDist = Infinity, bestSegId = -1, bestSide = null, bestT = 0;

        for (const seg of segments) {
            for (let i = 0; i < seg.nodes.length - 1; i++) {
                const a = seg.nodes[i], b = seg.nodes[i+1];
                const { dist, t } = pointToSegDist(addr.lat, addr.lon,
                    a.lat, a.lon, b.lat, b.lon);

                if (dist < bestDist) {
                    // Cumulative distance along segment for ordering
                    let cumDist = 0;
                    for (let j = 0; j < i; j++) {
                        cumDist += haversine(seg.nodes[j].lat, seg.nodes[j].lon,
                                             seg.nodes[j+1].lat, seg.nodes[j+1].lon);
                    }
                    const edgeDist = haversine(a.lat, a.lon, b.lat, b.lon);
                    const totalT = (cumDist + t * edgeDist) / (seg.distance || 1);

                    bestDist = dist;
                    bestSegId = seg.id;
                    bestT = totalT;
                    bestSide = sideOfLine(addr.lat, addr.lon,
                        a.lat, a.lon, b.lat, b.lon);
                }
            }
        }

        if (bestSegId >= 0 && bestDist < 200) {
            addressSnapping.push({
                gid: addr.gid,
                segmentId: bestSegId,
                side: bestSide,
                t: Math.round(bestT * 10000) / 10000,
                snapDist: Math.round(bestDist * 10) / 10
            });
        }
    }
    console.log(`  ${addressSnapping.length} addresses snapped (${addresses.length - addressSnapping.length} too far)`);

    // 6. Build sub-segments: group by (segmentId, side), order by t
    const subSegMap = new Map();
    for (const as of addressSnapping) {
        const key = `${as.segmentId}:${as.side}`;
        if (!subSegMap.has(key)) subSegMap.set(key, []);
        subSegMap.get(key).push(as);
    }

    const subSegments = [];
    let ssId = 0;
    for (const [key, entries] of subSegMap) {
        entries.sort((a, b) => a.t - b.t);
        const [segIdStr, side] = key.split(":");
        const segId = parseInt(segIdStr);
        const seg = segments[segId];
        subSegments.push({
            id: ssId++,
            segmentId: segId,
            side,
            streetName: seg.name,
            highway: seg.highway,
            gids: entries.map(e => e.gid),
            count: entries.length
        });
    }
    console.log(`  ${subSegments.length} sub-segments built`);

    // 7. Build segment adjacency (shared intersection nodes)
    const nodeToSegs = new Map();
    for (const seg of segments) {
        for (const nid of [seg.startNode, seg.endNode]) {
            if (!nodeToSegs.has(nid)) nodeToSegs.set(nid, []);
            nodeToSegs.get(nid).push(seg.id);
        }
    }
    const segAdjacency = [];
    for (const [nodeId, segIds] of nodeToSegs) {
        const unique = [...new Set(segIds)];
        for (let i = 0; i < unique.length; i++) {
            for (let j = i + 1; j < unique.length; j++) {
                segAdjacency.push({ segA: unique[i], segB: unique[j], sharedNode: nodeId });
            }
        }
    }
    console.log(`  ${segAdjacency.length} segment adjacencies`);

    // 8. Summary stats
    const hoodCounts = new Map();
    for (const a of addresses) {
        hoodCounts.set(a.neighborhood, (hoodCounts.get(a.neighborhood) || 0) + 1);
    }
    console.log(`\nNeighborhoods: ${hoodCounts.size}`);
    const sortedHoods = [...hoodCounts].sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sortedHoods.slice(0, 10)) {
        console.log(`  ${name}: ${count}`);
    }

    // Snap distance stats
    const snapDists = addressSnapping.map(a => a.snapDist);
    snapDists.sort((a, b) => a - b);
    console.log(`\nSnap distances: median=${snapDists[Math.floor(snapDists.length/2)]}m, ` +
        `p95=${snapDists[Math.floor(snapDists.length*0.95)]}m, ` +
        `max=${snapDists[snapDists.length-1]}m`);

    // Sub-segment size stats
    const ssCounts = subSegments.map(s => s.count);
    ssCounts.sort((a, b) => a - b);
    console.log(`Sub-segments: ${subSegments.length}, median size=${ssCounts[Math.floor(ssCounts.length/2)]}, ` +
        `max=${ssCounts[ssCounts.length-1]}`);

    // 9. Save
    const output = {
        bounds: BOUNDS,
        extractDate: new Date().toISOString(),
        stats: {
            nodes: nodeCoords.size,
            intersections: intersections.size,
            ways: ways.length,
            segments: segments.length,
            subSegments: subSegments.length,
            addresses: addresses.length,
            snapped: addressSnapping.length,
            adjacencies: segAdjacency.length
        },
        // Compact node storage: array of [id, lat, lon]
        nodes: [...nodeCoords].map(([id, c]) => [id, c.lat, c.lon]),
        intersections: [...intersections],
        segments: segments.map(s => ({
            id: s.id, name: s.name, highway: s.highway,
            startNode: s.startNode, endNode: s.endNode,
            // Compact: just [lat, lon] pairs for the polyline
            polyline: s.nodes.map(n => [n.lat, n.lon]),
            distance: s.distance
        })),
        subSegments,
        segmentAdjacency: segAdjacency,
        addresses,
        addressSnapping
    };

    const outPath = path.join(__dirname, "..", "data", "network-extract.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(output));
    const sizeMB = (fs.statSync(outPath).size / 1048576).toFixed(1);
    console.log(`\nSaved ${outPath} (${sizeMB} MB)`);

    await saPool.end();
    await gisPool.end();
    console.log("Done.");
}

main().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});
