'use strict';

const _ = require('lodash');
const path = require('path');
const assert = require('assert').strict;
const fs = require('fs');
const semver = require('semver');
const jsonschemaTools = require('../jsonschema-tools.js');

function assertIdMatchesDirectory(schemaInfo, options) {
    const relativeSchemaPath = path.relative(options.schemaBasePath, schemaInfo.path);
    assert.ok(
        relativeSchemaPath.includes(schemaInfo.schema['$id'].substring(1)),
        "schema $id must match relative schema directory"
    );
}

function declareTests(options = { logLevel: 'warn' }) {

    options = jsonschemaTools.readConfig(options);
    const allSchemaInfos = jsonschemaTools.findSchemasByTitle(options);

    describe(`Schema Repository Structure in ${options.schemaBasePath}`, () => {
        Object.keys(allSchemaInfos).forEach((schemaTitle) => {
            describe(`Schema with title ${schemaTitle}`, () => {
                const schemaInfos = allSchemaInfos[schemaTitle];

                // All schemas with this title should be in the same directory
                it('all materialized files should be in the same directory', () => {
                    for (let i = 1; i < schemaInfos.length; i++) {
                        assert.equal(
                            path.dirname(schemaInfos[i].path),
                            path.dirname(schemaInfos[i - 1].path),
                            `${schemaInfos[i].path} is not in the same directory as ${schemaInfos[i - 1].path}`
                        );
                    }
                });

                // If any schemas have titles that are not in their proper directory, we will have
                // trouble declaring any further tests.
                const mismatchedSchemaTitleAndDirectory = _.find(schemaInfos, (schemaInfo) => {
                    const relativeSchemaPath = path.relative(options.schemaBasePath, schemaInfo.path);
                    return path.dirname(relativeSchemaPath) != schemaInfo.title
                });

                if (mismatchedSchemaTitleAndDirectory) {
                    it.only(`all materialized files should be in directory that matches schema title`, () => {
                        schemaInfos.forEach(schemaInfo => {
                            const relativeSchemaPath = path.relative(options.schemaBasePath, schemaInfo.path);
                            assert.equal(path.dirname(relativeSchemaPath), schemaInfo.title, 'schema title must match relative schema directory');
                        });
                    });
                    // Do no further structure tests on this schema title.
                    return;
                }

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
                if (_.isUndefined(currentSchemaInfo)) {
                    it.only (`must have a ${options.currentName} file`, () => {
                        assert.ok(!_.isUndefined(currentSchemaInfo), 'could not find current schema file');
                    });
                    // We will fail declaring further tests if no current file.
                    return;
                }

                // This is the highest versioned contentTypes[0] file, e.g. 1.0.0.yaml.
                const latestSchemaInfo = schemaInfos
                    .filter((schemaInfo) => {
                        return !schemaInfo.current && schemaInfo.contentType == options.contentTypes[0];
                    })
                    .sort((a, b) => semver.compare(a.version, b.version))
                    .pop();

                if (_.isUndefined(latestSchemaInfo)) {
                    it.only (`Must be able to find the latest schema version file`, () => {
                        assert.ok(!_.isUndefined(latestSchemaInfo), 'could not find latest schema version file');
                    });
                    // We will fail declaring further tests if no latestSchemaInfo
                    return;
                }

                // Make sure latestSchemaInfo is what it should be.
                it (`must contain materialized current schema file as the greatest ${options.contentTypes[0]} version ${currentSchemaInfo.version}.${options.contentTypes[0]}`, () => {
                    assert.equal(
                        latestSchemaInfo.path,
                        path.join(schemaDir, `${currentSchemaInfo.version}.${options.contentTypes[0]}`)
                    );
                    assert.ok(fs.existsSync(latestSchemaInfo.path));
                });

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
                    const dereferencedCurrentSchema = await jsonschemaTools.materializeSchema(
                        currentSchemaInfo.schema,
                        options,
                    );
                    assert.deepEqual(
                        latestSchemaInfo.schema,
                        dereferencedCurrentSchema,
                        `Dereferenced current schema does not equal latest schema version ${latestSchemaInfo.version}`
                    );
                });


                if (options.shouldSymlinkLatest) {
                    it(`Should have latest.${latestSchemaInfo.contentType} symlink pointing to latest version file ${latestSchemaInfo.path}`, () => {
                        const latestSymlinkPath = path.join(schemaDir, `latest.${latestSchemaInfo.contentType}`);
                        assert.ok(fs.existsSync(latestSymlinkPath));
                        assert.ok(fs.lstatSync(latestSymlinkPath).isSymbolicLink());
                        assert.equal(
                            fs.realpathSync(latestSymlinkPath),
                            fs.realpathSync(path.join(schemaDir, `${latestSchemaInfo.version}.${options.contentTypes[0]}`))
                        );
                    });

                    if (options.shouldSymlinkExtensionless) {
                        it(`Should have extensionless latest symlink pointing to latest version file ${latestSchemaInfo.path}`, () => {
                            const latestSymlinkPath = path.join(schemaDir, 'latest');
                            assert.ok(fs.existsSync(latestSymlinkPath));
                            assert.ok(fs.lstatSync(latestSymlinkPath).isSymbolicLink());
                            assert.equal(
                                fs.realpathSync(latestSymlinkPath),
                                fs.realpathSync(path.join(schemaDir, `${latestSchemaInfo.version}.${options.contentTypes[0]}`)));
                        });
                    }
                }


                // Tests for each individual schema version, including current.
                Object.keys(materializedSchemasInfosByVersion).forEach((version) => {
                    const schemaInfosForVersion = materializedSchemasInfosByVersion[version];

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

                            if (options.shouldSymlinkExtensionless && contentType === options.contentTypes[0]) {
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

                            it(`$id must match directory`, () => {
                                assertIdMatchesDirectory(schemaInfoForContentType, options);
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

module.exports = declareTests;
