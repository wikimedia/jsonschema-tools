'use strict';

const _         = require('lodash');
const yaml      = require('js-yaml');
const path      = require('path');
const semver    = require('semver');
const fse       = require('fs-extra');
const pino      = require('pino');
const util      = require('util');
const exec      = util.promisify(require('child_process').exec);


const defaultOptions = {
    shouldSymlink: true,
    contentType: 'yaml',
    currentName: 'current.yaml',
    schemaVersionField: '$id',
    shouldDereference: true,
    dryRun: false,
    gitStaged: true,
    log: pino({ level: 'warn', prettyPrint: true }),
};


// TODO: support reading in from config file?  JSON? INI (git config)?

/**
 * Map of contentType to serializer.
 */
const serializers = {
    'yaml': yaml.dump,
    'json': JSON.stringify
};

function execCommand(command, cwd, options = {}) {
    _.defaults(options, defaultOptions);

    if (cwd) {
        options.log.debug(`Running: \`${command}\` in ${cwd}`);
        return exec(command, { cwd });
    } else {
        options.log.debug(`Running: \`${command}\``);
        return exec(command);
    }
}

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



function gitAdd(paths, gitRoot, options = {}) {
    _.defaults(options, defaultOptions);
    const command = `git add ${paths.join(' ')}`;
    return execCommand(command, gitRoot, options);
}

async function gitModifiedSchemaPaths(gitRoot, options = {}) {
    _.defaults(options, defaultOptions);
    const command = `git diff ${options.gitStaged ? '--cached' : ''} --name-only --diff-filter=ACM`;
    const modifiedFiles = (await execCommand(command, gitRoot, options)).stdout.trim().split('\n');
    return _.filter(modifiedFiles, file => path.basename(file) === options.currentName);
}


async function dereferenceSchema(schema) {
    return schema;
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

    const version = schemaVersion(schema, options.schemaVersionField);

    // TODO: deference and validate schema here.
    const materializedSchemaPath = path.join(
        schemaDirectory, `${version}.${options.contentType}`
    );

    let generatedFiles = [];
    if (!options.dryRun) {
        await writeObject(schema, materializedSchemaPath, options.contentType);
        log.info(`Materialized schema at ${materializedSchemaPath}.`);
        generatedFiles.push(materializedSchemaPath);
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
            generatedFiles.push(symlinkPath);
        } else {
            log.info(
                `--dry-run: Would have created extensionless symlink ${symlinkPath} to ${target}.`
            );
        }
    }

    return generatedFiles;
}


async function materializeModifiedSchemas(gitRoot = undefined, options = {}) {
    _.defaults(options, defaultOptions);

    gitRoot = gitRoot || process.cwd();
    options.log.info(`Looking for modified schema files in ${gitRoot}`);
    const schemaPaths = await gitModifiedSchemaPaths(gitRoot, options);

    if (_.isEmpty(schemaPaths)) {
        options.log.info('No modfiied schema paths were found.');
        return [];
    } else {
        const generatedFiles = _.flatten(await Promise.all(schemaPaths.map(async (schemaPath) => {
            const schemaFile = path.resolve(gitRoot, schemaPath);
            const schema = await readObject(schemaFile);
            const schemaDirectory = path.dirname(schemaFile);
            return materializeSchemaVersion(
                schemaDirectory,
                schema,
                options
            );
        })));

        if (options.shouldGitAdd && !options.dryRun) {
            options.log.info(`New schema files have been generated. Adding them to git: ${generatedFiles}`);
            try {
                await gitAdd(generatedFiles, gitRoot, options);
            } catch (err) {
                options.log.error(err, 'Failed git add of new schema files.');
                throw err;
            }
        }
        return generatedFiles;
    }
}

module.exports = {
    defaultOptions,
    readObject,
    gitAdd,
    dereferenceSchema,
    materializeSchemaVersion,
    materializeModifiedSchemas
};

