'use strict';

const jsonschemaTools = require('../jsonschema-tools.js');
const {
    shouldSkipTestCase,
    shouldDeclareTestCase
} = require('./util');

const assert = require('assert').strict;
const traverseSchema = require('json-schema-traverse');
const _ = require('lodash');

const Ajv = require('ajv');
const ajv = new Ajv({
    schemaId: '$id'
});
const isSchemaValid = ajv.compile(require('ajv/lib/refs/json-schema-draft-07.json'));
const isSchemaSecure = ajv.compile(require('ajv/lib/refs/json-schema-secure.json'));
// Both http and https can be used as the draft-07 $schema URL.
// However, the draft-07 metaschema uses an http URL as its
// $id field.  AJV caches schemas by their $id.  In order
// to avoid a remote lookup of this metaschema if a
// schema sets $schema to https, we manually cache the
// local copy of draft-07 metaschema with the https URL.
ajv.addSchema(
    require('ajv/lib/refs/json-schema-draft-07.json'),
    'https://json-schema.org/draft-07/schema'
);

function assertMonomorphTypes(node, path = '') {
    if (Array.isArray(node.type)) {
        throw new assert.AssertionError({
            message: `Polymorphic type property at #${path}`
        });
    }
    Object.keys(node.properties || {}).forEach((key) => {
        const keyPath = `${path}/properties/${key}`;
        if (!node.properties[key].type) {
            throw new assert.AssertionError({
                message: `Missing type at #${keyPath}`
            });
        }
        assertMonomorphTypes(node.properties[key], keyPath);
    });
    (node.allOf || []).forEach((schema) => {
        assertMonomorphTypes(schema, path);
    });
}

function assertSnakeCaseProperties(node, path = '') {
    (node.allOf || []).forEach((schema) => {
        assertSnakeCaseProperties(schema, path);
    });
    Object.keys(node.properties || {}).forEach((prop) => {
        const propPath = `${path}/properties/${prop}`;
        if (!/^[$a-z]+[a-z0-9_]*$/.test(prop)) {
            throw new assert.AssertionError({
                message: `Non snake_case: #/${propPath}`
            });
        }
        assertSnakeCaseProperties(node.properties[prop], propPath);
    });
}

function assertRequired(node, path = '') {
    if (node.required) {
        assert.ok(node.properties, `#${path}/properties must exist`);
        node.required.forEach((prop) => {
            assert.ok(
                node.properties[prop],
                `#${path}/properties/${prop} is required but not exist`
            );
        });
    }
    Object.keys(node.properties || {}).forEach((prop) => {
        assertRequired(node.properties[prop], `${path}/properties/${prop}`);
    });
}

function assertSchemaIsValid(schema) {
    if (!isSchemaValid(schema)) {
        throw new assert.AssertionError({
            message: 'Schema is invalid',
            expected: [],
            actual: isSchemaValid.errors
        });
    }
}

function assertSchemaIsSecure(schema) {
    if (!isSchemaSecure(schema)) {
        throw new assert.AssertionError({
            message: 'Schema insecure errors',
            expected: [],
            actual: isSchemaSecure.errors
        });
    }
}

function assertExamplesId(schema) {
    schema.examples.forEach((example, index) => {
        assert.strictEqual(
            example.$schema, schema.$id,
            `example ${index} $schema value does not match schema\'s $id value`
        );
    });
}

function assertValidExamples(schema) {
    schema.examples.forEach((example, index) => {
        if (!ajv.validate(schema, example)) {
            throw new assert.AssertionError({
                message: `example ${index} did not validate against schema: ${ajv.errorsText()}`,
            });
        }
    });
}

function assertEnforcedNumericBounds(schema, options = {}) {
    options = jsonschemaTools.readConfig(options);

    const enforcedMin = options.enforcedNumericBounds[0];
    const enforcedMax = options.enforcedNumericBounds[1];
    traverseSchema(schema, (obj, _1, _2, _3, _4, _5, fieldName) => {
        if (['number', 'integer'].includes(obj.type)) {
            assert.ok(typeof obj.minimum === 'number', `field ${fieldName} doesn\'t have a valid minimum value`);
            assert.ok(obj.minimum >= enforcedMin, `field ${fieldName} has a minimum value lower than enforcedNumericBounds minimum ${enforcedMin}`);

            assert.ok(typeof obj.maximum === 'number', `field ${fieldName} doesn\'t have a valid maximum value`);
            assert.ok(obj.maximum <= enforcedMax, `field ${fieldName} has a maximum value higher than enforcedNumericBounds minimum ${enforcedMax}`);
        }
    });
}

/**
 * Test case name => test case object.
 * description, test case assertFn and test case condition.
 */
const testCases = [
    {
        name: 'schema-is-valid',
        description: 'must be a valid JSONSchema',
        assertFn: assertSchemaIsValid,
    },
    {
        name: 'schema-is-secure',
        description: 'must be a secure JSONSchema',
        assertFn: assertSchemaIsSecure,
    },
    {
        name: 'schema-snake-case-properties',
        description: 'properties must be snake-case',
        assertFn: assertSnakeCaseProperties,
    },
    {
        name: 'schema-monomorphic-types',
        description: 'has no union types',
        assertFn: assertMonomorphTypes,
    },
    {
        name: 'schema-required-properties-exist',
        description: 'all required properties must exist',
        assertFn: assertRequired,
        condition: (schemaInfo) => {
            return !schemaInfo.current;
        },
    },
    {
        name: 'schema-examples-$schema-matches-schema-$id',
        description: 'examples must have $schema == schema\'s $id',
        assertFn: assertExamplesId,
        condition: (schemaInfo) => {
            return !schemaInfo.current && _.has(schemaInfo.schema, 'examples');
        },
    },
    {
        name: 'schema-examples-are-valid',
        description: 'examples must validate against schema',
        assertFn: assertValidExamples,
        condition: (schemaInfo) => {
            return !schemaInfo.current && _.has(schemaInfo.schema, 'examples');
        },
    },
    {
        name: 'schema-enforced-numeric-bounds',
        description: 'should have minimum and maximum values inside the configured bounds for all numeric fields',
        assertFn: assertEnforcedNumericBounds,
        condition: (schemaInfo, options = {}) => {
            return !schemaInfo.current && options.enforcedNumericBounds;
        },
    }
];




function declareTests(options = {}) {
    options = jsonschemaTools.readConfig(options);
    const allSchemas = jsonschemaTools.findSchemasByTitle(options);
    describe(`Schema Robustness in Repository ${options.schemaBasePath}`, () => {
        for (const title of Object.keys(allSchemas)) {
            describe(title, () => {
                allSchemas[title].forEach((schemaInfo) => {
                    const testName =
                        (schemaInfo.current ? 'current' : schemaInfo.version) +
                        (schemaInfo.contentType ? `.${schemaInfo.contentType}` : '');

                    describe(testName, () => {
                        testCases.filter(
                            // Conditional declartion of test cases is configured by
                            // the test cases themselves.
                            testCase => shouldDeclareTestCase(testCase, schemaInfo, options)
                        ).forEach((testCase) => {
                            it(testCase.description, function() {
                                // Skipping test cases for certain schema files
                                // is a configurable option.
                                if (shouldSkipTestCase(testCase, schemaInfo, options)) {
                                    this.skip();
                                } else {
                                    testCase.assertFn(schemaInfo.schema, options);
                                }
                            });
                        });
                    });
                });
            });
        }
    });

}

module.exports = declareTests;
