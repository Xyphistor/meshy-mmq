// measurementFile.js
//
// dependencies:
//  three.js
//
// description:
//  saved sets of measurements: the automatic measurement landmarks and the
//  points of the manual measurements, so they can be put back on the same
//  scan later
//
//  points are stored in mm relative to the minimum corner of the scan's
//  bounding box, so they still line up if the scan is imported in a
//  different place; the values are stored for reference only
//
//  the cover measurements are saved as the heights of their levels above the
//  base and, for the neck sections, the neck cut plane and their depths
//  below it
//
//  also reads the version 1 files saved by Auto Measure, which only have the
//  automatic measurement landmarks
//
// example:
//  var data = MeasurementFile.create({
//    name: "Customer",
//    scan: "scan.obj",
//    min: modelMin, size: modelSize,
//    autoMeasure: { mode: "basic", landmarks: landmarks }, // or null
//    cover: coverState, // from CoverMeasure.find, or null
//    measurements: [{ name, type, axis, convexHull, nearestContour, points }],
//    values: [{ group, name, value, unit }]
//  });
//
//  var read = MeasurementFile.read(data, modelMin, modelSize);
//  // read.autoMeasure.landmarks and read.measurements[i].points are placed
//  // on the current scan

var MeasurementFile = (function() {

  var Vector3 = THREE.Vector3;

  var FORMAT = "meshy-measurements";
  var VERSION = 2;
  // the format of the version 1 files saved by Auto Measure
  var AUTO_MEASURE_FORMAT = "meshy-auto-measure";

  // measurement params saved along with the points
  var MEASUREMENT_PARAMS = ["type", "axis", "convexHull", "nearestContour"];

  function round(v, places) {
    var f = Math.pow(10, places);

    return Math.round(v * f) / f;
  }

  function relative(p, min) {
    return [round(p.x - min.x, 2), round(p.y - min.y, 2), round(p.z - min.z, 2)];
  }

  function absolute(a, min) {
    if (!Array.isArray(a) || a.length !== 3) return null;

    return new Vector3(a[0] + min.x, a[1] + min.y, a[2] + min.z);
  }

  // data to save to a file
  // params:
  //  name: report name
  //  scan: scan filename
  //  min, size: the scan's bounding box minimum and size, in mm
  //  autoMeasure: { mode, landmarks } or null; landmarks include midX
//  cover: the cover measurements' state (see CoverMeasure.find) or null
  //  measurements: array of { name, type, axis, convexHull, nearestContour,
  //   points }
  //  values: array of { group, name, value, unit }, for reference
  function create(params) {
    var min = params.min;
    var size = params.size;
    var autoMeasure = null;

    if (params.autoMeasure) {
      var landmarks = {};
      var lm = params.autoMeasure.landmarks;

      for (var key in lm) {
        if (lm[key] && lm[key].isVector3) landmarks[key] = relative(lm[key], min);
      }

      autoMeasure = {
        mode: params.autoMeasure.mode,
        midX: round(lm.midX - min.x, 2),
        landmarks: landmarks
      };
    }

    return {
      format: FORMAT,
      version: VERSION,
      saved: new Date().toISOString(),
      name: params.name || "",
      scan: params.scan || "",
      units: "mm",
      scanSize: [round(size.x, 2), round(size.y, 2), round(size.z, 2)],
      autoMeasure: autoMeasure,
      cover: params.cover ? createCover(params.cover, min) : null,
      measurements: params.measurements.map(function(m) {
        var saved = { name: m.name };

        MEASUREMENT_PARAMS.forEach(function(key) {
          if (m[key] !== undefined) saved[key] = m[key];
        });

        saved.points = m.points.map(function(p) { return relative(p, min); });

        return saved;
      }),
      values: params.values
    };
  }

  function createCover(cover, min) {
    var neck = cover.neck;

    return {
      // heights above the base of the scan
      levels: cover.levels.map(function(level) { return round(level.z - min.z, 2); }),
      neck: neck ? {
        cutNormal: [round(neck.cut.normal.x, 6), round(neck.cut.normal.y, 6), round(neck.cut.normal.z, 6)],
        cutCentre: relative(neck.cut.centroid, min),
        top: round(neck.top, 2),
        base: round(neck.base, 2)
      } : null
    };
  }

  function readCover(cover, min) {
    if (!cover || !Array.isArray(cover.levels)) return null;

    var neck = null;
    var n = cover.neck;

    if (n && Array.isArray(n.cutNormal) && n.cutNormal.length === 3) {
      var normal = new Vector3(n.cutNormal[0], n.cutNormal[1], n.cutNormal[2]).normalize();
      var centroid = absolute(n.cutCentre, min);

      if (centroid && typeof n.top === "number" && typeof n.base === "number") {
        neck = {
          cut: { normal: normal, offset: normal.dot(centroid), centroid: centroid },
          top: n.top,
          base: n.base
        };
      }
    }

    return {
      levels: cover.levels.filter(function(h) { return typeof h === "number"; })
        .map(function(h) { return h + min.z; }),
      neck: neck
    };
  }

  // a saved set placed on the scan with the given bounding box minimum and
  // size
  // returns {
  //  name, scan,
  //  sizeDifference: largest difference in mm between the saved and current
  //   scan sizes,
  //  autoMeasure: { mode, landmarks } or null; landmarks may be incomplete,
  //  cover: { levels: [z], neck: { cut, top, base } or null } or null,
  //  measurements: array of { name, type, axis, convexHull, nearestContour,
  //   points }
  // }
  function read(data, min, size) {
    if (!data || (data.format !== FORMAT && data.format !== AUTO_MEASURE_FORMAT)) {
      throw new Error("This isn't a measurements file.");
    }

    if (data.format === FORMAT && data.version > VERSION) {
      throw new Error("This file was saved by a newer version of Meshy.");
    }

    // version 1 Auto Measure files only have the automatic measurements, at
    // the top level; files from before there was a basic mode are full
    var auto = data.format === AUTO_MEASURE_FORMAT ?
      { mode: data.mode || "full", midX: data.midX, landmarks: data.landmarks } :
      data.autoMeasure;
    var autoMeasure = null;

    if (auto && auto.landmarks) {
      var landmarks = {};

      for (var key in auto.landmarks) {
        var p = absolute(auto.landmarks[key], min);
        if (p) landmarks[key] = p;
      }

      if (typeof auto.midX === "number") landmarks.midX = auto.midX + min.x;

      autoMeasure = { mode: auto.mode, landmarks: landmarks };
    }

    var measurements = (data.measurements || []).map(function(m) {
      var read = { name: m.name || "" };

      MEASUREMENT_PARAMS.forEach(function(key) {
        if (m[key] !== undefined) read[key] = m[key];
      });

      read.points = (m.points || []).map(function(a) { return absolute(a, min); });

      return read;
    }).filter(function(m) {
      return m.type && m.points.length > 0 && m.points.every(function(p) { return p !== null; });
    });

    var sizeDifference = 0;

    if (data.scanSize && data.scanSize.length === 3) {
      sizeDifference = Math.max(
        Math.abs(data.scanSize[0] - size.x),
        Math.abs(data.scanSize[1] - size.y),
        Math.abs(data.scanSize[2] - size.z)
      );
    }

    return {
      name: data.name || "",
      scan: data.scan || "",
      sizeDifference: sizeDifference,
      autoMeasure: autoMeasure,
      cover: data.format === FORMAT ? readCover(data.cover, min) : null,
      measurements: measurements
    };
  }

  return {
    create: create,
    read: read
  };

})();
