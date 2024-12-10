var proj4 = require('proj4');
var vec3 = require('gl-vec3');
var mat4 = require('gl-mat4');
var util = require('./util');

proj4 = proj4.__esModule ? proj4.default : proj4;
/* Ensure all projections in proj4 are included. */
var projections = require.context('proj4/projections', true, /.*\.js$/);
projections.keys().forEach(function (key) {
  proj4.Proj.projections.add(projections(key));
});

var transformCache = {};
/* Up to maxTransformCacheSize squared might be cached.  When the maximum cache
 * size is reached, the cache is completely emptied.  Since we probably won't
 * be rapidly switching between a large number of transforms, this is adequate
 * simple behavior. */
var maxTransformCacheSize = 10;

/* A RegExp to detect if two transforms only different by the middle axis's
 * direction. */
var axisPattern = /^(.* |)\+axis=e(n|s)u(| .*)$/;
var affinePattern = /(^|\s)\+(s[1-3][1-3]|[xyz]off)=\S/;

/**
 * This purpose of this class is to provide a generic interface for computing
 * coordinate transformations.  The interface is taken from proj4js, which also
 * provides the geospatial projection implementation.  The interface is
 * intentionally simple to allow for custom, non-geospatial use cases.  For
 * further details, see http://proj4js.org/
 *
 * The default transforms lat/long coordinates into web mercator for use with
 * standard tile sets.
 *
 * This class is intended to be extended in the future to support 2.5 and 3
 * dimensional transformations.  The forward/inverse methods take optional
 * z values that are ignored in current mapping context, but will in the
 * future perform more general 3D transformations.
 *
 * @class
 * @alias geo.transform
 * @param {object} options Constructor options
 * @param {string} options.source A proj4 string for the source projection
 * @param {string} options.target A proj4 string for the target projection
 * @returns {geo.transform}
 */
