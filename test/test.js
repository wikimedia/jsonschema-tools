'use strict';

const _ = require('lodash');
const testFixture = require('test-fixture');
const fse = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const assert = require('assert');
const rewire = require('rewire');

const {
    materializeSchemaToPath,
    materializeSchema,
    findSchemasByTitleAndMajor,
    readConfig,
    getSchemaById,
    materializeAllSchemas,
    schemaVersion,
    serializers,
    tests
} = require('../index.js');


/* eslint camelcase: 1 */
const expectedBasicSchema = {
    title: 'basic',
    description: 'Schema used for simple tests',
    $id: '/basic/1.2.0',
    $schema: 'https://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    allOf: [
        { $ref: '/common/1.0.0' },
    ],
    properties: {
        test: {
            type: 'string',
            default: 'default test'
        },
        test_number: {
            type: 'number',
            maximum: 9007199254740991,
            minimum: -9007199254740991
        },
        test_integer: {
            type: 'integer',
            maximum: 9007199254740991,
            minimum: 0
        },
        test_array: {
            type: 'array',
            items: {
                type: 'string',
            },
        },
        test_map: {
            description: 'We want to support \'map\' types using additionalProperties to specify the value types.  (Keys are always strings.)\n',
            type: 'object',
            additionalProperties: {
                type: 'string'
            }
        },
        test_enum: {
            description: 'Only new entries to an enum should be allowed, and they can be provided in any order.',
            type: 'string',
            enum: ['val3', 'val1', 'val2'],
        },
        test_oneof: {
            type: 'object',
            oneOf: [
                {
                    type: 'object',
                    required: ['test'],
                    properties: {
                        test: {
                            type: 'string'
                        }
                    }
                },
                {
                    type: 'object',
                    required: ['test'],
                    properties: {
                        test: {
                            type: 'string'
                        },
                        test2: {
                            type: 'string'
                        }
                    }
                }
            ]
        },
        test_uri: {
            type: 'string',
            format: 'uri-reference',
            maxLength: 1024
        },
    },
    required: ['test'],
    examples: [
        {
            $schema: { $ref: '#/$id' },
            dt: '2020-06-25T00:00:00Z',
            test: 'test_string_value',
            test_number: 1.0,
            test_map: { keyA: 'valueA' },
        },
        {
            $schema: { $ref: '#/$id' },
            dt: '2020-06-25T00:00:00Z',
            test: 'test_string_value_2',
        },
    ],
};

const expectedBasicDereferencedSchema = {
    title: 'basic',
    description: 'Schema used for simple tests',
    $id: '/basic/1.2.0',
    $schema: 'https://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    properties: {
        $schema: {
            type: 'string',
            description: 'The URI identifying the jsonschema for this event. This may be just a short uri containing only the name and revision at the end of the URI path.  e.g. /schema_name/12345 is acceptable. This often will (and should) match the schema\'s $id field.\n',
        },
        dt: {
            type: 'string',
            maxLength: 128,
            format: 'date-time',
        },
        test: {
            type: 'string',
            default: 'default test'
        },
        test_number: {
            type: 'number',
            maximum: 9007199254740991,
            minimum: -9007199254740991
        },
        test_integer: {
            type: 'integer',
            maximum: 9007199254740991,
            minimum: 0
        },
        test_array: {
            type: 'array',
            items: {
                type: 'string',
            },
        },
        test_map: {
            description: 'We want to support \'map\' types using additionalProperties to specify the value types.  (Keys are always strings.)\n',
            type: 'object',
            additionalProperties: {
                type: 'string'
            }
        },
        test_enum: {
            description: 'Only new entries to an enum should be allowed, and they can be provided in any order.',
            type: 'string',
            enum: ['val3', 'val1', 'val2'],
        },
        test_oneof: {
            type: 'object',
            oneOf: [
                {
                    type: 'object',
                    required: ['test'],
                    properties: {
                        test: {
                            type: 'string'
                        }
                    }
                },
                {
                    type: 'object',
                    required: ['test'],
                    properties: {
                        test: {
                            type: 'string'
                        },
                        test2: {
                            type: 'string'
                        }
                    }
                }
            ]
        },
        test_uri: {
            type: 'string',
            format: 'uri-reference',
            maxLength: 1024
        },
    },
    required: ['$schema', 'test'],
    examples: [
        {
            // Even though both common and basic define $schema in their first example,
            // The root (basic) schemas examples should take precedence when using
            // jsonschema-tools custom examples merge.
            $schema: '/basic/1.2.0',
            dt: '2020-06-25T00:00:00Z',
            test: 'test_string_value',
            test_number: 1.0,
            test_map: { keyA: 'valueA' },
        },
        {
            $schema: '/basic/1.2.0',
            dt: '2020-06-25T00:00:00Z',
            test: 'test_string_value_2',
        },
    ]
};

