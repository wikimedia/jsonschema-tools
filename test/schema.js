'use strict';

const fixture = require('test-fixture')()
const fse = require('fs-extra');
const yaml     = require('js-yaml');
const assert = require('assert');

const Schema = require('../jsonschema-repository').Schema;


const cp = require('child_process');
function exec(command, opts) {
  return new Promise(function(resolve, reject) {
    return cp.exec(command, opts, function(err, result) {
      if (err) {
        reject(err);
      }
      else {
        resolve(result);
      }
    });
  });
};

const fixtureRepositoryUrl = '/Users/otto/Projects/wm/analytics/jsonschema-repository-fixture';
const fixtureRepositoryPath = 'repositories/jsonschema-repository-fixture'
const fixtureRepositoryAbsolutePath = `${fixture.root}/${fixtureRepositoryPath}`;


function cloneRepository(url, dest) {
    return exec(`git clone ${url} ${dest}`);
}

async function readSchemaFile(schemaPath) {
    const content = await fse.readFile(schemaPath);
    return yaml.safeLoad(content.toString('utf-8'));

}


describe('Schema', function() {

    before('Cloning fixture repositories', async function() {
        await fse.remove(fixtureRepositoryAbsolutePath)
        await cloneRepository(fixtureRepositoryUrl, fixtureRepositoryAbsolutePath);
    });

    after('Deleting fixture repositories', async function() {
        await fse.remove(fixtureRepositoryAbsolutePath)
    });

    beforeEach('Copying submodule fixtures to temp directory', async function() {
        // Copy the fixtures/ dir into a temp directory that is automatically
        // cleaned up after each test.
        await fixture.copy();
        this.repoPath = await fse.realpath(fixture.resolve(fixtureRepositoryPath));
    });

    it('init() discovers proper repository and schema details', async function() {
        const schemaDirectory = `${this.repoPath}/schemas/basic`
        const schema = await Schema.init(schemaDirectory);

        assert.equal(
            schema.repository.path(),
            this.repoPath + '/.git/',
            'Schema repository path should be git repository root'
        );

        assert.equal(
            schema.schemaDirectory,
            schemaDirectory
        );
    });

    it('finds latest version', async function() {
        const schemaDirectory = `${this.repoPath}/schemas/basic`
        const schema = await Schema.init(schemaDirectory);

        assert.equal(
            await schema.latestVersion(),
            '1.1.0',
            'latest version is 1.1.0'
        );
    });

    it('finds all versions', async function() {
        const schemaDirectory = `${this.repoPath}/schemas/basic`
        const schema = await Schema.init(schemaDirectory);

        const versions = await schema.versions();
        assert.deepStrictEqual(
            versions,
            ['1.0.0', '1.1.0'],
            'All versions are found'
        );
    });

    it('computes next version', async function() {
        const schemaDirectory = `${this.repoPath}/schemas/basic`
        const schema = await Schema.init(schemaDirectory);

        assert.equal(
            await schema.nextVersion(),
            '1.2.0'
        );
        assert.equal(
            await schema.nextVersion('major'),
            '2.0.0'
        );
    });

    it('reads latest schema object', async function() {
        const schemaDirectory = `${this.repoPath}/schemas/basic`
        const schema = await Schema.init(schemaDirectory);

        const latestSchema = await readSchemaFile(`${this.repoPath}/schemas/basic/${await schema.latestVersion()}`);

        assert.deepStrictEqual(
            await schema.latestVersionObject(),
            latestSchema
        );
    });

    it('knows when new schema is not needed', async function() {
        const schemaDirectory = `${this.repoPath}/schemas/basic`
        const schema = await Schema.init(schemaDirectory);

        const latestSchema = await readSchemaFile(`${this.repoPath}/schemas/basic/${await schema.latestVersion()}`);
        assert.equal(
            await schema.needsNewVersion(latestSchema),
            false,
            'latest schema is the same schema, so no new version is needed'
        );
    });

    it('knows when new schema is needed', async function() {
        const schemaDirectory = `${this.repoPath}/schemas/basic`
        const schema = await Schema.init(schemaDirectory);

        const candidateSchema = await readSchemaFile(`${this.repoPath}/schemas/basic/${await schema.latestVersion()}`);
        // Alter candidateSchema so it is different.
        candidateSchema['properties']['new_field'] = {
            'type': 'string'
        };

        assert.equal(
            await schema.needsNewVersion(candidateSchema),
            true,
            'candidate schema is different, so new version is needed'
        );
    });

    it('generates new schema version file (without extensionless symlink)', async function() {
        const schemaDirectory = `${this.repoPath}/schemas/basic`
        const schema = await Schema.init(schemaDirectory, {shouldSymlink: false});

        const candidateSchema = await readSchemaFile(`${this.repoPath}/schemas/basic/${await schema.latestVersion()}`);
        // Alter candidateSchema so it is different.
        candidateSchema['properties']['new_field'] = {
            'type': 'string'
        };

        const newVersion = schema.nextVersion();

        const newVersionPath = await schema.generateNextVersion(candidateSchema);

        const newVersionObject = await readSchemaFile(newVersionPath);
        assert.deepStrictEqual(
            newVersionObject,
            candidateSchema
        );

        assert.equal(
            await fse.exists(`${this.repoPath}/schemas/basic/${newVersion}`),
            false,
            'generateNextVersion should not symlink if shouldSymlink: false'
        );

        assert.equal(
            await schema.gitAddNextVersionCommand(),
            `git add ${newVersionPath}`
        )
    });


    it('generates new schema version file (with extensionless symlink)', async function() {
        const schemaDirectory = `${this.repoPath}/schemas/basic`
        const schema = await Schema.init(schemaDirectory, {shouldSymlink: true});

        const candidateSchema = await readSchemaFile(`${this.repoPath}/schemas/basic/${await schema.latestVersion()}`);
        // Alter candidateSchema so it is different.
        candidateSchema['properties']['new_field'] = {
            'type': 'string'
        };

        const newVersion = await schema.nextVersion();
        const newVersionPath = await schema.generateNextVersion(candidateSchema);
        const newVersionObject = await readSchemaFile(newVersionPath);

        assert.deepStrictEqual(
            newVersionObject,
            candidateSchema
        );

        const symlinkPath = `${this.repoPath}/schemas/basic/${newVersion}`;
        assert.equal(
            await fse.exists(symlinkPath),
            true,
            'generateNextVersion should symlink if shouldSymlink: true'
        );

        const linkRealPath = await fse.realpath(symlinkPath);
        assert.equal(
            linkRealPath,
            newVersionPath,
            `symlink should point at ${newVersionPath}`
        );

        assert.equal(
            await schema.gitAddNextVersionCommand(),
            `git add ${newVersionPath} ${symlinkPath}`
        )
    });

});