var transform = function (options) {
  'use strict';
  if (!(this instanceof transform)) {
    options = options || {};
    if (!(options.source in transformCache)) {
      if (Object.keys(transformCache).length >= maxTransformCacheSize) {
        transformCache = {};
      }
      transformCache[options.source] = {};
    }
    if (!(options.target in transformCache[options.source])) {
      if (Object.keys(transformCache[options.source]).length >= maxTransformCacheSize) {
        transformCache[options.source] = {};
      }
      transformCache[options.source][options.target] = new transform(options);
    }
    return transformCache[options.source][options.target];
  }

  var m_this = this,
      m_proj,              // The raw proj4js object
      m_source,            // The source projection
      m_target,            // The target projection
      m_source_matrix,     // an additional transformation for the source
      m_source_matrix_inv,
      m_target_matrix,     // an additional transformation for the target
      m_target_matrix_inv;

  var AffineFactorPositions = {
    s11: 0,
    s12: 4,
    s13: 8,
    xoff: 12,
    s21: 1,
    s22: 5,
    s23: 9,
    yoff: 13,
    s31: 2,
    s32: 6,
    s33: 10,
    zoff: 14
  };

  /**
   * Parse a projection string.  If the projection string includes any of
   * +s[123][123]= or +[xyz]off=, those values are converted into a matrix and
   * removed from the projection string.  This allows applying affine
   * transforms as specified in Proj 6.0.0 to be used (excluding toff and
   * tscale).  This could can be removed once proj4js supports the affine
   * parameters.
   *
   * @param {string} value A proj4 string possibly with affine parameters.
   * @returns {object} An object with a string value 'proj' and optional array
   *    values 'matrix' and 'inverse' (either both or neither will be present).
   *    The returned matrices are always 16-value arrays if present.  The proj
   *    value is the proj4 string with the affine parameters removed.
   */
  function parse_projection(value) {
    if (!affinePattern.exec(value)) {
      return {proj: value};
    }
    var mat = util.mat4AsArray(),
        newvalue = [],
        inv, result;
    value.split(/(\s+)/).forEach((part) => {
      var match = /^\+(s[1-3][1-3]|[xyz]off)=(.*)$/.exec(part);
      if (!match) {
        newvalue.push(part);
      } else {
        mat[AffineFactorPositions[match[1]]] = parseFloat(match[2]);
      }
    });
    result = {
      proj: newvalue.join(' '),
      orig: value
    };
    inv = mat4.invert(util.mat4AsArray(), mat);
    // only store if the matrix is invertable
    if (inv) {
      result.matrix = mat;
      result.inverse = inv;
    } else {
      console.warn('Affine transform is not invertable and will not be used: ' + value);
    }
    return result;
  }

  /**
   * Generate the internal proj4 object.
   * @private
   */
  function generate_proj4() {
    var source_proj = parse_projection(m_this.source()),
        target_proj = parse_projection(m_this.target()),
        source = source_proj.proj,
        target = target_proj.proj;
    m_source_matrix = source_proj.matrix;
    m_source_matrix_inv = source_proj.inverse;
    m_target_matrix = target_proj.matrix;
    m_target_matrix_inv = target_proj.inverse;
    m_proj = new proj4(source, target);
  }

  /**
   * Get/Set the source projection.
   *
   * @param {string} [arg] The new source projection.  If `undefined`, return
   *    the current source projection.
   * @returns {string|this} The current source projection if it was queried,
   *    otherwise the current transform object.
   */
  this.source = function (arg) {
    if (arg === undefined) {
      return m_source || 'EPSG:4326';
    }
    m_source = arg;
    generate_proj4();
    return m_this;
  };

  /**
   * Get/Set the target projection.
   *
   * @param {string} [arg] The new target projection.  If `undefined`, return
   *    the current target projection.
   * @returns {string|this} The current target projection if it was queried,
   *    otherwise the current transform object.
   */
  this.target = function (arg) {
    if (arg === undefined) {
      return m_target || 'EPSG:3857';
    }
    m_target = arg;
    generate_proj4();
    return m_this;
  };

  /**
   * Perform a forward transformation (source -> target).
   * @protected
   *
   * @param {geo.geoPosition} point The point in source coordinates.
   * @returns {geo.geoPosition} A point object in the target coordinates.
   */
  this._forward = function (point) {
    if (m_source_matrix) {
      var mp = vec3.transformMat4(util.vec3AsArray(), [point.x, point.y, point.z || 0], m_source_matrix_inv);
      point = {x: mp[0], y: mp[1], z: mp[2]};
    }
    var pt = m_proj.forward(point, true);
    pt.z = point.z || 0;
    if (m_target_matrix) {
      var ip = vec3.transformMat4(util.vec3AsArray(), [pt.x, pt.y, pt.z], m_target_matrix);
      pt = {x: ip[0], y: ip[1], z: ip[2]};
    }
    return pt;
  };

  /**
   * Perform an inverse transformation (target -> source).
   * @protected
   *
   * @param {geo.geoPosition} point The point in target coordinates.
   * @returns {geo.geoPosition} A point object in the source coordinates.
   */
  this._inverse = function (point) {
    if (m_target_matrix) {
      var mp = vec3.transformMat4(util.vec3AsArray(), [point.x, point.y, point.z || 0], m_target_matrix_inv);
      point = {x: mp[0], y: mp[1], z: mp[2]};
    }
    var pt = m_proj.inverse(point, true);
    pt.z = point.z || 0;
    if (m_source_matrix) {
      var ip = vec3.transformMat4(util.vec3AsArray(), [pt.x, pt.y, pt.z], m_source_matrix);
      pt = {x: ip[0], y: ip[1], z: ip[2]};
    }
    return pt;
  };

  /**
   * Perform a forward transformation (source -> target) in place.
   * @protected
   *
   * @param {geo.geoPosition|geo.geoPosition[]} point The point coordinates
   *    or array of points in source coordinates.
   * @returns {geo.geoPosition|geo.geoPosition[]} A point object or array in
   *    the target coordinates.
   */
  this.forward = function (point) {
    if (Array.isArray(point)) {
      return point.map(m_this._forward);
    }
    return m_this._forward(point);
  };

  /**
   * Perform an inverse transformation (target -> source) in place.
   * @protected
   *
   * @param {geo.geoPosition|geo.geoPosition[]} point The point coordinates
   *    or array of points in target coordinates.
   * @returns {geo.geoPosition|geo.geoPosition[]} A point object or array in
   *    the source coordinates.
   */
  this.inverse = function (point) {
    if (Array.isArray(point)) {
      return point.map(m_this._inverse);
    }
    return m_this._inverse(point);
  };

  // Set defaults given by the constructor
  options = options || {};
  try {
    this.source(options.source);
  } catch (err) {
    console.error('Can\'t use transform source: ' + options.source);
    this.source('EPSG:4326');
  }
  try {
    this.target(options.target);
  } catch (err) {
    console.error('Can\'t use transform target: ' + options.target);
    this.target('EPSG:3857');
  }

  return this;
};