const expectedBasicDereferencedSchemaWithoutNumericBounds = _.cloneDeep(
    expectedBasicDereferencedSchema
);
// basic/current.yaml only specifies a test_integer field minimum of 0.  For the test that disables
// numeric bounds enforcement, we need the same schema, but without the numeric bounds enforced on
// fields that don't explicitly set max and min.
delete expectedBasicDereferencedSchemaWithoutNumericBounds.properties.test_number.maximum;
delete expectedBasicDereferencedSchemaWithoutNumericBounds.properties.test_number.minimum;
delete expectedBasicDereferencedSchemaWithoutNumericBounds.properties.test_integer.maximum;

/* eslint camelcase: 0 */

describe('materializeSchemaToPath', function() {
    let tests = [
        {
            name: 'should materialize new yaml version from file with extensionless symlink',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlinkExtensionless: true,
                shouldSymlinkLatest: false,
                contentTypes: ['yaml'],
                shouldGitAdd: false,
                shouldDereference: false,
            },
            expected: {
                materializedPaths: ['schemas/basic/1.2.0.yaml', 'schemas/basic/1.2.0'],
                extensionlessSymlinkPath: 'schemas/basic/1.2.0',
                schema: expectedBasicSchema
            },
        },
        {
            name: 'should materialize new yaml version from file without extensionless symlink',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlinkExtensionless: false,
                shouldSymlinkLatest: false,
                contentTypes: ['yaml'],
                shouldGitAdd: false,
                shouldDereference: false,
            },
            expected: {
                materializedPaths: ['schemas/basic/1.2.0.yaml'],
                extensionlessSymlinkPath: 'schemas/basic/1.2.0',
                schema: expectedBasicSchema
            },
        },
        {
            name: 'should materialize new json version from file with extensionless symlink',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlinkExtensionless: true,
                shouldSymlinkLatest: false,
                contentTypes: ['json'],
                shouldGitAdd: false,
                shouldDereference: false,
            },
            expected: {
                materializedPaths: ['schemas/basic/1.2.0.json', 'schemas/basic/1.2.0'],
                extensionlessSymlinkPath: 'schemas/basic/1.2.0',
                schema: expectedBasicSchema
            },
        },
        {
            name: 'should materialize new json version from file without extensionless symlink',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlinkExtensionless: false,
                shouldSymlinkLatest: false,
                contentTypes: ['json'],
                shouldGitAdd: false,
                shouldDereference: false,
            },
            expected: {
                materializedPaths: ['schemas/basic/1.2.0.json'],
                extensionlessSymlinkPath: 'schemas/basic/1.2.0',
                schema: expectedBasicSchema
            },
        },
        {
            name: 'should materialize new json version from file without extensionless with latest symlink',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlinkExtensionless: false,
                shouldSymlinkLatest: true,
                contentTypes: ['json'],
                shouldGitAdd: false,
                shouldDereference: false,
            },
            expected: {
                materializedPaths: ['schemas/basic/1.2.0.json', 'schemas/basic/latest.json'],
                extensionlessSymlinkPath: 'schemas/basic/1.2.0',
                latestSchemaVersion: '1.2.0',
                schema: expectedBasicSchema
            },
        },
        {
            name: 'should materialize new yaml and json version from file with extensionless symlink',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlinkExtensionless: true,
                shouldSymlinkLatest: false,
                contentTypes: ['json', 'yaml'],
                shouldGitAdd: false,
                shouldDereference: false,
            },
            expected: {
                materializedPaths: ['schemas/basic/1.2.0.json', 'schemas/basic/1.2.0.yaml', 'schemas/basic/1.2.0'],
                extensionlessSymlinkPath: 'schemas/basic/1.2.0',
                schema: expectedBasicSchema
            },
        },
        {
            name: 'should materialize new yaml and json version from file with extensionless symlink and dereferencing',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlinkExtensionless: true,
                shouldSymlinkLatest: false,
                contentTypes: ['json', 'yaml'],
                shouldGitAdd: false,
                shouldDereference: true,
            },
            expected: {
                materializedPaths: ['schemas/basic/1.2.0.json', 'schemas/basic/1.2.0.yaml', 'schemas/basic/1.2.0'],
                extensionlessSymlinkPath: 'schemas/basic/1.2.0',
                schema: expectedBasicDereferencedSchema
            },
        },
        {
            name: 'should materialize new yaml and json version from file with extensionless and latest symlinks and dereferencing',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlinkExtensionless: true,
                shouldSymlinkLatest: true,
                contentTypes: ['json', 'yaml'],
                shouldGitAdd: false,
                shouldDereference: true,
            },
            expected: {
                materializedPaths: ['schemas/basic/1.2.0.json', 'schemas/basic/1.2.0.yaml', 'schemas/basic/1.2.0', 'schemas/basic/latest.json', 'schemas/basic/latest.yaml', 'schemas/basic/latest'],
                extensionlessSymlinkPath: 'schemas/basic/1.2.0',
                latestSchemaVersion: '1.2.0', // Used to construct tests that ensure latest symlinks point to the right place
                schema: expectedBasicDereferencedSchema
            },
        },
    ];


    let fixture;

    beforeEach('Copying fixtures to temp directory', async function() {
        // Copy the fixtures/ dir into a temp directory that is automatically
        // cleaned up after each test.
        fixture = testFixture();
        await fixture.copy();

        // set proper schemaBaseUris to temp fixture path
        tests = await Promise.all(tests.map(async (test) => {
            test.options.schemaBaseUris = [fixture.resolve('schemas/')];
            test.options = readConfig(test.options, true);
            return test;
        }));
    });

    tests.forEach((test) => {
        it(test.name, async function() {
            const schemaFile = fixture.resolve(test.schemaPath);
            const schemaDirectory = path.dirname(schemaFile);
            const schema = yaml.safeLoad(await fse.readFile(schemaFile, 'utf-8'));

            const materializedFiles = await materializeSchemaToPath(
                schemaDirectory, schema, test.options
            );

            assert.deepStrictEqual(
                materializedFiles.sort(),
                test.expected.materializedPaths.sort().map(p => fixture.resolve(p))
            );

            if (test.options.shouldSymlinkLatest) {
                test.options.contentTypes.forEach(async (contentType) => {
                    assert.equal(
                        await fse.realpath(path.join(schemaDirectory, `latest.${contentType}`)),
                        await fse.realpath(path.join(schemaDirectory, `${test.expected.latestSchemaVersion}.${contentType}`))
                    );
                });
            }

            assert.equal(
                await fse.exists(fixture.resolve(test.expected.extensionlessSymlinkPath)),
                test.options.shouldSymlinkExtensionless
            );
            if (test.options.shouldSymlinkExtensionless) {
                assert.equal(
                    // The symlink should point at the first
                    // contentType listed in contentTypes.
                    await fse.realpath(fixture.resolve(test.expected.extensionlessSymlinkPath)),
                    await fse.realpath(fixture.resolve(test.expected.materializedPaths[0]))
                );
            }


            // Assert that all materialized files are what is expected.
            materializedFiles.forEach(async (materializedFile) => {
                const materializedSchema = yaml.safeLoad(await fse.readFile(materializedFile, 'utf-8'));
                assert.deepStrictEqual(materializedSchema, test.expected.schema);
            });
        });
    });

    // This test cannot be part of the automated declared tests above, because
    // the generated examples are not pre-determined, so the deepStrictEqual
    // comparison will fail.
    it('should dereference and materialize new yaml version and generate examples', async () => {
        const options = readConfig({
            contentTypes: ['yaml'],
            shouldGitAdd: false,
            shouldDereference: true,
            shouldGenerateExample: true,
            schemaBaseUris: [fixture.resolve('schemas/')],
        }, true);

        const schemaFile = fixture.resolve('schemas/basic/current.yaml');
        const schemaDirectory = path.dirname(schemaFile);
        const schema = expectedBasicDereferencedSchema;

        // remove the schema examples so one will be generated for us.
        delete schema.examples;

        const materializedFiles = await materializeSchemaToPath(
            schemaDirectory, schema, options
        );
        materializedFiles.forEach(async (materializedFile) => {
            const materializedSchema = yaml.safeLoad(await fse.readFile(materializedFile, 'utf-8'));
            assert.ok(
                !_.isEmpty(materializedSchema.examples),
                `should have generated example in ${materializedFile}`
            );
            assert.ok(_.isString(materializedSchema.examples[0].test));
            assert.ok(_.isInteger(materializedSchema.examples[0].test_integer));
            assert.ok(_.isNumber(materializedSchema.examples[0].test_number));
            assert.strictEqual(materializedSchema.examples[0].test_uri, 'http://example.org');
            assert.strictEqual(materializedSchema.examples[0].$schema, '/basic/1.2.0');

        });
    });
});


