#!/usr/bin/env node
'use strict';

const util = require('util');
const _        = require('lodash');
const yaml     = require('js-yaml');
const path = require('path');
const glob = require('glob');
const semver = require('semver');
const NodeGit = require('nodegit');
const fs = require("fs");
const writeFile = util.promisify(fs.writeFile);
const unlink = util.promisify(fs.unlink);
const symlink = util.promisify(fs.symlink);
const access = util.promisify(fs.access);

/**
 * Converts a utf-8 byte buffer or a YAML/JSON string into
 * an object and returns it.
 * @param {string|Buffer|Object} data
 * @return {Object}
 */
function objectFactory(data) {
    // If we were given a byte Buffer, parse it as utf-8 string.
    if (data instanceof Buffer) {
        data = data.toString('utf-8');
    } else if (_.isObject(data)) {
        // if we were given a a JS object, return it now.
        return data;
    }

    // If we now have a string, then assume it is a YAML/JSON string.
    if (_.isString(data)) {
        data = yaml.safeLoad(data);
    } else {
        throw new Error(
            'Could not convert data into an object.  ' +
            'Data must be a utf-8 byte buffer or a YAML/JSON string'
        );
    }

    return data;
}


function writeYamlFile(object, outputPath) {
    return writeFile(outputPath, yaml.dump(object));
}

const defaultOptions = {
    gitReference: 'HEAD',
    gitReferenceType: NodeGit.Reference.TYPE.SYMBOLIC, // NodeGit.Reference.TYPE.
    shouldSymlink: true,
    // TODO add option to generate and expect JSON rather than yaml
    contentType: 'yaml',
    schemaVersionRegex: /.*\/(\d+\.\d+\.\d+).yaml$/
};

class EventSchema {
    constructor(
        schemaDirectory,
        repository,
        options = {}
    ) {
        _.defaults(this, options, defaultOptions);

        this.schemaDirectory = schemaDirectory;
        this.repository = repository;

        // this.schemaVersionRegex = new RegExp(`(\d+\.\d+\.\d+)\.${this.contentType}$`);
    }

    static async init(schemaDirectory) {
        const absoluteDir = path.resolve(schemaDirectory);
        const repo = await NodeGit.Repository.open(
            await NodeGit.Repository.discover(absoluteDir, 0, '/')
        );
        return new EventSchema(schemaDirectory, repo);
    }

    // TODO: Can we create a function that inspects the diff of the schemas
    // auto generates a semver.inc 'release' argument value?
    // E.g. if only descriptions change, this can be 'patch'.
    // If fields added, this can be 'minor'.
    // If field types changed, this can be 'major'.
    // static releaseTypeOfChange(origSchema, newSchema) {
    // }

    extractVersion(schemaPath) {
        const match = schemaPath.match(this.schemaVersionRegex);
        if (match) {
            return match[1];
        } else {
            return null;
        }
    }

    // TODO: Is this useful?  We could just always assume we should work with HEAD via repo.getHeadCommit()
    async getCommit() {
        if (this.gitReferenceType == NodeGit.Reference.TYPE.SYMBOLIC) {
            // If this is a valid name, it is something like HEAD or refs/heads/branchname
            if (NodeGit.Reference.isValidName(this.gitReference)) {
                const oid = await NodeGit.Reference.nameToId(this.repository, this.gitReference);
                return this.repository.getCommit(oid);
            } else {
                // assume this is a branch
                return this.repository.getBranchCommit(this.gitReference);
            }
        } else if (this.gitReferenceType == NodeGit.Reference.TYPE.OID) {
            // Else this is a sha commit id.
            return this.repository.getCommit(this.gitReference);
        } else {
            throw new Error(`invalid gitReferenceType ${this.gitReferenceType}`);
        }
    }

    async schemaDirectoryEntries() {
        const commit = await this.getCommit();
        const tree = await NodeGit.Tree.lookup(this.repository, commit.treeId());

        const schemaDirectoryTreeEntry = await tree.getEntry(this.schemaDirectory);
        if (!schemaDirectoryTreeEntry.isTree()) {
            throw new Error(`${this.schemaDirectory} is not a git tree!`);
        }
        const schemaDirectoryTree = await schemaDirectoryTreeEntry.getTree();
        return schemaDirectoryTree.entries();
    }

    async entryContent(entry) {
        const blob = await entry.getBlob();
        return blob.content();
    }

