var $ = require('jquery');
var inherit = require('./inherit');
var tileLayer = require('./tileLayer');
var registry = require('./registry');
var quadFeature = require('./quadFeature');

/**
 * Create a new instance of osmLayer.  This is a {@link geo.tileLayer} with
 * an OSM url and attribution defaults and with the tiles centered on the
 * origin.
 *
 * @class
 * @alias geo.osmLayer
 * @extends geo.tileLayer
 *
 * @param {object} arg
 * @param {number} [arg.mapOpacity] If specified, and `arg.opacity` is not
 *    specified, use this as the layer opacity.
 */
var osmLayer = function (arg) {

  var imageTile = require('./imageTile');

  if (!(this instanceof osmLayer)) {
    return new osmLayer(arg);
  }
  if (arg.mapOpacity !== undefined && arg.opacity === undefined) {
    arg.opacity = arg.mapOpacity;
  }
  tileLayer.call(this, arg);

  /* mapOpacity is just another name for the layer opacity. */
  this.mapOpacity = this.opacity;

  /**
   * Returns an instantiated imageTile object with the given indices.  This
   * method always returns a new tile object.  Use `_getTileCached` to use
   * the caching layer.
   *
   * @param {object} index The tile index.
   * @param {number} index.x
   * @param {number} index.y
   * @param {number} index.level
   * @param {object} source The tile index used for constructing the url.
   * @param {number} source.x
   * @param {number} source.y
   * @param {number} source.level
   * @returns {geo.tile}
   */
  this._getTile = function (index, source) {
    var urlParams = source || index;
    return imageTile({
      index: index,
      size: {x: this._options.tileWidth, y: this._options.tileHeight},
      queue: this._queue,
      overlap: this._options.tileOverlap,
      scale: this._options.tileScale,
      url: this._options.url.call(
        this, urlParams.x, urlParams.y, urlParams.level || 0,
        this._options.subdomains),
      crossDomain: this._options.crossDomain
    });
  }.bind(this);
};

/**
 * This object contains the default options used to initialize the osmLayer.
 */
osmLayer.defaults = $.extend({}, tileLayer.defaults, {
  tileOffset : function (level) {
    var s = Math.pow(2, level - 1) * 256;
    return {x: s, y: s};
  },
  url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: 'Tile data &copy; <a href="https://osm.org/copyright">' +
    'OpenStreetMap</a> contributors'
});

inherit(osmLayer, tileLayer);
/* By default, ask to support image quads.  If the user needs full
 * reprojection, they will need to require the
 * quadFeature.capabilities.imageFull feature */
registry.registerLayer('osm', osmLayer, [quadFeature.capabilities.image]);

module.exports = osmLayer;
