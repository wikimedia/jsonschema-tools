'use strict';


const _ = require('lodash');
const path = require('path');
const assert = require('assert').strict;
const fs = require('fs');
const jsonschemaTools = require('./jsonschema-tools.js');


// TODO: make each test type (structure, conventions, compatibilty, etc.) separate module.exports)
function declareTests(options = { logLevel: 'warn' }) {

    options = jsonschemaTools.readConfig(options);
    const allSchemaInfos = jsonschemaTools.findSchemasByTitle(options);

    describe(`Schema Repository in ${options.schemaBasePath}`, () => {
        Object.keys(allSchemaInfos).forEach((schemaTitle) => {
            describe(schemaTitle, () => {
                const schemaInfos = allSchemaInfos[schemaTitle];

                // All schemas with this title should be in the same directory
                it('all schema versions should be in the same directory', () => {
                    for (let i = 1; i < schemaInfos.length; i++) {
                        assert.equal(
                            path.dirname(schemaInfos[i].path),
                            path.dirname(schemaInfos[i - 1].path),
                            `${schemaInfos[i].path} is not in the same directory as ${schemaInfos[i - 1].path}`
                        );
                    }
                });

                // We will test below that all schemas are in the same directory, so
                // we can use the directory of the first schema as the schema directory for
                // further tests.
                const schemaDir = path.dirname(schemaInfos[0].path);

                it(`must contain ${options.currentName} schema file`, () => {
                    assert.ok(fs.existsSync(path.join(schemaDir, 'current.yaml')));
                });

                // TODO: Is this a test we really need?
                it('must not contain extensionless current symlink', () => {
                    assert.equal(false, fs.existsSync(path.join(schemaDir, 'current')));
                });

                const currentSchemaInfo = schemaInfos.find((schemaInfo) => schemaInfo.current);
                const latestSchemaInfo = schemaInfos.filter((schemaInfo) => !schemaInfo.current).pop();

                const materializedSchemasInfosByVersion = _.groupBy(
                    schemaInfos,
                    info => info.version
                );

                it(`current version ${currentSchemaInfo.version} must be equal to materialized latest version ${latestSchemaInfo.version}`, async () => {
                    assert.equal(
                        latestSchemaInfo.version,
                        currentSchemaInfo.version,
                        `Current and latest schema versions read from ${options.schemaVersionField} do not match`
                    );

                    const dereferencedCurrentSchema = await jsonschemaTools.dereferenceSchema(
                        currentSchemaInfo.schema,
                        options,
                    );
                    assert.deepEqual(
                        latestSchemaInfo.schema,
                        dereferencedCurrentSchema,
                        `Dereferenced current schema does not equal latest schema version ${latestSchemaInfo.version}`
                    );
                });

                // Tests for each individual schema version, including current.
                Object.keys(materializedSchemasInfosByVersion).forEach((version) => {
                    const schemaInfosForVersion = materializedSchemasInfosByVersion[version];

                    console.log(version, schemaInfosForVersion);
                    describe(version, () => {

                        options.contentTypes.forEach((contentType) => {
                            const schemaInfoForContentType = schemaInfosForVersion
                            .find(schemaInfo => schemaInfo.contentType === contentType);

                            it(`must have ${contentType} version in ${schemaDir}`, () => {
                                assert.ok(schemaInfoForContentType, `Does not have schema info for ${contentType}`);
                                assert.equal(
                                    path.dirname(schemaInfoForContentType.path), schemaDir,
                                    `${schemaInfoForContentType.path} is not in expected ${schemaDir}`
                                );
                                assert.ok(
                                    fs.existsSync(schemaInfoForContentType.path),
                                    `${schemaInfoForContentType.path} does not exist`
                                );
                            });

                            if (options.shouldSymlink && contentType === options.contentTypes[0]) {
                                it(`must have extensionless symlink version pointing to ${contentType}`, () => {
                                    const filePath = path.join(schemaDir, version);
                                    assert.ok(fs.existsSync(filePath));
                                    assert.ok(fs.lstatSync(filePath).isSymbolicLink());
                                    assert.equal(fs.readlinkSync(filePath), `${version}.${contentType}`);
                                });
                            }

                            it(`${contentType} version must have correct ${options.schemaTitleField}`, () => {
                                assert.equal(schemaInfoForContentType.title, schemaTitle);
                            });

                            const relativeSchemaPath = path.relative(options.schemaBasePath, schemaInfoForContentType.path);
                            it(`${contentType} version must be in directory that matches title`, () => {
                                assert.equal(path.dirname(relativeSchemaPath), schemaTitle);
                            });
                        });

                        const materializedSchemaInfosForVersion = schemaInfosForVersion
                        .filter(schemaInfo => !schemaInfo.current);
                        // Assert that all materialized files of the same
                        // version are the same schema.
                        it('all materialized content types must be equal', () => {

                            for (let i = 1; i < materializedSchemaInfosForVersion.length; i++) {
                                assert.deepEqual(
                                    materializedSchemaInfosForVersion[i].schema,
                                    materializedSchemaInfosForVersion[i - 1].schema,
                                    `${schemaTitle} ${version}.${materializedSchemaInfosForVersion[i].contentType} ` +
                                    `does not equal ${version}.${materializedSchemaInfosForVersion[i - 1].contentType}`
                                );
                            }
                        });
                    });
                });
            });
        });
    });
}

module.exports = {
    declareTests
};
