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


/**
 * Retuns a new Ajv instance. We need multiple ajv insttances
 * for tests here because we may be adding the same schema
 * from multiple files (.yaml, json, etc.) which will have the same
 * $id. AJV will fail if the a schema with the same $id is added multiple times.
 */
function ajv() {
    const ajv = new Ajv({
        schemaId: '$id'
    });
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

    return ajv;
}

const isSchemaValid = ajv().compile(require('ajv/lib/refs/json-schema-draft-07.json'));
const isSchemaSecure = ajv().compile(require('ajv/lib/refs/json-schema-secure.json'));


function assertDeterministicTypes(node, path = '') {
    // if node type is union type, fail.
    if (Array.isArray(node.type)) {
        throw new assert.AssertionError({
            message: `Polymorphic type property at #${path}`
        });
    }

    // if node type is array, assert items.type
    if (node.type === 'array') {
        if (!node.items || !node.items.type) {
            throw new assert.AssertionError({
                message: `array type must specify items.type: #/${path}`
            });
        }
        // Assert that items types are monomorphic too
        assertDeterministicTypes(node.items, `${path}/items`);
    }

    // if node type is object, assert it has a schema or is a map
    if (node.type == 'object') {
        const hasSchema = node.properties || node.oneOf || node.allOf;
        if (!hasSchema && !node.additionalProperties) {
            throw new assert.AssertionError({
                message: `object type must specify properties or additionalProperties: #/${path}`
            });
        }

        // map type
        if (node.additionalProperties) {
            // Assert additionalProperties type
            assertDeterministicTypes(node.additionalProperties, `${path}/additionalProperties`);
        }
    }

    // if node has properties, assert their types.
    Object.keys(node.properties || {}).forEach((key) => {
        const keyPath = `${path}/properties/${key}`;
        if (!node.properties[key].type) {
            throw new assert.AssertionError({
                message: `Missing type at #${keyPath}`
            });
        }
        assertDeterministicTypes(node.properties[key], keyPath);
    });

    // if node uses allOf, assert that each are deterministic
    (node.allOf || []).forEach((schema) => {
        assertDeterministicTypes(schema, path);
    });

    // if node uses oneOf, assert that all types are the same and deterministic
    if (node.oneOf && node.oneOf.length > 0) {
        const {type} = node.oneOf[0];

        // All types should be the same
        const hasSameType = node.oneOf.every((schema) => schema.type === type);
        if (!hasSameType) {
            throw new assert.AssertionError({
                message: `oneOf contains schemas with different types at #${path}`
            });
        }

        // If object type, the required fields should be the same
        if (type === 'object') {
            const shape = node.oneOf[0].required || [];
            node.oneOf.forEach(({required}) => {
                const hasSameShape = shape.every(item => required.includes(item)) && required.every(item => shape.includes(item));
                if (!hasSameShape) {
                    throw new assert.AssertionError({
                        message: `oneOf contains schemas with different types at #${path}`
                    });
                }
            });
        }

        node.oneOf.forEach((schema) => {
            assertDeterministicTypes(schema, path);
        });
    }
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
        const validator = ajv();
        if (!validator.validate(schema, example)) {
            throw new assert.AssertionError({
                message: `example ${index} did not validate against schema: ${validator.errorsText()}`,
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
        // current schema doesn't have to be valid as it
        // can have unresolved $refs in it, and we don't
        // dereference them for this test.
        condition: (schemaInfo) => {
            return !schemaInfo.current;
        },
    },
    {
        name: 'schema-is-secure',
        description: 'must be a secure JSONSchema',
        assertFn: assertSchemaIsSecure,
    },
    {
        name: 'schema-snake-case-properties',
        description: 'properties must be snake_case',
        assertFn: assertSnakeCaseProperties,
    },
    {
        name: 'schema-monomorphic-types',
        description: 'deprecated. Superseded by schema-deterministic-types',
        assertFn: assertDeterministicTypes,
        // Types of propeties may be pulled in by $ref, so don't
        // run this test on non-dereferenced current schemas.
        condition: (schemaInfo) => {
            return !schemaInfo.current;
        },
    },
    {
        name: 'schema-deterministic-types',
        description: 'has deterministic types (no unions, missing array value types, etc.)',
        assertFn: assertDeterministicTypes,
        // Types of propeties may be pulled in by $ref, so don't
        // run this test on non-dereferenced current schemas.
        condition: (schemaInfo) => {
            return !schemaInfo.current;
        },
    },
    {
        name: 'schema-required-properties-exist',
        description: 'all required properties must exist',
        assertFn: assertRequired,
        // current schemas might have required properties
        // declared via $ref, so don't run this test for current.
        condition: (schemaInfo) => {
            return !schemaInfo.current;
        },
    },
    {
        name: 'schema-examples-$schema-matches-schema-$id',
        description: 'examples must have $schema == schema\'s $id',
        assertFn: assertExamplesId,
        // current schema's examples should use $ref for example $schema,
        // don't run on non derefernced current schema.
        condition: (schemaInfo) => {
            return !schemaInfo.current &&
                _.has(schemaInfo.schema, 'examples') &&
                _.has(schemaInfo.schema.properties, '$schema');
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
