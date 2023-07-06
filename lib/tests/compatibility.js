'use strict';

const jsonschemaTools = require('../jsonschema-tools');
const {
    shouldSkipTestCase
} = require('./util');

const _ = require('lodash');
const assert = require('assert').strict;

// TODO: move these functions into tools module instead of tests?
/**
 * These fields are allowed to change between versions.
 */
const FIELDS_ALLOWED_TO_CHANGE = [
    '$id',
    'description',
    'examples'
];

function isAllowedToChange(fieldName) {
    return FIELDS_ALLOWED_TO_CHANGE.indexOf(fieldName) !== -1;
}

function assertRequiredCompatible(newRequired, oldRequired, path) {
    if (oldRequired && !newRequired) {
        throw new assert.AssertionError({
            message: `Removed list of required properties at: ${path}`,
            expected: oldRequired,
            actual: newRequired
        });
    }

    if (!_.isEqual(newRequired.sort(), oldRequired.sort())) {
        throw new assert.AssertionError({
            message: `Requiredness of properties cannot be modified at: ${path}`,
            expected: oldRequired,
            actual: newRequired
        });
    }
}

/**
 * Asserts that newEnum is a superset of oldEnum
 * @param {Array} newEnum
 * @param {Array} oldEnum
 * @param {string} path
 */
function assertEnumCompatible(newEnum, oldEnum, path) {
    if (oldEnum && !newEnum) {
        throw new assert.AssertionError({
            message: `Removed enum at: ${path}`,
            expected: oldEnum,
            actual: newEnum
        });
    }

    if (!oldEnum.every(e => newEnum.includes(e))) {
        throw new assert.AssertionError({
            message: `New enum is not superset of old enum at: ${path}`,
            expected: oldEnum,
            actual: newEnum
        });
    }
}

function assertCompatible(newSchema, oldSchema, path = '') {
    if (typeof newSchema !== typeof oldSchema ||
        Array.isArray(newSchema) !== Array.isArray(oldSchema)) {
        throw new assert.AssertionError({
            message: `Error at path: ${path}`,
            expected: oldSchema,
            actual: newSchema || {}
        });
    } else if (typeof oldSchema === 'object') {
        // Go recursively
        for (const key of Object.keys(oldSchema)) {
            if (isAllowedToChange(key)) {
                continue;
            }

            switch (key) {
                case 'required':
                    assertRequiredCompatible(newSchema.required, oldSchema.required, `${path}.${key}`);
                    break;
                case 'enum':
                    assertEnumCompatible(newSchema.enum, oldSchema.enum, path);
                    break;
                default:
                    // If the field is in both schemas, must be compatible
                    if (key in newSchema) {
                        assertCompatible(newSchema[key], oldSchema[key], `${path}.${key}`);
                    } else {
                        throw new assert.AssertionError({
                            message: `Error at path: ${path}.${key}`,
                            expected: oldSchema,
                            actual: newSchema
                        });
                    }
                    break;
            }
        }
    } else if (newSchema !== oldSchema) {
        throw new assert.AssertionError({
            message: `Error at path: ${path}`,
            expected: oldSchema,
            actual: newSchema
        });
    }
}

// Used as the testCase name in the skipSchemaTestCases option.
const compatibilityTestCase = {
    name: 'schema-version-compatibility'
};

function declareTests(options = { logLevel: 'warn' }) {
    options = jsonschemaTools.readConfig(options);
    const allSchemas = jsonschemaTools.findSchemasByTitleAndMajor(options);

    describe(`Schema Compatibility in Repository ${options.schemaBasePath}`, () => {
        for (const title of Object.keys(allSchemas)) {
            describe(title, () => {
                for (const major of Object.keys(allSchemas[title])) {
                    const materializedSchemas = allSchemas[title][major]
                    .filter(schemaInfo => !schemaInfo.current)
                    // Only check compatibility of the 'main' (first) contentType.
                    // Tests that the various content types are the same schema
                    // are handled by the stucture tests.
                    .filter(schemaInfo => schemaInfo.contentType === options.contentTypes[0]);

                    if (materializedSchemas.length > 1) {
                        describe(`Major Version ${major}`, () => {
                            for (let i = 0; i < materializedSchemas.length - 1; i++) {
                                const oldSchemaInfo = materializedSchemas[i];
                                const newSchemaInfo = materializedSchemas[i + 1];
                                it(`${newSchemaInfo.version} must be compatible with ${oldSchemaInfo.version}`, function() {
                                    if (shouldSkipTestCase(compatibilityTestCase, newSchemaInfo, options)) {
                                        this.skip();
                                    } else {
                                        assertCompatible(newSchemaInfo.schema, oldSchemaInfo.schema);
                                    }
                                });
                            }
                        });
                    }
                }
            });
        }
    });

}

module.exports = declareTests;
