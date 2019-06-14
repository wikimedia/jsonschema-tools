'use strict';

const testFixture = require('test-fixture');
const fse = require('fs-extra');
const assert = require('assert');

const materializeSchemaVersion = require('../index.js');


describe('materializeSchemaVersion', function() {
    let fixture;
    beforeEach('Copying fixtures to temp directory', async function() {
        // Copy the fixtures/ dir into a temp directory that is automatically
        // cleaned up after each test.
        fixture = testFixture();
        await fixture.copy();
    });

    const tests = [
        {
            name: 'should materialize new yaml version from file with symlink',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlink: true,
                contentType: 'yaml',
                shouldGitAdd: false,
            },
            expected: {
                materializedPath: 'schemas/basic/1.2.0.yaml',
                symlinkPath: 'schemas/basic/1.2.0',
            },
        },
        {
            name: 'should materialize new yaml version from file without symlink',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlink: false,
                contentType: 'yaml',
                shouldGitAdd: false,
            },
            expected: {
                materializedPath: 'schemas/basic/1.2.0.yaml',
                symlinkPath: 'schemas/basic/1.2.0',
            },
        },
        {
            name: 'should materialize new json version from file with symlink',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlink: true,
                contentType: 'json',
                shouldGitAdd: false,
            },
            expected: {
                materializedPath: 'schemas/basic/1.2.0.json',
                symlinkPath: 'schemas/basic/1.2.0',
            },
        },
        {
            name: 'should materialize new json version from file without symlink',
            schemaPath: 'schemas/basic/current.yaml',
            options: {
                shouldSymlink: false,
                contentType: 'json',
                shouldGitAdd: false,
            },
            expected: {
                materializedPath: 'schemas/basic/1.2.0.json',
                symlinkPath: 'schemas/basic/1.2.0',
            },
        },
    ];

    tests.forEach((test) => {
        it(test.name, async function() {
            const schemaPath = fixture.resolve('schemas/basic/current.yaml');

            const materializedPath = await materializeSchemaVersion(
                schemaPath, undefined, test.options
            );

            assert.equal(
                materializedPath,
                fixture.resolve(test.expected.materializedPath)
            );

            assert.equal(
                await fse.exists(fixture.resolve(test.expected.symlinkPath)),
                test.options.shouldSymlink
            );
            if (test.shouldSymlink) {
                assert.equald(
                    await fse.realpath(test.expected.symlinkPath),
                    test.expected.materializedPath
                );
            }
        });
    });
});
