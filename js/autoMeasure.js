// autoMeasure.js
//
// dependencies:
//  three.js
//  calculate.js
//
// description:
//  automatic dressmaker's measurements of a body scan: finds landmarks and
//  levels on the torso, then measures girths and lengths between them, as a
//  tape measure would (bridging hollows, e.g. between the breasts)
//
//  assumes the scan is upright with +z up, the front of the body facing -y,
//  and the body's left side toward +x; units are mm
//
// classes:
//  AutoMeasure.SliceMesh
//  constructor arguments:
//   - mesh: THREE.Mesh to measure
//
// example:
//  var sliceMesh = new AutoMeasure.SliceMesh(mesh);
//  var landmarks = AutoMeasure.findLandmarks(sliceMesh);
//
//  /* optionally adjust landmark positions here */
//
//  var results = AutoMeasure.measure(sliceMesh, landmarks);
//
//  results is an array of objects like
//   { key, name, group, value, segments }
//  where value is in mm (null if the measurement failed) and segments is an
//  array of THREE.Line3 showing the tape
//
//  AutoMeasure.Modes.basic has its own findLandmarks and measure for just the
//  bust, under bust, waist, abdomen, and hip girths; Modes.full uses the
//  functions above



var AutoMeasure = (function() {

  var Vector3 = THREE.Vector3;
  var Plane = THREE.Plane;
  var Line3 = THREE.Line3;

  var X = new Vector3(1, 0, 0);
  var Y = new Vector3(0, 1, 0);
  var Z = new Vector3(0, 0, 1);

  // distance of a hint point from the body, used to pick which way around a
  // cross-section a tape goes
  var HINT_DISTANCE = 2000;

  // spacing of the horizontal sections used to profile the body
  var PROFILE_STEP = 5;



  // SliceMesh: a triangle soup prepared for fast plane sections

  function SliceMesh(mesh) {
    var positions = [];

    mesh.updateMatrixWorld();

    Calculate.traverseFaces(mesh, function(va, vb, vc) {
      positions.push(va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z);
    });

    var count = positions.length / 9;
    var p = new Float64Array(positions);
    var normals = new Float64Array(count * 3);
    var zmin = new Float64Array(count);
    var zmax = new Float64Array(count);

    this.min = new Vector3(Infinity, Infinity, Infinity);
    this.max = new Vector3(-Infinity, -Infinity, -Infinity);

    for (var f = 0; f < count; f++) {
      var o = f * 9;

      // face normal from the winding order
      var abx = p[o + 3] - p[o], aby = p[o + 4] - p[o + 1], abz = p[o + 5] - p[o + 2];
      var acx = p[o + 6] - p[o], acy = p[o + 7] - p[o + 1], acz = p[o + 8] - p[o + 2];

      normals[f * 3] = aby * acz - abz * acy;
      normals[f * 3 + 1] = abz * acx - abx * acz;
      normals[f * 3 + 2] = abx * acy - aby * acx;

      zmin[f] = Math.min(p[o + 2], p[o + 5], p[o + 8]);
      zmax[f] = Math.max(p[o + 2], p[o + 5], p[o + 8]);

      for (var v = 0; v < 9; v += 3) {
        this.min.x = Math.min(this.min.x, p[o + v]);
        this.min.y = Math.min(this.min.y, p[o + v + 1]);
        this.min.z = Math.min(this.min.z, p[o + v + 2]);
        this.max.x = Math.max(this.max.x, p[o + v]);
        this.max.y = Math.max(this.max.y, p[o + v + 1]);
        this.max.z = Math.max(this.max.z, p[o + v + 2]);
      }
    }

    this.count = count;
    this.positions = p;
    this.normals = normals;

    // bucket faces by height so that horizontal sections only test the faces
    // that can cross them; stored as offsets into a flat array of face indices
    var bucketSize = 2;
    var bucketCount = Math.floor((this.max.z - this.min.z) / bucketSize) + 1;
    var offsets = new Int32Array(bucketCount + 1);

    for (var f = 0; f < count; f++) {
      var b0 = Math.floor((zmin[f] - this.min.z) / bucketSize);
      var b1 = Math.floor((zmax[f] - this.min.z) / bucketSize);

      for (var b = b0; b <= b1; b++) offsets[b + 1]++;
    }

    for (var b = 0; b < bucketCount; b++) offsets[b + 1] += offsets[b];

    var fill = offsets.slice(0, bucketCount);
    var items = new Int32Array(offsets[bucketCount]);

    for (var f = 0; f < count; f++) {
      var b0 = Math.floor((zmin[f] - this.min.z) / bucketSize);
      var b1 = Math.floor((zmax[f] - this.min.z) / bucketSize);

      for (var b = b0; b <= b1; b++) items[fill[b]++] = f;
    }

    this.bucketSize = bucketSize;
    this.bucketCount = bucketCount;
    this.bucketOffsets = offsets;
    this.bucketItems = items;
  }

  Object.assign(SliceMesh.prototype, {

    // intersect the mesh with a plane; returns an array of THREE.Line3,
    // oriented like Calculate.crossSection's segments (wound CCW about the
    // plane normal around the outside of the mesh)
    segments: function(plane) {
      var n = plane.normal;
      var segments = [];

      // horizontal plane: only test faces in the relevant bucket
      if (Math.abs(n.x) < 1e-12 && Math.abs(n.y) < 1e-12) {
        var z = -plane.constant / n.z;
        var b = Math.floor((z - this.min.z) / this.bucketSize);

        if (b < 0 || b >= this.bucketCount) return segments;

        var offsets = this.bucketOffsets;
        var items = this.bucketItems;

        for (var i = offsets[b], l = offsets[b + 1]; i < l; i++) {
          this.intersectFace(items[i], n, plane.constant, segments);
        }
      }
      else {
        for (var f = 0, l = this.count; f < l; f++) {
          this.intersectFace(f, n, plane.constant, segments);
        }
      }

      return segments;
    },

    // find a flat plate on one side of the body (e.g. an armhole plate on a
    // dress form) between heights z0 and z1; sign is 1 for the left (+x)
    // side, -1 for the right; returns { top, bottom } or null if no plate
    flatSide: function(sign, z0, z1) {
      var p = this.positions;
      var normals = this.normals;
      var faces = [];

      for (var f = 0; f < this.count; f++) {
        var o = f * 9;
        var cz = (p[o + 2] + p[o + 5] + p[o + 8]) / 3;

        if (cz < z0 || cz > z1) continue;

        var nx = normals[f * 3], ny = normals[f * 3 + 1], nz = normals[f * 3 + 2];
        var len = Math.sqrt(nx * nx + ny * ny + nz * nz);

        if (len === 0 || nx * sign / len < 0.8) continue;

        faces.push({
          f: f,
          area: len / 2,
          normal: new Vector3(nx / len, ny / len, nz / len),
          center: new Vector3(
            (p[o] + p[o + 3] + p[o + 6]) / 3,
            (p[o + 1] + p[o + 4] + p[o + 7]) / 3,
            cz
          )
        });
      }

      // fit a plane to the faces, then keep only the faces lying in it,
      // tightening the tolerance each time
      var plateNormal = new Vector3(sign, 0, 0);
      var offset = null;
      var tolerances = [0.8, 0.98, 0.995];

      for (var t = 0; t < tolerances.length; t++) {
        faces = faces.filter(function(face) {
          return face.normal.dot(plateNormal) > tolerances[t] &&
            (offset === null || Math.abs(face.center.dot(plateNormal) - offset) < 3);
        });

        if (faces.length === 0) return null;

        var sumNormal = new Vector3();
        var sumOffset = 0;
        var sumArea = 0;

        // the plate is the outermost flat part of the side, so weight toward
        // the faces furthest out
        var outermost = Math.max.apply(null, faces.map(function(face) { return face.center.x * sign; }));

        faces = faces.filter(function(face) { return face.center.x * sign > outermost - 30; });

        faces.forEach(function(face) {
          sumNormal.addScaledVector(face.normal, face.area);
          sumArea += face.area;
        });

        plateNormal = sumNormal.normalize();

        faces.forEach(function(face) {
          sumOffset += face.center.dot(plateNormal) * face.area;
        });

        offset = sumOffset / sumArea;
      }

      // too small to be an armhole plate
      if (sumArea < 2000) return null;

      var top = null;
      var bottom = null;

      faces.forEach(function(face) {
        var o = face.f * 9;

        for (var v = 0; v < 9; v += 3) {
          var vertex = new Vector3(p[o + v], p[o + v + 1], p[o + v + 2]);

          if (top === null || vertex.z > top.z) top = vertex;
          if (bottom === null || vertex.z < bottom.z) bottom = vertex;
        }
      });

      return { top: top, bottom: bottom };
    },

    intersectFace: function(f, n, constant, segments) {
      var p = this.positions;
      var o = f * 9;

      var d0 = n.x * p[o] + n.y * p[o + 1] + n.z * p[o + 2] + constant;
      var d1 = n.x * p[o + 3] + n.y * p[o + 4] + n.z * p[o + 5] + constant;
      var d2 = n.x * p[o + 6] + n.y * p[o + 7] + n.z * p[o + 8] + constant;

      // treat points on the plane as above it so that every crossing is
      // counted exactly once
      var s0 = d0 >= 0, s1 = d1 >= 0, s2 = d2 >= 0;

      if (s0 === s1 && s1 === s2) return;

      var points = [];

      if (s0 !== s1) points.push(edgePoint(p, o, o + 3, d0, d1));
      if (s1 !== s2) points.push(edgePoint(p, o + 3, o + 6, d1, d2));
      if (s2 !== s0) points.push(edgePoint(p, o + 6, o, d2, d0));

      var a = points[0];
      var b = points[1];

      if (a.equals(b)) return;

      // orient the segment so that the face normal points to its right, as
      // seen from the plane normal
      var fx = this.normals[f * 3], fy = this.normals[f * 3 + 1], fz = this.normals[f * 3 + 2];
      var dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      var cx = dy * n.z - dz * n.y;
      var cy = dz * n.x - dx * n.z;
      var cz = dx * n.y - dy * n.x;

      if (fx * cx + fy * cy + fz * cz < 0) segments.push(new Line3(b, a));
      else segments.push(new Line3(a, b));
    }

  });

  // point where the edge between two vertices crosses the plane, computed
  // from the vertices in a fixed order so that the two faces sharing the edge
  // produce exactly the same point
  function edgePoint(p, i, j, di, dj) {
    if (p[i] > p[j] || (p[i] === p[j] && (p[i + 1] > p[j + 1] ||
        (p[i + 1] === p[j + 1] && p[i + 2] > p[j + 2])))) {
      var ti = i; i = j; j = ti;
      var td = di; di = dj; dj = td;
    }

    var t = di / (di - dj);

    return new Vector3(
      p[i] + (p[j] - p[i]) * t,
      p[i + 1] + (p[j + 1] - p[i + 1]) * t,
      p[i + 2] + (p[j + 2] - p[i + 2]) * t
    );
  }



  // sections and loops

  // closed loops of the section of the mesh by a plane, largest first; each
  // is { chain, points, area, centroid, min, max }
  function sectionLoops(sliceMesh, plane) {
    var chains = Calculate.chainsFromSegments(sliceMesh.segments(plane));
    var basis = planeBasis(plane.normal);
    var loops = [];

    for (var c = 0; c < chains.length; c++) {
      var chain = chains[c];

      if (!chain.closed || chain.points.length < 3) continue;

      var loop = loopInfo(chain, basis);

      // holes (wound the other way) are not part of the outside surface
      if (loop.area > 0) loops.push(loop);
    }

    loops.sort(function(a, b) { return b.area - a.area; });

    return loops;
  }

  // two unit vectors spanning the plane with the given normal, such that
  // u x v = normal
  function planeBasis(normal) {
    var u = Math.abs(normal.z) < 0.9 ? new Vector3().crossVectors(Z, normal) : new Vector3().crossVectors(normal, X);
    u.normalize();

    var v = new Vector3().crossVectors(normal, u).normalize();

    return { u: u, v: v, normal: normal };
  }

  function loopInfo(chain, basis) {
    var points = chain.points;
    var n = points.length;
    var area = 0;
    var cu = 0, cv = 0;
    var min = new Vector3(Infinity, Infinity, Infinity);
    var max = new Vector3(-Infinity, -Infinity, -Infinity);

    for (var i = 0; i < n; i++) {
      var a = points[i];
      var b = points[(i + 1) % n];
      var au = a.dot(basis.u), av = a.dot(basis.v);
      var bu = b.dot(basis.u), bv = b.dot(basis.v);
      var cross = au * bv - bu * av;

      area += cross;
      cu += (au + bu) * cross;
      cv += (av + bv) * cross;

      min.min(a);
      max.max(a);
    }

    area /= 2;

    var centroid = new Vector3();

    if (area !== 0) {
      cu /= 6 * area;
      cv /= 6 * area;

      // the offset of the plane along its normal is the same for all points
      var w = points[0].dot(basis.normal);

      centroid.copy(basis.u).multiplyScalar(cu)
        .addScaledVector(basis.v, cv)
        .addScaledVector(basis.normal, w);
    }

    return {
      chain: chain,
      points: points,
      area: area,
      centroid: centroid,
      min: min,
      max: max,
      basis: basis
    };
  }

  // convex hull of a loop in its plane, as an array of 3D points in CCW order
  function loopHull(loop) {
    var basis = loop.basis;
    var pts = loop.points.map(function(p) {
      return { u: p.dot(basis.u), v: p.dot(basis.v), p: p };
    });

    pts.sort(function(a, b) { return a.u - b.u || a.v - b.v; });

    function cross(o, a, b) {
      return (a.u - o.u) * (b.v - o.v) - (a.v - o.v) * (b.u - o.u);
    }

    // Andrew's monotone chain
    var lower = [];
    for (var i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }

    var upper = [];
    for (var i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }

    lower.pop();
    upper.pop();

    return lower.concat(upper).map(function(h) { return h.p; });
  }

  function closedLength(points) {
    var length = 0;

    for (var i = 0, n = points.length; i < n; i++) {
      length += points[i].distanceTo(points[(i + 1) % n]);
    }

    return length;
  }

  function closedSegments(points) {
    var segments = [];

    for (var i = 0, n = points.length; i < n; i++) {
      segments.push(new Line3(points[i], points[(i + 1) % n]));
    }

    return segments;
  }

  function horizontalPlane(z) {
    return new Plane(Z.clone(), -z);
  }

  // the largest loop in the horizontal section at height z
  function torsoLoop(sliceMesh, z) {
    var loops = sectionLoops(sliceMesh, horizontalPlane(z));

    return loops.length > 0 ? loops[0] : null;
  }

  // the closest point on a closed loop to the given point, or null
  function nearestOnLoop(loop, point) {
    if (!loop) return null;

    var points = loop.points;
    var n = points.length;
    var best = null;
    var bestDist = Infinity;

    for (var i = 0; i < n; i++) {
      var p = new Line3(points[i], points[(i + 1) % n]).closestPointToPoint(point, true, new Vector3());
      var d = p.distanceToSquared(point);

      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }

    return best;
  }

  // points where a closed loop crosses the line through the given point in
  // the given direction (both in the plane of the loop), sorted along the
  // direction
  function loopCrossings(loop, point, direction) {
    var normal = loop.basis.normal;
    // the line is the intersection of the loop's plane and the plane through
    // point with this normal
    var lineNormal = new Vector3().crossVectors(direction, normal).normalize();
    var offset = lineNormal.dot(point);
    var points = loop.points;
    var n = points.length;
    var crossings = [];

    for (var i = 0; i < n; i++) {
      var a = points[i];
      var b = points[(i + 1) % n];
      var da = lineNormal.dot(a) - offset;
      var db = lineNormal.dot(b) - offset;

      if ((da >= 0) === (db >= 0)) continue;

      crossings.push(a.clone().lerp(b, da / (da - db)));
    }

    crossings.sort(function(a, b) { return a.dot(direction) - b.dot(direction); });

    return crossings;
  }

  // the first or last crossing of a loop by a line, or null
  function firstCrossing(loop, point, direction) {
    var crossings = loop ? loopCrossings(loop, point, direction) : [];

    return crossings.length > 0 ? crossings[0] : null;
  }

  // index of the point furthest from the line through a and b on the side of
  // the given direction; returns -1 if no point is on that side
  function cornerIndex(points, a, b, side) {
    var chord = new Vector3().subVectors(b, a);
    var chordLength = chord.length();

    if (chordLength === 0) return -1;

    chord.divideScalar(chordLength);

    // component of the side direction perpendicular to the chord
    var perp = side.clone().addScaledVector(chord, -side.dot(chord)).normalize();
    var best = -1;
    var bestDist = 0;

    for (var i = 0; i < points.length; i++) {
      var d = new Vector3().subVectors(points[i], a).dot(perp);

      if (d > bestDist) {
        bestDist = d;
        best = i;
      }
    }

    return best;
  }

  // points along a profile line: the first crossing of the section loop by a
  // line in the given direction at each height in [z0, z1]
  function profilePoints(loop, x, direction, z0, z1, step) {
    var points = [];

    if (!loop) return points;

    for (var z = Math.min(z0, z1); z <= Math.max(z0, z1); z += step) {
      var p = firstCrossing(loop, new Vector3(x, 0, z), direction);

      if (p) points.push(p);
    }

    return points;
  }

  // the tape from start to end, in the plane through both points that also
  // contains the given direction, going around the given side of the body;
  // pulled taut over hollows unless taut is false
  // returns { points, segments, length } or null
  function tape(sliceMesh, start, end, direction, side, taut) {
    if (!start || !end) return null;

    var chord = new Vector3().subVectors(end, start);
    var normal = new Vector3().crossVectors(chord, direction);

    if (normal.lengthSq() < 1e-12) return null;

    normal.normalize();

    var plane = new Plane().setFromNormalAndCoplanarPoint(normal, start);
    var chains = Calculate.chainsFromSegments(sliceMesh.segments(plane));

    if (chains.length === 0) return null;

    // a point on the right side: where the line through the middle of the
    // chord, perpendicular to it, leaves the surface on that side
    var mid = start.clone().add(end).multiplyScalar(0.5);
    var perp = new Vector3().crossVectors(normal, chord).normalize();

    if (perp.dot(side) < 0) perp.negate();

    var via = outermostCrossing(nearestChain(chains, start), mid, perp, chord.clone().normalize());

    if (!via) via = mid.clone().addScaledVector(perp, HINT_DISTANCE);

    return Calculate.pathOnChains(chains, normal, start, via, end, taut !== false);
  }

  // the chain with the closest point to the given point
  function nearestChain(chains, point) {
    var best = null;
    var bestDist = Infinity;

    for (var c = 0; c < chains.length; c++) {
      var points = chains[c].points;

      for (var i = 0; i < points.length; i++) {
        var d = points[i].distanceToSquared(point);

        if (d < bestDist) {
          bestDist = d;
          best = chains[c];
        }
      }
    }

    return best;
  }

  // the furthest point in the given direction where a chain crosses the line
  // through origin in that direction (the origin may be outside the surface,
  // e.g. on a chord across a hollow); along is a unit vector in the chain's
  // plane perpendicular to the line
  function outermostCrossing(chain, origin, direction, along) {
    var points = chain.points;
    var n = points.length;
    var segmentCount = chain.closed ? n : n - 1;
    var best = null;
    var bestT = -Infinity;

    for (var i = 0; i < segmentCount; i++) {
      var a = points[i];
      var b = points[(i + 1) % n];
      var da = new Vector3().subVectors(a, origin).dot(along);
      var db = new Vector3().subVectors(b, origin).dot(along);

      if ((da >= 0) === (db >= 0)) continue;

      var p = a.clone().lerp(b, da / (da - db));
      var t = new Vector3().subVectors(p, origin).dot(direction);

      if (t > bestT) {
        bestT = t;
        best = p;
      }
    }

    return best;
  }



  // landmark detection

  // horizontal sections of the body at regular heights
  function profile(sliceMesh) {
    var levels = [];

    for (var z = sliceMesh.min.z + PROFILE_STEP / 2; z < sliceMesh.max.z; z += PROFILE_STEP) {
      var loops = sectionLoops(sliceMesh, horizontalPlane(z));

      if (loops.length === 0) continue;

      var loop = loops[0];

      levels.push({
        z: z,
        loop: loop,
        girth: closedLength(loopHull(loop)),
        width: loop.max.x - loop.min.x,
        // area of the second-largest loop relative to the largest
        secondRatio: loops.length > 1 ? loops[1].area / loop.area : 0
      });
    }

    return levels;
  }

  function levelsBetween(levels, z0, z1) {
    return levels.filter(function(l) { return l.z >= z0 && l.z <= z1; });
  }

  function extremeLevel(levels, key, wantMax) {
    var best = null;

    for (var i = 0; i < levels.length; i++) {
      if (best === null || (wantMax ? levels[i][key] > best[key] : levels[i][key] < best[key])) {
        best = levels[i];
      }
    }

    return best;
  }

  function median(values) {
    var sorted = values.slice().sort(function(a, b) { return a - b; });

    return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
  }

  // find the body landmarks; returns an object of named points plus the
  // midline x coordinate (midX), or throws if the scan can't be analyzed
  function findLandmarks(sliceMesh) {
    var levels = profile(sliceMesh);

    if (levels.length < 10) throw new Error("Couldn't find the body in the scan.");

    var zBottom = sliceMesh.min.z;
    var zTop = sliceMesh.max.z;
    var height = zTop - zBottom;

    // crotch: highest level in the lower part of the body where the legs form
    // two similar loops; the bottom of the scan if the legs aren't separate
    var zCrotch = zBottom;
    var lower = levelsBetween(levels, zBottom, zBottom + 0.55 * height);

    for (var i = 0; i < lower.length; i++) {
      if (lower[i].secondRatio > 0.3) zCrotch = lower[i].z;
    }

    // hip width, for scale
    var hipZone = levelsBetween(levels, zCrotch + 20, zCrotch + 0.3 * (zTop - zCrotch));
    var hipWidth = extremeLevel(hipZone.length ? hipZone : levels, "width", true).width;

    // shoulders: going down from the top, the first level that's wide
    // compared to the hips; everything above is the neck (and head)
    var zShoulder = zTop;

    for (var i = levels.length - 1; i >= 0; i--) {
      if (levels[i].width >= 0.6 * hipWidth) {
        zShoulder = levels[i].z;
        break;
      }
    }

    // a reference height on the neck: on a dress form, where the neck is cut
    // off at the top of the scan, halfway up the neck (clear of the cut);
    // else, the narrowest part of the neck below the head
    var zNeck;
    // top of the neck, for finding the nape
    var zNeckTop;

    if (zTop - zShoulder < 150) {
      zNeck = (zShoulder + zTop) / 2;
      zNeckTop = zTop - 2;
    }
    else {
      var neckZone = levelsBetween(levels, zShoulder + PROFILE_STEP, zShoulder + 150);
      zNeck = neckZone.length > 0 ? extremeLevel(neckZone, "girth", false).z : zShoulder + 50;
      zNeckTop = zNeck;
    }

    // body midline
    var midX = median(levelsBetween(levels, zCrotch + 50, zShoulder - 100).map(function(l) {
      return l.loop.centroid.x;
    }));

    var torsoLength = zShoulder - zCrotch;

    // underarms, searching the upper half of the torso
    var zUpper = zCrotch + 0.5 * torsoLength;
    var underarm = findUnderarms(levels, zUpper, zShoulder, midX);

    if (!underarm) throw new Error("Couldn't find the underarms.");

    // dress forms usually have flat armhole plates: the underarm is the bottom
    // of the plate and the shoulder point is the top
    var plateL = null, plateR = null;

    if (!underarm.hasArms) {
      plateL = sliceMesh.flatSide(1, zUpper, zShoulder);
      plateR = sliceMesh.flatSide(-1, zUpper, zShoulder);

      if (plateL) underarm.left = plateL.bottom;
      if (plateR) underarm.right = plateR.bottom;
    }

    var zUnderarm = (underarm.left.z + underarm.right.z) / 2;

    // bust points: on each side, going down from the underarms, the first
    // forward peak that's followed by the crease under the bust (so a tummy
    // further down isn't mistaken for the bust)
    var bustZone = levelsBetween(levels, zUnderarm - 0.35 * (zUnderarm - zCrotch), zUnderarm - PROFILE_STEP);
    var maxOffset = 0.45 * hipWidth;

    function bustPoint(sign) {
      var peak = null;

      for (var i = bustZone.length - 1; i >= 0; i--) {
        var points = bustZone[i].loop.points;
        var levelFront = null;

        for (var j = 0; j < points.length; j++) {
          var dx = (points[j].x - midX) * sign;

          if (dx < 30 || dx > maxOffset) continue;

          if (levelFront === null || points[j].y < levelFront.y) levelFront = points[j];
        }

        if (levelFront === null) continue;

        if (peak === null || levelFront.y < peak.y) peak = levelFront;
        // the surface has turned back in under the bust
        else if (levelFront.y > peak.y + 5) break;
      }

      return peak ? peak.clone() : null;
    }

    var bustL = bustPoint(1);
    var bustR = bustPoint(-1);

    if (!bustL || !bustR) throw new Error("Couldn't find the bust points.");

    var zBust = (bustL.z + bustR.z) / 2;

    // midline section, for the front and back profiles
    var sagittal = sectionLoops(sliceMesh, new Plane(X.clone(), -midX))[0] || null;
    var front = new Vector3(0, -1, 0);
    var back = new Vector3(0, 1, 0);

    // front neck point: the hollow where the neck meets the chest, i.e. the
    // front profile point furthest behind the line from the neck to the upper
    // chest (above any cleavage)
    var zChest = zUnderarm + 0.4 * (zShoulder - zUnderarm);
    var frontProfile = profilePoints(sagittal, midX, back, zChest, zNeck, 2);
    var neckFront = firstCrossing(sagittal, new Vector3(midX, 0, zNeck), back);
    var chestFront = firstCrossing(sagittal, new Vector3(midX, 0, zChest), back);
    var cfNeck = null;

    if (neckFront && chestFront) {
      var idx = cornerIndex(frontProfile, neckFront, chestFront, back);
      if (idx >= 0) cfNeck = frontProfile[idx].clone();
    }

    if (!cfNeck) cfNeck = firstCrossing(sagittal, new Vector3(midX, 0, zShoulder), back);

    // nape: the hollow where the back of the neck meets the upper back
    var backProfile = profilePoints(sagittal, midX, front, zUnderarm, zNeckTop, 2);
    var neckBack = firstCrossing(sagittal, new Vector3(midX, 0, zNeckTop), front);
    var upperBack = null;

    for (var i = 0; i < backProfile.length; i++) {
      if (backProfile[i].z < zShoulder && (upperBack === null || backProfile[i].y > upperBack.y)) {
        upperBack = backProfile[i];
      }
    }

    var nape = null;

    if (neckBack && upperBack) {
      var abovePeak = backProfile.filter(function(p) { return p.z >= upperBack.z; });
      var idx = cornerIndex(abovePeak, neckBack, upperBack, front);
      if (idx >= 0) nape = abovePeak[idx].clone();
    }

    if (!nape) nape = firstCrossing(sagittal, new Vector3(midX, 0, zShoulder), front);

    if (!cfNeck || !nape) throw new Error("Couldn't find the neck.");

    // side neck points: the sides of the neck girth
    var neckLoop = neckGirthLoop(sliceMesh, cfNeck, nape);

    if (!neckLoop) throw new Error("Couldn't find the neck circumference.");

    var neckSideL = null, neckSideR = null;

    for (var i = 0; i < neckLoop.points.length; i++) {
      var p = neckLoop.points[i];

      if (neckSideL === null || p.x > neckSideL.x) neckSideL = p;
      if (neckSideR === null || p.x < neckSideR.x) neckSideR = p;
    }

    neckSideL = neckSideL.clone();
    neckSideR = neckSideR.clone();

    // shoulder points
    var shoulderL, shoulderR;

    if (underarm.hasArms) {
      shoulderL = shoulderTop(sliceMesh, underarm.left.x, neckSideL);
      shoulderR = shoulderTop(sliceMesh, underarm.right.x, neckSideR);
    }
    else {
      shoulderL = plateL ? plateL.top : shoulderCorner(sliceMesh, neckSideL, underarm.left, X);
      shoulderR = plateR ? plateR.top : shoulderCorner(sliceMesh, neckSideR, underarm.right, X.clone().negate());
    }

    if (!shoulderL || !shoulderR) throw new Error("Couldn't find the shoulder points.");

    // hip: fullest level in the lower half of the body between crotch and bust
    var hipLevel = extremeLevel(levelsBetween(levels, zCrotch + 30, zCrotch + 0.55 * (zBust - zCrotch)), "girth", true);

    if (!hipLevel) throw new Error("Couldn't find the hip.");

    var zHip = hipLevel.z;

    // under bust: the crease under each breast, i.e. the front profile point
    // through the bust point furthest behind the line from the bust point down
    // to the hip
    var underBustZ = [];

    [bustL, bustR].forEach(function(bust) {
      var loop = sectionLoops(sliceMesh, new Plane(X.clone(), -bust.x))[0];
      if (!loop) return;

      var points = profilePoints(loop, bust.x, back, zHip, bust.z, 2);
      var hipFront = firstCrossing(loop, new Vector3(bust.x, 0, zHip), back);
      if (!hipFront) return;

      var idx = cornerIndex(points, bust, hipFront, back);
      if (idx >= 0) underBustZ.push(points[idx].z);
    });

    var zUnderBust = underBustZ.length > 0 ?
      underBustZ.reduce(function(a, b) { return a + b; }) / underBustZ.length :
      zBust - 0.2 * (zBust - zHip);

    // waist: narrowest level between the under bust and the hip, keeping
    // clear of the under bust crease (on some figures the body keeps getting
    // narrower right up to the crease)
    var span = zUnderBust - zHip;
    var waistLevel = extremeLevel(levelsBetween(levels, zHip + 0.3 * span, zUnderBust - 0.2 * span), "girth", false);

    if (!waistLevel) throw new Error("Couldn't find the waist.");

    var zWaist = waistLevel.z;

    // waist points below the busts: nearest points on the waist line
    var waistLoop = torsoLoop(sliceMesh, zWaist);

    return {
      midX: midX,
      cfNeck: cfNeck,
      nape: nape,
      neckSideL: neckSideL,
      neckSideR: neckSideR,
      shoulderL: shoulderL,
      shoulderR: shoulderR,
      underarmL: underarm.left,
      underarmR: underarm.right,
      bustL: bustL,
      bustR: bustR,
      underBust: levelPoint(sliceMesh, midX, zUnderBust),
      waist: levelPoint(sliceMesh, midX, zWaist),
      waistBustL: nearestOnLoop(waistLoop, bustL),
      waistBustR: nearestOnLoop(waistLoop, bustR),
      abdomen: levelPoint(sliceMesh, midX, (zWaist + zHip) / 2),
      hip: levelPoint(sliceMesh, midX, zHip)
    };
  }

  // level landmarks are shown at the front of the body on the midline
  function levelPoint(sliceMesh, midX, z) {
    var loop = torsoLoop(sliceMesh, z);
    var p = loop ? firstCrossing(loop, new Vector3(midX, 0, z), Y) : null;

    return p || new Vector3(midX, sliceMesh.min.y, z);
  }

  // landmarks for the basic measurements: just the girth levels
  function findBasicLandmarks(sliceMesh) {
    var lm = findLandmarks(sliceMesh);
    var zBust = (lm.bustL.z + lm.bustR.z) / 2;

    return {
      midX: lm.midX,
      bust: levelPoint(sliceMesh, lm.midX, zBust),
      underBust: lm.underBust,
      waist: lm.waist,
      abdomen: lm.abdomen,
      hip: lm.hip
    };
  }

  // the neck girth loop: section by the plane through the front neck point and
  // nape that's level from side to side
  function neckGirthLoop(sliceMesh, cfNeck, nape) {
    var normal = new Vector3().subVectors(nape, cfNeck).cross(X).normalize();

    if (normal.z < 0) normal.negate();

    var plane = new Plane().setFromNormalAndCoplanarPoint(normal, cfNeck);
    var loops = sectionLoops(sliceMesh, plane);
    var mid = cfNeck.clone().add(nape).multiplyScalar(0.5);
    var best = null;
    var bestDist = Infinity;

    // the loop that contains the neck is the one nearest the middle of the
    // neck
    for (var i = 0; i < loops.length; i++) {
      var d = loops[i].centroid.distanceTo(mid);

      if (d < bestDist) {
        bestDist = d;
        best = loops[i];
      }
    }

    return best;
  }

  // underarm points: for scans with arms, the top of the gap between arm and
  // body; for armless forms, the bottom of the flat armhole plates
  function findUnderarms(levels, zLow, zShoulder, midX) {
    var zone = levelsBetween(levels, zLow, zShoulder);

    if (zone.length < 3) return null;

    // arms: going up from the bust, the body loop suddenly gets much wider
    // where the arms join it
    for (var i = 1; i < zone.length; i++) {
      if (zone[i].width > 1.3 * zone[i - 1].width) {
        var points = sidePoints(zone[i - 1].loop, midX);
        points.hasArms = true;

        return points;
      }
    }

    // armless: the armhole plates are the widest part of the upper body; the
    // underarm is the bottom of the run of levels that are nearly as wide
    var result = { hasArms: false };

    ["left", "right"].forEach(function(side) {
      var sign = side === "left" ? 1 : -1;
      var extent = zone.map(function(l) {
        return sign > 0 ? l.loop.max.x : -l.loop.min.x;
      });
      var widest = 0;

      for (var i = 1; i < extent.length; i++) {
        if (extent[i] > extent[widest]) widest = i;
      }

      var bottom = widest;

      while (bottom > 0 && extent[bottom - 1] >= extent[widest] - 3) bottom--;

      result[side] = sidePoints(zone[bottom].loop, midX)[side];
    });

    return result;
  }

  // the outermost points of a loop on each side of the midline; where the side
  // is flat (e.g. an armhole plate), the middle of the flat part
  function sidePoints(loop, midX) {
    function outermost(sign) {
      var points = loop.points.filter(function(p) { return (p.x - midX) * sign > 0; });

      if (points.length === 0) return null;

      var extreme = Math.max.apply(null, points.map(function(p) { return p.x * sign; }));
      var flat = points.filter(function(p) { return p.x * sign > extreme - 2; });
      var meanY = flat.reduce(function(s, p) { return s + p.y; }, 0) / flat.length;
      var best = flat[0];

      for (var i = 1; i < flat.length; i++) {
        if (Math.abs(flat[i].y - meanY) < Math.abs(best.y - meanY)) best = flat[i];
      }

      return best.clone();
    }

    return {
      left: outermost(1),
      right: outermost(-1)
    };
  }

  // shoulder point of an armless form: the corner where the shoulder line
  // meets the armhole plate, on the line over the shoulder from the side neck
  // point to the underarm
  function shoulderCorner(sliceMesh, neckSide, underarm, outward) {
    var side = outward.clone().add(Z).normalize();
    var path = tape(sliceMesh, neckSide, underarm, Z, side, false);

    if (!path) return null;

    var idx = cornerIndex(path.points, neckSide, underarm, side);

    return idx >= 0 ? path.points[idx].clone() : null;
  }

  // shoulder point with arms: the top of the shoulder above the underarm,
  // from the section through it, near the side neck point
  function shoulderTop(sliceMesh, x, neckSide) {
    var loops = sectionLoops(sliceMesh, new Plane(X.clone(), -x));
    var best = null;

    for (var i = 0; i < loops.length; i++) {
      var points = loops[i].points;

      for (var j = 0; j < points.length; j++) {
        // only consider the part of the section near the shoulder
        if (Math.abs(points[j].y - neckSide.y) > 100) continue;

        if (best === null || points[j].z > best.z) best = points[j];
      }
    }

    return best ? best.clone() : null;
  }



  // measurements

  // definitions of the measurements, in report order
  var Definitions = [
    { key: "neck", name: "Neck", group: "Circumferences" },
    { key: "highBust", name: "High bust", group: "Circumferences" },
    { key: "bust", name: "Bust", group: "Circumferences" },
    { key: "underBust", name: "Under bust", group: "Circumferences" },
    { key: "waist", name: "Waist", group: "Circumferences" },
    { key: "abdomen", name: "Abdomen", group: "Circumferences" },
    { key: "hip", name: "Hip", group: "Circumferences" },

    { key: "frontLength", name: "Centre front (neck to waist)", group: "Front" },
    { key: "bustHeightL", name: "Neck to bust point (L)", group: "Front" },
    { key: "bustHeightR", name: "Neck to bust point (R)", group: "Front" },
    { key: "waistHeightL", name: "Neck to waist over bust (L)", group: "Front" },
    { key: "waistHeightR", name: "Neck to waist over bust (R)", group: "Front" },
    { key: "bustSpan", name: "Bust span", group: "Front" },
    { key: "acrossFront", name: "Across front", group: "Front" },

    { key: "backLength", name: "Centre back (nape to waist)", group: "Back" },
    { key: "acrossBack", name: "Across back", group: "Back" },
    { key: "shoulderWidth", name: "Shoulder width", group: "Back" },
    { key: "waistToAbdomen", name: "Waist to abdomen", group: "Back" },
    { key: "waistToHip", name: "Waist to hip", group: "Back" },

    { key: "shoulderLengthL", name: "Shoulder length (L)", group: "Sides" },
    { key: "shoulderLengthR", name: "Shoulder length (R)", group: "Sides" },
    { key: "sideLengthL", name: "Side length (L)", group: "Sides" },
    { key: "sideLengthR", name: "Side length (R)", group: "Sides" }
  ];

  // names of the adjustable landmarks, in display order
  var LandmarkNames = {
    cfNeck: "Front neck",
    nape: "Nape",
    neckSideL: "Side neck (L)",
    neckSideR: "Side neck (R)",
    shoulderL: "Shoulder point (L)",
    shoulderR: "Shoulder point (R)",
    underarmL: "Underarm (L)",
    underarmR: "Underarm (R)",
    bustL: "Bust point (L)",
    bustR: "Bust point (R)",
    underBust: "Under bust level",
    waist: "Waist level",
    waistBustL: "Waist below bust (L)",
    waistBustR: "Waist below bust (R)",
    abdomen: "Abdomen level",
    hip: "Hip level"
  };

  // measure everything from the landmarks
  function measure(sliceMesh, lm) {
    var midX = lm.midX;
    var front = new Vector3(0, -1, 0);
    var back = new Vector3(0, 1, 0);
    var results = {};

    function set(key, path) {
      results[key] = path ? { value: path.length, segments: path.segments } : null;
    }

    function add(a, b) {
      if (!a || !b) return null;

      return { length: a.length + b.length, segments: a.segments.concat(b.segments) };
    }

    function girth(z) {
      return girthAt(sliceMesh, z);
    }

    // front or back midline point at height z
    function midlinePoint(z, direction) {
      return firstCrossing(torsoLoop(sliceMesh, z), new Vector3(midX, 0, z), direction);
    }

    function attempt(fn) {
      try { return fn(); }
      catch (e) { return null; }
    }

    // girths

    set("neck", attempt(function() {
      var loop = neckGirthLoop(sliceMesh, lm.cfNeck, lm.nape);
      if (!loop) return null;

      var hull = loopHull(loop);

      return { length: closedLength(hull), segments: closedSegments(hull) };
    }));

    // just below the underarms so the arms aren't included
    var zHighBust = (lm.underarmL.z + lm.underarmR.z) / 2 - 5;
    var zBust = (lm.bustL.z + lm.bustR.z) / 2;

    set("highBust", attempt(function() { return girth(zHighBust); }));
    set("bust", attempt(function() { return girth(zBust); }));
    set("underBust", attempt(function() { return girth(lm.underBust.z); }));
    set("waist", attempt(function() { return girth(lm.waist.z); }));
    set("abdomen", attempt(function() { return girth(lm.abdomen.z); }));
    set("hip", attempt(function() { return girth(lm.hip.z); }));

    // lengths

    var waistLoop = torsoLoop(sliceMesh, lm.waist.z);
    var waistFront = midlinePoint(lm.waist.z, back);
    var waistBack = midlinePoint(lm.waist.z, front);

    set("frontLength", attempt(function() {
      return tape(sliceMesh, lm.cfNeck, waistFront, Y, front);
    }));

    ["L", "R"].forEach(function(s) {
      var neckSide = lm["neckSide" + s];
      var bust = lm["bust" + s];

      var toBust = attempt(function() {
        return tape(sliceMesh, neckSide, bust, Y, front);
      });

      set("bustHeight" + s, toBust);

      // straight down from the bust point to the waist point below it; the
      // waist point is snapped to the waist line (and the landmark updated)
      // so it follows the waist level if that's moved
      var waistBust = nearestOnLoop(waistLoop, lm["waistBust" + s] || bust);
      if (waistBust) lm["waistBust" + s] = waistBust;

      set("waistHeight" + s, attempt(function() {
        return add(toBust, tape(sliceMesh, bust, waistBust, Y, front));
      }));
    });

    set("bustSpan", attempt(function() {
      return tape(sliceMesh, lm.bustR, lm.bustL, Y, front);
    }));

    // across front and back: halfway between the shoulder points and the
    // underarms, between the armholes
    var zAcross = (lm.shoulderL.z + lm.shoulderR.z + lm.underarmL.z + lm.underarmR.z) / 4;
    var acrossLoop = torsoLoop(sliceMesh, zAcross);

    ["Front", "Back"].forEach(function(name) {
      var direction = name === "Front" ? back : front;

      set("across" + name, attempt(function() {
        var left = firstCrossing(acrossLoop, new Vector3(lm.underarmL.x - 5, 0, zAcross), direction);
        var right = firstCrossing(acrossLoop, new Vector3(lm.underarmR.x + 5, 0, zAcross), direction);

        return tape(sliceMesh, right, left, Y, direction.clone().negate());
      }));
    });

    set("backLength", attempt(function() {
      return tape(sliceMesh, lm.nape, waistBack, Y, back);
    }));

    set("shoulderWidth", attempt(function() {
      return tape(sliceMesh, lm.shoulderR, lm.shoulderL, Y, back);
    }));

    ["abdomen", "hip"].forEach(function(level) {
      var key = level === "hip" ? "waistToHip" : "waistToAbdomen";

      set(key, attempt(function() {
        var end = midlinePoint(lm[level].z, front);

        return tape(sliceMesh, waistBack, end, Y, back);
      }));
    });

    ["L", "R"].forEach(function(s) {
      var outward = new Vector3(s === "L" ? 1 : -1, 0, 0);
      var neckSide = lm["neckSide" + s];
      var shoulder = lm["shoulder" + s];
      var underarm = lm["underarm" + s];

      set("shoulderLength" + s, attempt(function() {
        return tape(sliceMesh, neckSide, shoulder, Z, Z);
      }));

      // down the side, like a side seam, to the waist directly below the
      // underarm
      set("sideLength" + s, attempt(function() {
        var waistSide = firstCrossing(torsoLoop(sliceMesh, lm.waist.z),
          new Vector3(midX, underarm.y, lm.waist.z), outward.clone().negate());

        return tape(sliceMesh, underarm, waistSide, X, outward);
      }));
    });

    return resultList(Definitions, results);
  }

  // horizontal girth at height z, bridging hollows
  function girthAt(sliceMesh, z) {
    var loop = torsoLoop(sliceMesh, z);
    if (!loop) return null;

    var hull = loopHull(loop);

    return { length: closedLength(hull), segments: closedSegments(hull) };
  }

  // results in the order of the definitions, from a map of key to
  // { value, segments }
  function resultList(definitions, results) {
    return definitions.map(function(def) {
      var r = results[def.key];

      return {
        key: def.key,
        name: def.name,
        group: def.group,
        value: r ? r.value : null,
        segments: r ? r.segments : []
      };
    });
  }

  // basic measurements: the girths at the bust, under bust, waist, abdomen,
  // and hip levels

  var BasicDefinitions = Definitions.filter(function(def) {
    return ["bust", "underBust", "waist", "abdomen", "hip"].indexOf(def.key) >= 0;
  });

  var BasicLandmarkNames = {
    bust: "Bust level",
    underBust: "Under bust level",
    waist: "Waist level",
    abdomen: "Abdomen level",
    hip: "Hip level"
  };

  function measureBasic(sliceMesh, lm) {
    var results = {};

    BasicDefinitions.forEach(function(def) {
      var path = null;

      try { path = girthAt(sliceMesh, lm[def.key].z); }
      catch (e) { }

      results[def.key] = path ? { value: path.length, segments: path.segments } : null;
    });

    return resultList(BasicDefinitions, results);
  }

  // the sets of measurements: each has its own landmarks, measurements, and
  // report layout
  var Modes = {
    full: {
      key: "full",
      name: "Full",
      definitions: Definitions,
      landmarkNames: LandmarkNames,
      findLandmarks: findLandmarks,
      measure: measure
    },
    basic: {
      key: "basic",
      name: "Basic",
      definitions: BasicDefinitions,
      landmarkNames: BasicLandmarkNames,
      findLandmarks: findBasicLandmarks,
      measure: measureBasic
    }
  };



  // report

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // printable HTML report of the measurements in cm
  // params:
  //  name: report name (e.g. customer or job)
  //  filename: scan filename
  //  results: from the mode's measure()
  //  images: array of { name, url } views of the model
  //  mode: "full" (default) or "basic"; the basic report has a single table
  //   of circumferences
  function reportHTML(params) {
    var date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    var basic = params.mode === "basic";
    var groups = [];

    function cm(result) {
      return result.value === null ? "&ndash;" : (result.value / 10).toFixed(1);
    }

    params.results.forEach(function(result) {
      var group = groups.length > 0 && groups[groups.length - 1].name === result.group ?
        groups[groups.length - 1] : null;

      if (!group) {
        group = { name: result.group, rows: [] };
        groups.push(group);
      }

      group.rows.push(result);
    });

    var tables = groups.map(function(group) {
      var rows = group.rows.map(function(result) {
        return "<tr><td>" + escapeHTML(result.name) + "</td><td class=\"value\">" + cm(result) + "</td></tr>";
      }).join("");

      return "<table><thead><tr><th>" + escapeHTML(group.name) + "</th><th class=\"value\">cm</th></tr></thead>" +
        "<tbody>" + rows + "</tbody></table>";
    }).join("");

    if (basic) {
      tables = "<table class=\"circumferences\"><thead><tr><th>Circumference</th><th class=\"value\">cm</th></tr></thead><tbody>" +
        params.results.map(function(result) {
          return "<tr><td>" + escapeHTML(result.name) + "</td><td class=\"value\">" + cm(result) + "</td></tr>";
        }).join("") +
        "</tbody></table>";
    }

    var images = params.images.map(function(image) {
      return "<figure><img src=\"" + image.url + "\" alt=\"" + escapeHTML(image.name) + " view\">" +
        "<figcaption>" + escapeHTML(image.name) + "</figcaption></figure>";
    }).join("");

    var title = params.name ? escapeHTML(params.name) : "Measurements";
    var note = basic ?
      "Circumferences are measured level, bridging hollows as a tape measure would." :
      "Circumferences are measured level, and lengths along the surface; both bridge hollows as a tape measure would. " +
      "Blue: circumferences. Orange: lengths. L and R are the body's left and right.";

    return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
      "<title>" + title + " - " + (basic ? "basic " : "") + "measurements</title>" +
      "<style>" +
      "@page { size: A4 portrait; margin: 12mm; }" +
      "body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0 auto; max-width: 190mm; padding: 8mm 0; }" +
      "header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #111; padding-bottom: 4px; }" +
      "h1 { font-size: 20px; margin: 0; }" +
      ".meta { font-size: 12px; color: #444; text-align: right; }" +
      ".tables { columns: 2; column-gap: 10mm; margin-top: 6mm; }" +
      "table { width: 100%; border-collapse: collapse; margin-bottom: 5mm; break-inside: avoid; font-size: 13px; }" +
      "th { text-align: left; border-bottom: 1px solid #111; padding: 3px 4px; }" +
      "td { border-bottom: 1px solid #ddd; padding: 3px 4px; }" +
      ".value { text-align: right; font-variant-numeric: tabular-nums; width: 18mm; }" +
      ".tables.basic { columns: 1; }" +
      "table.circumferences { width: 90mm; font-size: 15px; }" +
      "table.circumferences td.value { font-weight: bold; }" +
      ".views { display: flex; justify-content: space-between; gap: 4mm; margin-top: 2mm; break-inside: avoid; }" +
      "figure { margin: 0; flex: 1; text-align: center; }" +
      "figure img { width: 100%; border: 1px solid #ddd; }" +
      "figcaption { font-size: 12px; color: #444; }" +
      ".note { font-size: 11px; color: #555; margin-top: 4mm; }" +
      "@media print { body { padding: 0; } }" +
      "</style></head><body>" +
      "<header><h1>" + title + "</h1><div class=\"meta\">" + date +
      (params.filename ? "<br>Scan: " + escapeHTML(params.filename) : "") + "</div></header>" +
      "<div class=\"tables" + (basic ? " basic" : "") + "\">" + tables + "</div>" +
      "<div class=\"views\">" + images + "</div>" +
      "<p class=\"note\">" + note + "</p>" +
      "</body></html>";
  }



  // saving and loading

  var FILE_FORMAT = "meshy-auto-measure";
  var FILE_VERSION = 1;

  function round(v, places) {
    var f = Math.pow(10, places);

    return Math.round(v * f) / f;
  }

  // data to save to a file: landmarks are in mm relative to the minimum
  // corner of the scan's bounding box, so they still line up if the scan is
  // imported in a different place; the measurements are for reference only
  // params:
  //  mode: "full" or "basic"
  //  name: report name
  //  filename: scan filename
  //  sliceMesh, landmarks, results
  function saveData(params) {
    var mode = Modes[params.mode];
    var min = params.sliceMesh.min;
    var size = params.sliceMesh.max.clone().sub(min);
    var landmarks = {};

    for (var key in mode.landmarkNames) {
      var p = params.landmarks[key];
      if (!p) continue;

      landmarks[key] = [round(p.x - min.x, 2), round(p.y - min.y, 2), round(p.z - min.z, 2)];
    }

    return {
      format: FILE_FORMAT,
      version: FILE_VERSION,
      mode: mode.key,
      saved: new Date().toISOString(),
      name: params.name || "",
      scan: params.filename || "",
      units: "mm",
      scanSize: [round(size.x, 2), round(size.y, 2), round(size.z, 2)],
      midX: round(params.landmarks.midX - min.x, 2),
      landmarks: landmarks,
      measurementsCm: params.results.map(function(result) {
        return {
          key: result.key,
          name: result.name,
          value: result.value === null ? null : round(result.value / 10, 1)
        };
      })
    };
  }

  // landmarks for the given mode ("full" or "basic") from saved data, placed
  // on the given scan; any missing from the file are found automatically
  // returns { landmarks, name, scan, sizeDifference } where sizeDifference is
  // the largest difference in mm between the saved and current scan sizes
  function loadData(sliceMesh, data, modeKey) {
    if (!data || data.format !== FILE_FORMAT || !data.landmarks) {
      throw new Error("This isn't an Auto Measure file.");
    }

    if (data.version > FILE_VERSION) {
      throw new Error("This file was saved by a newer version of Auto Measure.");
    }

    var mode = Modes[modeKey];
    // files saved before there was a basic mode are full
    var fileMode = Modes[data.mode || "full"];

    if (fileMode !== mode) {
      throw new Error("This file has " + (fileMode ? fileMode.name.toLowerCase() : "unknown") +
        " measurements" + (fileMode ? "; load it under Auto Measure " + fileMode.name : "") + ".");
    }

    var min = sliceMesh.min;
    var size = sliceMesh.max.clone().sub(min);
    var landmarks = {};
    var missing = false;

    for (var key in mode.landmarkNames) {
      var p = data.landmarks[key];

      if (p && p.length === 3) {
        landmarks[key] = new Vector3(p[0] + min.x, p[1] + min.y, p[2] + min.z);
      }
      else missing = true;
    }

    if (typeof data.midX === "number") landmarks.midX = data.midX + min.x;
    else missing = true;

    if (missing) {
      var found = mode.findLandmarks(sliceMesh);

      for (var k in found) {
        if (landmarks[k] === undefined) landmarks[k] = found[k];
      }
    }

    var sizeDifference = 0;

    if (data.scanSize && data.scanSize.length === 3) {
      sizeDifference = Math.max(
        Math.abs(data.scanSize[0] - size.x),
        Math.abs(data.scanSize[1] - size.y),
        Math.abs(data.scanSize[2] - size.z)
      );
    }

    return {
      landmarks: landmarks,
      name: data.name || "",
      scan: data.scan || "",
      sizeDifference: sizeDifference
    };
  }



  return {
    SliceMesh: SliceMesh,
    findLandmarks: findLandmarks,
    measure: measure,
    reportHTML: reportHTML,
    saveData: saveData,
    loadData: loadData,
    tape: tape,
    Modes: Modes,
    Definitions: Definitions,
    LandmarkNames: LandmarkNames
  };

})();
