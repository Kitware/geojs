var inherit = require('./inherit');
var feature = require('./feature');
var transform = require('./transform');
var util = require('./util');

/**
 * Heatmap feature specification.
 *
 * @typedef {geo.feature.spec} geo.heatmapFeature.spec
 * @extends geo.feature.spec
 * @property {geo.geoPosition|Function} [position] Position of the data.
 *   Default is (data).
 * @property {Function} [intensity] Scalar value of each data point.  The
 *   scalar value must be a positive real number and is used to compute the
 *   weight for each data point.
 * @property {number} [maxIntensity=null] Maximum intensity of the data.
 *   Maximum intensity must be a positive real number and is used to normalize
 *   all intensities within a dataset.  If `null`, it is computed.
 * @property {number} [minIntensity=null] Minimum intensity of the data.
 *   Minimum intensity must be a positive real number and is used to normalize
 *   all intensities within a dataset.  If `null`, it is computed.
 * @property {number} [updateDelay=-1] Delay in milliseconds after a zoom,
 *   rotate, or pan event before recomputing the heatmap.  If 0, this is double
 *   the last render time.  If negative, it is roughly the last render time
 *   plus the absolute value of the specified number of refresh intervals.
 *   compute a delay based on the last heatmap render time.
 * @property {boolean|number|'auto'} [binned='auto'] If `true` or a number,
 *   spatially bin data as part of producing the heatmap.  If falsy, each
 *   datapoint stands on its own.  If `'auto'`, bin data if there are more data
 *   points than there would be bins.  Using `true` or `auto` uses bins that
 *   are `max(Math.floor((radius + blurRadius) / 8), 3)`.
 * @property {object} [style] A style for the heatmap.
 * @property {object} [style.color] An object where the keys are numbers from
 *   [0-1] and the values are {@link geo.geoColor}.  This is used to transform
 *   normalized intensity.
 * @property {number} [style.radius=10] Radius of a point in pixels.
 * @property {number} [style.blurRadius=10] Blur radius for each point in
 *   pixels.
 * @property {boolean} [style.gaussian=true] If truthy, approximate a gaussian
 *   distribution for each point using a multi-segment linear radial
 *   approximation.  The total weight of the gaussian area is approximately the
 *   `9/16 r^2`.  The sum of `radius + blurRadius` is used as the radius for
 *   the gaussian distribution.
 * @property {boolean} [scaleWithZoom=false] If truthy, the value for radius
 *   and blurRadius scale with zoom.  In this case, the values for radius and
 *   blurRadius are the values at zoom-level zero.  If the scaled radius is
 *   less than 0.5 or more than 8192 screen pixels, the heatmap will not
 *   render.
 */

/**
 * Create a new instance of class heatmapFeature.
 *
 * @class
 * @alias geo.heatmapFeature
 * @param {geo.heatmapFeature.spec} arg Feature specification.
 * @extends geo.feature
 * @returns {geo.heatmapFeature}
 */
