require('../src/vendor');
window.geo = require('../src/index');

// codemirror and plugins
require('codemirror/lib/codemirror.css');
require('codemirror/addon/lint/lint.css');
require('codemirror/addon/fold/foldgutter.css');

window.jsonlint = require('jsonlint-mod');
require('codemirror');
require('codemirror/mode/javascript/javascript');
require('codemirror/addon/lint/lint');
require('codemirror/addon/lint/json-lint');
require('codemirror/addon/fold/brace-fold');
require('codemirror/addon/fold/foldcode');
require('codemirror/addon/fold/foldgutter');
require('codemirror/addon/edit/matchbrackets');

// Colorbrewer
window.colorbrewer = require('colorbrewer/index.ts').default;

// d3
window.d3 = require('d3');
