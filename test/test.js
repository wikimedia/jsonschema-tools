'use strict';

const _ = require('lodash');
const testFixture = require('test-fixture');
const fse = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const assert = require('assert');

const {
    materializeSchemaVersion,
} = require('../index.js');



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
            },
        },
    ];


    let fixture;

    before('Loading expected schemas', async function() {
        const fixturePath = 'test/fixtures';
        tests = await Promise.all(tests.map(async (test) => {
            const expectedSchema = yaml.safeLoad(await fse.readFile(path.join(fixturePath, test.schemaPath), 'utf-8'));

            if (test.options.shouldDereference) {
                // The only $ref in the expectedSchema is to /common/1.0.0#properties.
                // Ensure those properties are in this version of the expected schema
                // so we can compare it to a dereferenced one later.
                expectedSchema.properties.$schema = {
                    type: 'string',
                    description: 'The URI identifying the jsonschema for this event. This may be just a short uri containing only the name and revision at the end of the URI path.  e.g. /schema_name/12345 is acceptable. This often will (and should) match the schema\'s $id field.\n',
                };
                expectedSchema.properties.dt = {
                    type: 'string',
                    format: 'date-time',
                };
                delete expectedSchema.properties.$ref;
            }

            test.expected.schema = expectedSchema;
            return test;
        }));
    });

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
                assert.deepStrictEqual(materializedSchema, test.expected.schema);
            });
        });
    });
});


// describe('materializeDereferencedSchemaVersion', function() {
//     let fixture;

//     // Use the same regular tests, but check that dereferences work.
//     const derererenceTests = _.cloneDeep(tests);
//     derererenceTests.forEach(t => _.set(t, 'options.shouldDereference', true));

//     beforeEach('Copying fixtures to temp directory', async function() {
//         // Copy the fixtures/ dir into a temp directory that is automatically
//         // cleaned up after each test.
//         fixture = testFixture();
//         await fixture.copy();
//     });

//     it('should dereference TODO', function() {
//         // dereferenceSchema();
//         assert.ok(true);
//     });

// });