/**
 * Contains a reference to `proj4.defs`.  The functions serves two
 * purposes.
 *
 *   1. It is a key value mapping of all loaded projection definitions
 *   2. It is a function that will add additional definitions.
 *
 * See:
 *   http://proj4js.org/
 */
transform.defs = proj4.defs;

/**
 * Look up a projection definition from epsg.io.
 * For the moment, we only handle `EPSG` codes.
 *
 * @param {string} projection A projection alias (e.g. EPSG:4326)
 * @returns {promise} Resolves with the proj4 definition
 */
transform.lookup = function (projection) {
  var $ = require('jquery');
  var code, defer = $.Deferred(), parts;

  if (proj4.defs.hasOwnProperty(projection)) {
    return defer.resolve(proj4.defs[projection]);
  }

  parts = projection.split(':');
  if (parts.length !== 2 || parts[0].toUpperCase() !== 'EPSG') {
    return defer.reject('Invalid projection code').promise();
  }
  code = parts[1];

  return $.ajax({
    url: 'https://epsg.io/' + encodeURIComponent(code) + '.proj4'
  }).done(function (data) {
    var result = (data.results || [])[0];
    if (!result) {
      return defer.reject(data).promise();
    }

    proj4.defs(projection, result);
    return $.when(proj4.defs[projection]);
  });
};

/**
 * Transform an array of coordinates from one projection into another.  The
 * transformation may occur in place (modifying the input coordinate array),
 * depending on the input format.  The coordinates can be an object with x,
 * y, and (optionally z) or an array of 2 or 3 values, or an array of either
 * of those, or a single flat array with 2 or 3 components per coordinate.
 * Arrays are always modified in place.  Individual point objects are not
 * altered; new point objects are returned unless no transform is needed.
 *
 * @param {string} srcPrj The source projection.
 * @param {string} tgtPrj The destination projection.
 * @param {geo.geoPosition|geo.geoPosition[]|number[]} coordinates An array of
 *    coordinate objects.  These may be in object or array form, or a flat
 *    array.
 * @param {number} [numberOfComponents] For flat arrays, either 2 or 3.
 * @returns {geo.geoPosition|geo.geoPosition[]|number[]} The transformed
 *    coordinates.
 */
transform.transformCoordinates = function (srcPrj, tgtPrj, coordinates, numberOfComponents) {
  'use strict';

  if (srcPrj === tgtPrj || (Array.isArray(coordinates) && !coordinates.length)) {
    return coordinates;
  }

  if (Array.isArray(coordinates) && coordinates.length >= 3 && numberOfComponents === 3 && !util.isObject(coordinates[0]) && !affinePattern.test(srcPrj) && !affinePattern.test(tgtPrj)) {
    return transform.transformCoordinatesFlatArray3(srcPrj, tgtPrj, coordinates);
  }
  if (Array.isArray(coordinates) && coordinates.length && util.isObject(coordinates[0]) && 'x' in coordinates[0] && 'y' in coordinates[0]) {
    var smatch = srcPrj.match(axisPattern),
        tmatch = tgtPrj.match(axisPattern);
    // if the two projections only differ in the middle axis
    if (smatch && tmatch && smatch[1] === tmatch[1] && smatch[3] === tmatch[3]) {
      if ('z' in coordinates[0]) {
        return coordinates.map(p => ({x: +p.x, y: -p.y, z: +p.z || 0}));
      }
      return coordinates.map(p => ({x: +p.x, y: -p.y}));
    }
  }
  var trans = transform({source: srcPrj, target: tgtPrj}), output;
  if (util.isObject(coordinates) && 'x' in coordinates && 'y' in coordinates) {
    output = trans.forward({x: +coordinates.x, y: +coordinates.y, z: +coordinates.z || 0}, true);
    if ('z' in coordinates) {
      return output;
    }
    return {x: output.x, y: output.y};
  }
  if (Array.isArray(coordinates) && coordinates.length === 1 &&
      util.isObject(coordinates[0]) && 'x' in coordinates[0] &&
      'y' in coordinates[0]) {
    output = trans.forward({x: +coordinates[0].x, y: +coordinates[0].y, z: +coordinates[0].z || 0}, true);
    if ('z' in coordinates[0]) {
      return [output];
    }
    return [{x: output.x, y: output.y}];
  }
  return transform.transformCoordinatesArray(trans, coordinates, numberOfComponents);
};

