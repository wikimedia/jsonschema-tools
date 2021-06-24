'use strict';

const jsonschemaTools = require('../jsonschema-tools.js');
const _ = require('lodash');

/**
 * Not all test cases should be run for every schema file.
 * If a condition fn is declared on the test case, it will be evalulated.
 * If the condition returns false, the test case should not be declared.
 * @param {Object} testCase
 * @param {Object} schemaInfo
 * @param {Object} options
 * @return {boolean}
 */
function shouldDeclareTestCase(testCase, schemaInfo, options = {}) {
    options = jsonschemaTools.readConfig(options);
    return (_.isUndefined(testCase.condition) || testCase.condition(schemaInfo, options));
}

/**
 * If options.skipSchemaTestCases contains matches for
 * this schema, any test cases listed there should be ignored.
 * @param {Object} testCase
 * @param {Object} schemaInfo
 * @param {Object} options
 * @return {boolean}
 */
function shouldSkipTestCase(testCase, schemaInfo, options = {}) {
    options = jsonschemaTools.readConfig(options);
    const schemaId = _.get(schemaInfo.schema, '$id', '');

    // testsIgnoreSchemas is schema $id regex => list of rule names to ignore.
    // Find all entries that match $id and and extract the ruleNames.
    const ignoreTestCases = _.uniq(_.flatten(_.values(_.pickBy(
        options.skipSchemaTestCases,
        (_, schemaIdRegex) => schemaId.match(schemaIdRegex)
    ))));

    return ignoreTestCases.includes(testCase.name);
}

module.exports = {
    shouldDeclareTestCase,
    shouldSkipTestCase
};
