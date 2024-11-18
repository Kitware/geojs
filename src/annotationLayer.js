var inherit = require('./inherit');
var featureLayer = require('./featureLayer');
var geo_annotation = require('./annotation');
var geo_event = require('./event');
var registry = require('./registry');
var transform = require('./transform');
var $ = require('jquery');
var Mousetrap = require('mousetrap');
var textFeature = require('./textFeature');

/**
 * Object specification for an annotation layer.
 *
 * @typedef {geo.layer.spec} geo.annotationLayer.spec
 * @extends {geo.layer.spec}
 * @property {number} [dblClickTime=300] The delay in milliseconds that is
 *   treated as a double-click when working with annotations.
 * @property {number} [adjacentPointProximity=5] The minimum distance in
 *   display coordinates (pixels) between two adjacent points when creating a
 *   polygon or line.  A value of 0 requires an exact match.
 * @property {number} [continuousPointProximity=5] The minimum distance in
 *   display coordinates (pixels) between two adjacent points when dragging
 *   to create an annotation.  `false` disables continuous drawing mode.
 * @property {number} [continuousPointCollinearity=1.0deg] The minimum angle
 *   between a series of three points when dragging to not interpret them as
 *   collinear.  Only applies if `continuousPointProximity` is not `false`.
 * @property {number} [continuousCloseProximity=10] The minimum distance in
 *   display coordinates (pixels) to close a polygon or end drawing a line when
 *   dragging to create an annotation.  `false` never closes at the end of a
 *   drag.  `true` is effectively infinite.
 * @property {number} [finalPointProximity=10] The maximum distance in display
 *   coordinates (pixels) between the starting point and the mouse coordinates
 *   to signal closing a polygon.  A value of 0 requires an exact match.  A
 *   negative value disables closing a polygon by clicking on the start point.
 * @property {boolean} [showLabels=true] Truthy to show feature labels that are
 *   allowed by the associated feature to be shown.
 * @property {boolean} [clickToEdit=false] Truthy to allow clicking an
 *   annotation to place it in edit mode.
 * @property {geo.textFeature.styleSpec} [defaultLabelStyle] Default styles for
 *   labels.
 */

/**
 * @typedef {object} geo.annotationLayer.labelRecord
 * @property {string} text The text of the label
 * @property {geo.geoPosition} position The position of the label in map gcs
 *    coordinates.
 * @property {geo.textFeature.styleSpec} [style] A {@link geo.textFeature}
 *    style object.
 */

/**
 * @typedef {geo.util.polyop.spec} geo.util.polyop.annotationLayerSpec
 * @extends {geo.util.polyop.spec}
 * @property {string} [keepAnnotations='exact'] Determine which annotations are
 *   present after a boolean operation.  `'exact'` replaces modified
 *   annotations with the results; unmodified annotations are left as is.
 *   `'all'` replaces all annotations, so unchanged annotations may be
 *   converted to polygonAnnotations.  `'none'` discards all existing
 *   annotations and only keeps modified results.
 */

/**
 * Layer to handle direct interactions with different features.  Annotations
 * (features) can be created by calling mode(<name of feature>) or cancelled
 * with mode(null).  There is also an "edit" mode which is used when modifying
 * an annotation.
 *
 * @class
 * @alias geo.annotationLayer
 * @extends geo.featureLayer
 * @param {geo.annotationLayer.spec} [arg] Specification for the new layer.
 * @returns {geo.annotationLayer}
 * @fires geo.event.annotation.state
 * @fires geo.event.annotation.coordinates
 * @fires geo.event.annotation.edit_action
 * @fires geo.event.annotation.select_edit_handle
 */