/**
 * Transform an array of coordinates from one projection into another.  The
 * transformation may occur in place (modifying the input coordinate array),
 * depending on the input format.  The coordinates can be an array of 2 or 3
 * values, or an array of either of those, or a single flat array with 2 or 3
 * components per coordinate.  The array is modified in place.
 *
 * @param {transform} trans The transformation object.
 * @param {geo.geoPosition[]|number[]} coordinates An array of coordinate
 *      objects or a flat array.
 * @param {number} numberOfComponents For flat arrays, either 2 or 3.
 * @returns {geo.geoPosition[]|number[]} The transformed coordinates
 */
transform.transformCoordinatesArray = function (trans, coordinates, numberOfComponents) {
  var i, count, offset, xAcc, yAcc, zAcc, writer, output, projPoint,
      initPoint = {};

  // Default Z accessor
  zAcc = function () {
    return 0.0;
  };

  // Helper methods
  function handleArrayCoordinates() {
    if (Array.isArray(coordinates[0])) {
      if (coordinates[0].length === 2) {
        xAcc = function (index) {
          return +coordinates[index][0];
        };
        yAcc = function (index) {
          return +coordinates[index][1];
        };
        writer = function (index, x, y) {
          output[index] = [x, y];
        };
      } else if (coordinates[0].length === 3) {
        xAcc = function (index) {
          return +coordinates[index][0];
        };
        yAcc = function (index) {
          return +coordinates[index][1];
        };
        zAcc = function (index) {
          return +coordinates[index][2];
        };
        writer = function (index, x, y, z) {
          output[index] = [x, y, z];
        };
      } else {
        throw new Error('Invalid coordinates. Requires two or three components per array');
      }
    } else {
      if (coordinates.length === 2) {
        offset = 2;

        xAcc = function (index) {
          return +coordinates[index * offset];
        };
        yAcc = function (index) {
          return +coordinates[index * offset + 1];
        };
        writer = function (index, x, y) {
          output[index] = x;
          output[index + 1] = y;
        };
      } else if (coordinates.length === 3) {
        offset = 3;

        xAcc = function (index) {
          return +coordinates[index * offset];
        };
        yAcc = function (index) {
          return +coordinates[index * offset + 1];
        };
        zAcc = function (index) {
          return +coordinates[index * offset + 2];
        };
        writer = function (index, x, y, z) {
          output[index] = x;
          output[index + 1] = y;
          output[index + 2] = z;
        };
      } else if (numberOfComponents) {
        if (numberOfComponents === 2 || numberOfComponents === 3) {
          offset = numberOfComponents;

          xAcc = function (index) {
            return +coordinates[index];
          };
          yAcc = function (index) {
            return +coordinates[index + 1];
          };
          if (numberOfComponents === 2) {
            writer = function (index, x, y) {
              output[index] = x;
              output[index + 1] = y;
            };
          } else {
            zAcc = function (index) {
              return +coordinates[index + 2];
            };
            writer = function (index, x, y, z) {
              output[index] = x;
              output[index + 1] = y;
              output[index + 2] = z;
            };
          }
        } else {
          throw new Error('Number of components should be two or three');
        }
      } else {
        throw new Error('Invalid coordinates');
      }
    }
  }

  // Helper methods
  function handleObjectCoordinates() {
    if (coordinates[0] &&
        'x' in coordinates[0] &&
        'y' in coordinates[0]) {
      xAcc = function (index) {
        return +coordinates[index].x;
      };
      yAcc = function (index) {
        return +coordinates[index].y;
      };

      if ('z' in coordinates[0]) {
        zAcc = function (index) {
          return +coordinates[index].z;
        };
        writer = function (index, x, y, z) {
          output[i] = {x: x, y: y, z: z};
        };
      } else {
        writer = function (index, x, y) {
          output[index] = {x: x, y: y};
        };
      }
    } else {
      throw new Error('Invalid coordinates');
    }
  }

  if (Array.isArray(coordinates)) {
    output = [];
    output.length = coordinates.length;
    count = coordinates.length;

    if (!coordinates.length) {
      return output;
    }
    if (Array.isArray(coordinates[0]) || util.isObject(coordinates[0])) {
      offset = 1;

      if (Array.isArray(coordinates[0])) {
        handleArrayCoordinates();
      } else if (util.isObject(coordinates[0])) {
        handleObjectCoordinates();
      }
    } else {
      handleArrayCoordinates();
    }
  } else {
    throw new Error('Coordinates are not valid');
  }

  for (i = 0; i < count; i += offset) {
    initPoint.x = xAcc(i);
    initPoint.y = yAcc(i);
    initPoint.z = zAcc(i);
    projPoint = trans.forward(initPoint, true);
    writer(i, projPoint.x, projPoint.y, projPoint.z);
  }
  return output;
};

