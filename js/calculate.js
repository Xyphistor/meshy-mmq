// calculate.js
//
// dependencies:
//  three.js
//
// description:
//  computation of various quantities from a THREE.Mesh
//
// classes:
//  none

// Anton Bovin, 2018



var Calculate = (function() {

  // shorthands for Three.js constructors

  var Vector3 = THREE.Vector3;
  var Line3 = THREE.Line3;
  var Box3 = THREE.Box3;
  var Plane = THREE.Plane;



  // internal functions - computations are performed on 3 vertices instead of
  // Face3 objects

  function _triangleArea(va, vb, vc) {
    var vab = va.clone().sub(vb);
    var vac = va.clone().sub(vc);

    // |(b - a) cross (c - a)| / 2
    return vab.cross(vac).length() / 2.0;
  }

  function _triangleVolume(va, vb, vc) {
    var volume = 0;
    volume += (-vc.x*vb.y*va.z + vb.x*vc.y*va.z + vc.x*va.y*vb.z);
    volume += (-va.x*vc.y*vb.z - vb.x*va.y*vc.z + va.x*vb.y*vc.z);

    return volume / 6.0;
  }

  function _triangleCenter(va, vb, vc) {
    var v = new Vector3();

    return v.add(va).add(vb).add(vc).divideScalar(3);
  }

  function _triangleCenterOfMass(va, vb, vc) {
    var v = new Vector3();

    return v.add(va).add(vb).add(vc).divideScalar(4);
  }

  function _triangleBoundingBox(va, vb, vc) {
    var box = new Box3();

    box.expandByPoint(va);
    box.expandByPoint(vb);
    box.expandByPoint(vc);

    return box;
  }

  function _planeTriangleIntersection(plane, va, vb, vc, normal) {
    // intersection points of the plane with all three face segments; each is
    // undefined if no intersection
    var iab = new Vector3();
    var ibc = new Vector3();
    var ica = new Vector3();

    iab = plane.intersectLine(new Line3(va, vb), iab);
    ibc = plane.intersectLine(new Line3(vb, vc), ibc);
    ica = plane.intersectLine(new Line3(vc, va), ica);

    var result = null;

    // if no intersections, return null
    if (iab === undefined && ibc === undefined && ica === undefined) {
      return null;
    }
    // in the anomalous situation that the plane intersects all three segments,
    // do special handling
    else if (iab !== undefined && ibc !== undefined && ica !== undefined) {
      // two possible degenerate cases:
      // 1. all three points lie on the plane, so there's no segment intersection
      // 2. two points lie on the plane - they form the segment
      var da = plane.distanceToPoint(va);
      var db = plane.distanceToPoint(vb);
      var dc = plane.distanceToPoint(vc);

      // if 1, return null
      if (da === 0 && db === 0 && dc === 0) return null;

      // if 2, two of the intersection points will be coincident; return two
      // non-coincident points (but only if one of them is above the plane)
      if (iab.equals(ibc) && (da > 0 || dc > 0)) result = new Line3(iab, ica);
      else if (ibc.equals(ica) && (db > 0 || da > 0)) result = new Line3(ibc, iab);
      else if (ica.equals(iab) && (dc > 0 || db > 0)) result = new Line3(ica, ibc);
      else return null;
    }
    // else two intersections, so get them and set the result
    else {
      // get the first and second intersections
      var v0 = iab !== undefined ? iab : ibc !== undefined ? ibc : ica;
      var v1 = v0 === iab ? (ibc !== undefined ? ibc : ica) : (v0 === ibc ? ica : undefined);

      // if either intersection doesn't exist, return null
      if (v0 === undefined || v1 === undefined) return null;
      // if intersection points are the same, return null
      if (v0.equals(v1)) return null;

      result = new Line3(v0, v1);
    }

    if (result === null) return null;

    // correct the order of points based on the normal
    var delta = new Vector3();
    result.delta(delta);

    if (normal.dot(delta.cross(plane.normal)) < 0) {
      var tmp = result.start;
      result.start = result.end;
      result.end = tmp;
    }

    return result;
  }



  // external functions

  // get an array of the face's vertices in the original winding order
  function _faceVertices(face, vertices, matrix, va, vb, vc) {
    va = va || new Vector3();
    vb = vb || new Vector3();
    vc = vc || new Vector3();

    va.copy(vertices[face.a]);
    vb.copy(vertices[face.b]);
    vc.copy(vertices[face.c]);

    if (matrix !== undefined) {
      va.applyMatrix4(matrix);
      vb.applyMatrix4(matrix);
      vc.applyMatrix4(matrix);
    }

    return [va, vb, vc];
  }

  // calculate face area
  function _faceArea(face, vertices, matrix) {
    var [va, vb, vc] = _faceVertices(face, vertices, matrix);

    return _triangleArea(va, vb, vc);
  }

  // calculate the volume of an irregular tetrahedron with one vertex at the
  // origin and the given face forming the remaining three vertices
  function _faceVolume(face, vertices, matrix) {
    var [va, vb, vc] = _faceVertices(face, vertices, matrix);

    return _triangleVolume(va, vb, vc);
  }

  // center of a face
  function _faceCenter(face, vertices, matrix) {
    var [va, vb, vc] = _faceVertices(face, vertices, matrix);

    return _triangleCenter(va, vb, vc);
  }

  // center of mass of an irregular tetrahedron with one vertex at the origin
  // and the given face forming the remaining three vertices
  function _faceCenterOfMass(face, vertices, matrix) {
    var [va, vb, vc] = _faceVertices(face, vertices, matrix);

    return _triangleCenterOfMass(va, vb, vc);
  }

  // calculate a bounding box for a face
  function _faceBoundingBox(face, vertices, matrix) {
    var [va, vb, vc] = _faceVertices(face, vertices, matrix);

    return _triangleBoundingBox(va, vb, vc);
  }

  // calculate the intersection of a face with an arbitrary plane
  function _planeFaceIntersection(plane, face, vertices, matrix) {
    var [va, vb, vc] = _faceVertices(face, vertices, matrix);

    var normal = face.normal.clone().transformDirection(matrix);

    return _planeTriangleIntersection(plane, va, vb, vc, normal);
  }

  // apply a function to each face
  // arguments:
  //  objects: an array of THREE.Mesh objects, or a single THREE.Mesh
  //  callback: takes three vertices, a normal, and an index, all in world
  //   space; these vectors are local variables in this function and should be
  //   copied, never stored directly
  function _traverseFaces(objects, callback) {
    if (Array.isArray(objects)) {
      for (var o = 0, ol = objects.length; o < ol; o++) {
        var mesh = objects[o];

        _traverseFaces(mesh, callback);
      }

      return;
    }

    var mesh = objects;

    var geo = mesh.geometry;
    var matrixWorld = mesh.matrixWorld;

    var va = new Vector3();
    var vb = new Vector3();
    var vc = new Vector3();
    var normal = new Vector3();

    if (geo.isBufferGeometry) {
      var index = geo.index;
      var position = geo.attributes.position;

      // indexed faces - each triple of indices represents a face
      if (index !== null) {
        for (var i = 0, l = index.count; i < l; i += 3) {
          var a = index.getX(i);
          var b = index.getX(i + 1);
          var c = index.getX(i + 2);

          va.fromBufferAttribute(position, a).applyMatrix4(matrixWorld);
          vb.fromBufferAttribute(position, b).applyMatrix4(matrixWorld);
          vc.fromBufferAttribute(position, c).applyMatrix4(matrixWorld);

          THREE.Triangle.getNormal(va, vb, vc, normal);

          callback(va, vb, vc, normal, i / 3);
        }
      }
      // else, each three contiguous verts in position attribute constitute a
      // face
      else {
        for (var i = 0, l = position.count; i < l; i += 3) {
          va.fromBufferAttribute(position, i).applyMatrix4(matrixWorld);
          vb.fromBufferAttribute(position, i + 1).applyMatrix4(matrixWorld);
          vc.fromBufferAttribute(position, i + 2).applyMatrix4(matrixWorld);

          THREE.Triangle.getNormal(va, vb, vc, normal);

          callback(va, vb, vc, normal, i / 3);
        }
      }
    }
    else {
      var faces = geo.faces, vertices = geo.vertices;

      for (var f = 0; f < faces.length; f++) {
        var face = faces[f];

        _faceVertices(face, vertices, matrixWorld, va, vb, vc);
        normal.copy(face.normal).transformDirection(matrixWorld);

        callback(va, vb, vc, normal, f);
      }
    }
  }

  // calculate the surface area of a mesh
  function _surfaceArea(mesh) {
    var area = 0;

    _traverseFaces(mesh, function(va, vb, vc) {
      area += _triangleArea(va, vb, vc);
    });

    return area;
  }

  // calculate the volume of a mesh
  function _volume(mesh) {
    var volume = 0;

    _traverseFaces(mesh, function(va, vb, vc) {
      volume += _triangleVolume(va, vb, vc);
    });

    return volume;
  }

  // calculate the center of mass of a mesh
  function _centerOfMass(mesh) {
    var center = new Vector3();
    var volume = 0;

    _traverseFaces(mesh, function(va, vb, vc) {
      var faceVolume = _triangleVolume(va, vb, vc);
      var faceCenterOfMass = _triangleCenterOfMass(va, vb, vc);

      // add current face's center of mass, weighted by its volume
      center.add(faceCenterOfMass.multiplyScalar(faceVolume));

      // update volume
      volume += faceVolume;
    });

    // divide by total volume to get center of mass
    return center.divideScalar(volume);
  }

  // calculate the intersection of the plane and mesh
  // arguments:
  //  plane: THREE.Plane
  //  mesh: THREE.Mesh
  //  splitPolygons: true to split the intersection into polygons, false to
  //    leave the result as an unordered array of segments
  // returns an array of objects like { segments, boundingBox, area, length }
  function _crossSection(plane, mesh, splitPolygons) {
    // don't split by default
    splitPolygons = splitPolygons || false;

    var point = new Vector3();
    plane.coplanarPoint(point);

    var pa = new Vector3();
    var pb = new Vector3();
    var delta = new Vector3();
    var cross = new Vector3();

    // store the segments forming the intersection
    var segments = [];

    _traverseFaces(mesh, function(va, vb, vc, normal) {
      var segment = _planeTriangleIntersection(plane, va, vb, vc, normal);

      // nonzero contribution if plane intersects face
      if (segment !== null) segments.push(segment);
    });

    // make an array of polygons - if not splitting, the only element will be
    // an aggregate of the all the segments of the cross-section
    var segmentSets = splitPolygons ? _polygonsFromSegments(segments) : [segments];

    // calculate a { segments, boundingBox, area, length } object for each poly
    var result = [];

    for (var ss = 0, lss = segmentSets.length; ss < lss; ss++) {
      var segmentSet = segmentSets[ss];

      var area = 0;
      var length = 0;
      var boundingBox = new Box3();

      for (var s = 0, ls = segmentSet.length; s < ls; s++) {
        var segment = segmentSet[s];

        boundingBox.expandByPoint(segment.start);
        boundingBox.expandByPoint(segment.end);

        // triangle between coplanar point and the two endpoints of the segment
        pa.subVectors(segment.start, point);
        pb.subVectors(segment.end, point);

        // compute area of the triangle; possibly change sign depending on the
        // normal
        segment.delta(delta);
        cross.crossVectors(delta, plane.normal);
        var sign = Math.sign(pa.dot(cross));
        var segmentArea = pa.cross(pb).length() / 2;

        // increment area
        area += segmentArea * sign;

        // increment length
        length += segment.distance();
      }

      // result for the current polygon
      result.push({
        segments: segmentSet,
        boundingBox: boundingBox,
        area: area,
        length: length
      });
    }

    return result;
  }

  // gets the contour (object like { segments, boundingBox, area, length })
  // whose total distance to the set of points is minimal
  function _nearestContourToPoints(contours, points) {
    if (contours.length < 1) return null;
    if (contours.length === 1) return contours[0];

    var n = points.length;
    var nearestContour = null;

    // the points will all have some distance from the nearest
    // contour - they should all be exactly on the contour, so their
    // total distance to the closest segments of the contour should be
    // about 0; use this fact to find the closest contour
    var minDist = Infinity;

    var closestPoint = new Vector3();

    for (var c = 0, lc = contours.length; c < lc; c++) {
      var contour = contours[c];

      // minimum distances of each marker point to the contour's segments
      var contourMinDist = [];
      for (var p = 0; p < n; p++) contourMinDist.push(Infinity);

      for (var s = 0, ls = contour.segments.length; s < ls; s++) {
        var segment = contour.segments[s];

        for (var p = 0; p < n; p++) {
          var point = points[p];

          // calculate closest point on segment to this point
          segment.closestPointToPoint(point, false, closestPoint);

          // update min distance from contour to this point
          contourMinDist[p] = Math.min(contourMinDist[p], closestPoint.distanceTo(point));
        }
      }

      var distSum = 0;
      for (var p = 0; p < n; p++) distSum += contourMinDist[p];

      if (distSum < minDist) {
        nearestContour = contour;
        minDist = distSum;
      }
    }

    return nearestContour;
  }

  // calculates a planar convex hull of a set of segments
  // arguments:
  //  plane: THREE.Plane
  //  segments: an array of THREE.Line3 objects
  // returns an object like { segments, boundingBox, area, length }
  function _planarConvexHull(plane, segments) {
    if (THREE.QuickHull === undefined) {
      console.error("Calculating the convex hull relies on THREE.QuickHull.");

      return null;
    }

    var boundingBox = new Box3();

    // build an array of the points forming the cross-section to compute
    // the hull
    var points = [];

    for (var p = 0, lp = segments.length; p < lp; p++) {
      var point = segments[p].start;

      points.push(point);
      boundingBox.expandByPoint(point);
    }

    // push two points on either side of the plane to force the convex
    // hull to occupy some volume (else, the 3D hull would be in a plane,
    // which is not well-defined behavior);
    // the resulting 3D hull will consist of triangles with two verts on
    // the intended 2D hull and the remaining vert on either above or
    // below vert
    var center = new Vector3();
    var size = new Vector3();
    boundingBox.getCenter(center);
    boundingBox.getSize(size);
    var maxSize = Math.max(size.x, size.y, size.z);

    var below = center.clone().addScaledVector(plane.normal, -maxSize);
    var above = center.clone().addScaledVector(plane.normal, maxSize);

    points.push(below, above);

    // compute the hull
    var hull = new THREE.QuickHull().setFromPoints(points);

    // get one of the halfedges in the plane of the cross-section
    var faces = hull.faces;
    var startHalfedge = null;

    for (var f = 0, lf = faces.length; f < lf; f++) {
      var face = faces[f];
      var he = face.edge;

      // iterate over a face's halfedges (wound CCW), find the one that
      // ends on above vert, get its predecessor
      do {
        if (he.head().point.equals(above)) {
          startHalfedge = he.prev;
          break;
        }
        he = he.next;
      } while (he !== face.edge);

      if (startHalfedge !== null) break;
    }

    // trace around the 2D hull from the starting halfedge, store segments
    var halfedge = startHalfedge;
    var segments = [];
    var area = 0;
    var length = 0;

    var pa = new Vector3();
    var pb = new Vector3();
    var delta = new Vector3();
    var cross = new Vector3();
    var planePoint = new Vector3();
    plane.coplanarPoint(planePoint);

    do {
      var v0 = halfedge.tail().point;
      var v1 = halfedge.head().point;
      var segment = new Line3(v0, v1);

      // push new segment
      segments.push(segment);

      // increment contour length
      length += v0.distanceTo(v1);

      pa.subVectors(v0, planePoint);
      pb.subVectors(v1, planePoint);

      // compute area of the triangle; possibly change sign depending on the
      // normal
      segment.delta(delta);
      cross.crossVectors(delta, plane.normal);
      var sign = Math.sign(pa.dot(cross));
      var segmentArea = pa.cross(pb).length() / 2;

      // increment area
      area += segmentArea * sign;

      halfedge = halfedge.next.twin.next;
    } while (halfedge !== startHalfedge);

    return {
      segments: segments,
      boundingBox: boundingBox,
      area: area,
      length: length
    };
  }

  // calculates the path along the surface of the mesh between two points, in
  // the plane through those two points and a third "via" point; the path
  // follows the cross-section contour from start to end, going the way around
  // that passes through the via point
  // arguments:
  //  mesh: THREE.Mesh
  //  start, via, end: THREE.Vector3 points on the surface of the mesh
  //  convexHull: if true, pull the path taut over the outside of the contour,
  //    bridging concavities as a tape measure would
  // returns an object like { points, segments, boundingBox, length, closed },
  // or null if no path exists
  function _surfacePath(mesh, start, via, end, convexHull) {
    var normal = new Vector3().subVectors(via, start);
    normal.cross(new Vector3().subVectors(end, start)).normalize();

    // if the points are collinear, the plane is undefined
    if (normal.length() === 0) return null;

    var plane = new Plane().setFromNormalAndCoplanarPoint(normal, start);

    // store the segments forming the intersection
    var segments = [];

    _traverseFaces(mesh, function(va, vb, vc, faceNormal) {
      var segment = _planeTriangleIntersection(plane, va, vb, vc, faceNormal);

      // nonzero contribution if plane intersects face
      if (segment !== null) segments.push(segment);
    });

    return _pathOnChains(_chainsFromSegments(segments), normal, start, via, end, convexHull);
  }

  // given the chains forming a cross-section (from _chainsFromSegments) and
  // the plane normal, find the path from start to end along the chain nearest
  // to them, going the way around that passes closest to via; via need not be
  // on the surface - any point on the correct side of the cross-section works
  // returns an object like { points, segments, boundingBox, length, closed },
  // or null if no path exists
  function _pathOnChains(chains, normal, start, via, end, convexHull) {
    // find the chain closest to the start and end and locate them on it
    var chain = null;
    var ls = null;
    var le = null;
    var minDist = Infinity;

    for (var c = 0, lc = chains.length; c < lc; c++) {
      var startLocation = _locateOnChain(chains[c], start);
      var endLocation = _locateOnChain(chains[c], end);
      var dist = startLocation.distance + endLocation.distance;

      if (dist < minDist) {
        chain = chains[c];
        ls = startLocation;
        le = endLocation;
        minDist = dist;
      }
    }

    if (chain === null) return null;

    var lv = _locateOnChain(chain, via);

    // determine which way along the chain to go from start to end; on a
    // closed chain, go forward if the via point comes before the end point
    var forward;

    if (chain.closed) {
      var dEnd = _mod(le.distanceAlong - ls.distanceAlong, chain.length);
      var dVia = _mod(lv.distanceAlong - ls.distanceAlong, chain.length);

      forward = dVia <= dEnd;
    }
    else {
      forward = le.distanceAlong >= ls.distanceAlong;
    }

    var points = _chainPortion(chain, ls, le, forward);

    // chains are wound CCW about the plane normal, so the mesh interior is on
    // the left going forward and on the right going backward
    if (convexHull) points = _tautPath(points, normal, forward ? 1 : -1);

    var pathSegments = [];
    var boundingBox = new Box3();
    var length = 0;

    for (var p = 0, lp = points.length; p < lp; p++) {
      boundingBox.expandByPoint(points[p]);

      if (p > 0) {
        pathSegments.push(new Line3(points[p - 1], points[p]));
        length += points[p - 1].distanceTo(points[p]);
      }
    }

    return {
      points: points,
      segments: pathSegments,
      boundingBox: boundingBox,
      length: length,
      closed: chain.closed
    };
  }

  // non-negative remainder of a / n
  function _mod(a, n) {
    return ((a % n) + n) % n;
  }

  // like _polygonsFromSegments, but also keeps open chains (e.g., where the
  // plane passes through a hole in the mesh); returns an array of chains, as
  // made by _makeChain
  function _chainsFromSegments(segments, p) {
    p = p !== undefined ? p : 1e5;

    var n = segments.length;
    var startHashes = [];
    var endHashes = [];
    var used = [];

    // maps from vertex hashes to the indices of segments starting/ending there
    var startMap = {};
    var endMap = {};

    for (var s = 0; s < n; s++) {
      var startHash = _vectorHash(segments[s].start, p);
      var endHash = _vectorHash(segments[s].end, p);

      startHashes.push(startHash);
      endHashes.push(endHash);

      // segments too short to hash to two different values are skipped
      used.push(startHash === endHash);

      if (startHash === endHash) continue;

      (startMap[startHash] = startMap[startHash] || []).push(s);
      (endMap[endHash] = endMap[endHash] || []).push(s);
    }

    function nextUnused(indices) {
      if (indices === undefined) return -1;

      for (var i = 0; i < indices.length; i++) {
        if (!used[indices[i]]) return indices[i];
      }

      return -1;
    }

    var chains = [];

    for (var s = 0; s < n; s++) {
      if (used[s]) continue;

      used[s] = true;

      var forwardPoints = [segments[s].start, segments[s].end];
      var backwardPoints = [];
      var closed = false;
      var current, next;

      // extend forward until the chain closes or runs out
      current = s;
      while ((next = nextUnused(startMap[endHashes[current]])) !== -1) {
        used[next] = true;
        current = next;

        if (endHashes[current] === startHashes[s]) {
          closed = true;
          break;
        }

        forwardPoints.push(segments[current].end);
      }

      // if open, also extend backward from the first segment
      if (!closed) {
        current = s;
        while ((next = nextUnused(endMap[startHashes[current]])) !== -1) {
          used[next] = true;
          current = next;

          backwardPoints.push(segments[current].start);
        }
      }

      chains.push(_makeChain(backwardPoints.reverse().concat(forwardPoints), closed));
    }

    return chains;
  }

  // make a chain object from an ordered array of points; if closed, the last
  // point connects back to the first
  function _makeChain(points, closed) {
    var n = points.length;
    var cumulative = [0];

    for (var i = 1; i < n; i++) {
      cumulative.push(cumulative[i - 1] + points[i - 1].distanceTo(points[i]));
    }

    var length = cumulative[n - 1];
    if (closed) length += points[n - 1].distanceTo(points[0]);

    return {
      points: points,
      closed: closed,
      // distance along the chain to each point
      cumulative: cumulative,
      length: length
    };
  }

  // find the closest point on a chain to the given point; returns an object
  // like { index, t, point, distance, distanceAlong }, where index is the
  // chain segment, t is the parameter along it, and distanceAlong is the
  // distance from the start of the chain
  function _locateOnChain(chain, point) {
    var points = chain.points;
    var n = points.length;
    var segmentCount = chain.closed ? n : n - 1;

    var line = new Line3();
    var closest = new Vector3();

    var result = {
      index: 0,
      t: 0,
      point: points[0].clone(),
      distance: Infinity,
      distanceAlong: 0
    };

    for (var i = 0; i < segmentCount; i++) {
      line.set(points[i], points[(i + 1) % n]);

      var t = line.closestPointToPointParameter(point, true);
      line.at(t, closest);

      var distance = closest.distanceTo(point);

      if (distance < result.distance) {
        result.index = i;
        result.t = t;
        result.point.copy(closest);
        result.distance = distance;
        result.distanceAlong = chain.cumulative[i] + t * line.distance();
      }
    }

    return result;
  }

  // get the points along a chain between two locations (from _locateOnChain),
  // going forward or backward along the chain
  function _chainPortion(chain, from, to, forward) {
    var points = chain.points;
    var n = points.length;
    var result = [from.point.clone()];

    var sameSegment = from.index === to.index && (forward ? from.t <= to.t : from.t >= to.t);

    if (!sameSegment) {
      // going forward, the vertices run from the end of the "from" segment to
      // the start of the "to" segment; going backward, the reverse
      var k = forward ? (from.index + 1) % n : from.index;
      var last = forward ? to.index : (to.index + 1) % n;
      var step = forward ? 1 : n - 1;

      for (var i = 0; i < n; i++) {
        result.push(points[k].clone());

        if (k === last) break;

        k = (k + step) % n;
      }
    }

    result.push(to.point.clone());

    return result;
  }

  // pull an open planar path taut over its convex side, as a string pinned at
  // both ends would be, skipping across any concavities;
  // normal is the plane normal and sign is 1 if the mesh interior is on the
  // left of the path (viewed from the normal side), -1 if on the right
  function _tautPath(points, normal, sign) {
    var stack = [];
    var a = new Vector3();
    var b = new Vector3();

    for (var i = 0, l = points.length; i < l; i++) {
      var q = points[i];

      // pop vertices where the path turns away from the interior (concave) or
      // goes straight
      while (stack.length >= 2) {
        var p0 = stack[stack.length - 2];
        var p1 = stack[stack.length - 1];

        a.subVectors(p1, p0);
        b.subVectors(q, p1);

        if (sign * normal.dot(a.cross(b)) > 0) break;

        stack.pop();
      }

      stack.push(q);
    }

    return stack;
  }

  // calculate circle normal, center, and radius from three coplanar points:
  // take two pairs of coplanar points, calculate bisector of both pairs;
  // the bisectors will intersect at the center
  function _circleFromThreePoints(p0, p1, p2) {
    var sa = p0.clone().sub(p1);
    var sb = p2.clone().sub(p1);

    // normal
    var normal = sa.clone().cross(sb).normalize();

    // if points are collinear, can't compute the circle, so unready the
    // result and return
    if (normal.length() === 0) return null;

    // bisector points
    var pa = p0.clone().add(p1).multiplyScalar(0.5);
    var pb = p2.clone().add(p1).multiplyScalar(0.5);

    // bisector directions
    var da = normal.clone().cross(sa).normalize();
    var db = normal.clone().cross(sb).normalize();

    // the bisectors won't generally intersect exactly, but we can
    // calculate a point of closest approach:
    // if line 0 and 1 are
    // v0 = p0 + t0d0, v1 = p1 + t1d1, then
    // t0 = ((d0 - d1 (d0 dot d1)) dot (p1 - p0)) / (1 - (d0 dot d1)^2)
    // t1 = ((d0 (d0 dot d1) - d1) dot (p1 - p0)) / (1 - (d0 dot d1)^2)

    var dadb = da.dot(db);
    var denominator = 1 - dadb * dadb;

    // just in case, to avoid division by 0
    if (denominator === 0) return null;

    // scalar parameter
    var ta = da.clone().addScaledVector(db, -dadb).dot(pb.clone().sub(pa)) / denominator;

    var center = pa.clone().addScaledVector(da, ta);
    var radius = center.distanceTo(p2);

    return {
      normal: normal,
      center: center,
      radius: radius
    };
  }

  // hash map utilities for extracting polygons from segment lists

  function _numHash(n, p) {
    return Math.round(n*p);
  }

  function _vectorHash(v, p) {
    return _numHash(v.x, p)+'_' + _numHash(v.y, p) + '_' + _numHash(v.z, p);
  }

  function _objectGetKey(object) {
    for (var key in object) return key;
    return null;
  }

  function _polygonsFromSegments(segments, p) {
    p = p !== undefined ? p : 1e5;

    // adjacency map
    var m = {};

    // build the map
    for (var s = 0, l = segments.length; s < l; s++) {
      var segment = segments[s];
      var startHash = _vectorHash(segment.start, p);
      var endHash = _vectorHash(segment.end, p);

      // if segment is sufficiently long that its start and end don't hash to
      // the same value, add it to the map
      if (startHash !== endHash) m[startHash] = segment;
    }

    for (var s = 0, l = segments.length; s < l; s++) {
      var segment = segments[s];
      var startHash = _vectorHash(segment.start, p);
      var endHash = _vectorHash(segment.end, p);
    }

    // extract the polygons
    var polygons = [];
    var polygon;

    var start;
    var current = null;

    while ((start = _objectGetKey(m)) !== null) {
      current = start;
      polygon = [];

      do {
        segment = m[current];

        if (segment === undefined) break;

        polygon.push(segment);
        delete m[current];

        current = _vectorHash(segment.end, p);
      } while (current !== start);

      if (current === start) polygons.push(polygon);
    }

    return polygons;
  }

  return {
    faceVertices: _faceVertices,
    faceArea: _faceArea,
    faceCenter: _faceCenter,
    faceBoundingBox: _faceBoundingBox,

    traverseFaces: _traverseFaces,

    surfaceArea: _surfaceArea,
    volume: _volume,
    centerOfMass: _centerOfMass,
    crossSection: _crossSection,
    nearestContourToPoints: _nearestContourToPoints,
    planarConvexHull: _planarConvexHull,
    surfacePath: _surfacePath,
    pathOnChains: _pathOnChains,
    chainsFromSegments: _chainsFromSegments,
    circleFromThreePoints: _circleFromThreePoints
  };

})();
