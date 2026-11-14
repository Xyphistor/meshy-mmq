// coverMeasure.js
//
// dependencies:
//  three.js
//  calculate.js
//  autoMeasure.js
//
// description:
//  measurements for a stretchy cover of a dress form: circumferences around
//  the surface (following hollows rather than bridging them, as stretchy
//  fabric does) of
//   - horizontal sections every 5cm from the base up, starting 2mm above the
//     base and stopping at the top of the model
//   - two sections parallel to the angled cut through the top of the neck:
//     the neck top, 2mm below the cut, and the neck base, where the neck
//     meets the shoulders
//  horizontal levels that cut into the neck (above the lowest point of the
//  neck base section) are left out. Where a level crosses more than one
//  part (e.g. both legs), its circumference is the total around all of
//  them, as with Cross-section z (ignoring specks under MIN_PART in area).
//
//  assumes the scan is upright with +z up; units are mm
//
// example:
//  var sliceMesh = new AutoMeasure.SliceMesh(mesh);
//  var state = CoverMeasure.find(sliceMesh);
//
//  /* optionally move levels: state.levels[i].z, state.neck.top, state.neck.base */
//
//  var rows = CoverMeasure.measure(sliceMesh, state);
//
//  rows is an array of { key, kind, name, height, value, segments } from the
//  top down, where kind is "neckTop", "neckBase", or "level", height is the
//  height above the base (for the neck sections, of their highest point),
//  value is the circumference (null if the section failed), all in mm