describe('findSchemasByTitleAndMajor', function() {
    let fixture;

    beforeEach('Copying fixtures to temp directory', async function() {
        // Copy the fixtures/ dir into a temp directory that is automatically
        // cleaned up after each test.
        fixture = testFixture();
        await fixture.copy();
    });

    it('should find schemas grouped by title and major', function() {
        // Force re-reading of (default) config options.
        const options = readConfig({ schemaBasePath: fixture.resolve('schemas/') }, true);
        const schemasByTitleAndMajor = findSchemasByTitleAndMajor(options);
        assert.deepStrictEqual(_.keys(schemasByTitleAndMajor), ['common', 'basic', 'legacy']);
        assert.deepStrictEqual(_.keys(schemasByTitleAndMajor.basic), ['1']);
        assert.deepStrictEqual(_.keys(schemasByTitleAndMajor.common), ['1']);

        const basicInfos = schemasByTitleAndMajor.basic['1'];
        assert.deepStrictEqual(basicInfos.map(e => e.version), ['1.0.0', '1.1.0', '1.2.0']);
        // at this point basic 1.2.0 is not materialized, there should be only one 1.2.0 verison
        // and it shoudl have current == true.
        const latest = _.last(basicInfos);
        assert.strictEqual(latest.version, '1.2.0');
        assert.strictEqual(latest.current, true);
    });

    it('should ignore schemas if they match ignoreSchemas config', function() {
        const customOptions = {
            schemaBasePath: fixture.resolve('schemas/'),
            ignoreSchemas: [/\/basic\/1.1.0/],
        };

        const options = readConfig(customOptions, true);
        const schemasByTitleAndMajor = findSchemasByTitleAndMajor(options);

        const basicInfos = schemasByTitleAndMajor.basic['1'];
        assert.deepStrictEqual(basicInfos.map(e => e.version), ['1.0.0', '1.2.0']);
    });
});