var heatmapFeature = function (arg) {
  'use strict';
  if (!(this instanceof heatmapFeature)) {
    return new heatmapFeature(arg);
  }
  arg = arg || {};
  feature.call(this, arg);

  /**
   * @private
   */
  var m_this = this,
      m_position,
      m_intensity,
      m_maxIntensity,
      m_minIntensity,
      m_updateDelay,
      m_binned,
      m_gcsPosition,
      s_init = this._init;

  this.featureType = 'heatmap';

  m_position = arg.position || util.identityFunction;
  m_intensity = arg.intensity || function (d) { return 1; };
  m_maxIntensity = arg.maxIntensity !== undefined ? arg.maxIntensity : null;
  m_minIntensity = arg.minIntensity !== undefined ? arg.minIntensity : null;
  m_binned = arg.binned !== undefined ? arg.binned : 'auto';
  m_updateDelay = (arg.updateDelay || arg.updateDelay === 0) ? parseInt(arg.updateDelay, 10) : -1;

  /**
   * Get/Set maxIntensity.
   *
   * @param {number|null} [val] If not specified, return the current value.
   *    If a number, use this as the maximum intensity.  If `null`, compute
   *    the maximum intensity.
   * @returns {number|null|this}
   */
  this.maxIntensity = function (val) {
    if (val === undefined) {
      return m_maxIntensity;
    } else {
      m_maxIntensity = val;
      m_this.dataTime().modified();
      m_this.modified();
    }
    return m_this;
  };

  /**
   * Get/Set minIntensity.
   *
   * @param {number|null} [val] If not specified, return the current value.
   *    If a number, use this as the minimum intensity.  If `null`, compute
   *    the minimum intensity.
   * @returns {number|null|this}
   */
  this.minIntensity = function (val) {
    if (val === undefined) {
      return m_minIntensity;
    } else {
      m_minIntensity = val;
      m_this.dataTime().modified();
      m_this.modified();
    }
    return m_this;
  };

  /**
   * Get/Set updateDelay.
   *
   * @param {number} [val] If not specified, return the current update delay.
   *    If specified, this is the delay in milliseconds after a zoom, rotate,
   *    or pan event before recomputing the heatmap.  If 0, this is double the
   *    last render time.  If negative, it is roughly the last render time plus
   *    the absolute value of the specified number of refresh intervals.
   * @returns {number|this}
   */
  this.updateDelay = function (val) {
    if (val === undefined) {
      return m_updateDelay;
    } else {
      m_updateDelay = parseInt(val, 10);
    }
    return m_this;
  };

  /**
   * Get/Set binned value.
   *
   * @param {boolean|number|'auto'} [val] If not specified, return the current
   *    binned value.  If `true` or a number, spatially bin data as part of
   *    producing the heatmap.  If falsy, each datapoint stands on its own.
   *    If `'auto'`, bin data if there are more data points than there would be
   *    bins.  Using `true` or `auto` uses bins that are
   *    `max(Math.floor((radius + blurRadius) / 8), 3)`.
   * @returns {boolean|number|'auto'|this}
   */
  this.binned = function (val) {
    if (val === undefined) {
      return m_binned;
    } else {
      if (val === 'true') {
        val = true;
      } else if (val === 'false') {
        val = false;
      } else if (val !== 'auto' && val !== true && val !== false) {
        val = parseInt(val, 10);
        if (val <= 0 || isNaN(val)) {
          val = false;
        }
      }
      m_binned = val;
      m_this.dataTime().modified();
      m_this.modified();
    }
    return m_this;
  };

  /**
   * Get/Set position accessor.
   *
   * @param {geo.geoPosition|Function} [val] If not specified, return the
   *    current position accessor.  If specified, use this for the position
   *    accessor and return `this`.  If a function is given, this is called
   *    with `(dataElement, dataIndex)`.
   * @returns {geo.geoPosition|Function|this} The current position or this
   *    feature.
   */
  this.position = function (val) {
    if (val === undefined) {
      return m_position;
    } else {
      m_position = val;
      m_this.dataTime().modified();
      m_this.modified();
    }
    return m_this;
  };

  /**
   * Get pre-computed gcs position accessor.
   *
   * @returns {geo.heatmap}
   */
  this.gcsPosition = function () {
    m_this._update();
    return m_gcsPosition;
  };

  /**
   * Get/Set intensity.
   *
   * @param {Function} [val] If not specified, the current intensity accessor.
   *    Otherwise, a function that returns the intensity of each data point.
   * @returns {Function|this}
   */
  this.intensity = function (val) {
    if (val === undefined) {
      return m_intensity;
    } else {
      m_intensity = val;
      m_this.dataTime().modified();
      m_this.modified();
    }
    return m_this;
  };

  /**
   * Initialize.
   *
   * @param {geo.heatmapFeature.spec} arg
   */
  this._init = function (arg) {
    s_init.call(m_this, arg);

    var defaultStyle = Object.assign(
      {},
      {
        radius: 10,
        blurRadius: 10,
        gaussian: true,
        color: {
          0:    {r: 0, g: 0, b: 0.0, a: 0.0},
          0.25: {r: 0, g: 0, b: 1, a: 0.5},
          0.5:  {r: 0, g: 1, b: 1, a: 0.6},
          0.75: {r: 1, g: 1, b: 0, a: 0.7},
          1:    {r: 1, g: 0, b: 0, a: 0.8}},
        scaleWithZoom: false
      },
      arg.style === undefined ? {} : arg.style
    );

    m_this.style(defaultStyle);

    if (m_position) {
      m_this.dataTime().modified();
    }
  };

  /**
   * Build the feature.
   *
   * @returns {this}
   */
  this._build = function () {
    var data = m_this.data(),
        intensity = null,
        position = [],
        setMax = (m_maxIntensity === null || m_maxIntensity === undefined),
        setMin = (m_minIntensity === null || m_minIntensity === undefined);

    data.forEach(function (d, i) {
      position.push(m_this.position()(d, i));
      if (setMax || setMin) {
        intensity = m_this.intensity()(d, i);
        if (m_maxIntensity === null || m_maxIntensity === undefined) {
          m_maxIntensity = intensity;
        }
        if (m_minIntensity === null || m_minIntensity === undefined) {
          m_minIntensity = intensity;
        }
        if (setMax && intensity > m_maxIntensity) {
          m_maxIntensity = intensity;
        }
        if (setMin && intensity < m_minIntensity) {
          m_minIntensity = intensity;
        }

      }
    });
    if (setMin && setMax && m_minIntensity === m_maxIntensity) {
      m_minIntensity -= 1;
    }
    m_gcsPosition = transform.transformCoordinates(
      m_this.gcs(), m_this.layer().map().gcs(), position);

    m_this.buildTime().modified();
    return m_this;
  };

  this._init(arg);
  return this;
};

inherit(heatmapFeature, feature);
module.exports = heatmapFeature;