var CoverMeasure = (function() {

  var Vector3 = THREE.Vector3;
  var Plane = THREE.Plane;

  // spacing of the horizontal levels
  var SPACING = 50;

  // gap left at the base, the top, and the neck cut, avoiding edge glitches
  var EDGE = 2;

  // the base of the neck is searched for this far below the cut, in steps
  var NECK_SEARCH = 160;
  var NECK_STEP = 2;

  // separate parts of a horizontal level smaller than this in area (mm^2) are
  // scan debris, not part of the model
  var MIN_PART = 100;



  // the flat cut through the top of the neck: the largest plane patch facing
  // up near the top of the model, which must reach the top; returns
  // { normal, offset, centroid, area }, with the plane normal·p = offset and
  // the normal pointing out of the model, or null if there's no cut
  function findCut(sliceMesh) {
    var p = sliceMesh.positions;
    var normals = sliceMesh.normals;
    var zTop = sliceMesh.max.z;
    var faces = [];

    for (var f = 0; f < sliceMesh.count; f++) {
      var o = f * 9;
      var cz = (p[o + 2] + p[o + 5] + p[o + 8]) / 3;

      if (cz < zTop - 150) continue;

      var nx = normals[f * 3], ny = normals[f * 3 + 1], nz = normals[f * 3 + 2];
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz);

      if (len === 0 || nz / len < 0.5) continue;

      faces.push({
        f: f,
        area: len / 2,
        normal: new Vector3(nx / len, ny / len, nz / len),
        center: new Vector3((p[o] + p[o + 3] + p[o + 6]) / 3, (p[o + 1] + p[o + 4] + p[o + 7]) / 3, cz)
      });
    }

    if (faces.length === 0) return null;

    function inliers(normal, offset) {
      return faces.filter(function(face) {
        return face.normal.dot(normal) > 0.99 && Math.abs(face.center.dot(normal) - offset) < 2;
      });
    }

    function areaOf(list) {
      var area = 0;
      for (var i = 0; i < list.length; i++) area += list[i].area;
      return area;
    }

    // try a spread of faces as seeds and keep the one with the most area in
    // its plane
    var stride = Math.max(1, Math.floor(faces.length / 400));
    var best = null;
    var bestArea = 0;

    for (var i = 0; i < faces.length; i += stride) {
      var seed = faces[i];
      var area = areaOf(inliers(seed.normal, seed.center.dot(seed.normal)));

      if (area > bestArea) {
        bestArea = area;
        best = seed;
      }
    }

    // refine the plane from the faces in it
    var normal = best.normal.clone();
    var offset = best.center.dot(normal);
    var cut = null;

    for (var iter = 0; iter < 3; iter++) {
      cut = inliers(normal, offset);

      var sum = new Vector3();
      cut.forEach(function(face) { sum.addScaledVector(face.normal, face.area); });
      normal = sum.normalize();

      var area = areaOf(cut);
      var sumOffset = 0;
      cut.forEach(function(face) { sumOffset += face.center.dot(normal) * face.area; });
      offset = sumOffset / area;
    }

    var area = areaOf(cut);

    // too small for a neck cut (e.g. the top of a head)
    if (area < 2500) return null;

    var centroid = new Vector3();
    var top = -Infinity;

    cut.forEach(function(face) {
      centroid.addScaledVector(face.center, face.area / area);

      var o = face.f * 9;
      top = Math.max(top, p[o + 2], p[o + 5], p[o + 8]);
    });

    // the cut must be at the top of the model
    if (top < zTop - 10) return null;

    return { normal: normal, offset: offset, centroid: centroid, area: area };
  }



  // sections parallel to the cut

  // faces that can cross planes parallel to the cut down to maxDepth below
  // it, for faster sections
  function NeckFaces(sliceMesh, cut, maxDepth) {
    var p = sliceMesh.positions;
    var n = cut.normal;
    var faces = [];

    for (var f = 0; f < sliceMesh.count; f++) {
      var o = f * 9;
      var d0 = cut.offset - (n.x * p[o] + n.y * p[o + 1] + n.z * p[o + 2]);
      var d1 = cut.offset - (n.x * p[o + 3] + n.y * p[o + 4] + n.z * p[o + 5]);
      var d2 = cut.offset - (n.x * p[o + 6] + n.y * p[o + 7] + n.z * p[o + 8]);

      if (Math.max(d0, d1, d2) < 0 || Math.min(d0, d1, d2) > maxDepth) continue;

      faces.push(f);
    }

    this.sliceMesh = sliceMesh;
    this.cut = cut;
    this.maxDepth = maxDepth;
    this.faces = faces;
  }

  // the plane parallel to the cut, depth below it
  function cutPlane(cut, depth) {
    return new Plane(cut.normal.clone(), -(cut.offset - depth));
  }

  // the loop of the section parallel to the cut at the given depth that goes
  // around the neck: the one whose centre is nearest the line through the
  // middle of the cut, along its normal
  function neckLoop(sliceMesh, cut, depth, neckFaces) {
    var plane = cutPlane(cut, depth);
    var segments;

    if (neckFaces && depth <= neckFaces.maxDepth) {
      segments = [];
      for (var i = 0, l = neckFaces.faces.length; i < l; i++) {
        sliceMesh.intersectFace(neckFaces.faces[i], plane.normal, plane.constant, segments);
      }
    }
    else {
      segments = sliceMesh.segments(plane);
    }

    var loops = AutoMeasure.loopsFromSegments(segments, plane.normal);
    var best = null;
    var bestDist = Infinity;

    for (var i = 0; i < loops.length; i++) {
      var offAxis = loops[i].centroid.clone().sub(cut.centroid);
      offAxis.addScaledVector(cut.normal, -offAxis.dot(cut.normal));

      var d = offAxis.length();

      if (d < bestDist) {
        bestDist = d;
        best = loops[i];
      }
    }

    return best;
  }

  // circumference of the neck section at each depth below the cut
  function neckProfile(sliceMesh, cut) {
    var neckFaces = new NeckFaces(sliceMesh, cut, NECK_SEARCH);
    var profile = [];

    for (var depth = EDGE; depth <= NECK_SEARCH; depth += NECK_STEP) {
      var loop = neckLoop(sliceMesh, cut, depth, neckFaces);

      profile.push({ depth: depth, length: loop ? AutoMeasure.closedLength(loop.points) : null });
    }

    return profile;
  }

  // depth of the base of the neck below the cut: the knee of the curve of
  // circumference against depth, where the neck flares into the shoulders.
  // That's the point furthest below the straight line from the top of the
  // neck to where the circumference grows fastest.
  function findNeckBase(profile) {
    var points = profile.filter(function(p) { return p.length !== null; });
    var span = 2;
    var steepest = -1;
    var steepestGrowth = -Infinity;

    // growth over a few steps, to smooth out scan noise
    for (var i = 0; i + span < points.length; i++) {
      var growth = (points[i + span].length - points[i].length) / (points[i + span].depth - points[i].depth);

      if (growth > steepestGrowth) {
        steepestGrowth = growth;
        steepest = i;
      }
    }

    if (steepest < 2) return null;

    var a = points[0], b = points[steepest];
    var slope = (b.length - a.length) / (b.depth - a.depth);
    var knee = null;
    var kneeGap = 0;

    for (var i = 1; i < steepest; i++) {
      var gap = a.length + slope * (points[i].depth - a.depth) - points[i].length;

      if (gap > kneeGap) {
        kneeGap = gap;
        knee = points[i].depth;
      }
    }

    return knee;
  }



  // finding and measuring

  // the starting levels and neck sections for a model; returns
  // { base, top, levels: [{ id, z }], neck: { cut, top, base } | null }
  // where base and top are the model's lowest and highest z, and neck.top and
  // neck.base are depths below the cut
  function find(sliceMesh) {
    var base = sliceMesh.min.z;
    var top = sliceMesh.max.z;
    var levels = [];

    for (var h = 0; base + Math.max(h, EDGE) <= top - EDGE; h += SPACING) {
      levels.push({ id: "L" + levels.length, z: base + Math.max(h, EDGE) });
    }

    var neck = null;
    var cut = findCut(sliceMesh);

    if (cut) {
      var neckBase = findNeckBase(neckProfile(sliceMesh, cut));

      neck = { cut: cut, top: EDGE, base: neckBase === null ? 60 : neckBase };
    }

    return { base: base, top: top, levels: levels, neck: neck };
  }

  function sectionRow(key, kind, name, loop, base) {
    if (!loop) return { key: key, kind: kind, name: name, height: null, value: null, segments: [] };

    return {
      key: key,
      kind: kind,
      name: name,
      height: loop.max.z - base,
      value: AutoMeasure.closedLength(loop.points),
      segments: AutoMeasure.closedSegments(loop.points),
      minZ: loop.min.z
    };
  }

  // measure the sections; returns rows from the top down (see above), and the
  // levels left out because they cut into the neck as excluded: [id]
  function measure(sliceMesh, state) {
    var rows = [];
    var excluded = [];
    var limit = Infinity;
    var neck = state.neck;

    if (neck) {
      var neckFaces = new NeckFaces(sliceMesh, neck.cut, Math.max(neck.top, neck.base) + 1);
      var topRow = sectionRow("neckTop", "neckTop", "Neck top",
        neckLoop(sliceMesh, neck.cut, neck.top, neckFaces), state.base);
      var baseRow = sectionRow("neckBase", "neckBase", "Neck base",
        neckLoop(sliceMesh, neck.cut, neck.base, neckFaces), state.base);

      rows.push(topRow, baseRow);

      // horizontal levels above the lowest point of the neck base cut into
      // the neck
      var lowest = baseRow.value !== null ? baseRow.minZ : topRow.value !== null ? topRow.minZ : null;
      if (lowest !== null) limit = lowest;
    }

    var levels = state.levels.slice().sort(function(a, b) { return b.z - a.z; });

    levels.forEach(function(level) {
      if (level.z > limit) {
        excluded.push(level.id);
        return;
      }

      // all the parts the level crosses (e.g. both legs)
      var loops = AutoMeasure.sectionLoops(sliceMesh, new Plane(new Vector3(0, 0, 1), -level.z))
        .filter(function(loop, i) { return i === 0 || loop.area >= MIN_PART; });
      var height = level.z - state.base;
      var value = null;
      var segments = [];

      loops.forEach(function(loop) {
        value += AutoMeasure.closedLength(loop.points);
        segments = segments.concat(AutoMeasure.closedSegments(loop.points));
      });

      rows.push({
        key: level.id,
        kind: "level",
        name: (height / 10).toFixed(1) + " cm",
        height: height,
        value: value,
        parts: loops.length,
        segments: segments
      });
    });

    return { rows: rows, excluded: excluded };
  }

  // the rows as tab-separated text to paste into a spreadsheet: height above
  // the base and circumference, both in cm to 1 decimal place, from the top
  // down
  function tableText(rows) {
    return rows.filter(function(row) { return row.value !== null; }).map(function(row) {
      return (row.height / 10).toFixed(1) + "\t" + (row.value / 10).toFixed(1);
    }).join("\r\n") + "\r\n";
  }

  // depth below the cut of the plane parallel to it through a point
  function depthOf(cut, point) {
    return cut.offset - cut.normal.dot(point);
  }



  return {
    find: find,
    findCut: findCut,
    neckProfile: neckProfile,
    findNeckBase: findNeckBase,
    measure: measure,
    tableText: tableText,
    depthOf: depthOf,
    SPACING: SPACING,
    EDGE: EDGE
  };

})();
