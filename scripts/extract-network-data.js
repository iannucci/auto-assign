#!/usr/bin/env node
// Extract road network and address data from the SA/GIS databases.
// Run on sitrep.rail.com where DB access is available.
// Outputs: data/network-extract.json
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

// Point-to-line-segment distance (returns distance and projection parameter t)
function pointToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return { dist: haversine(px, py, ax, ay), t: 0 };
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projLat = ax + t * (bx - ax);
    const projLon = ay + t * (by - ay);
    return { dist: haversine(px, py, projLat, projLon), t };
}

// Determine which side of a directed line (A→B) a point P is on
// Returns 'left' or 'right' using cross product
function sideOfLine(px, py, ax, ay, bx, by) {
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    return cross >= 0 ? "left" : "right";
}

async function main() {
    console.log("=== Extracting road network and addresses ===");

    // 1. Extract road network from GIS database
    console.log("Querying road network...");
    const roadQuery = `
        WITH bounded_roads AS (
            SELECT l.osm_id, l.name, l.highway, l.oneway, w.nodes
            FROM planet_osm_line l
            JOIN planet_osm_ways w ON w.id = l.osm_id
            WHERE l.highway = ANY($1)
            AND l.way && ST_Transform(ST_MakeEnvelope($2, $3, $4, $5, 4326), 3857)
        )
        SELECT r.osm_id, r.name, r.highway, r.oneway, r.nodes,
            array_agg(n.id ORDER BY array_position(r.nodes, n.id)) as node_ids,
            array_agg(n.lat / 10000000.0 ORDER BY array_position(r.nodes, n.id)) as lats,
            array_agg(n.lon / 10000000.0 ORDER BY array_position(r.nodes, n.id)) as lons
        FROM bounded_roads r
        JOIN planet_osm_nodes n ON n.id = ANY(r.nodes)
        GROUP BY r.osm_id, r.name, r.highway, r.oneway, r.nodes
    `;
    const roadResult = await gisPool.query(roadQuery, [
        ROAD_TYPES, BOUNDS.swLon, BOUNDS.swLat, BOUNDS.neLon, BOUNDS.neLat
    ]);
    console.log(`  ${roadResult.rows.length} road ways found`);

    // Build node map and edge list
    const nodesMap = new Map(); // nodeId -> {lat, lon}
    const edges = [];           // {from, to, name, highway, dist, bearing}
    const nodeDegree = new Map(); // nodeId -> count of edges touching it

    for (const row of roadResult.rows) {
        const nodeIds = row.node_ids;
        const lats = row.lats;
        const lons = row.lons;

        for (let i = 0; i < nodeIds.length; i++) {
            if (!nodesMap.has(nodeIds[i])) {
                nodesMap.set(nodeIds[i], { lat: lats[i], lon: lons[i] });
            }
        }

        for (let i = 0; i < nodeIds.length - 1; i++) {
            const dist = haversine(lats[i], lons[i], lats[i+1], lons[i+1]);
            edges.push({
                from: nodeIds[i], to: nodeIds[i+1],
                name: row.name || null, highway: row.highway,
                dist: Math.round(dist * 10) / 10,
                osmId: row.osm_id
            });
            // Track degree for intersection detection
            nodeDegree.set(nodeIds[i], (nodeDegree.get(nodeIds[i]) || 0) + 1);
            nodeDegree.set(nodeIds[i+1], (nodeDegree.get(nodeIds[i+1]) || 0) + 1);
        }
    }
    console.log(`  ${nodesMap.size} nodes, ${edges.length} edges`);

    // 2. Identify intersections: nodes with degree > 2 or way endpoints
    // Also: nodes where street name changes
    const wayEndpoints = new Set();
    for (const row of roadResult.rows) {
        const nids = row.node_ids;
        wayEndpoints.add(nids[0]);
        wayEndpoints.add(nids[nids.length - 1]);
    }

    const intersections = new Set();
    for (const [nodeId, degree] of nodeDegree) {
        if (degree > 2 || wayEndpoints.has(nodeId)) {
            intersections.add(nodeId);
        }
    }
    console.log(`  ${intersections.size} intersection nodes`);

    // 3. Build segments: maximal chains of edges between intersections
    // A segment is a sequence of edges along the same OSM way between two intersection nodes
    const segments = [];
    const visitedEdges = new Set();

    // Build adjacency for traversal
    const adjForward = new Map(); // nodeId -> [{to, edgeIdx}]
    for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (!adjForward.has(e.from)) adjForward.set(e.from, []);
        adjForward.get(e.from).push({ to: e.to, idx: i });
    }

    // For each edge, trace from intersection to intersection along same OSM way
    for (let ei = 0; ei < edges.length; ei++) {
        if (visitedEdges.has(ei)) continue;
        const startEdge = edges[ei];
        const osmId = startEdge.osmId;
        const name = startEdge.name;

        // Find the start of this segment (walk backward to an intersection)
        // Actually simpler: just trace forward from each intersection
    }

    // Alternative approach: group edges by OSM way, then split at intersections
    const wayEdges = new Map(); // osmId -> [edgeIdx] in order
    for (const row of roadResult.rows) {
        const nids = row.node_ids;
        const edgeIndices = [];
        for (let i = 0; i < nids.length - 1; i++) {
            // Find the matching edge
            const idx = edges.findIndex((e, ei) =>
                e.osmId === row.osm_id && e.from === nids[i] && e.to === nids[i+1]
            );
            if (idx >= 0) edgeIndices.push(idx);
        }
        wayEdges.set(row.osm_id, { edges: edgeIndices, name: row.name, highway: row.highway, nodeIds: nids });
    }

    // Split each way at intersection nodes to form segments
    let segId = 0;
    for (const [osmId, way] of wayEdges) {
        const nids = way.nodeIds;
        let segStart = 0;
        for (let i = 1; i < nids.length; i++) {
            if (intersections.has(nids[i]) || i === nids.length - 1) {
                // Segment from nids[segStart] to nids[i]
                const segNodes = [];
                for (let j = segStart; j <= i; j++) {
                    const n = nodesMap.get(nids[j]);
                    segNodes.push({ id: nids[j], lat: n.lat, lon: n.lon });
                }
                let segDist = 0;
                for (let j = 0; j < segNodes.length - 1; j++) {
                    segDist += haversine(segNodes[j].lat, segNodes[j].lon,
                                         segNodes[j+1].lat, segNodes[j+1].lon);
                }
                segments.push({
                    id: segId++,
                    osmId,
                    name: way.name,
                    highway: way.highway,
                    startNode: nids[segStart],
                    endNode: nids[i],
                    nodes: segNodes,
                    distance: Math.round(segDist * 10) / 10
                });
                segStart = i; // Next segment starts at this intersection
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
    const addressSegments = []; // {gid, segmentId, side, distAlongSegment, snapDist}

    for (const addr of addresses) {
        let bestDist = Infinity, bestSegId = -1, bestSide = null, bestT = 0;

        for (const seg of segments) {
            // Check each edge of the segment
            for (let i = 0; i < seg.nodes.length - 1; i++) {
                const a = seg.nodes[i], b = seg.nodes[i+1];
                const { dist, t } = pointToSegment(addr.lat, addr.lon, a.lat, a.lon, b.lat, b.lon);

                // Compute cumulative t along segment
                let cumDist = 0;
                for (let j = 0; j < i; j++) {
                    cumDist += haversine(seg.nodes[j].lat, seg.nodes[j].lon,
                                         seg.nodes[j+1].lat, seg.nodes[j+1].lon);
                }
                const edgeDist = haversine(a.lat, a.lon, b.lat, b.lon);
                const totalT = (cumDist + t * edgeDist) / (seg.distance || 1);

                if (dist < bestDist) {
                    bestDist = dist;
                    bestSegId = seg.id;
                    bestT = totalT;
                    bestSide = sideOfLine(addr.lat, addr.lon, a.lat, a.lon, b.lat, b.lon);
                }
            }
        }

        if (bestSegId >= 0 && bestDist < 200) { // Max 200m snap distance
            addressSegments.push({
                gid: addr.gid,
                segmentId: bestSegId,
                side: bestSide,
                t: Math.round(bestT * 10000) / 10000,
                snapDist: Math.round(bestDist * 10) / 10
            });
        }
    }
    console.log(`  ${addressSegments.length} addresses snapped (${addresses.length - addressSegments.length} too far from road)`);

    // 6. Build sub-segments
    // Group snapped addresses by (segmentId, side), order by t
    const subSegMap = new Map(); // "segId:side" -> [addr entries]
    for (const as of addressSegments) {
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

    // 7. Build segment adjacency graph (which segments share intersection nodes)
    const nodeToSegments = new Map(); // nodeId -> [segId]
    for (const seg of segments) {
        for (const nid of [seg.startNode, seg.endNode]) {
            if (!nodeToSegments.has(nid)) nodeToSegments.set(nid, []);
            nodeToSegments.get(nid).push(seg.id);
        }
    }

    const segmentAdjacency = []; // {segA, segB, sharedNode, dist}
    for (const [nodeId, segIds] of nodeToSegments) {
        for (let i = 0; i < segIds.length; i++) {
            for (let j = i + 1; j < segIds.length; j++) {
                segmentAdjacency.push({
                    segA: segIds[i],
                    segB: segIds[j],
                    sharedNode: nodeId
                });
            }
        }
    }
    console.log(`  ${segmentAdjacency.length} segment adjacencies`);

    // 8. Save everything
    const output = {
        bounds: BOUNDS,
        extractDate: new Date().toISOString(),
        nodes: Object.fromEntries([...nodesMap].map(([id, n]) => [id, { lat: n.lat, lon: n.lon }])),
        intersections: [...intersections],
        segments: segments.map(s => ({
            id: s.id, osmId: s.osmId, name: s.name, highway: s.highway,
            startNode: s.startNode, endNode: s.endNode,
            nodes: s.nodes.map(n => ({ id: n.id, lat: n.lat, lon: n.lon })),
            distance: s.distance
        })),
        subSegments,
        segmentAdjacency,
        addresses: addresses.map(a => ({
            gid: a.gid, street_address: a.street_address,
            lat: a.lat, lon: a.lon, neighborhood: a.neighborhood
        })),
        addressSnapping: addressSegments
    };

    const outPath = path.join(__dirname, "..", "data", "network-extract.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(output));
    const sizeMB = (fs.statSync(outPath).size / 1048576).toFixed(1);
    console.log(`\nSaved ${outPath} (${sizeMB} MB)`);

    // Summary stats by neighborhood
    const hoodCounts = new Map();
    for (const a of addresses) {
        hoodCounts.set(a.neighborhood, (hoodCounts.get(a.neighborhood) || 0) + 1);
    }
    const sortedHoods = [...hoodCounts].sort((a, b) => b[1] - a[1]);
    console.log(`\nTop neighborhoods:`);
    for (const [name, count] of sortedHoods.slice(0, 10)) {
        console.log(`  ${name}: ${count} addresses`);
    }

    await saPool.end();
    await gisPool.end();
    console.log("\nDone.");
}

main().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});