describe('readConfig', function() {
    let fixture;

    before('Copying fixtures to temp directory', async function() {
        // Copy the fixtures/ dir into a temp directory that is automatically
        // cleaned up after each test.
        fixture = testFixture();
        await fixture.copy();
    });

    it('should load configs from 2 files and custom options and set proper defaults', function() {
        const customOptions = {
            configPaths: [
                fixture.resolve('jsonschema-tools.config1.yaml'),
                fixture.resolve('jsonschema-tools.config2.yaml'),
            ],
            shouldSymlinkExtensionless: true
        };

        const options = readConfig(customOptions, true);

        assert.strictEqual(options.shouldSymlinkExtensionless, true); // overridden by custom option
        assert.deepEqual(options.contentTypes, ['yaml', 'json']); // overridden by config2
        assert.strictEqual(options.shouldDereference, false); // overridden by config1
        assert.strictEqual(options.schemaTitleField, 'title'); // defaultOptions
    });
});

describe('getSchemaById', function() {
    let fixture;

    before('Copying fixtures to temp directory', async function() {
        // Copy the fixtures/ dir into a temp directory that is automatically
        // cleaned up after each test.
        fixture = testFixture();
        await fixture.copy();
    });

    it('should get existent schema by $id', async function() {
        const customOptions = {
            schemaBasePath: fixture.resolve('schemas/')
        };
        const options = readConfig(customOptions, true);

        const schema = await getSchemaById('/common/1.0.0', options);
        assert.equal(schema.$id, '/common/1.0.0');
    });

    it('should reject if no schema can be found by $id', async function() {
        const customOptions = {
            schemaBasePath: fixture.resolve('schemas/')
        };
        const options = readConfig(customOptions, true);
        assert.rejects(async () => {
            await getSchemaById('/nonexistent/1.0.0', options);
        });
    });
});

