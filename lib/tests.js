'use strict';

const jsonschemaTools = require('./jsonschema-tools');

const repositoryTests = {
    structure: require('./tests/structure.js'),
    robustness: require('./tests/robustness.js'),
    compatibility: require('./tests/compatibility.js'),
};

function allTests(options = {}) {
    options = jsonschemaTools.readConfig(options);
    Object.values(repositoryTests).forEach(test => test(options));
}

module.exports = {
    all: allTests,
    ...repositoryTests
};
