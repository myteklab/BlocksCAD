// Routes CSG and CAG union, subtract and intersect through Manifold (WebAssembly) when it has
// loaded. The csg.js BSP trees get slow fast: 40 overlapping spheres took 15 s, Manifold does the
// same work in under a second. Any shape Manifold refuses (not watertight, or an error inside the
// wasm) falls back to the original csg.js code, so a model never fails to render because of this
// file, it only renders slower.
//
// Runs inside the render worker. Faces keep their "shared" object (color, and the block tag that
// click-to-highlight reads) through the round trip: every vertex carries a palette index as a
// fourth property, and Manifold keeps properties through its cuts.

var FastBooleans = (function () {
  var wasm = null;
  var original = {};
  var stats = { fast: 0, fallback: 0, lastError: '' };

  function newPalette() {
    return { keys: {}, list: [] };
  }

  // csg.js leaves T-junctions: a corner of one face sitting partway along another face's edge.
  // Manifold refuses those, so on a refusal each edge gets the corners that lie on it.
  function splitEdges(outlines) {
    var EPS = 1e-5;
    var points = [];
    var seen = {};
    outlines.forEach(function (outline) {
      outline.forEach(function (p) {
        var k = p._x + ' ' + p._y + ' ' + p._z;
        if (!seen[k]) { seen[k] = 1; points.push(p); }
      });
    });
    points.sort(function (a, b) { return a._x - b._x; });
    var xs = points.map(function (p) { return p._x; });
    function firstAtLeast(x) {
      var lo = 0, hi = xs.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid + 1; else hi = mid; }
      return lo;
    }
    return outlines.map(function (outline) {
      var out = [];
      for (var i = 0; i < outline.length; i++) {
        var a = outline[i], b = outline[(i + 1) % outline.length];
        out.push(a);
        var dx = b._x - a._x, dy = b._y - a._y, dz = b._z - a._z;
        var len2 = dx * dx + dy * dy + dz * dz;
        if (len2 < EPS * EPS) continue;
        var found = [];
        for (var j = firstAtLeast(Math.min(a._x, b._x) - EPS); j < points.length && xs[j] <= Math.max(a._x, b._x) + EPS; j++) {
          var p = points[j];
          var px = p._x - a._x, py = p._y - a._y, pz = p._z - a._z;
          var t = (px * dx + py * dy + pz * dz) / len2;
          if (t <= 1e-9 || t >= 1 - 1e-9) continue;
          var cx = py * dz - pz * dy, cy = pz * dx - px * dz, cz = px * dy - py * dx;
          if (cx * cx + cy * cy + cz * cz > EPS * EPS * len2) continue;
          found.push({ t: t, p: p });
        }
        found.sort(function (u, v) { return u.t - v.t; });
        found.forEach(function (f) { out.push(f.p); });
      }
      return out;
    });
  }

  function toManifold(csg, palette, repair) {
    var props = [];
    var tris = [];
    var index = {};
    var count = 0;
    var polys = csg.polygons;
    var outlines = polys.map(function (poly) { return poly.vertices.map(function (v) { return v.pos; }); });
    if (repair) outlines = splitEdges(outlines);
    function vertexId(x, y, z, ci) {
      // Same point with a different palette entry stays a separate vertex; mesh.merge()
      // below tells Manifold those are one position.
      var key = x + ' ' + y + ' ' + z + ' ' + ci;
      var id = index[key];
      if (id === undefined) {
        id = count++;
        index[key] = id;
        props.push(x, y, z, ci);
      }
      return id;
    }
    for (var p = 0; p < polys.length; p++) {
      var shared = polys[p].shared || CSG.Polygon.defaultShared;
      var sharedKey = shared.getTag();
      var ci = palette.keys[sharedKey];
      if (ci === undefined) {
        ci = palette.list.length;
        palette.keys[sharedKey] = ci;
        palette.list.push(shared);
      }
      var outline = outlines[p];
      var ids = outline.map(function (pos) { return vertexId(pos._x, pos._y, pos._z, ci); });
      if (outline.length > polys[p].vertices.length) {
        // Points added along an edge are in line with their neighbors, so a fan from a corner
        // would make flat slivers. A fan from the middle of a convex face never does.
        var sx = 0, sy = 0, sz = 0;
        outline.forEach(function (pos) { sx += pos._x; sy += pos._y; sz += pos._z; });
        var c = vertexId(sx / outline.length, sy / outline.length, sz / outline.length, ci);
        for (var k = 0; k < ids.length; k++) {
          var n = ids[(k + 1) % ids.length];
          if (ids[k] !== n) tris.push(c, ids[k], n);
        }
        continue;
      }
      for (var t = 1; t + 1 < ids.length; t++) {
        if (ids[0] !== ids[t] && ids[t] !== ids[t + 1] && ids[0] !== ids[t + 1]) tris.push(ids[0], ids[t], ids[t + 1]);
      }
    }
    if (!tris.length) throw new Error('empty shape');
    var mesh = new wasm.Mesh({ numProp: 4, vertProperties: new Float32Array(props), triVerts: new Uint32Array(tris) });
    mesh.merge();
    try {
      return new wasm.Manifold(mesh);
    } catch (e) {
      if (repair || !/manifold/i.test(String(e && e.message || e))) throw e;
      return toManifold(csg, palette, true);
    }
  }

  function fromManifold(m, palette) {
    var mesh = m.getMesh();
    var np = mesh.numProp;
    var vp = mesh.vertProperties;
    var tv = mesh.triVerts;
    var verts = [];
    for (var i = 0; i < vp.length; i += np) verts.push(new CSG.Vertex(new CSG.Vector3D(vp[i], vp[i + 1], vp[i + 2])));
    var polygons = [];
    for (var t = 0; t < tv.length; t += 3) {
      var a = tv[t], b = tv[t + 1], c = tv[t + 2];
      // A face with no palette entry is one Manifold made itself (a minkowski sum, say).
      var shared = (np > 3 && palette && palette.list[Math.round(vp[a * np + 3])]) || CSG.Polygon.defaultShared;
      polygons.push(new CSG.Polygon([verts[a], verts[b], verts[c]], shared));
    }
    var out = CSG.fromPolygons(polygons);
    out.isCanonicalized = true;
    out.isRetesselated = true;
    return out;
  }

  // A CAG is a set of closed outlines that never cross, so even-odd filling reads it correctly
  // whichever way each outline happens to wind.
  function toCrossSection(cag) {
    var paths = cag.getOutlinePaths().map(function (path) {
      return path.points.map(function (pt) { return [pt._x, pt._y]; });
    }).filter(function (pts) { return pts.length >= 3; });
    if (!paths.length) throw new Error('empty shape');
    return new wasm.CrossSection(paths, 'EvenOdd');
  }

  function fromCrossSection(cs) {
    var sides = [];
    cs.toPolygons().forEach(function (contour) {
      if (contour.length < 3) return;
      var prev = new CAG.Vertex(new CSG.Vector2D(contour[contour.length - 1][0], contour[contour.length - 1][1]));
      for (var i = 0; i < contour.length; i++) {
        var cur = new CAG.Vertex(new CSG.Vector2D(contour[i][0], contour[i][1]));
        sides.push(new CAG.Side(prev, cur));
        prev = cur;
      }
    });
    return CAG.fromSides(sides).canonicalized();
  }

  function deleteAll(list) {
    for (var i = 0; i < list.length; i++) {
      try { list[i].delete(); } catch (e) {}
    }
  }

  function combine(op, first, rest, Kind) {
    if (op === 'union') return Kind.union([first].concat(rest));
    if (op === 'subtract') return Kind.difference([first].concat(rest));
    return Kind.intersection([first].concat(rest));
  }

  function run3d(op, first, others) {
    var palette = newPalette();
    var made = [];
    try {
      var a = toManifold(first, palette);
      made.push(a);
      var rest = others.map(function (o) { var m = toManifold(o, palette); made.push(m); return m; });
      var result = combine(op, a, rest, wasm.Manifold);
      made.push(result);
      var out = fromManifold(result, palette);
      stats.fast++;
      return out;
    } catch (e) {
      stats.fallback++;
      stats.lastError = String(e && e.message || e);
      return null;
    } finally {
      deleteAll(made);
    }
  }

  function run2d(op, first, others) {
    var made = [];
    try {
      var a = toCrossSection(first);
      made.push(a);
      var rest = others.map(function (o) { var c = toCrossSection(o); made.push(c); return c; });
      var result = combine(op, a, rest, wasm.CrossSection);
      made.push(result);
      var out = fromCrossSection(result);
      stats.fast++;
      return out;
    } catch (e) {
      stats.fallback++;
      stats.lastError = String(e && e.message || e);
      return null;
    } finally {
      deleteAll(made);
    }
  }

  function wrap(Kind, op, runner) {
    var key = (Kind === CSG ? 'CSG.' : 'CAG.') + op;
    original[key] = Kind.prototype[op];
    Kind.prototype[op] = function (others) {
      // CAG's own union calls CSG union with extra flags on a "wall" stand-in for the 2D shape,
      // and expects csg.js polygons back, so any call with flags stays on csg.js.
      if (wasm && arguments.length === 1) {
        var list = others instanceof Array ? others : [others];
        if (list.length && list.every(function (o) { return o instanceof Kind; })) {
          var out = runner(op, this, list);
          if (out) {
            if (Kind === CSG) out.properties = this.properties;
            return out;
          }
        }
      }
      return original[key].apply(this, arguments);
    };
  }

  return {
    install: function (manifoldModule) {
      if (wasm || !manifoldModule) return;
      wasm = manifoldModule;
      ['union', 'subtract', 'intersect'].forEach(function (op) {
        wrap(CSG, op, run3d);
        wrap(CAG, op, run2d);
      });
    },
    active: function () { return !!wasm; },
    wasm: function () { return wasm; },
    newPalette: newPalette,
    toManifold: toManifold,
    fromManifold: fromManifold,
    toCrossSection: toCrossSection,
    fromCrossSection: fromCrossSection,
    deleteAll: deleteAll,
    stats: stats
  };
})();