/**
 * Transform an array of coordinates from one projection into another.  The
 * transformation occurs in place, modifying the input coordinate array.  The
 * coordinates are an array of [x0, y0, z0, x1, y1, z1, ...].
 *
 * @param {string} srcPrj The source projection.
 * @param {string} tgtPrj The destination projection.  This must not be the
 *    same as the source projection.
 * @param {number[]} coordinates A flat array of values.
 * @returns {number[]} The transformed coordinates.
 */
transform.transformCoordinatesFlatArray3 = function (srcPrj, tgtPrj, coordinates) {
  'use strict';

  var i,
      smatch = srcPrj.match(axisPattern),
      tmatch = tgtPrj.match(axisPattern);
  // if the two projections only differ in the middle axis
  if (smatch && tmatch && smatch[1] === tmatch[1] && smatch[3] === tmatch[3]) {
    for (i = coordinates.length - 3 + 1; i >= 0; i -= 3) {
      coordinates[i] *= -1;
    }
    return coordinates;
  }
  var src = proj4.Proj(srcPrj),
      tgt = proj4.Proj(tgtPrj),
      projPoint, initPoint = {};
  const trans = new proj4(src, tgt);
  for (i = coordinates.length - 3; i >= 0; i -= 3) {
    initPoint.x = +coordinates[i];
    initPoint.y = +coordinates[i + 1];
    initPoint.z = +(coordinates[i + 2] || 0.0);
    projPoint = trans.forward(initPoint, true);
    coordinates[i] = projPoint.x;
    coordinates[i + 1] = projPoint.y;
    coordinates[i + 2] = projPoint.z === undefined ? initPoint.z : projPoint.z;
  }
  return coordinates;
};

/**
 * Apply an affine transformation consisting of a translation then a scaling
 * to the given coordinate array.  Note, the transformation occurs in place
 * so the input coordinate object are mutated.
 *
 * @param {object} def
 * @param {geo.geoPosition} def.origin The transformed origin
 * @param {object} def.scale The transformed scale factor.  This is an object
 *  with `x`, `y`, and `z` parameters.
 * @param {geo.geoPosition[]} coords An array of coordinate objects.
 * @returns {geo.geoPosition[]} The transformed coordinates.
 */
transform.affineForward = function (def, coords) {
  'use strict';
  var i, origin = def.origin, scale = def.scale || {x: 1, y: 1, z: 1};
  for (i = 0; i < coords.length; i += 1) {
    coords[i].x = (coords[i].x - origin.x) * scale.x;
    coords[i].y = (coords[i].y - origin.y) * scale.y;
    coords[i].z = ((coords[i].z || 0) - (origin.z || 0)) * scale.z;
  }
  return coords;
};