    async schemaEntries() {
        const directoryEntries = await this.schemaDirectoryEntries();
        const schemaEntries = _.filter(directoryEntries, (entry) => {
            return entry.isFile() && entry.path().match(this.schemaVersionRegex);
        });
        return _.sortBy(schemaEntries, (entry) => entry.path());
    }

    async versions() {
        const schemaEntries = await this.schemaEntries();
        return schemaEntries.map(entry => this.extractVersion(entry.path()));
    }

    async latestVersion() {
        const versions = await this.versions();
        return _.last(versions);
    }

    async versionEntry(version) {
        return _.find(await this.schemaEntries(), (entry) => {
            return version == this.extractVersion(entry.path());
        })
    }

    async versionContent(version) {
        return this.entryContent(await this.versionEntry(version));
    }

    async versionObject(version) {
        return objectFactory(await this.versionContent(version));
    }

    async latestVersionContent() {
        return this.versionContent(await this.latestVersion());
    }

    async latestVersionObject() {
        return this.versionObject(await this.latestVersion());
    }

    async needsNewVersion(candidateSchema) {
        const latestSchema = await this.latestVersionObject();
        return !_.isEqual(latestSchema, candidateSchema);
    }

    async nextVersion(release='minor') {
        const latestVersion = await this.latestVersion();
        return semver.inc(latestVersion, release);
    }

    async nextVersionPath() {
        const nextVersion = await this.nextVersion();
        return `${this.schemaDirectory}/${nextVersion}.${this.contentType}`;
    }

    async createExtensionlessSymlink(schemaPath) {
        const filename = path.basename(schemaPath);
        const symlinkPath = path.join(
            path.dirname(schemaPath),
            path.basename(schemaPath, `.${this.contentType}`)
        );

        try {
            await access(symlinkPath, fs.constants.F_OK | fs.constants.W_OK);
            console.error(`Removing and recreating symlink ${symlinkPath}`);
            await unlink(symlinkPath);
        } catch (err) {
            if (err.code == 'ENOENT') {
                // no op, the file doesn't exist so we can just create a new symlink
            } else {
                throw new Error(`File ${symlinkPath} is not writeable. Cannot create extensionless symlink.`, err);
            }
        }

        await symlink(filename, symlinkPath);
        return symlinkPath;
    }

    async generateNextVersion(candidateSchema) {
        const nextVersionPath = await this.nextVersionPath();
        // TODO: dereference schema $refs.
        await writeYamlFile(candidateSchema, nextVersionPath);

        let gitAddCommand = `git add ${nextVersionPath}`;
        if (this.shouldSymlink) {
            const symlinkPath = await this.createExtensionlessSymlink(nextVersionPath);
            console.error(`Created extensionless symlink ${symlinkPath} -> ${nextVersionPath}`);
            gitAddCommand += ` ${symlinkPath}`;
        }
        console.error(`Generated new schema version for ${this}. Before committing please run: ${gitAddCommand}`);
        return nextVersionPath;
    
        // TODO: I want to git add this new file right here, but
        // I can't because the repo index is locked while this filter clean process runs.


        // WIP...
        // const lockedIndex = await NodeGit.Index.open("index.lock");
        // lockedIndex.write();

        // const index = await this.repository.refreshIndex();

        // let relock = false;
        // if (fs.existsSync('.git/index.lock')) {
        //     console.error('index.lock exists, removing');
        //     await unlink('.git/index.lock');
        //     relock = true;
        // }

        // const index = await this.repository.refreshIndex();
        // console.error(`adding ${nextVersionPath} to ${index.path()}`);

        // await index.addByPath(nextVersionPath);
        // await index.write();

        // if (relock) {
        //     console.error("relocking");
        //     fs.closeSync(fs.openSync('.git/index.lock', 'w'));
        // }
        
    }

    toString() {
        return `Schema ${this.schemaDirectory}`;
    }
}


if (require.main === module) {
    const schemaPath = process.argv[2];
    const data = fs.readFileSync(0, 'utf-8');
    const candidateSchema = objectFactory(data);
    
    EventSchema.init(path.dirname(schemaPath)).then(async (es) => {
        const needsNewVersion = await es.needsNewVersion(candidateSchema);
        if (needsNewVersion) {
            console.error(`${es} needs new version: ${await es.nextVersion()}`);
            try {
                const newVersionPath = await es.generateNextVersion(candidateSchema);
            } catch(err) {
                console.error("FAILED ", err);
            }
        } else {
            console.error(`${es} does not need new version.  Latest is ${await es.latestVersion()}`);
        }
    });
}


module.exports = {
    EventSchema,
}