var annotationLayer = function (arg) {
  'use strict';
  if (!(this instanceof annotationLayer)) {
    return new annotationLayer(arg);
  }
  featureLayer.call(this, arg);

  var mapInteractor = require('./mapInteractor');
  var timestamp = require('./timestamp');
  var util = require('./util');

  var m_this = this,
      s_init = this._init,
      s_exit = this._exit,
      s_draw = this.draw,
      s_update = this._update,
      m_buildTime = timestamp(),
      m_options,
      m_mode = null,
      m_annotations = [],
      m_annotationIds = {},
      m_features = [],
      m_labelFeature,
      m_labelLayer,
      m_keyHandler;

  var geojsonStyleProperties = {
    closed: {dataType: 'boolean', keys: ['closed', 'close']},
    fill: {dataType: 'boolean', keys: ['fill']},
    fillColor: {dataType: 'color', keys: ['fillColor', 'fill-color', 'marker-color', 'fill']},
    fillOpacity: {dataType: 'opacity', keys: ['fillOpacity', 'fill-opacity']},
    lineCap: {dataType: 'text', keys: ['lineCap', 'line-cap']},
    lineJoin: {dataType: 'text', keys: ['lineJoin', 'line-join']},
    radius: {dataType: 'positive', keys: ['radius']},
    scaled: {dataType: 'booleanOrNumber', keys: ['scaled']},
    stroke: {dataType: 'boolean', keys: ['stroke']},
    strokeColor: {dataType: 'color', keys: ['strokeColor', 'stroke-color', 'stroke']},
    strokeOffset: {dataType: 'number', keys: ['strokeOffset', 'stroke-offset']},
    strokeOpacity: {dataType: 'opacity', keys: ['strokeOpacity', 'stroke-opacity']},
    strokeWidth: {dataType: 'positive', keys: ['strokeWidth', 'stroke-width']}
  };
  var textFeatureDataTypes = {
    offset: 'coordinate2',
    rotateWithMap: 'boolean',
    rotation: 'angle',
    scaleWithMap: 'boolean',
    scale: 'booleanOrNumber',
    shadowBlur: 'numberOrBlank',
    shadowOffset: 'coordinate2',
    strokeWidth: 'numberOrBlank',
    visible: 'boolean'
  };
  textFeature.usedStyles.forEach(function (key) {
    geojsonStyleProperties[key] = {
      option: 'labelStyle',
      dataType: textFeatureDataTypes[key] || 'text',
      keys: [
        key,
        'label' + key.charAt(0).toUpperCase() + key.slice(1),
        key.replace(/([A-Z])/g, '-$1').toLowerCase(),
        'label-' + key.replace(/([A-Z])/g, '-$1').toLowerCase()]
    };
  });

  m_options = util.deepMerge({}, {
    dblClickTime: 300,
    adjacentPointProximity: 5,  // in pixels, 0 is exact
    // in pixels; set to continuousPointProximity to false to disable
    // continuous drawing modes.
    continuousPointProximity: 5,
    // in radians, minimum angle between continuous points to interpret them as
    // being collinear
    continuousPointCollinearity: 1.0 * Math.PI / 180,
    continuousCloseProximity: 10, // in pixels, 0 is exact
    finalPointProximity: 10,  // in pixels, 0 is exact
    showLabels: true,
    clickToEdit: false
  }, arg);

  /**
   * Process an action event.  If we are in rectangle-creation mode, this
   * creates a rectangle.
   *
   * @param {geo.event} evt The selection event.
   * @fires geo.event.annotation.edit_action
   */
  this._processAction = function (evt) {
    var update;
    if (evt.state && evt.state.actionRecord &&
        evt.state.actionRecord.owner === geo_annotation.actionOwner &&
        m_this.currentAnnotation) {
      switch (m_this.mode()) {
        case m_this.modes.edit:
          update = m_this.currentAnnotation.processEditAction(evt);
          if (m_this.currentAnnotation &&
              m_this.currentAnnotation._editHandle &&
              m_this.currentAnnotation._editHandle.handle) {
            m_this.geoTrigger(geo_event.annotation.edit_action, {
              annotation: m_this.currentAnnotation,
              handle: m_this.currentAnnotation._editHandle ? m_this.currentAnnotation._editHandle.handle : undefined,
              action: evt.event
            });
            if (evt.event === geo_event.actionup) {
              m_this._selectEditHandle(
                {data: m_this.currentAnnotation._editHandle.handle},
                m_this.currentAnnotation._editHandle.handle.selected);
            }
          }
          break;
        case m_this.modes.cursor:
          m_this.currentAnnotation._cursorHandleMousemove(evt.mouse);
          update = m_this.currentAnnotation.processAction(evt);
          m_this.geoTrigger(geo_event.annotation.cursor_action, {
            annotation: m_this.currentAnnotation,
            operation: m_this.currentBooleanOperation(),
            evt: evt
          });
          break;
        default:
          update = m_this.currentAnnotation.processAction(evt);
          break;
      }
    }
    m_this._updateFromEvent(update);
  };

  /**
   * Check if there is a current boolean operation.
   *
   * @returns {string?} Either undefined for no current boolean operation or
   *   the name of the operation.
   */
  this.currentBooleanOperation = function () {
    let op;
    if (m_this._currentBooleanClass) {
      op = m_this._currentBooleanClass.split('-')[1];
    }
    return op;
  };

  /**
   * Check if the map is currently in a mode where we are adding an annotation
   * with a boolean operation.  If so, remove the current annotation from the
   * layer, then apply it via the boolean operation.
   */
  this._handleBooleanOperation = function () {
    const op = m_this.currentBooleanOperation();
    if (!op || !m_this.currentAnnotation || !m_this.currentAnnotation.toPolygonList) {
      return;
    }
    const newAnnot = m_this.currentAnnotation;
    m_this.removeAnnotation(m_this.currentAnnotation, false);
    if (m_this.annotations().length || (op !== 'difference' && op !== 'intersect')) {
      const evt = {
        annotation: newAnnot,
        operation: op
      };
      m_this.geoTrigger(geo_event.annotation.boolean, evt);
      if (evt.cancel !== false) {
        util.polyops[op](m_this, newAnnot.toPolygonList(), {correspond: {}, keepAnnotations: 'exact', style: m_this});
      }
    }
  };

  /**
   * Handle updating the current annotation based on an update state.
   *
   * @param {string|undefined} update Truthy to update.  `'done'` if the
   *    annotation was completed and the mode should return to `null`.
   *    `'remove'` to remove the current annotation and set the mode to `null`.
   *    Falsy to do nothing.
   */
  this._updateFromEvent = function (update) {
    switch (update) {
      case 'remove':
        m_this.removeAnnotation(m_this.currentAnnotation, false);
        m_this.mode(null);
        break;
      case 'done':
        m_this._handleBooleanOperation();
        m_this.mode(null);
        break;
    }
    if (update) {
      m_this.modified();
      m_this.draw();
    }
  };

  /**
   * Check the state of the modifier keys and apply them if appropriate.
   *
   * @param {geo.event} evt The mouse move or click event.
   */
  this._handleMouseMoveModifiers = function (evt) {
    if (m_this.mode() !== m_this.modes.edit && m_this.currentAnnotation.options('allowBooleanOperations') && (m_this.currentAnnotation._coordinates().length < 2 || m_this.mode() === m_this.modes.cursor)) {
      if (evt.modifiers) {
        const mod = (evt.modifiers.shift ? 's' : '') + (evt.modifiers.ctrl ? 'c' : '') + (evt.modifiers.meta || evt.modifiers.alt ? 'a' : '');
        if (m_this._currentBooleanClass === m_this._booleanClasses[mod]) {
          return;
        }
        m_this._currentBooleanClass = m_this._booleanClasses[mod];
        const mapNode = m_this.map().node();
        Object.values(m_this._booleanClasses).forEach((c) => {
          mapNode.toggleClass(c, m_this._booleanClasses[mod] === c);
        });
      }
    }
  };

  /**
   * Handle mouse movement.  If there is a current annotation, the movement
   * event is sent to it.
   *
   * @param {geo.event} evt The mouse move event.
   */
  this._handleMouseMove = function (evt) {
    if (m_this.mode() && m_this.currentAnnotation) {
      m_this._handleMouseMoveModifiers(evt);
      var update = m_this.currentAnnotation.mouseMove(evt);
      if (update) {
        m_this.modified();
        m_this.draw();
      }
    }
  };

  /**
   * Select or deselect an edit handle.
   *
   * @param {geo.event} evt The mouse move event.
   * @param {boolean} enable Truthy to select the handle, falsy to deselect it.
   * @returns {this}
   */
  this._selectEditHandle = function (evt, enable) {
    if (!evt.data || !evt.data.editHandle) {
      return;
    }
    $.each(m_features[geo_annotation._editHandleFeatureLevel], function (type, feature) {
      feature.feature.modified();
    });
    m_this.currentAnnotation.selectEditHandle(evt.data, enable);
    m_this.draw();
    m_this.map().node().toggleClass('annotation-input', !!enable);
    m_this.map().interactor().removeAction(
      undefined, undefined, geo_annotation.actionOwner);
    if (enable) {
      var actions = m_this.currentAnnotation.actions(geo_annotation.state.edit);
      $.each(actions, function (idx, action) {
        m_this.map().interactor().addAction(action);
      });
    }
    return m_this;
  };

  /**
   * Handle mouse on events.  If there is no current annotation and
   * clickToEdit is enabled, any hovered annotation is highlighted.
   * event is sent to it.
   *
   * @param {geo.event} evt The mouse move event.
   */
  this._handleMouseOn = function (evt) {
    if (!evt.data || !evt.data.annotation) {
      return;
    }
    if (m_this.mode() === m_this.modes.edit && m_this.currentAnnotation) {
      m_this._selectEditHandle(evt, true);
      return;
    }
    if (m_this.mode() || m_this.currentAnnotation || !m_this.options('clickToEdit')) {
      return;
    }
    evt.data.annotation.state(geo_annotation.state.highlight);
    m_this.modified();
    m_this.draw();
  };

  /**
   * Handle mouse off events.  If the specific annotation is in the highlight
   * state, move it back to the done state.
   *
   * @param {geo.event} evt The mouse move event.
   */
  this._handleMouseOff = function (evt) {
    if (!evt.data || !evt.data.annotation) {
      return;
    }
    if (m_this.mode() === m_this.modes.edit && evt.data.editHandle && evt.data.selected) {
      m_this._selectEditHandle(evt, false);
      return;
    }
    if (evt.data.annotation.state() === geo_annotation.state.highlight) {
      evt.data.annotation.state(geo_annotation.state.done);
      m_this.modified();
      m_this.draw();
    }
  };

  /**
   * Handle mouse clicks.  If there is a current annotation, the click event is
   * sent to it.
   *
   * @param {geo.event} evt The mouse click event.
   */
  this._handleMouseClick = function (evt) {
    var retrigger = false, update;
    if (m_this.mode() === m_this.modes.edit) {
      if (m_this.map().interactor().hasAction(undefined, undefined, geo_annotation.actionOwner)) {
        update = m_this.currentAnnotation.mouseClickEdit(evt);
        m_this._updateFromEvent(update);
        return;
      }
      m_this.mode(null);
      m_this.draw();
      $.each(m_features, function (idx, featureLevel) {
        $.each(featureLevel, function (type, feature) {
          feature.feature._clearSelectedFeatures();
        });
      });
      retrigger = true;
    } else if (m_this.mode() && m_this.currentAnnotation) {
      m_this._handleMouseMoveModifiers(evt);
      update = m_this.currentAnnotation.mouseClick(evt);
      m_this._updateFromEvent(update);
      retrigger = !m_this.mode();
      if (m_this.mode() === m_this.modes.cursor) {
        m_this.geoTrigger(geo_event.annotation.cursor_click, {
          annotation: m_this.currentAnnotation,
          operation: m_this.currentBooleanOperation(),
          evt: evt
        });
      }
    } else if (!m_this.mode() && !m_this.currentAnnotation && m_this.options('clickToEdit')) {
      var highlighted = m_this.annotations().filter(function (ann) {
        return ann.state() === geo_annotation.state.highlight;
      });
      if (highlighted.length !== 1) {
        return;
      }
      m_this.mode(m_this.modes.edit, highlighted[0]);
      m_this.draw();
      retrigger = true;
    }
    if (retrigger) {
      // retrigger mouse move to ensure the correct events are attached
      m_this.map().interactor().retriggerMouseMove();
    }
  };

  /**
   * Set or get options.
   *
   * @param {string|object} [arg1] If `undefined`, return the options object.
   *    If a string, either set or return the option of that name.  If an
   *    object, update the options with the object's values.
   * @param {object} [arg2] If `arg1` is a string and this is defined, set
   *    the option to this value.
   * @returns {object|this} If options are set, return the annotation,
   *    otherwise return the requested option or the set of options.
   */
  this.options = function (arg1, arg2) {
    if (arg1 === undefined) {
      return m_options;
    }
    if (typeof arg1 === 'string' && arg2 === undefined) {
      return m_options[arg1];
    }
    if (arg2 === undefined) {
      m_options = util.deepMerge(m_options, arg1);
    } else {
      m_options[arg1] = arg2;
    }
    m_this.modified();
    return m_this;
  };

  /**
   * Calculate the display distance for two coordinate in the current map.
   *
   * @param {geo.geoPosition|geo.screenPosition} coord1 The first coordinates.
   * @param {string|geo.transform|null} gcs1 `undefined` to use the interface
   *    gcs, `null` to use the map gcs, `'display'` if the coordinates are
   *    already in display coordinates, or any other transform.
   * @param {geo.geoPosition|geo.screenPosition} coord2 the second coordinates.
   * @param {string|geo.transform|null} [gcs2] `undefined` to use the interface
   *    gcs, `null` to use the map gcs, `'display'` if the coordinates are
   *    already in display coordinates, or any other transform.
   * @returns {number} the Euclidean distance between the two coordinates.
   */
  this.displayDistance = function (coord1, gcs1, coord2, gcs2) {
    var map = m_this.map();
    if (gcs1 !== 'display') {
      gcs1 = (gcs1 === null ? map.gcs() : (
        gcs1 === undefined ? map.ingcs() : gcs1));
      coord1 = map.gcsToDisplay(coord1, gcs1);
    }
    if (gcs2 !== 'display') {
      gcs2 = (gcs2 === null ? map.gcs() : (
        gcs2 === undefined ? map.ingcs() : gcs2));
      coord2 = map.gcsToDisplay(coord2, gcs2);
    }
    var dist = Math.sqrt(Math.pow(coord1.x - coord2.x, 2) +
                         Math.pow(coord1.y - coord2.y, 2));
    return dist;
  };

  /**
   * Add an annotation to the layer.  The annotation could be in any state.
   *
   * @param {geo.annotation} annotation The annotation to add.
   * @param {string|geo.transform|null} [gcs] `undefined` to use the interface
   *    gcs, `null` to use the map gcs, or any other transform.
   * @param {boolean} [update] If `false`, don't update the layer after adding
   *    the annotation.
   * @returns {this} The current layer.
   * @fires geo.event.annotation.add_before
   * @fires geo.event.annotation.add
   */
  this.addAnnotation = function (annotation, gcs, update) {
    if (m_annotationIds[annotation.id()] === undefined) {
      while (m_this.annotationById(annotation.id())) {
        annotation.newId();
      }
      m_this.geoTrigger(geo_event.annotation.add_before, {
        annotation: annotation
      });
      m_annotations.push(annotation);
      m_annotationIds[annotation.id()] = annotation;
      annotation.layer(m_this);
      var map = m_this.map();
      gcs = (gcs === null ? map.gcs() : (
        gcs === undefined ? map.ingcs() : gcs));
      if (gcs !== map.gcs()) {
        annotation._convertCoordinates(gcs, map.gcs());
      }
      if (update !== false) {
        m_this.modified();
        m_this.draw();
      }
      m_this.geoTrigger(geo_event.annotation.add, {
        annotation: annotation
      });
    }
    return m_this;
  };

  /**
   * Remove an annotation from the layer.
   *
   * @param {geo.annotation} annotation The annotation to remove.
   * @param {boolean} [update] If `false`, don't update the layer after removing
   *    the annotation.
   * @param {int} [pos] The posiiton of the annotation in the annotation list,
   *    if known.  This speeds up the process.
   * @returns {boolean} `true` if an annotation was removed.
   * @fires geo.event.annotation.remove
   */
  this.removeAnnotation = function (annotation, update, pos) {
    if (annotation.id && m_annotationIds[annotation.id()] !== undefined) {
      pos = m_annotations.indexOf(annotation);
      if (annotation === m_this.currentAnnotation) {
        m_this.currentAnnotation = null;
      }
      if (m_annotationIds[annotation.id()] !== undefined) {
        delete m_annotationIds[annotation.id()];
      }
      annotation._exit();
      m_annotations.splice(pos, 1);
      if (update !== false) {
        m_this.modified();
        m_this.draw();
      }
      m_this.geoTrigger(geo_event.annotation.remove, {
        annotation: annotation
      });
      return true;
    }
    return false;
  };

  /**
   * Remove all annotations from the layer.
   *
   * @param {boolean} [skipCreating] If truthy, don't remove annotations that
   *    are in the create state.
   * @param {boolean} [update] If `false`, don't update the layer after
   *    removing the annotation.
   * @returns {number} The number of annotations that were removed.
   */
  this.removeAllAnnotations = function (skipCreating, update) {
    var removed = 0, annotation;
    for (let pos = m_annotations.length - 1; pos >= 0; pos -= 1) {
      annotation = m_annotations[pos];
      if (skipCreating && annotation.state() === geo_annotation.state.create) {
        continue;
      }
      m_this.removeAnnotation(annotation, false, pos);
      removed += 1;
    }
    if (removed && update !== false) {
      m_this.modified();
      m_this.draw();
    }
    return removed;
  };

  /**
   * Get the list of annotations on the layer.
   *
   * @returns {geo.annotation[]} An array of annotations.
   */
  this.annotations = function () {
    return m_annotations.slice();
  };

  /**
   * Get an annotation by its id.
   *
   * @param {number} id The annotation ID.
   * @returns {geo.annotation} The selected annotation or `undefined` if none
   *    matches the id.
   */
  this.annotationById = function (id) {
    if (id !== undefined && id !== null) {
      id = +id;  /* Cast to int */
    }
    return m_annotationIds[id];
  };

  /* A list of special modes */
  this.modes = {
    edit: 'edit',
    cursor: 'cursor'
  };

  /* Keys are short-hand for preferred event modifiers.  Values are classes to
   * apply to the map node. */
  this._booleanClasses = {
    s: 'annotation-union',
    sc: 'annotation-intersect',
    c: 'annotation-difference',
    sa: 'annotation-xor'
  };

  /**
   * Get or set the current mode.
   *
   * @param {string|null} [arg] `undefined` to get the current mode, `null` to
   *    stop creating/editing, `this.modes.edit` (`'edit'`) plus an annotation
   *    to switch to edit mode, `this.modes.cursor` plus an annotation to
   *    switch to using the annotation as a cursor, or the name of the type of
   *    annotation to create.  Available annotations can listed via
   *    {@link geo.listAnnotations}.
   * @param {geo.annotation} [editAnnotation] If `arg === this.modes.edit` or
   *    `arg === this.modes.cursor`, this is the annotation that should be
   *    edited or used.
   * @param {object} [options] Additional options to pass when creating an
   *    annotation.
   * @returns {string|null|this} The current mode or the layer.
   * @fires geo.event.annotation.mode
   */
  this.mode = function (arg, editAnnotation, options) {
    if (arg === undefined) {
      return m_mode;
    }
    if (arg !== m_mode ||
        ((arg === m_this.modes.edit || arg === m_this.modes.cursor) && editAnnotation !== m_this.editAnnotation) ||
        (arg !== m_this.modes.edit && arg !== m_this.modes.cursor && arg && !m_this.currentAnnotation)
    ) {
      var createAnnotation, actions,
          mapNode = m_this.map().node(), oldMode = m_mode;
      m_mode = arg;
      mapNode.toggleClass('annotation-input', !!(m_mode && m_mode !== m_this.modes.edit && m_mode !== m_this.modes.cursor));
      if (!m_mode || m_mode === m_this.modes.edit) {
        Object.values(m_this._booleanClasses).forEach((c) => mapNode.toggleClass(c, false));
        m_this._currentBooleanClass = undefined;
      }
      if (!m_keyHandler) {
        m_keyHandler = Mousetrap(mapNode[0]);
      }
      if (m_mode) {
        m_keyHandler.bind('esc', function () { m_this.mode(null); });
      } else {
        m_keyHandler.unbind('esc');
      }
      if (m_this.currentAnnotation) {
        switch (m_this.currentAnnotation.state()) {
          case geo_annotation.state.create:
            m_this.removeAnnotation(m_this.currentAnnotation);
            break;
          case geo_annotation.state.edit:
            m_this.currentAnnotation.state(geo_annotation.state.done);
            m_this.modified();
            m_this.draw();
            break;
          case geo_annotation.state.cursor:
            m_this.currentAnnotation.state(geo_annotation.state.done);
            m_this.modified();
            m_this.draw();
            m_this.map().node().toggleClass('annotation-cursor', false);
            break;
        }
        m_this.currentAnnotation = null;
      }
      if (m_mode === m_this.modes.edit) {
        m_this.currentAnnotation = editAnnotation;
        m_this.currentAnnotation.state(geo_annotation.state.edit);
        m_this.modified();
      } else if (m_mode === m_this.modes.cursor) {
        m_this.currentAnnotation = editAnnotation;
        m_this.currentAnnotation.state(geo_annotation.state.cursor);
        m_this.modified();
        m_this.map().node().toggleClass('annotation-cursor', true);
        actions = m_this.currentAnnotation.actions(geo_annotation.state.cursor);
      } else if (registry.registries.annotations[m_mode]) {
        createAnnotation = registry.registries.annotations[m_mode].func;
      }
      m_this.map().interactor().removeAction(
        undefined, undefined, geo_annotation.actionOwner);
      if (createAnnotation) {
        options = Object.assign({}, options || {}, {
          state: geo_annotation.state.create,
          layer: m_this
        });
        m_this.currentAnnotation = createAnnotation(options);
        m_this.addAnnotation(m_this.currentAnnotation, null);
        actions = m_this.currentAnnotation.actions(geo_annotation.state.create);
      }
      if (actions) {
        $.each(actions, function (idx, action) {
          m_this.map().interactor().addAction(action);
        });
      }
      m_this.geoTrigger(geo_event.annotation.mode, {
        mode: m_mode, oldMode: oldMode});
      if (oldMode === m_this.modes.edit || oldMode === m_this.modes.cursor) {
        m_this.modified();
      }
    }
    return m_this;
  };

  /**
   * Return the current set of annotations as a geojson object.  Alternately,
   * add a set of annotations from a geojson object.
   *
   * @param {string|object|File} [geojson] If present, add annotations based on
   *    the given geojson object.  If `undefined`, return the current
   *    annotations as geojson.  This may be a JSON string, a javascript
   *    object, or a File object.
   * @param {boolean|string} [clear] If `true`, when adding annotations, first
   *    remove all existing objects.  If `'update'`, update existing
   *    annotations and remove annotations that no longer exist.  If falsy,
   *    update existing annotations and leave annotations that have not
   *    changed.
   * @param {string|geo.transform|null} [gcs] `undefined` to use the interface
   *    gcs, `null` to use the map gcs, or any other transform.
   * @param {boolean} [includeCrs] If truthy, include the coordinate system in
   *    the output.
   * @returns {object|number|undefined} If `geojson` was undefined, the current
   *    annotations is a javascript object that can be converted to geojson
   *    using JSON.stringify.  If `geojson` is specified, either the number of
   *    annotations now present upon success, or `undefined` if the value in
   *    `geojson` was not able to be parsed.
   */
  this.geojson = function (geojson, clear, gcs, includeCrs) {
    if (geojson !== undefined) {
      var reader = registry.createFileReader('geojsonReader', {
        layer: m_this,
        lineStyle: require('./annotation/lineAnnotation').defaults.style,
        pointStyle: require('./annotation/pointAnnotation').defaults.style,
        polygonStyle: require('./annotation/polygonAnnotation').defaults.style
      });
      if (!reader.canRead(geojson)) {
        return;
      }
      if (clear === true) {
        m_this.removeAllAnnotations(true, false);
      }
      if (clear === 'update') {
        $.each(m_this.annotations(), function (idx, annotation) {
          annotation.options('updated', false);
        });
      }
      reader.read(geojson, function (features) {
        $.each(features.slice(), function (feature_idx, feature) {
          m_this._geojsonFeatureToAnnotation(feature, gcs);
          m_this.deleteFeature(feature);
        });
      });
      if (clear === 'update') {
        $.each(m_this.annotations(), function (idx, annotation) {
          if (annotation.options('updated') === false &&
              annotation.state() === geo_annotation.state.done) {
            m_this.removeAnnotation(annotation, false);
          }
        });
      }
      m_this.modified();
      m_this.draw();
      return m_annotations.length;
    }
    geojson = null;
    var features = [];
    $.each(m_annotations, function (annotation_idx, annotation) {
      var obj = annotation.geojson(gcs, includeCrs);
      if (obj) {
        features.push(obj);
      }
    });
    if (features.length) {
      geojson = {
        type: 'FeatureCollection',
        features: features
      };
    }
    return geojson;
  };

  /**
   * Convert a feature as parsed by the geojson reader into one or more
   * annotations.
   *
   * @param {geo.feature} feature The feature to convert.
   * @param {string|geo.transform|null} [gcs] `undefined` to use the interface
   *    gcs, `null` to use the map gcs, or any other transform.
   * @fires geo.event.annotation.update
   */
  this._geojsonFeatureToAnnotation = function (feature, gcs) {
    var dataList = feature.data(),
        annotationList = registry.listAnnotations(),
        map = m_this.map();
    gcs = (gcs === null ? map.gcs() : (
      gcs === undefined ? map.ingcs() : gcs));
    $.each(dataList, function (data_idx, data) {
      var type = (data.properties || {}).annotationType || feature.featureType,
          options = Object.assign({}, data.properties || {}),
          position, datagcs, i, existing;
      if (!annotationList.includes(type)) {
        return;
      }
      options.style = options.style || {};
      options.labelStyle = options.labelStyle || {};
      delete options.annotationType;
      // the geoJSON reader can emit line, polygon, point, and marker
      switch (feature.featureType) {
        case 'line':
          position = feature.line()(data, data_idx);
          if (!position || position.length < 2) {
            return;
          }
          // make a copy of the position array to avoid mutating the original.
          position = position.slice();
          break;
        case 'polygon':
          position = feature.polygon()(data, data_idx);
          if (!position || !position.outer || position.outer.length < 3) {
            return;
          }
          // make a copy of the position array to avoid mutating the original.
          position = {
            outer: position.outer.slice(),
            inner: (position.inner || []).map((h) => h.slice())
          };
          if (position.outer[position.outer.length - 1][0] === position.outer[0][0] &&
              position.outer[position.outer.length - 1][1] === position.outer[0][1]) {
            position.outer.splice(position.outer.length - 1, 1);
            if (position.outer.length < 3) {
              return;
            }
          }
          position.inner.forEach((h) => {
            if (h.length > 3 && h[h.length - 1][0] === h[0][0] && h[h.length - 1][1] === h[0][1]) {
              h.splice(h.length - 1, 1);
            }
          });
          if (!position.inner || !position.inner.length) {
            position = position.outer;
          }
          break;
        case 'marker':
          position = data.geometry.coordinates[0].slice(0, 4);
          break;
        case 'point':
          position = [feature.position()(data, data_idx)];
          break;
      }
      datagcs = ((data.crs && data.crs.type === 'name' && data.crs.properties &&
                  data.crs.properties.type === 'proj4' &&
                  data.crs.properties.name) ? data.crs.properties.name : gcs);
      [position.outer || position].concat(position.inner || []).forEach((poslist) => {
        for (i = 0; i < poslist.length; i += 1) {
          poslist[i] = util.normalizeCoordinates(poslist[i]);
        }
        if (datagcs !== map.gcs()) {
          const transposlist = transform.transformCoordinates(datagcs, map.gcs(), poslist);
          for (i = 0; i < poslist.length; i += 1) {
            poslist[i] = transposlist[i];
          }
        }
      });
      options.coordinates = position;
      /* For each style listed in the geojsonStyleProperties object, check if
       * is given under any of the variety of keys as a valid instance of the
       * required data type.  If not, use the property from the feature. */
      $.each(geojsonStyleProperties, function (key, prop) {
        var value;
        $.each(prop.keys, function (idx, altkey) {
          if (value === undefined) {
            value = m_this.validateAttribute(options[altkey], prop.dataType);
          }
        });
        if (value === undefined) {
          value = m_this.validateAttribute(
            feature.style.get(key)(data, data_idx), prop.dataType);
        }
        if (value !== undefined) {
          options[prop.option || 'style'][key] = value;
        }
      });
      /* Delete property keys we have used */
      $.each(geojsonStyleProperties, function (key, prop) {
        $.each(prop.keys, function (idx, altkey) {
          delete options[altkey];
        });
      });
      if (options.annotationId !== undefined) {
        existing = m_this.annotationById(options.annotationId);
        if (existing) {
          delete options.annotationId;
        }
      }
      if (existing && existing.type() === type && existing.state() === geo_annotation.state.done && existing.options('updated') === false) {
        /* We could change the state of the existing annotation if it differs
         * from done. */
        delete options.state;
        delete options.layer;
        options.updated = true;
        existing.options(options);
        m_this.geoTrigger(geo_event.annotation.update, {
          annotation: existing
        });
      } else {
        options.state = geo_annotation.state.done;
        options.layer = m_this;
        options.updated = 'new';
        m_this.addAnnotation(registry.createAnnotation(type, options), null);
      }
    });
  };

  /**
   * Validate a value for an attribute based on a specified data type.  This
   * returns a sanitized value or `undefined` if the value was invalid.  Data
   * types include:
   * - `color`: a css string, `#rrggbb` hex string, `#rgb` hex string, number,
   *   or object with r, g, b properties in the range of [0-1].
   * - `opacity`: a floating point number in the range [0, 1].
   * - `positive`: a floating point number greater than zero.
   * - `boolean`: a string whose lowercase value is `'false'`, `'off'`, or
   *   `'no'`, and falsy values are false, all else is true.  `null` and
   *   `undefined` are still considered invalid values.
   * - `booleanOrNumber`: a string whose lowercase value is `'false'`, `'off'`,
   *   `'no'`, `'true'`, `'on'`, or `'yes'`, falsy values that aren't 0, and
   *   `true` are handled as booleans.  Otherwise, a floating point number that
   *   isn't NaN or an infinity.
   * - `coordinate2`: either an object with x and y properties that are
   *   numbers, or a string of the form <x>[,]<y> with optional whitespace, or
   *   a JSON encoded object with x and y values, or a JSON encoded list of at
   *   leasst two numbers.
   * - `number`: a floating point number that isn't NaN or an infinity.
   * - `angle`: a number that represents radians.  If followed by one of `deg`,
   *   `grad`, or `turn`, it is converted to radians.  An empty string is also
   *   allowed.
   * - `text`: any text string.
   * @param {number|string|object|boolean} value The value to validate.
   * @param {string} dataType The data type for validation.
   * @returns {number|string|object|boolean|undefined} The sanitized value or
   *    `undefined`.
   */
  this.validateAttribute = function (value, dataType) {
    var parts;

    if (value === undefined || value === null) {
      return;
    }
    switch (dataType) {
      case 'angle':
        if (value === '') {
          break;
        }
        parts = /^\s*([-.0-9eE]+)\s*(deg|rad|grad|turn)?\s*$/.exec(('' + value).toLowerCase());
        if (!parts || !isFinite(parts[1])) {
          return;
        }
        var factor = (parts[2] === 'grad' ? Math.PI / 200 :
          (parts[2] === 'deg' ? Math.PI / 180 :
            (parts[2] === 'turn' ? 2 * Math.PI : 1)));
        value = +parts[1] * factor;
        break;
      case 'boolean':
        value = !!value && ['false', 'no', 'off'].indexOf(('' + value).toLowerCase()) < 0;
        break;
      case 'booleanOrNumber':
        if ((!value && value !== 0 && value !== '') || ['true', 'false', 'off', 'on', 'no', 'yes'].indexOf(('' + value).toLowerCase()) >= 0) {
          value = !!value && ['false', 'no', 'off'].indexOf(('' + value).toLowerCase()) < 0;
        } else {
          if (!util.isNonNullFinite(value)) {
            return;
          }
          value = +value;
        }
        break;
      case 'coordinate2':
        if (value === '') {
          break;
        }
        if (value && util.isNonNullFinite(value.x) && util.isNonNullFinite(value.y)) {
          value.x = +value.x;
          value.y = +value.y;
          break;
        }
        try { value = JSON.parse(value); } catch (err) { }
        if (value && util.isNonNullFinite(value.x) && util.isNonNullFinite(value.y)) {
          value.x = +value.x;
          value.y = +value.y;
          break;
        }
        if (Array.isArray(value) && util.isNonNullFinite(value[0]) && util.isNonNullFinite(value[1])) {
          value = {x: +value[0], y: +value[1]};
          break;
        }
        parts = /^\s*([-.0-9eE]+)(?:\s+|\s*,)\s*([-.0-9eE]+)\s*$/.exec('' + value);
        if (!parts || !isFinite(parts[1]) || !isFinite(parts[2])) {
          return;
        }
        value = {x: +parts[1], y: +parts[2]};
        break;
      case 'color':
        value = util.convertColor(value);
        if (value === undefined || value.r === undefined) {
          return;
        }
        break;
      case 'number':
        if (!util.isNonNullFinite(value)) {
          return;
        }
        value = +value;
        break;
      case 'numberOrBlank':
        if (value === '') {
          break;
        }
        if (!util.isNonNullFinite(value)) {
          return;
        }
        value = +value;
        break;
      case 'opacity':
        if (value === '') {
          return;
        }
        value = +value;
        if (isNaN(value) || value < 0 || value > 1) {
          return;
        }
        break;
      case 'positive':
        value = +value;
        if (!isFinite(value) || value <= 0) {
          return;
        }
        break;
      case 'text':
        value = '' + value;
        break;
    }
    return value;
  };

  /**
   * Update layer.
   *
   * @returns {this} The current layer.
   */
  this._update = function () {
    if (m_this.timestamp() > m_buildTime.timestamp()) {
      var labels = m_this.options('showLabels') ? [] : null,
          editable = m_this.options('clickToEdit') || m_this.mode() === m_this.modes.edit;
      /* Internally, we have a set of feature levels (to provide z-index
       * support), each of which can have data from multiple annotations.  We
       * clear the data on each of these features, then build it up from each
       * annotation.  Eventually, it may be necessary to optimize this and
       * only update the features that are changed.
       */
      $.each(m_features, function (idx, featureLevel) {
        $.each(featureLevel, function (type, feature) {
          feature.data = [];
          delete feature.feature.scaleOnZoom;
        });
      });
      $.each(m_annotations, function (annotation_idx, annotation) {
        var features = annotation.features();
        if (labels) {
          var annotationLabel = annotation.labelRecord();
          if (annotationLabel) {
            labels.push(annotationLabel);
          }
        }
        $.each(features, function (idx, featureLevel) {
          if (m_features[idx] === undefined) {
            m_features[idx] = {};
          }
          $.each(featureLevel, function (type, featureSpec) {
            /* Create features as needed */
            if (!m_features[idx][type]) {
              var feature = m_this.createFeature(type, {
                gcs: m_this.map().gcs(),
                selectionAPI: editable
              });
              if (!feature) {
                /* We can't create the desired feature, probably because of the
                 * selected renderer.  Issue one warning only. */
                var key = 'error_feature_' + type;
                if (!m_this[key]) {
                  console.warn('Cannot create a ' + type + ' feature for ' +
                               'annotations.');
                  m_this[key] = true;
                }
                return;
              }
              if (editable) {
                feature.geoOn(geo_event.feature.mouseon, m_this._handleMouseOn);
                feature.geoOn(geo_event.feature.mouseoff, m_this._handleMouseOff);
              }

              /* Since each annotation can have separate styles, the styles are
               * combined together with a meta-style function.  Any style that
               * could be used should be in this list.  Color styles may be
               * restricted to {r, g, b} objects for efficiency, but this
               * hasn't been tested.
               */
              var style = {};
              $.each([
                'closed', 'fill', 'fillColor', 'fillOpacity', 'line',
                'lineCap', 'lineJoin', 'polygon', 'position', 'radius',
                'radiusIncludesStroke', 'rotateWithMap', 'rotation',
                'scaleWithZoom', 'stroke', 'strokeColor', 'strokeOffset',
                'strokeOpacity', 'strokeWidth', 'symbolValue', 'uniformPolygon'
              ], function (keyidx, key) {
                var origFunc;
                if (feature.style()[key] !== undefined) {
                  origFunc = feature.style.get(key);
                }
                style[key] = function (d, i, d2, i2) {
                  var style = (
                    (d && d.style) ? d.style : (d && d[2] && d[2].style) ?
                      d[2].style : d2.style);
                  var result = style ? style[key] : d;
                  if (util.isFunction(result)) {
                    result = result(d, i, d2, i2);
                  }
                  if (result === undefined && origFunc) {
                    result = origFunc(d, i, d2, i2);
                  }
                  return result;
                };
              });
              feature.style(style);
              m_features[idx][type] = {
                feature: feature,
                style: style,
                data: []
              };
            } else {
              feature = m_features[idx][type].feature;
              // update whether we check for selections on existing features
              if (feature.selectionAPI() !== !!editable) {
                feature.selectionAPI(editable);
                if (editable) {
                  feature.geoOn(geo_event.feature.mouseon, m_this._handleMouseOn);
                  feature.geoOn(geo_event.feature.mouseoff, m_this._handleMouseOff);
                } else {
                  feature.geoOff(geo_event.feature.mouseon, m_this._handleMouseOn);
                  feature.geoOff(geo_event.feature.mouseoff, m_this._handleMouseOff);
                }
              }
            }
            /* Collect the data for each feature */
            var dataEntry = featureSpec.data || featureSpec;
            if (!Array.isArray(dataEntry)) {
              dataEntry = [dataEntry];
            }
            dataEntry.forEach(function (dataElement) {
              dataElement.annotation = annotation;
              m_features[idx][type].data.push(dataElement);
              if (featureSpec.scaleOnZoom) {
                m_features[idx][type].feature.scaleOnZoom = true;
              }
            });
          });
        });
      });
      /* Update the data for each feature */
      $.each(m_features, function (idx, featureLevel) {
        $.each(featureLevel, function (type, feature) {
          feature.feature.data(feature.data);
        });
      });
      m_this._updateLabels(labels);
      m_buildTime.modified();
    }
    s_update.call(m_this, arguments);
    return m_this;
  };

  /**
   * Show or hide annotation labels.  Create or destroy a child layer or a
   * feature as needed.
   *
   * @param {object[]|null} labels The list of labels to display of `null` for
   *    no labels.
   * @returns {this} The class instance.
   * @fires geo.event.annotation.layerAdd
   */
  this._updateLabels = function (labels) {
    if (!labels || !labels.length) {
      m_this._removeLabelFeature();
      return m_this;
    }
    if (!m_labelFeature) {
      if (!(registry.registries.features[m_this.rendererName()] || {}).text) {
        var renderer = registry.rendererForFeatures(['text']);
        m_labelLayer = registry.createLayer('feature', m_this.map(), {renderer: renderer});
        m_this.addChild(m_labelLayer);
        m_labelLayer._update();
        m_this.geoTrigger(geo_event.layerAdd, {
          target: m_this,
          layer: m_labelLayer
        });
      }
      var style = {};
      textFeature.usedStyles.forEach(function (key) {
        style[key] = function (d, i) {
          if (d.style && d.style[key] !== undefined) {
            return d.style[key];
          }
          return (m_this.options('defaultLabelStyle') || {})[key];
        };
      });
      m_labelFeature = (m_labelLayer || m_this).createFeature('text', {
        style: style,
        gcs: m_this.map().gcs(),
        position: function (d) {
          return d.position;
        }
      });
    }
    m_labelFeature.data(labels);
    return m_this;
  };

  /**
   * Check if any features are marked that they need to be updated when a zoom
   * occurs.  If so, mark that feature as modified.
   */
  this._handleZoom = function () {
    var i, features = m_this.features();
    for (i = 0; i < features.length; i += 1) {
      if (features[i].scaleOnZoom) {
        features[i].modified();
      }
    }
  };

  /**
   * Remove the label feature if it exists.
   *
   * @returns {this} The current layer.
   * @fires geo.event.annotation.layerRemove
   */
  this._removeLabelFeature = function () {
    if (m_labelLayer) {
      m_labelLayer._exit();
      m_this.removeChild(m_labelLayer);
      m_this.geoTrigger(geo_event.layerRemove, {
        target: m_this,
        layer: m_labelLayer
      });
      m_labelLayer = m_labelFeature = null;
    }
    if (m_labelFeature) {
      m_this.removeFeature(m_labelFeature);
      m_labelFeature = null;
    }
    return m_this;
  };

  /**
   * Update if necessary and draw the layer.
   *
   * @returns {this} The current layer.
   */
  this.draw = function () {
    m_this._update();
    s_draw.call(m_this);
    return m_this;
  };

  /**
   * Return any annotation that has area as a polygon list: an array of
   * polygons, each of which is an array of polylines, each of which is an
   * array of points, each of which is a 2-tuple of numbers.
   *
   * @param {geo.util.polyop.spec} [opts] Ignored.
   * @returns {geo.polygonList} A list of polygons.
   */
  this.toPolygonList = function (opts) {
    const poly = [];
    opts = opts || {};
    const indices = [];
    if (!opts.annotationIndices) {
      opts.annotationIndices = {};
    }
    opts.annotationIndices[m_this.id()] = indices;
    m_annotations.forEach((annotation, idx) => {
      if (annotation.toPolygonList) {
        annotation.toPolygonList(opts).forEach((p) => poly.push(p));
        indices.push(idx);
      }
    });
    return poly;
  };

  /**
   * Replace appropriate annotations with a list of polygons.
   *
   * @param {geo.polygonList} poly A list of polygons.
   * @param {geo.util.polyop.annotationLayerSpec} [opts] This contains
   *   annotationIndices and correspondence used to track annotations.
   * @returns {this}
   */
  this.fromPolygonList = function (poly, opts) {
    if (!poly || !poly.length) {
      return m_this;
    }
    /* One of 'all', 'exact', 'none'; default is 'exact' */
    const keep = opts.keepAnnotations;
    const keepIds = {};
    const reusedIds = {};
    let correspond, exact, annot;
    const indices = (opts.annotationIndices || {})[m_this.id()];
    if (indices && opts.correspond && opts.correspond.poly1 && indices.length === opts.correspond.poly1.length) {
      correspond = opts.correspond.poly1;
      exact = opts.correspond.exact1;
      annot = m_this.annotations();
    }
    if (keep !== 'all' && keep !== 'none' && annot) {
      annot.forEach((oldAnnot, idx) => {
        if (indices.indexOf(idx) < 0) {
          keepIds[oldAnnot.id()] = true;
        }
      });
    }
    const polyAnnot = [];
    poly.forEach((p, idx) => {
      p = p.map((h) => h.map((pt) => ({x: pt[0], y: pt[1]})));
      const result = {
        vertices: p.length === 1 ? p[0] : {outer: p[0], inner: p.slice(1)}
      };
      if (correspond) {
        for (let i = 0; i < correspond.length; i += 1) {
          if (correspond[i] && correspond[i].indexOf(idx) >= 0) {
            const orig = annot[indices[i]];
            if (keep !== 'all' && keep !== 'none' && exact && exact[i] && exact[i].indexOf(idx) >= 0) {
              keepIds[orig.id()] = true;
              return;
            }
            if (keep !== 'all' && reusedIds[orig.id()] === undefined) {
              result.annotationId = orig.id();
              reusedIds[orig.id()] = true;
            }
            ['name', 'description', 'label'].forEach((k) => {
              if (orig[k](undefined, true)) {
                result[k] = orig[k](undefined, true);
              }
            });
            Object.entries(orig.options()).forEach(([key, value]) => {
              if (['showLabel', 'style'].indexOf(key) >= 0 || key.endsWith('Style')) {
                result[key] = value;
              }
            });
            break;
          }
        }
      }
      polyAnnot.push(result);
    });
    let update = false;
    // delete extant annotations
    if (keep !== 'all' && annot) {
      annot
        .filter((oldAnnot) => keepIds[oldAnnot.id()] === undefined)
        .forEach((oldAnnot) => {
          m_this.removeAnnotation(oldAnnot, false);
          update = true;
        });
    }
    // add new annotations
    polyAnnot.forEach((p) => {
      m_this.addAnnotation(registry.createAnnotation('polygon', p), m_this.map().gcs(), false);
      update = true;
    });
    if (update) {
      m_this.modified();
      m_this.draw();
    }
    return m_this;
  };

  /**
   * Initialize.
   *
   * @returns {this} The current layer.
   */
  this._init = function () {
    // Call super class init
    s_init.call(m_this);

    if (!m_this.map().interactor()) {
      m_this.map().interactor(mapInteractor({actions: []}));
    }
    m_this.geoOn(geo_event.actionselection, m_this._processAction);
    m_this.geoOn(geo_event.actionmove, m_this._processAction);
    m_this.geoOn(geo_event.actionup, m_this._processAction);

    m_this.geoOn(geo_event.mouseclick, m_this._handleMouseClick);
    m_this.geoOn(geo_event.mousemove, m_this._handleMouseMove);

    m_this.geoOn(geo_event.zoom, m_this._handleZoom);

    return m_this;
  };

  /**
   * Free all resources.
   *
   * @returns {this} The current layer.
   */
  this._exit = function () {
    if (m_keyHandler) {
      m_keyHandler.reset();
    }
    m_this._removeLabelFeature();
    // Call super class exit
    s_exit.call(m_this);
    m_annotations = [];
    m_annotationIds = {};
    m_features = [];
    return m_this;
  };

  return m_this;
};

inherit(annotationLayer, featureLayer);
registry.registerLayer('annotation', annotationLayer);
module.exports = annotationLayer;