/**
 * Apply an inverse affine transformation which is the inverse to
 * {@link geo.transform.affineForward}.  Note, the transformation occurs in
 * place so the input coordinate object are mutated.
 *
 * @param {object} def
 * @param {geo.geoPosition} def.origin The transformed origin
 * @param {object} def.scale The transformed scale factor.  This is an object
 *  with `x`, `y`, and `z` parameters.
 * @param {geo.geoPosition[]} coords An array of coordinate objects.
 * @returns {geo.geoPosition[]} The transformed coordinates.
 */
transform.affineInverse = function (def, coords) {
  'use strict';
  var i, origin = def.origin, scale = def.scale || {x: 1, y: 1, z: 1};
  for (i = 0; i < coords.length; i += 1) {
    coords[i].x = coords[i].x / scale.x + origin.x;
    coords[i].y = coords[i].y / scale.y + origin.y;
    coords[i].z = (coords[i].z || 0) / scale.z + (origin.z || 0);
  }
  return coords;
};

/**
 * Compute the distance on the surface on a sphere.  The sphere is the major
 * radius of a specified ellipsoid.  Altitude is ignored.
 *
 * @param {geo.geoPosition} pt1 The first point.
 * @param {geo.geoPosition} pt2 The second point.
 * @param {string|geo.transform} [gcs] `undefined` to use the same gcs as the
 *    ellipsoid, otherwise the gcs of the points.
 * @param {string|geo.transform} [baseGcs='EPSG:4326'] the gcs of the
 *    ellipsoid.
 * @param {object} [ellipsoid=proj4.WGS84] An object with at least `a` and one
 *    of `b`, `f`, or `rf` (1 / `f`) -- this works with  proj4 ellipsoid
 *    definitions.
 * @returns {number} The distance in meters (or whatever units the ellipsoid
 *    was specified in.
 */
transform.sphericalDistance = function (pt1, pt2, gcs, baseGcs, ellipsoid) {
  baseGcs = baseGcs || 'EPSG:4326';
  ellipsoid = ellipsoid || proj4.WGS84;
  gcs = gcs || baseGcs;
  if (gcs !== baseGcs) {
    var pts = transform.transformCoordinates(gcs, baseGcs, [pt1, pt2]);
    pt1 = pts[0];
    pt2 = pts[1];
  }
  // baseGcs must be in degrees or this will be wrong
  var phi1 = pt1.y * Math.PI / 180,
      phi2 = pt2.y * Math.PI / 180,
      lambda = (pt2.x - pt1.x) * Math.PI / 180,
      sinphi1 = Math.sin(phi1), cosphi1 = Math.cos(phi1),
      sinphi2 = Math.sin(phi2), cosphi2 = Math.cos(phi2);
  var sigma = Math.atan2(
    Math.pow(
      Math.pow(cosphi2 * Math.sin(lambda), 2) +
      Math.pow(cosphi1 * sinphi2 - sinphi1 * cosphi2 * Math.cos(lambda), 2), 0.5),
    sinphi1 * sinphi2 + cosphi1 * cosphi2 * Math.cos(lambda)
  );
  return ellipsoid.a * sigma;
};

/**
 * Compute the Vincenty distance on the surface on an ellipsoid.  Altitude is
 * ignored.
 *
 * @param {geo.geoPosition} pt1 The first point.
 * @param {geo.geoPosition} pt2 The second point.
 * @param {string|geo.transform} [gcs] `undefined` to use the same gcs as the
 *    ellipsoid, otherwise the gcs of the points.
 * @param {string|geo.transform} [baseGcs='EPSG:4326'] the gcs of the
 *    ellipsoid.
 * @param {object} [ellipsoid=proj4.WGS84] An object with at least `a` and one
 *    of `b`, `f`, or `rf` (1 / `f`) -- this works with  proj4 ellipsoid
 *    definitions.
 * @param {number} [maxIterations=100] Maximum number of iterations to use
 *    to test convergence.
 * @returns {object} An object with `distance` in meters (or whatever units the
 *    ellipsoid was specified in), `alpha1` and `alpha2`, the azimuths at the
 *    two points in radians.  The result may be `undefined` if the formula
 *    fails to converge, which can happen near antipodal points.
 */