describe('Reasonable schema version number parsing', function() {
    it('should parse versions from $id strings', async () => {
        assert(schemaVersion(expectedBasicSchema, '$id') === '1.2.0');
    });

    it('should parse $id strings with embedded numerals', async () => {
        const barebonesSchema = {
            $id: '/w3c/reportingapi/report/1.2.3',
        };
        assert(schemaVersion(barebonesSchema, '$id') === '1.2.3');
    });
});

describe('serialization key order', function() {
    it('is deterministic', async () => {
        const tests = [
            {
                keys: [ 'allOf', 'properties' ],
                expected: [ 'properties', 'allOf' ],
            },
            {
                keys: [ 'foo', 'properties' ],
                expected: [ 'properties', 'foo' ],
            },
            {
                keys: [ 'properties', 'foo' ],
                expected: [ 'properties', 'foo' ],
            },
            {
                keys: [ 'zebra', 'ant' ],
                expected: [ 'ant', 'zebra' ],
            },
        ];

        await Promise.all(tests.map(async (test) => {

            _.keys(serializers).forEach((serializerName) => {
                const serialize = serializers[serializerName];

                assert.deepStrictEqual(
                    _.flow(
                        () => test.keys,
                        _.invert,
                        serialize,
                        yaml.load,
                        Object.keys
                    )(),
                    test.expected,
                    `${serializerName} serializer should serialize in deterministic key order`
                );

            });
        }));
    });
});

describe('Numeric bounds enforcement', function() {
    it('should apply max and min by default if bounds aren\'t configured', async () => {
        const customOptions = {};
        const options = readConfig(customOptions, true);
        const schema = expectedBasicDereferencedSchema;

        const materializedSchema = await materializeSchema(schema, options);

        // basic schema has test_integer's mininum set to 0, so we shouldn't
        // overwrite it with MIN_SAFE_INTEGER.
        assert(
            materializedSchema.properties.test_integer.minimum ===
            0
        );
        assert(
            materializedSchema.properties.test_integer.maximum ===
            Number.MAX_SAFE_INTEGER
        );

        assert(
            materializedSchema.properties.test_number.minimum ===
            Number.MIN_SAFE_INTEGER
        );
        assert(
            materializedSchema.properties.test_number.maximum ===
            Number.MAX_SAFE_INTEGER
        );
    });

    it('should not apply bounds if option is false', async () => {
        const customOptions = {
            enforcedNumericBounds: false
        };
        const options = readConfig(customOptions, true);
        const schema = expectedBasicDereferencedSchemaWithoutNumericBounds;

        const materializedSchema = await materializeSchema(schema, options);
        assert(materializedSchema.properties.test_integer.minimum === 0);
        assert(_.isUndefined(materializedSchema.properties.test_integer.maximum));
        assert(_.isUndefined(materializedSchema.properties.test_number.minimum));
        assert(_.isUndefined(materializedSchema.properties.test_number.maximum));
    });
});

