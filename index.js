#!/usr/bin/env node
'use strict';

const _         = require('lodash');
const yaml      = require('js-yaml');
const path      = require('path');
const semver    = require('semver');
const fse       = require('fs-extra');
const pino      = require('pino');
const neodoc    = require('neodoc');

const defaultOptions = {
    shouldSymlink: true,
    contentType: 'yaml',
    schemaVersionField: '$id',
    shouldGitAdd: true,
    dryRun: false,
    log: pino({ level: 'warn', prettyPrint: true }),
};

/**
 * Map of contentType to serializer.
 */
const serializers = {
    'yaml': yaml.dump,
    'json': JSON.stringify
};


const usage = `
usage: jsonschema-materialize [options] [<schema-file>]

Extracts the schema version from a field in the schema
and outputs a file named for the version with the derefenced schema.
If no <schema-file> is provided, schema will be read from stdin.
If the schema is read from stdin one of <schema-file> or --output-dir is required.
If --output-dir is not provided, the output directory
is assumed to be the parent directory of <schema-file>.

options:
    -h, --help
    -o, --output-dir <output-directory>     Directory in which to write versioned schema file.
    -c, --content-type <content-type>       [Default: ${defaultOptions.contentType}]
    -V, --version-field <version-field>     [Default: ${defaultOptions.schemaVersionField}]
    -G, --no-git-add
    -S, --no-symlink
    -v, --verbose
    -n, --dry-run
`;
const parsedUsage = neodoc.parse(usage, { smartOptions: true });


/**
 * Reads in a yaml or json file from file
 * @param {string|int} file string path or int file descriptor to read
 * @return {Promise<Object>} read and parsed object
 */
async function readObject(file) {
    return yaml.safeLoad(await fse.readFile(file, 'utf-8'));
}


/**
 * Serializes object and writes to file.
 * @param {Object} object object to serialize and write to file
 * @param {string|int} file string path or int file descriptor to write
 * @param {string} contentType either 'yaml' or 'json'
 * @return {Promise} resolves when file is written
 */
function writeObject(object, file, contentType) {
    const serialize = serializers[contentType];
    if (_.isUndefined(serialize)) {
        throw new Error(
            `Cannot write schema file to ${file}, ` +
            `no serializer for ${contentType} is defined. ` +
            `contentType must be one of ${_.keys(serializers).join(',')}`
        );
    }
    return fse.writeFile(file, serialize(object));
}

/**
 * Returns a semantic version from a schema given a field
 * in that schema that contains the version.
 * This uses semver.coerce to get the version.
 * @param {Object} schema
 * @param {string} schemaVersionField
 *  field in schema that contains version,
 *  suitable for passing to lodash#get
 * @return {string} semantic version
 */
function schemaVersion(schema, schemaVersionField) {
    return semver.coerce(_.get(schema, schemaVersionField)).version;
}

/**
 * Returns the filePath without a file extension.
 * @param {string} filePath
 * @return {string}
 */
function extensionlessPath(filePath) {
    const parsedPath = path.parse(filePath);
    return path.join(parsedPath.dir, parsedPath.name);
}

/**
 * Creates a symlink at symlinkPath pointing at targetPath.
 * @param {string} targetPath
 * @param {string} symlinkPath
 * @return {Promise} resolves when symlink is created
 */
async function createSymlink(targetPath, symlinkPath) {
    try {
        await fse.access(symlinkPath, fse.constants.F_OK | fse.constants.W_OK);
        await fse.unlink(symlinkPath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            // no op, the file doesn't exist so we can just create a new symlink
        } else {
            throw new Error(`File ${symlinkPath} is not writeable. Cannot create extensionless symlink.`, err);
        }
    }
    return fse.symlink(targetPath, symlinkPath);
}

/**
 * Given a list of paths, returns a git add command
 * @param {Array<string>} paths
 * @return {string}
 */
function gitAddCommand(paths) {
    return `git add ${paths.join(' ')}`;
}

/**
 * Materializes a versioned schema file in the directory.
 *
 * @param {string} schemaDirectory directory in which to materialize schema
 * @param {Object} schema Schema to materialize
 * @param {Object} options
 * @return {Promise<string>} path of newly materialized schema
 */
async function materializeSchemaVersion(schemaDirectory, schema, options = {}) {
    _.defaults(options, defaultOptions);
    const log = options.log;
    // const schemaDirectory = path.dirname(schemaPath);

    const version = schemaVersion(schema, options.schemaVersionField);

    // TODO: deference and validate schema here.
    const materializedSchemaPath = path.join(
        schemaDirectory, `${version}.${options.contentType}`
    );

    let newFiles = [];
    if (!options.dryRun) {
        await writeObject(schema, materializedSchemaPath, options.contentType);
        log.info(`Materialized schema at ${materializedSchemaPath}.`);
        newFiles.push(materializedSchemaPath);
    }
    else {
        log.info(`--dry-run: Would have materialized schema at ${materializedSchemaPath}.`);
    }

    if (options.shouldSymlink) {
        const symlinkPath = extensionlessPath(materializedSchemaPath);
        const target = path.basename(materializedSchemaPath);
        if (!options.dryRun) {
            await createSymlink(target, symlinkPath);
            log.info(
                `Created extensionless symlink ${symlinkPath} -> ${target}.`
            );
            newFiles.push(symlinkPath);
        } else {
            log.info(
                `--dry-run: Would have created extensionless symlink ${symlinkPath} to ${target}.`
            );
        }
    }

    // TODO: Can we run git add during a git hook / gitattributes filter clean?
    if (options.shouldGitAdd && !options.dryRun) {
        /* eslint no-console: "off" */
        console.error(`New schema files have been generated. Please run:\n${gitAddCommand(newFiles)}`);
    }

    return materializedSchemaPath;
}


async function main(argv) {
    const args = neodoc.run(parsedUsage, argv);
    console.log(args);

    // Make sure at least one of <schema-file> or --output-dir is provided.
    if (_.isUndefined(args['<schema-file>']) && _.isUndefined(args['--output-dir'])) {
        console.error('Must specify at least <schema-file> or --output-dir\n' + parsedUsage.helpText);
        process.exit(1);
    }

    const options = {
        contentType: args['--content-type'],
        schemaVersionField: args['--version-field'],
        shouldGitAdd: !args['--no-git-add'],
        shouldSymlink: !args['--no-symlink'],
        dryRun: args['--dry-run'],
        log: defaultOptions.log,
    };

    if (args['--verbose']) {
        options.log.level = 'debug';
    }

    const log = options.log;

    const schemaFile = args['<schema-file>'] || 'stdin';
    // schemaFile will not be stdin if no --output-dir.
    const schemaDirectory = args['--output-dir'] || path.dirname(schemaFile);

    try {
        log.info(`Reading schema from ${schemaFile}`);
        const schema = await readObject(schemaFile === 'stdin' ? 0 : schemaFile);
        await materializeSchemaVersion(schemaDirectory, schema, options);
    } catch (err) {
        log.fatal(err, `Failed materializing schema from ${schemaFile} into ${schemaDirectory}.`);
        // TODO: why is this not working?!
        process.exit(1);
    }
}

if (require.main === module) {
    main(process.argv);
}


module.exports = materializeSchemaVersion;
