// Modules the upstream translator does not know: offset, resize, projection, and our own bs_*
// ones. The patched translator (dist/openscad-openjscad-translator-x1.js) asks ExtraModules
// about any module name it does not recognize. A student's own procedure with the same name
// still wins, because the translator looks those up first.
//
// Each module turns into a call on ExtraModules.run in the generated JavaScript, which then runs
// in the render worker against csg.js shapes. Where Manifold is loaded (fast-booleans.js) the
// heavy ones use it. Without it, they use csg.js where csg.js has an equivalent, and otherwise
// stop with a message the student can read.

var ExtraModules = (function () {
  var adaptors = {};

  function literal(value, fallback) {
    if (value === undefined || value === null || (typeof value === 'number' && !isFinite(value))) value = fallback;
    return JSON.stringify(value);
  }

  function readArgs(ctx, inst, names) {
    var Context = ctx.constructor;
    var inner = Context.newContext(ctx, names, [], inst);
    var values = {};
    names.forEach(function (n) { values[n] = Context.contextVariableLookup(inner, n, undefined); });
    return { ctx: inner, values: values, segments: function (r) { return Context.get_fragments_from_r(Math.abs(r), inner); } };
  }

  // Everything inside the module's braces, unioned, as one JavaScript expression.
  function childCode(factory, ctx, inst) {
    var code = factory.getAdaptor({ name: 'union' }).evaluate(ctx, inst);
    if (code instanceof Array) code = code.length ? code[0] : undefined;
    return typeof code === 'string' && code.charAt(0) !== '.' ? code : undefined;
  }

  // define('name', ['arg', ...], {defaults}, build) where build(args) returns the extra call
  // arguments. With children: true the children's shape is the first argument.
  function define(name, argNames, defaults, opts, build) {
    adaptors[name] = function (factory) {
      return {
        evaluate: function (ctx, inst) {
          inst.argvalues = [];
          inst.argexpr.forEach(function (e) { inst.argvalues.push(e.evaluate(ctx)); });
          var a = readArgs(ctx, inst, argNames);
          var v = {};
          argNames.forEach(function (n) { v[n] = a.values[n] === undefined ? defaults[n] : a.values[n]; });
          var extra = build(v, a).map(function (x) { return literal(x, null); });
          if (!opts.children) return 'ExtraModules.run.' + opts.run + '(' + extra.join(', ') + ')';
          var child = childCode(factory, a.ctx, inst);
          if (child === undefined) return undefined;
          return 'ExtraModules.run.' + opts.run + '(' + [child].concat(extra).join(', ') + ')';
        }
      };
    };
  }

  define('bs_tag', ['n'], { n: -1 }, { children: true, run: 'tag' }, function (v) { return [v.n]; });

  // OpenSCAD's own offset(r=) and offset(delta=, chamfer=).
  define('offset', ['r', 'delta', 'chamfer'], { chamfer: false }, { children: true, run: 'offset' }, function (v, a) {
    var round = v.r !== undefined;
    var d = round ? v.r : (v.delta === undefined ? 1 : v.delta);
    return [d, round ? 'round' : (v.chamfer ? 'chamfer' : 'sharp'), a.segments(d)];
  });

  // OpenSCAD's resize(newsize, auto).
  define('resize', ['newsize', 'auto'], { newsize: [0, 0, 0], auto: false }, { children: true, run: 'resize' }, function (v) {
    var size = v.newsize instanceof Array ? v.newsize : [v.newsize, v.newsize, v.newsize];
    return [[size[0] || 0, size[1] || 0, size[2] || 0], !!v.auto];
  });

  define('projection', ['cut'], { cut: false }, { children: true, run: 'projection' }, function (v) { return [!!v.cut]; });

  define('bs_round_edges', ['r'], { r: 1 }, { children: true, run: 'roundEdges' }, function (v, a) {
    return [v.r, Math.max(8, a.segments(v.r))];
  });

  define('bs_shell', ['thickness', 'open_top'], { thickness: 1, open_top: false }, { children: true, run: 'shell' }, function (v, a) {
    return [v.thickness, !!v.open_top, Math.max(8, a.segments(v.thickness))];
  });

  define('bs_on_floor', [], {}, { children: true, run: 'onFloor' }, function () { return []; });

  define('bs_regular_polygon', ['sides', 'r'], { sides: 6, r: 10 }, { children: false, run: 'regularPolygon' }, function (v) {
    return [v.sides, v.r];
  });

  define('bs_star', ['points', 'r1', 'r2'], { points: 5, r1: 10, r2: 5 }, { children: false, run: 'star' }, function (v) {
    return [v.points, v.r1, v.r2];
  });

  // ---- runtime, called from the generated code ----

  function fail(message) {
    throw new Error(message);
  }

  function needManifold(what) {
    if (typeof FastBooleans === 'undefined' || !FastBooleans.active()) fail(what + ' needs a newer browser. Try the latest Chrome, Edge or Firefox.');
    return FastBooleans.wasm();
  }

  // Minkowski sums and differences drop Manifold's per-face properties, so every face of a
  // rounded or hollowed shape came back with the first part's color and block (a blue sphere
  // rounded beside a red cube turned red). The new surface stays within the radius of the old
  // one, so each face goes back to the part whose surface is nearest to it.
  function giveFacesToNearestPart(out, source) {
    var owners = [];
    source.polygons.forEach(function (p) { if (owners.indexOf(p.shared) < 0) owners.push(p.shared); });
    if (owners.length === 1) {
      out.polygons.forEach(function (p) { p.shared = owners[0]; });
      return out;
    }
    var tris = [];
    source.polygons.forEach(function (p) {
      for (var k = 1; k + 1 < p.vertices.length; k++) tris.push([p.vertices[0].pos, p.vertices[k].pos, p.vertices[k + 1].pos, p.shared]);
    });
    var b = source.getBounds();
    var cell = Math.max(b[1].minus(b[0]).length() / 40, 1e-3);
    var grid = {};
    function key(i, j, k) { return i + ',' + j + ',' + k; }
    tris.forEach(function (t, n) {
      var xs = [t[0].x, t[1].x, t[2].x], ys = [t[0].y, t[1].y, t[2].y], zs = [t[0].z, t[1].z, t[2].z];
      var lo = [xs, ys, zs].map(function (v) { return Math.floor(Math.min.apply(null, v) / cell); });
      var hi = [xs, ys, zs].map(function (v) { return Math.floor(Math.max.apply(null, v) / cell); });
      for (var i = lo[0]; i <= hi[0]; i++) for (var j = lo[1]; j <= hi[1]; j++) for (var k = lo[2]; k <= hi[2]; k++) {
        var c = key(i, j, k);
        (grid[c] || (grid[c] = [])).push(n);
      }
    });
    out.polygons.forEach(function (p) {
      var cx = 0, cy = 0, cz = 0;
      p.vertices.forEach(function (v) { cx += v.pos.x; cy += v.pos.y; cz += v.pos.z; });
      var pt = new CSG.Vector3D(cx / p.vertices.length, cy / p.vertices.length, cz / p.vertices.length);
      var ci = Math.floor(pt.x / cell), cj = Math.floor(pt.y / cell), ck = Math.floor(pt.z / cell);
      var best = Infinity, owner = null, seen = {};
      // Widen the search one ring at a time; one ring past the first hit can still hold a closer one.
      for (var ring = 0, stopAt = Infinity; ring <= stopAt && ring < 60; ring++) {
        for (var i = ci - ring; i <= ci + ring; i++) for (var j = cj - ring; j <= cj + ring; j++) for (var k = ck - ring; k <= ck + ring; k++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== ring) continue;
          var list = grid[key(i, j, k)];
          if (!list) continue;
          for (var n = 0; n < list.length; n++) {
            if (seen[list[n]]) continue;
            seen[list[n]] = 1;
            var t = tris[list[n]];
            var d = distanceToTriangle(pt, t[0], t[1], t[2]);
            if (d < best) { best = d; owner = t[3]; }
          }
        }
        if (owner && stopAt === Infinity) stopAt = ring + 1;
      }
      if (owner) p.shared = owner;
    });
    return out;
  }

  // Squared distance from p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5).
  function distanceToTriangle(p, a, b, c) {
    var ab = b.minus(a), ac = c.minus(a), ap = p.minus(a);
    var d1 = ab.dot(ap), d2 = ac.dot(ap);
    if (d1 <= 0 && d2 <= 0) return ap.lengthSquared();
    var bp = p.minus(b), d3 = ab.dot(bp), d4 = ac.dot(bp);
    if (d3 >= 0 && d4 <= d3) return bp.lengthSquared();
    var vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return p.minus(a.plus(ab.times(d1 / (d1 - d3)))).lengthSquared();
    var cp = p.minus(c), d5 = ab.dot(cp), d6 = ac.dot(cp);
    if (d6 >= 0 && d5 <= d6) return cp.lengthSquared();
    var vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return p.minus(a.plus(ac.times(d2 / (d2 - d6)))).lengthSquared();
    var va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return p.minus(b.plus(c.minus(b).times((d4 - d3) / ((d4 - d3) + (d5 - d6))))).lengthSquared();
    var denom = 1 / (va + vb + vc);
    return p.minus(a.plus(ab.times(vb * denom)).plus(ac.times(vc * denom))).lengthSquared();
  }

  function withManifold(shape, fn) {
    var wasm = FastBooleans.wasm();
    var palette = FastBooleans.newPalette();
    var made = [];
    try {
      var m = FastBooleans.toManifold(shape, palette);
      made.push(m);
      var out = fn(m, wasm, made);
      made.push(out);
      if (out.isEmpty && out.isEmpty()) return null;
      return giveFacesToNearestPart(FastBooleans.fromManifold(out, palette), shape);
    } finally {
      FastBooleans.deleteAll(made);
    }
  }

  // ---- shrinking and rounding solid pieces ----
  // Manifold's minkowski sum and difference split a shape into convex chunks first, which made
  // rounding a single sphere take 2.5 s. A convex piece has a direct answer: shrinking it moves
  // every face inward by r, and growing that back with a ball is the hull of a ball at each
  // corner. Pieces that are not convex (an L made of two cubes) keep the minkowski route,
  // because rounding their parts one by one would leave a groove where the parts meet.

  function meshPoints(m) {
    var g = m.getMesh(), np = g.numProp, v = g.vertProperties, out = [];
    for (var i = 0; i < v.length; i += np) out.push([v[i], v[i + 1], v[i + 2]]);
    return out;
  }

  // One [normal, offset] per distinct face plane.
  function facePlanes(m) {
    var g = m.getMesh(), np = g.numProp, v = g.vertProperties, t = g.triVerts, seen = {}, out = [];
    for (var i = 0; i < t.length; i += 3) {
      var a = t[i] * np, b = t[i + 1] * np, c = t[i + 2] * np;
      var ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
      var wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
      var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < 1e-12) continue;
      nx /= len; ny /= len; nz /= len;
      var d = nx * v[a] + ny * v[a + 1] + nz * v[a + 2];
      var key = Math.round(nx * 1e5) + ',' + Math.round(ny * 1e5) + ',' + Math.round(nz * 1e5) + ',' + Math.round(d * 1e4);
      if (seen[key]) continue;
      seen[key] = 1;
      out.push([nx, ny, nz, d]);
    }
    return out;
  }

  function isConvex(m, made) {
    var h = m.hull();
    made.push(h);
    var hv = h.volume();
    return Math.abs(hv - m.volume()) <= 1e-5 * Math.max(1, hv);
  }

  // The corners of a convex piece with every face moved inward by r, or null when nothing is
  // left. Done by duality around an inside point: each moved face becomes a point, and each
  // face of the hull of those points becomes a corner. One hull instead of hundreds of cuts.
  function shrinkConvex(m, r, wasm, made) {
    var pts = meshPoints(m), c = [0, 0, 0];
    pts.forEach(function (p) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; });
    c = c.map(function (x) { return x / pts.length; });
    var dual = [];
    var planes = facePlanes(m);
    for (var i = 0; i < planes.length; i++) {
      var q = planes[i];
      var dist = q[3] - r - (q[0] * c[0] + q[1] * c[1] + q[2] * c[2]);
      if (dist <= 1e-9) return null;
      dual.push([q[0] / dist, q[1] / dist, q[2] / dist]);
    }
    var h = wasm.Manifold.hull(dual);
    made.push(h);
    var corners = [];
    var hp = facePlanes(h);
    for (var j = 0; j < hp.length; j++) {
      if (hp[j][3] <= 1e-12) return null;
      corners.push([c[0] + hp[j][0] / hp[j][3], c[1] + hp[j][1] / hp[j][3], c[2] + hp[j][2] / hp[j][3]]);
    }
    return corners;
  }

  function shrinkPiece(piece, r, segments, wasm, made) {
    if (isConvex(piece, made)) {
      var corners = shrinkConvex(piece, r, wasm, made);
      if (!corners) return null;
      var hull = wasm.Manifold.hull(corners);
      made.push(hull);
      return hull.isEmpty() ? null : hull;
    }
    var ball = wasm.Manifold.sphere(r, segments);
    made.push(ball);
    var shrunk = piece.minkowskiDifference(ball);
    made.push(shrunk);
    return shrunk.isEmpty() ? null : shrunk;
  }

  function roundPiece(piece, r, segments, wasm, made) {
    var ball = wasm.Manifold.sphere(r, segments);
    made.push(ball);
    if (isConvex(piece, made)) {
      var corners = shrinkConvex(piece, r, wasm, made);
      if (!corners) return null;
      var bp = meshPoints(ball), sums = [];
      corners.forEach(function (p) {
        bp.forEach(function (b) { sums.push([p[0] + b[0], p[1] + b[1], p[2] + b[2]]); });
      });
      var out = wasm.Manifold.hull(sums);
      made.push(out);
      return out;
    }
    var shrunk = piece.minkowskiDifference(ball);
    made.push(shrunk);
    if (shrunk.isEmpty()) return null;
    var grown = shrunk.minkowskiSum(ball);
    made.push(grown);
    return grown;
  }

  function tagShared(shared, n) {
    var copy = new CSG.Polygon.Shared(shared.color);
    copy.blockTag = n;
    return copy;
  }

  function isEmpty3d(shape) {
    return !(shape instanceof CSG) || shape.polygons.length === 0;
  }

  var run = {
    // Marks every face that has no block yet with block n. Inner blocks tag first, so a face
    // keeps the innermost block that made it, and a hull or extrude claims the faces it built.
    tag: function (shape, n) {
      if (!(shape instanceof CSG) || n < 0) return shape;
      var made = {};
      var polygons = shape.polygons.map(function (p) {
        var shared = p.shared || CSG.Polygon.defaultShared;
        if (shared.blockTag !== undefined) return p;
        var key = shared.getTag();
        var tagged = made[key] || (made[key] = tagShared(shared, n));
        return new CSG.Polygon(p.vertices, tagged, p.plane);
      });
      var out = CSG.fromPolygons(polygons);
      out.properties = shape.properties;
      out.isCanonicalized = shape.isCanonicalized;
      out.isRetesselated = shape.isRetesselated;
      return out;
    },

    offset: function (shape, d, mode, segments) {
      if (!(shape instanceof CAG)) fail('Offset works on 2D shapes. Put it around a circle, square or other 2D shape.');
      if (!d) return shape;
      if (typeof FastBooleans !== 'undefined' && FastBooleans.active()) {
        var wasm = FastBooleans.wasm();
        var made = [];
        try {
          var cs = FastBooleans.toCrossSection(shape);
          made.push(cs);
          var join = mode === 'round' ? 'Round' : (mode === 'chamfer' ? 'Square' : 'Miter');
          var out = cs.offset(d, join, 2, Math.max(segments, 8));
          made.push(out);
          if (out.isEmpty()) fail('Offset made the shape disappear. Try a smaller number.');
          return FastBooleans.fromCrossSection(out);
        } finally {
          FastBooleans.deleteAll(made);
        }
      }
      return d > 0 ? shape.expand(d, segments) : shape.contract(-d, segments);
    },

    resize: function (shape, size, auto) {
      var b = shape.getBounds();
      var is3d = shape instanceof CSG;
      var have = [b[1].x - b[0].x, b[1].y - b[0].y, is3d ? b[1].z - b[0].z : 0];
      var factor = [1, 1, 1];
      var firstRatio = null;
      for (var i = 0; i < 3; i++) {
        if (size[i] > 0 && have[i] > 1e-9) {
          factor[i] = size[i] / have[i];
          if (firstRatio === null) firstRatio = factor[i];
        }
      }
      if (auto && firstRatio !== null) {
        for (var j = 0; j < 3; j++) if (!(size[j] > 0)) factor[j] = firstRatio;
      }
      return is3d ? shape.scale(factor) : shape.scale([factor[0], factor[1]]);
    },

    projection: function (shape, cut) {
      if (!(shape instanceof CSG)) fail('Projection needs a 3D shape inside it.');
      var wasm = needManifold('Projection');
      var made = [];
      try {
        var m = FastBooleans.toManifold(shape, FastBooleans.newPalette());
        made.push(m);
        var cs = cut ? m.slice(0) : m.project();
        made.push(cs);
        if (cs.isEmpty()) fail(cut ? 'Nothing crosses the floor (z = 0) to cut.' : 'Projection found nothing to flatten.');
        return FastBooleans.fromCrossSection(cs);
      } finally {
        FastBooleans.deleteAll(made);
      }
    },

    // Rounds the outside edges and keeps the overall size: shrink by r, then grow back by r
    // with a ball. Inside corners stay sharp, the same as the minkowski trick in OpenSCAD.
    roundEdges: function (shape, r, segments) {
      if (!(shape instanceof CSG)) fail('Round edges works on 3D shapes.');
      if (!(r > 0)) return shape;
      if (typeof FastBooleans === 'undefined' || !FastBooleans.active()) return shape.contract(r, segments).expand(r, segments);
      var out = withManifold(shape, function (m, wasm, made) {
        var pieces = m.decompose();
        pieces.forEach(function (p) { made.push(p); });
        var rounded = pieces.map(function (piece) {
          var result = roundPiece(piece, r, segments, wasm, made);
          if (!result) fail('That radius is too big for this shape. Try a smaller one.');
          return result;
        });
        return rounded.length === 1 ? rounded[0] : wasm.Manifold.union(rounded);
      });
      return out || fail('Round edges made the shape disappear. Try a smaller radius.');
    },

    // Hollows a solid, leaving walls this thick. With openTop the cavity also breaks through
    // the top, which turns a cylinder into a cup.
    shell: function (shape, t, openTop, segments) {
      if (!(shape instanceof CSG)) fail('Hollow works on 3D shapes.');
      if (!(t > 0)) return shape;
      if (typeof FastBooleans === 'undefined' || !FastBooleans.active()) {
        var innerSlow = shape.contract(t, segments);
        if (openTop) innerSlow = innerSlow.union(innerSlow.tr([0, 0, t * 1.5]));
        return shape.subtract(innerSlow);
      }
      return withManifold(shape, function (m, wasm, made) {
        var pieces = m.decompose();
        pieces.forEach(function (p) { made.push(p); });
        var cavities = pieces.map(function (piece) {
          var inner = shrinkPiece(piece, t, segments, wasm, made);
          if (!inner) fail('The walls are thicker than the shape. Try a thinner wall.');
          return inner;
        });
        var inner = cavities.length === 1 ? cavities[0] : wasm.Manifold.union(cavities);
        made.push(inner);
        if (openTop) {
          var raised = inner.translate([0, 0, t * 1.5]);
          made.push(raised);
          inner = wasm.Manifold.union(inner, raised);
          made.push(inner);
        }
        return m.subtract(inner);
      }) || fail('Hollow made the shape disappear.');
    },

    onFloor: function (shape) {
      var b = shape.getBounds();
      if (shape instanceof CSG) return shape.tr([-(b[0].x + b[1].x) / 2, -(b[0].y + b[1].y) / 2, -b[0].z]);
      return shape.tr([-(b[0].x + b[1].x) / 2, -b[0].y, 0]);
    },

    regularPolygon: function (sides, r) {
      sides = Math.round(sides);
      if (sides < 3) fail('A polygon needs at least 3 sides.');
      if (!(r > 0)) fail('The polygon needs a size bigger than 0.');
      var pts = [];
      for (var i = 0; i < sides; i++) {
        var a = Math.PI / 2 + 2 * Math.PI * i / sides;
        pts.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      return CAG.fromPoints(pts);
    },

    star: function (points, r1, r2) {
      points = Math.round(points);
      if (points < 2) fail('A star needs at least 2 points.');
      if (!(r1 > 0) || !(r2 > 0)) fail('Both star sizes need to be bigger than 0.');
      var pts = [];
      for (var i = 0; i < points * 2; i++) {
        var a = Math.PI / 2 + Math.PI * i / points;
        var r = i % 2 ? r2 : r1;
        pts.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      return CAG.fromPoints(pts);
    }
  };

  // Block tags have to survive the csg.js paths too. canonicalized() merges "shared" objects by
  // getHash(), and color() replaces every face's shared object, so both learn about the tag.
  (function keepTags() {
    var Shared = CSG.Polygon.Shared;
    var hash = Shared.prototype.getHash;
    Shared.prototype.getHash = function () {
      var h = hash.call(this);
      return this.blockTag === undefined ? h : h + '#' + this.blockTag;
    };
    var setShared = CSG.prototype.setShared;
    CSG.prototype.setShared = function (shared) {
      var tagged = this.polygons.some(function (p) { return p.shared && p.shared.blockTag !== undefined; });
      if (!tagged) return setShared.call(this, shared);
      var byTag = {};
      var polygons = this.polygons.map(function (p) {
        var n = p.shared && p.shared.blockTag;
        if (n === undefined) return new CSG.Polygon(p.vertices, shared, p.plane);
        var s = byTag[n] || (byTag[n] = tagShared(shared, n));
        return new CSG.Polygon(p.vertices, s, p.plane);
      });
      var out = CSG.fromPolygons(polygons);
      out.properties = this.properties;
      out.isRetesselated = this.isRetesselated;
      out.isCanonicalized = this.isCanonicalized;
      return out;
    };
  })();

  return {
    has: function (name) { return adaptors.hasOwnProperty(name); },
    adaptor: function (name, factory) { return adaptors[name](factory); },
    run: run,
    isEmpty3d: isEmpty3d
  };
})();
