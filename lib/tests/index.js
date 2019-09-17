'use strict';

const jsonschemaTools = require('../jsonschema-tools');

const repositoryTests = {
    structure: require('./structure'),
    robustness: require('./robustness'),
    compatibility: require('./compatibility'),
};

function allTests(options = {}) {
    options = jsonschemaTools.readConfig(options);
    Object.values(repositoryTests).forEach(test => test(options));
}

// Export functions for each type of test.  tests.all runs all repository tests.
module.exports = {
    all: allTests,
    ...repositoryTests
};
