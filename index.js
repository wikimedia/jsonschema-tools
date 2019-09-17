'use strict';

const jsTools = require('./lib/jsonschema-tools.js');

module.exports = { ...jsTools, tests: require('./lib/tests.js') };
