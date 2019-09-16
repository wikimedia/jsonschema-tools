'use strict';

const jsTools = require('./lib/jsonschema-tools.js');
const tests   = require('./lib/tests.js');

module.exports = { ...jsTools, ...tests };
