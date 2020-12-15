'use strict';

const assert = require('assert').strict;
const jsonschemaTools = require('../jsonschema-tools.js');
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

const assertMonomorphTypes = (node, path = '') => {
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
};

// TODO should we move this to a lint.js test file?
const assertSnakeCase = (node, path = '') => {
    (node.allOf || []).forEach((schema) => {
        assertSnakeCase(schema, path);
    });
    Object.keys(node.properties || {}).forEach((prop) => {
        const propPath = `${path}/properties/${prop}`;
        if (!/^[$a-z]+[a-z0-9_]*$/.test(prop)) {
            throw new assert.AssertionError({
                message: `Non snake_case: #/${propPath}`
            });
        }
        assertSnakeCase(node.properties[prop], propPath);
    });
};

const assertRequired = (node, path = '') => {
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
};

function declareTests(options = {}) {
    options = jsonschemaTools.readConfig(options);
    const allSchemas = jsonschemaTools.findSchemasByTitle(options);
    describe(`Schema Robustness in Repository ${options.schemaBasePath}`, () => {
        for (const title of Object.keys(allSchemas)) {
            describe(title, () => {
                allSchemas[title].forEach((schemaInfo) => {
                    const testName = (schemaInfo.current ? 'current' : schemaInfo.version) +
                        (schemaInfo.contentType ? `.${schemaInfo.contentType}` : '');

                    describe(testName, () => {
                        const schema = schemaInfo.schema;
                        it('must be valid JSON-Schema', () => {
                            if (!isSchemaValid(schema)) {
                                throw new assert.AssertionError({
                                    message: 'Schema is invalid',
                                    expected: [],
                                    actual: isSchemaValid.errors
                                });
                            }
                        });
                        it('must be a secure JSON-Schema', () => {
                            if (!isSchemaSecure(schema)) {
                                throw new assert.AssertionError({
                                    message: 'Schema insecure errors',
                                    expected: [],
                                    actual: isSchemaSecure.errors
                                });
                            }
                        });

                        it('must use snake_case', () => {
                            assertSnakeCase(schema);
                        });

                        it('must only have monomorphic types', () => {
                            assertMonomorphTypes(schema);
                        });

                        // The following tests are for materialized schemas only
                        if (!schemaInfo.current) {
                            it('all required properties must exist', () => {
                                assertRequired(schema);
                            });

                            if (options.requireExamples) {
                                it('must have JSONSchema examples', () => {
                                    assert.ok(schemaInfo.schema.examples);
                                });
                            }

                            if (schemaInfo.schema.examples) {
                                schemaInfo.schema.examples.forEach((example, index) => {
                                    it(`example ${index} must validate against schema`, () => {
                                        const result = ajv.validate(schemaInfo.schema, example);
                                        assert.ok(result, ajv.errorsText());

                                        // Remove the schema we added from ajv's schema cache.
                                        // We need to re-add this schema for every materialized
                                        // file type that exists to make sure they all work
                                        // as they should.  If we don't remove, ajv will
                                        // see that the schema has already been added by
                                        // its $id and fail with an error.
                                        ajv.removeSchema(schemaInfo.schema.$id);
                                    });

                                    it(`example ${index} must have $schema == $id`, () => {
                                        assert.strictEqual(
                                            example.$schema, schemaInfo.schema.$id,
                                            'examples $schema value must match schema\'s $id value'
                                        );
                                    });

                                });
                            }

                            if (options.enforcedNumericBounds) {
                                const enforcedMin = options.enforcedNumericBounds[0];
                                const enforcedMax = options.enforcedNumericBounds[1];
                                it(`Should have minimum and maximum values inside the configured bounds for all numeric fields`, () => {
                                    traverseSchema(schemaInfo.schema, (obj, _1, _2, _3, _4, _5, fieldName) => {
                                        if (['number', 'integer'].includes(obj.type)) {
                                            assert.ok(typeof obj.minimum === 'number', `field ${fieldName} doesn\'t have a valid minimum value`);
                                            assert.ok(obj.minimum >= enforcedMin, `field ${fieldName} has a minimum value lower than enforcedNumericBounds minimum ${enforcedMin}`);

                                            assert.ok(typeof obj.maximum === 'number', `field ${fieldName} doesn\'t have a valid maximum value`);
                                            assert.ok(obj.maximum <= enforcedMax, `field ${fieldName} has a maximum value higher than enforcedNumericBounds minimum ${enforcedMax}`);
                                        }
                                    })
                                });
                            }
                        }

                    });
                });
            });
        }
    });

}

module.exports = declareTests;
