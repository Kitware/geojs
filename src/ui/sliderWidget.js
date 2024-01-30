var svgWidget = require('./svgWidget');
var inherit = require('../inherit');
var registerWidget = require('../registry').registerWidget;

/**
 * @typedef {geo.gui.widget.spec} geo.gui.sliderWidget.spec
 * @extends {geo.gui.widget.spec}
 * @property {number} [width=20] The width of the slider in pixels.
 * @property {number} [height=160] The height of the slider in pixels.  The
 *   actual bar is `height - 3 * width`.
 */

/**
 * Create a new instance of class sliderWidget.
 *
 * @class
 * @alias geo.gui.sliderWidget
 * @extends geo.gui.svgWidget
 * @param {geo.gui.sliderWidget.spec} arg Options for the widget.
 * @returns {geo.gui.sliderWidget}
 */
var sliderWidget = function (arg) {
  'use strict';
  if (!(this instanceof sliderWidget)) {
    return new sliderWidget(arg);
  }
  svgWidget.call(this, arg);

  var d3 = require('../svg/svgRenderer').d3;
  var geo_event = require('../event');

  var m_this = this,
      s_exit = this._exit,
      m_xscale,
      m_yscale,
      m_plus,
      m_minus,
      m_nub,
      m_width = arg.width || 20, // Size of the widget in pixels
      m_height = arg.height || 160,  // slider height + 3 * width
      m_nubSize = arg.width ? arg.width * 0.5 : 10,
      m_plusIcon,
      m_minusIcon,
      m_group,
      m_lowContrast,
      m_highlightDur = 100;

  /* http://icomoon.io */
  /* CC BY 3.0 http://creativecommons.org/licenses/by/3.0/ */
  m_plusIcon = 'M512 81.92c-237.568 0-430.080 192.614-430.080 430.080 0 237.568 192.563 430.080 430.080 430.080s430.080-192.563 430.080-430.080c0-237.517-192.563-430.080-430.080-430.080zM564.326 564.326v206.182h-104.653v-206.182h-206.234v-104.653h206.182v-206.234h104.704v206.182h206.182v104.704h-206.182z';
  m_minusIcon = 'M512 81.92c-237.568 0-430.080 192.614-430.080 430.080 0 237.568 192.563 430.080 430.080 430.080s430.080-192.563 430.080-430.080c0-237.517-192.563-430.080-430.080-430.080zM770.56 459.674v104.704h-517.12v-104.704h517.12z';

  // Define off-white gray colors for low contrast ui (unselected).
  m_lowContrast = {
    white: '#f4f4f4',
    black: '#505050'
  };

  /**
   * Add an icon from a path string.  Returns a d3 group element.
   *
   * @param {string} icon svg path string.
   * @param {d3Selection} base where to append the element.
   * @param {number} cx Center x-coordinate.
   * @param {number} cy Center y-coordinate.
   * @param {number} size Icon size in pixels.
   * @returns {d3GroupElement}
   */
  function put_icon(icon, base, cx, cy, size) {
    var g = base.append('g');

    // the scale factor
    var s = size / 1024;

    g.append('g')
      .append('g')
        .attr(
          'transform',
          'translate(' + cx + ',' + cy + ') scale(' + s + ') translate(-512,-512)'
        )
      .append('path')
        .attr('d', icon)
        .attr('class', 'geo-glyphicon');

    return g;
  }

  /**
   * Return the size of the widget.
   *
   * @returns {geo.screenSize}
   */
  this.size = function () {
    return {width: m_width, height: m_height};
  };

  /**
   * Initialize the slider widget.
   *
   * @returns {this}
   */
  this._init = function () {
    m_this._createCanvas();
    m_this._appendCanvasToParent();

    m_this.reposition();

    var svg = d3.select(m_this.canvas()),
        map = m_this.layer().map();

    svg.attr('width', m_width).attr('height', m_height);

    // create d3 scales for positioning
    // TODO: make customizable and responsive
    m_xscale = d3.scaleLinear().domain([-4, 4]).range([0, m_width]);
    m_yscale = d3.scaleLinear().domain([0, 1]).range([m_width * 1.5, m_height - m_width * 1.5]);

    // Create the main group element
    svg = svg.append('g').classed('geo-ui-slider', true);
    m_group = svg;

    // Create + zoom button
    m_plus = svg.append('g');
    m_plus.append('circle')
      .datum({
        fill: 'white',
        stroke: null
      })
      .classed('geo-zoom-in', true)
      .attr('cx', m_xscale(0))
      .attr('cy', m_yscale(0.0) - m_width + 2)
      .attr('r', (m_width - 2) / 2)
      .style('cursor', 'pointer')
      .on('click', function () {
        var z = map.zoom();
        map.transition({
          zoom: z + 1,
          ease: d3.easeCubicInOut,
          duration: 500
        });
      })
      .on('mousedown', function (evt) {
        evt.stopPropagation();
      });

    put_icon(
      m_plusIcon,
      m_plus,
      m_xscale(0),
      m_yscale(0) - m_width + 2,
      m_width + 4
    ).style('cursor', 'pointer')
      .style('pointer-events', 'none')
      .select('path')
      .datum({
        fill: 'black',
        stroke: null
      });

    // Create the - zoom button
    m_minus = svg.append('g');
    m_minus.append('circle')
      .datum({
        fill: 'white',
        stroke: null
      })
      .classed('geo-zoom-out', true)
      .attr('cx', m_xscale(0))
      .attr('cy', m_yscale(1.0) + m_width - 2)
      .attr('r', (m_width - 2) / 2)
      .style('cursor', 'pointer')
      .on('click', function () {
        var z = map.zoom();
        map.transition({
          zoom: z - 1,
          ease: d3.easeCubicInOut,
          duration: 500
        });
      })
      .on('mousedown', function (evt) {
        evt.stopPropagation();
      });

    put_icon(
      m_minusIcon,
      m_minus,
      m_xscale(0),
      m_yscale(1) + m_width - 2,
      m_width + 4
    ).style('cursor', 'pointer')
      .style('pointer-events', 'none')
      .select('path')
      .datum({
        fill: 'black',
        stroke: null
      });

    /**
     * Respond to a mouse event on the widget.
     *
     * @param {d3Event} evt The event on the widget.
     * @param {boolean} [trans] Truthy for an animated transition.
     */
    function respond(evt, trans) {
      var z = m_yscale.invert(d3.pointer(event, svg.node())[1]),
          zrange = map.zoomRange();
      z = (1 - z) * (zrange.max - zrange.min) + zrange.min;
      if (trans) {
        map.transition({
          zoom: z,
          ease: d3.easeCubicInOut,
          duration: 500,
          done: m_this._update()
        });
      } else {
        map.zoom(z);
        m_this._update();
      }
      evt.stopPropagation();
    }

    // Create the track
    svg.append('rect')
      .datum({
        fill: 'white',
        stroke: 'black'
      })
      .classed('geo-zoom-track', true)
      .attr('x', m_xscale(0) - m_width / 6)
      .attr('y', m_yscale(0))
      .attr('rx', m_width / 10)
      .attr('ry', m_width / 10)
      .attr('width', m_width / 3)
      .attr('height', m_height - m_width * 3)
      .style('cursor', 'pointer')
      .on('click', function (evt) {
        respond(evt, true);
      });

    // Create the nub
    m_nub = svg.append('rect')
      .datum({
        fill: 'black',
        stroke: null
      })
      .classed('geo-zoom-nub', true)
      .attr('x', m_xscale(-4))
      .attr('y', m_yscale(0.5) - m_nubSize / 2)
      .attr('rx', 3)
      .attr('ry', 3)
      .attr('width', m_width)
      .attr('height', m_nubSize)
      .style('cursor', 'pointer')
      .on('mousedown', function (evt) {
        d3.select(document).on('mousemove.geo.slider', function () {
          respond(evt);
        });
        d3.select(document).on('mouseup.geo.slider', function () {
          respond(evt);
          d3.select(document).on('.geo.slider', null);
        });
        evt.stopPropagation();
      });

    /**
     * When the mouse is over the widget, change the style.
     */
    function mouseOver() {
      d3.select(this).attr('filter', 'url(#geo-highlight)');
      m_group.selectAll('rect,path,circle').transition()
        .duration(m_highlightDur)
        .style('fill', function (d) {
          return d.fill || null;
        })
        .style('stroke', function (d) {
          return d.stroke || null;
        });
    }

    /**
     * When the mouse is no longer over the widget, change the style.
     */
    function mouseOut() {
      d3.select(this).attr('filter', null);
      m_group.selectAll('circle,rect,path').transition()
        .duration(m_highlightDur)
        .style('fill', function (d) {
          return m_lowContrast[d.fill] || null;
        })
        .style('stroke', function (d) {
          return m_lowContrast[d.stroke] || null;
        });
    }

    m_group.selectAll('*')
      .on('mouseover', mouseOver)
      .on('mouseout', mouseOut);

    // Update the nub position on zoom
    m_this.geoOn(geo_event.zoom, m_this._update);

    mouseOut();
    m_this._update();
    return m_this;
  };

  /**
   * Removes the slider element from the map and unbinds all handlers.
   */
  this._exit = function () {
    m_this.geoOff(geo_event.zoom, m_this._update);
    m_group.remove();
    s_exit();
  };

  /**
   * Update the slider widget state in response to map changes.  I.e., zoom
   * range changes.
   *
   * @param {object} [obj] An object that can specify a zoom value.
   * @param {number} [obj.zoom] The new zoom value to show on the slider.
   */
  this._update = function (obj) {
    var map = m_this.layer().map(),
        zoomRange = map.zoomRange(),
        zoom = map.zoom(),
        zoomScale = d3.scaleLinear();

    obj = obj || {};
    zoom = obj.value || zoom;
    zoomScale.domain([zoomRange.min, zoomRange.max])
      .range([1, 0])
      .clamp(true);

    m_nub.attr('y', m_yscale(zoomScale(zoom)) - m_nubSize / 2);
  };
};

inherit(sliderWidget, svgWidget);

registerWidget('dom', 'slider', sliderWidget);
module.exports = sliderWidget;
