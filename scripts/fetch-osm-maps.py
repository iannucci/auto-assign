#!/usr/bin/env python3
"""Fetch OpenStreetMap tiles and composite neighborhood maps for the paper."""

import math
import os
import urllib.request
from PIL import Image

TILE_SIZE = 256
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "figures")
os.makedirs(OUT_DIR, exist_ok=True)

# Neighborhoods: name, minLat, maxLat, minLon, maxLon, zoom
NEIGHBORHOODS = [
    ("pac",  37.4275, 37.4294, -122.1432, -122.1405, 17),
    ("fm",   37.4148, 37.4213, -122.1228, -122.1142, 16),
    ("cc",   37.4422, 37.4492, -122.1520, -122.1394, 16),
    ("rp",   37.3890, 37.4250, -122.1550, -122.1305, 14),
    ("sg",   37.4298, 37.4512, -122.1620, -122.1475, 15),
]

def lat_lon_to_tile(lat, lon, zoom):
    """Convert lat/lon to tile x, y coordinates."""
    lat_rad = math.radians(lat)
    n = 2 ** zoom
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n
    return x, y

def fetch_tile(zoom, x, y):
    """Fetch a single OSM tile."""
    url = f"https://tile.openstreetmap.org/{zoom}/{x}/{y}.png"
    req = urllib.request.Request(url, headers={
        "User-Agent": "AutoAssignPaper/1.0 (academic research; bob@rail.com)"
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return Image.open(resp).convert("RGB")
    except Exception as e:
        print(f"  Failed to fetch tile {zoom}/{x}/{y}: {e}")
        # Return a gray tile as placeholder
        return Image.new("RGB", (TILE_SIZE, TILE_SIZE), (200, 200, 200))

def fetch_neighborhood_map(name, min_lat, max_lat, min_lon, max_lon, zoom):
    """Fetch and composite tiles for a neighborhood bounding box."""
    print(f"\n{name.upper()} (zoom {zoom}):")

    # Add some padding
    pad_lat = (max_lat - min_lat) * 0.1
    pad_lon = (max_lon - min_lon) * 0.1
    min_lat -= pad_lat
    max_lat += pad_lat
    min_lon -= pad_lon
    max_lon += pad_lon

    # Get tile ranges
    x_min_f, y_min_f = lat_lon_to_tile(max_lat, min_lon, zoom)  # NW corner
    x_max_f, y_max_f = lat_lon_to_tile(min_lat, max_lon, zoom)  # SE corner

    x_min = int(math.floor(x_min_f))
    x_max = int(math.floor(x_max_f))
    y_min = int(math.floor(y_min_f))
    y_max = int(math.floor(y_max_f))

    nx = x_max - x_min + 1
    ny = y_max - y_min + 1
    print(f"  Tiles: {nx}x{ny} = {nx*ny}")

    # Fetch and composite
    composite = Image.new("RGB", (nx * TILE_SIZE, ny * TILE_SIZE))
    for tx in range(x_min, x_max + 1):
        for ty in range(y_min, y_max + 1):
            tile = fetch_tile(zoom, tx, ty)
            px = (tx - x_min) * TILE_SIZE
            py = (ty - y_min) * TILE_SIZE
            composite.paste(tile, (px, py))

    # Crop to exact bounding box
    # Convert bbox corners to pixel coordinates within the composite
    px_left = (x_min_f - x_min) * TILE_SIZE
    px_right = (x_max_f - x_min) * TILE_SIZE
    py_top = (y_min_f - y_min) * TILE_SIZE
    py_bottom = (y_max_f - y_min) * TILE_SIZE

    cropped = composite.crop((int(px_left), int(py_top), int(px_right), int(py_bottom)))

    out_path = os.path.join(OUT_DIR, f"osm-{name}.png")
    cropped.save(out_path, "PNG")
    print(f"  Saved: {out_path} ({cropped.size[0]}x{cropped.size[1]})")
    return out_path

if __name__ == "__main__":
    for args in NEIGHBORHOODS:
        fetch_neighborhood_map(*args)
    print("\nDone.")