transform.vincentyDistance = function (pt1, pt2, gcs, baseGcs, ellipsoid, maxIterations) {
  baseGcs = baseGcs || 'EPSG:4326';
  ellipsoid = ellipsoid || proj4.WGS84;
  maxIterations = maxIterations || 100;
  gcs = gcs || baseGcs;
  if (gcs !== baseGcs) {
    var pts = transform.transformCoordinates(gcs, baseGcs, [pt1, pt2]);
    pt1 = pts[0];
    pt2 = pts[1];
  }
  var a = ellipsoid.a,
      b = ellipsoid.b || ellipsoid.a * (1.0 - (ellipsoid.f || 1.0 / ellipsoid.rf)),
      f = ellipsoid.f || (ellipsoid.rf ? 1.0 / ellipsoid.rf : 1.0 - b / a),
      // baseGcs must be in degrees or this will be wrong
      phi1 = pt1.y * Math.PI / 180,
      phi2 = pt2.y * Math.PI / 180,
      L = (((pt2.x - pt1.x) % 360 + 360) % 360) * Math.PI / 180,
      U1 = Math.atan((1 - f) * Math.tan(phi1)),  // reduced latitude
      U2 = Math.atan((1 - f) * Math.tan(phi2)),
      sinU1 = Math.sin(U1), cosU1 = Math.cos(U1),
      sinU2 = Math.sin(U2), cosU2 = Math.cos(U2),
      lambda = L, lastLambda = L + Math.PI * 2,
      sinSigma, cosSigma, sigma, sinAlpha, cos2alpha, cos2sigmasubm, C,
      u2, A, B, deltaSigma, iter;
  if (phi1 === phi2 && !L) {
    return {
      distance: 0,
      alpha1: 0,
      alpha2: 0
    };
  }
  for (iter = maxIterations; iter > 0 && Math.abs(lambda - lastLambda) > 1e-12; iter -= 1) {
    sinSigma = Math.pow(
      Math.pow(cosU2 * Math.sin(lambda), 2) +
      Math.pow(cosU1 * sinU2 - sinU1 * cosU2 * Math.cos(lambda), 2), 0.5);
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * Math.cos(lambda);
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = cosU1 * cosU2 * Math.sin(lambda) / sinSigma;
    cos2alpha = 1 - Math.pow(sinAlpha, 2);
    // cos2alpha is zero only when phi1 and phi2 are nearly zero.  In this
    // case, sinU1 and sinU2 are nearly zero and the the second term can be
    // dropped
    cos2sigmasubm = cosSigma - (cos2alpha ? 2 * sinU1 * sinU2 / cos2alpha : 0);
    C = f / 16 * cos2alpha * (4 + f * (4 - 3 * cos2alpha));
    lastLambda = lambda;
    lambda = L + (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (
      cos2sigmasubm + C * cosSigma * (-1 + 2 * Math.pow(cos2sigmasubm, 2))));
  }
  if (!iter) { // failure to converge
    return;
  }
  u2 = cos2alpha * (a * a - b * b) / (b * b);
  A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  B = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  deltaSigma = B * sinSigma * (cos2sigmasubm + B / 4 * (
    cosSigma * (-1 + 2 * Math.pow(cos2sigmasubm, 2)) -
    B / 6 * cos2sigmasubm * (-3 + 4 * sinSigma * sinSigma) *
    (-3 + 4 * Math.pow(cos2sigmasubm, 2))));
  return {
    distance: b * A * (sigma - deltaSigma),
    alpha1: Math.atan2(cosU2 * Math.sin(lambda), cosU1 * sinU2 - sinU1 * cosU2 * Math.cos(lambda)),
    alpha2: Math.atan2(cosU1 * Math.sin(lambda), -sinU1 * cosU2 + cosU1 * sinU2 * Math.cos(lambda))
  };
};

/**
 * Return a boolean indicating if the projections only differ in their y
 * coordinate.
 *
 * @param {string} srcPrj The source projection.
 * @param {string} tgtPrj The destination projection.
 * @returns {boolean} truthy if only the y coordinate is different between
 *    projections.
 */
transform.onlyInvertedY = function (srcPrj, tgtPrj) {
  const smatch = srcPrj.match(axisPattern),
      tmatch = tgtPrj.match(axisPattern);
  return smatch && tmatch && smatch[1] === tmatch[1] && smatch[3] === tmatch[3];
};

/* Expose proj4 to make it easier to debug */
transform.proj4 = proj4;

module.exports = transform;
