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
                // TODO: I'm not sure we want to enforce title -> path convention.
                // If we do, it should be an explicit test, not assuming
                // that schemaBasePath + schemaTitle is the actual schema dir path.
                const dirPath = path.join(options.schemaBasePath, schemaTitle);
                const schemaInfos = allSchemaInfos[schemaTitle];

                it(`must contain ${options.currentName} schema file`, () => {
                    assert.ok(fs.existsSync(path.join(dirPath, 'current.yaml')));
                });

                it('must not contain extensionless current symlink', () => {
                    assert.equal(false, fs.existsSync(path.join(dirPath, 'current')));
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
                    describe(version, () => {

                        options.contentTypes.forEach((contentType) => {
                            const schemaInfoForContentType = schemaInfos
                            .find(schemaInfo => schemaInfo.contentType === contentType);

                            it(`must have ${contentType} version`, () => {
                                assert.ok(schemaInfoForContentType);
                                // TODO use schemaInfo.path instead?
                                assert.ok(fs.existsSync(path.join(dirPath, `${version}.${contentType}`)));
                            });


                            if (options.shouldSymlink && contentType === options.contentTypes[0]) {
                                it(`must have extensionless symlink version pointing to ${contentType}`, () => {
                                    const filePath = path.join(dirPath, version);
                                    assert.ok(fs.existsSync(filePath));
                                    assert.ok(fs.lstatSync(filePath).isSymbolicLink());
                                    assert.equal(fs.readlinkSync(filePath), `${version}.${contentType}`);
                                });
                            }
                        });

                        // assert that all materialized files of the same version are the same schema.
                        it('all materialized content types must be equal', () => {
                            const materializedSchemaInfosForVersion = schemaInfosForVersion
                            .filter(schemaInfo => !schemaInfo.current);

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
