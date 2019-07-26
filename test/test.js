'use strict';

const testFixture = require('test-fixture');
const fse = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const assert = require('assert');

const {
    materializeSchemaVersion,
} = require('../index.js');


/* eslint camelcase: 1 */
const expectedBasicSchema = {
    title: 'test/event',
    description: 'Schema used for simple tests',
    $id: '/basic/1.2.0',
    $schema: 'https://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    allOf: [
        { $ref: '/common/1.0.0' },
        {
            properties: {
                test: {
                    type: 'string',
                    default: 'default test'
                },
                test_number: {
                    type: 'number'
                },
                test_integer: {
                    type: 'integer'
                },
                test_map: {
                    description: 'We want to support \'map\' types using additionalProperties to specify the value types.  (Keys are always strings.)\n',
                    type: 'object',
                    additionalProperties: {
                        type: 'string'
                    }
                }
            },
            required: ['test'],
        }
    ]
};

const expectedBasicDereferencedSchema = {
    title: 'test/event',
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
            format: 'date-time',
        },
        test: {
            type: 'string',
            default: 'default test'
        },
        test_number: {
            type: 'number'
        },
        test_integer: {
            type: 'integer'
        },
        test_map: {
            description: 'We want to support \'map\' types using additionalProperties to specify the value types.  (Keys are always strings.)\n',
            type: 'object',
            additionalProperties: {
                type: 'string'
            }
        }
    },
    required: ['$schema', 'test'],
};
/* eslint camelcase: 0 */

describe('materializeSchemaVersion', async function() {
    let tests = [
        {
            name: 'should materialize new yaml version from file with symlink',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlink: true,
                contentTypes: ['yaml'],
                shouldGitAdd: false,
                shouldDereference: false,
            },
            expected: {
                materializedPaths: ['schemas/basic/1.2.0.yaml', 'schemas/basic/1.2.0'],
                symlinkPath: 'schemas/basic/1.2.0',
                schema: expectedBasicSchema
            },
        },
        {
            name: 'should materialize new yaml version from file without symlink',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlink: false,
                contentTypes: ['yaml'],
                shouldGitAdd: false,
                shouldDereference: false,
            },
            expected: {
                materializedPaths: ['schemas/basic/1.2.0.yaml'],
                symlinkPath: 'schemas/basic/1.2.0',
                schema: expectedBasicSchema
            },
        },
        {
            name: 'should materialize new json version from file with symlink',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlink: true,
                contentTypes: ['json'],
                shouldGitAdd: false,
                shouldDereference: false,
            },
            expected: {
                materializedPaths: ['schemas/basic/1.2.0.json', 'schemas/basic/1.2.0'],
                symlinkPath: 'schemas/basic/1.2.0',
                schema: expectedBasicSchema
            },
        },
        {
            name: 'should materialize new json version from file without symlink',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlink: false,
                contentTypes: ['json'],
                shouldGitAdd: false,
                shouldDereference: false,
            },
            expected: {
                materializedPaths: ['schemas/basic/1.2.0.json'],
                symlinkPath: 'schemas/basic/1.2.0',
                schema: expectedBasicSchema
            },
        },
        {
            name: 'should materialize new yaml and json version from file with symlink',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlink: true,
                contentTypes: ['json', 'yaml'],
                shouldGitAdd: false,
                shouldDereference: false,
            },
            expected: {
                materializedPaths: ['schemas/basic/1.2.0.json', 'schemas/basic/1.2.0.yaml', 'schemas/basic/1.2.0'],
                symlinkPath: 'schemas/basic/1.2.0',
                schema: expectedBasicSchema
            },
        },
        {
            name: 'should materialize new yaml and json version from file with symlink and dereferencing',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlink: true,
                contentTypes: ['json', 'yaml'],
                shouldGitAdd: false,
                shouldDereference: true,
            },
            expected: {
                materializedPaths: ['schemas/basic/1.2.0.json', 'schemas/basic/1.2.0.yaml', 'schemas/basic/1.2.0'],
                symlinkPath: 'schemas/basic/1.2.0',
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
            return test;
        }));
    });

    tests.forEach((test) => {
        it(test.name, async function() {
            const schemaFile = fixture.resolve(test.schemaPath);
            const schemaDirectory = path.dirname(schemaFile);
            const schema = yaml.safeLoad(await fse.readFile(schemaFile, 'utf-8'));

            const materializedFiles = await materializeSchemaVersion(
                schemaDirectory, schema, test.options
            );

            assert.deepStrictEqual(
                materializedFiles.sort(),
                test.expected.materializedPaths.sort().map(p => fixture.resolve(p))
            );

            assert.equal(
                await fse.exists(fixture.resolve(test.expected.symlinkPath)),
                test.options.shouldSymlink
            );
            if (test.shouldSymlink) {
                assert.equal(
                    // The symlink should point at the first
                    // contentType listed in contentTypes.
                    await fse.realpath(test.expected.symlinkPath),
                    test.expected.materializedPaths[0]
                );
            }

            // Assert that all materialized files are what is expected.
            materializedFiles.forEach(async (materializedFile) => {
                const materializedSchema = yaml.safeLoad(await fse.readFile(materializedFile, 'utf-8'));
                // console.log(test.name, materializedSchema);
                assert.deepStrictEqual(materializedSchema, test.expected.schema);
            });
        });
    });
});