describe('Test Schema Repository Tests', function() {
    let fixture;

    before('Copying fixtures to temp directory', async function() {
        // Copy the fixtures/ dir into a temp directory that is automatically
        // cleaned up after each test.
        fixture = testFixture();
        await fixture.copy();
    });

    it('Should run all repository tests on schema repository using provided config options', async function() {
        const options = readConfig({
            schemaBasePath: fixture.resolve('schemas/'),
            contentTypes: ['yaml'],
            // The legacy schema has a camelCase key name.
            // Test that we can skip the snake-case-properties test case.
            skipSchemaTestCases: {
                '/legacy/.*': ['schema-snake-case-properties'],
                '/legacy/1.1.0': ['schema-version-compatibility'],
            },
        }, true);

        // basic/current is at 1.2.0, which is not yet materialized in fixture.
        // Materialize all so declareTests will pass.
        await materializeAllSchemas(options);
        tests.all(options);
    });

    // These needs to be its own test case so that we don't make the whole
    // schema fixtures fail the above repository tests.
    it('Should fail compatibility test if a requiredness is modified', async function() {
        const compatibilityTests = rewire('../lib/tests/compatibility');
        const assertCompatible = compatibilityTests.__get__('assertCompatible');

        const options = readConfig({
            schemaBasePath: fixture.resolve('schemas/'),
            contentTypes: ['yaml'],
        }, true);

        const oldSchema = await getSchemaById('/basic/1.0.0', options);
        const newSchema = await getSchemaById('/basic/1.1.0', options);

        // Modify newSchema.required.
        newSchema.required.push('test_number');
        assert.throws(
            () => assertCompatible(newSchema, oldSchema),
            assert.AssertionError
        );

        delete newSchema.required;
        assert.throws(
            () => assertCompatible(newSchema, oldSchema),
            assert.AssertionError
        );
    });

    it('Should fail compatibility test if a enum is not a superset', async function() {
        const compatibilityTests = rewire('../lib/tests/compatibility');
        const assertCompatible = compatibilityTests.__get__('assertCompatible');

        const options = readConfig({
            schemaBasePath: fixture.resolve('schemas/'),
            contentTypes: ['yaml'],
        }, true);

        const oldSchema = await getSchemaById('/basic/1.0.0', options);
        const newSchema = await getSchemaById('/basic/1.1.0', options);

        // Modify oldSchema test_enum field so that newSchema's test_enum is not a superset.
        oldSchema.properties.test_enum.enum.push('val0');

        assert.throws(
            () => assertCompatible(newSchema, oldSchema),
            assert.AssertionError
        );

        // // Test that removing an enum fails.
        delete newSchema.properties.test_enum.enum;
        assert.throws(
            () => assertCompatible(newSchema, oldSchema),
            assert.AssertionError
        );
    });

    it('Should fail robustness test if a array items type is not set', async function() {
        const robustnessTests = rewire('../lib/tests/robustness');
        const assertDeterministicTypes = robustnessTests.__get__('assertDeterministicTypes');

        const options = readConfig({
            schemaBasePath: fixture.resolve('schemas/'),
            contentTypes: ['yaml'],
        }, true);

        const schema = await getSchemaById('/basic/1.1.0', options);
        // Delete items.type and ensure throws.
        delete schema.properties.test_array.items.type;
        assert.throws(
            () => assertDeterministicTypes(schema),
            assert.AssertionError
        );

        // Delete items and ensure throws.
        delete schema.properties.test_array.items;
        assert.throws(
            () => assertDeterministicTypes(schema),
            assert.AssertionError
        );
    });

    describe('object type robustness tests', function() {

        let assertDeterministicTypes;
        let options;

        before('Setup schema', async function() {
            const robustnessTests = rewire('../lib/tests/robustness');
            assertDeterministicTypes = robustnessTests.__get__('assertDeterministicTypes');

            options = readConfig({
                schemaBasePath: fixture.resolve('schemas/'),
                contentTypes: ['yaml'],
            }, true);
        });

        it('Should fail robustness test if an object field does not have a schema', async function() {
            const schema = await getSchemaById('/basic/1.1.0', options);

            delete schema.properties.test_map.additionalProperties;
            assert.throws(
                () => assertDeterministicTypes(schema),
                assert.AssertionError
            );
        });

        it('Should fail robustness test if an object field has properties and additionalProperties', async function() {
            const schema = await getSchemaById('/basic/1.1.0', options);

            schema.properties.test_map.properties = [{ test: { type: 'string' } }];
            assert.throws(
                () => assertDeterministicTypes(schema),
                assert.AssertionError
            );
        });

        it('Should fail robustness test if additionalProperties type is a union', async function() {
            const schema = await getSchemaById('/basic/1.1.0', options);

            schema.properties.test_map.additionalProperties.type = ['string', 'number'];
            assert.throws(
                () => assertDeterministicTypes(schema),
                assert.AssertionError
            );
        });
    });

    describe('oneOf robustness tests', function() {

        let assertDeterministicTypes;
        let options;

        before('Setup schema', async function() {
            const robustnessTests = rewire('../lib/tests/robustness');
            assertDeterministicTypes = robustnessTests.__get__('assertDeterministicTypes');

            options = readConfig({
                schemaBasePath: fixture.resolve('schemas/'),
                contentTypes: ['yaml'],
            }, true);
        });

        it('Should fail robustness test if oneOf is of different types', async function() {
            const schema = await getSchemaById('/basic/1.1.0', options);

            schema.properties.test_oneof.oneOf[0].type = 'string';
            assert.throws(
                () => assertDeterministicTypes(schema),
                assert.AssertionError
            );
        });

        it('Should fail robustness test if oneOf objects have different required fields', async function() {
            const schema = await getSchemaById('/basic/1.1.0', options);

            schema.properties.test_oneof.oneOf[0].required = ['test2'];
            assert.throws(
                () => assertDeterministicTypes(schema),
                assert.AssertionError
            );
        });
    });
});
