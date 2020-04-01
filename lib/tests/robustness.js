'use strict';

const assert = require('assert').strict;
const jsonschemaTools = require('../jsonschema-tools.js');

const Ajv = require('ajv');
const ajv = new Ajv({
    schemaId: '$id'
});
const isSchemaValid = ajv.compile(require('ajv/lib/refs/json-schema-draft-07.json'));
const isSchemaSecure = ajv.compile(require('ajv/lib/refs/json-schema-secure.json'));

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

                        if (schemaInfo.schema.examples) {
                            it('examples must validate against schema', () => {
                                const examples = schemaInfo.schema.examples;

                                // We need a new Ajv each time so we don't
                                // use schema cached by $id which is the same
                                // for each content type.
                                const ajvForTest = new Ajv();

                                // Both http and https can be used as the draft-07 $schema URL.
                                // However, the draft-07 metaschema uses an http URL as its
                                // $id field.  AJV caches schemas by their $id.  In order
                                // to avoid a remote lookup of this metaschema if a
                                // schema sets $schema to https, we manually cache the
                                // local copy of draft-07 metaschema with the https URL.
                                ajvForTest.addSchema(
                                    require('ajv/lib/refs/json-schema-draft-07.json'),
                                    'https://json-schema.org/draft-07/schema'
                                );

                                examples.forEach((example) => {
                                    const result = ajvForTest.validate(schemaInfo.schema, example);
                                    assert.ok(result, ajvForTest.errorsText());
                                });
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
