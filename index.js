'use strict';

const _          = require('lodash');
const yaml       = require('js-yaml');
const path       = require('path');
const semver     = require('semver');
const fse        = require('fs-extra');
const pino       = require('pino');
const util       = require('util');
const exec       = util.promisify(require('child_process').exec);
const RefParser  = require('json-schema-ref-parser');
const mergeAllof = require('json-schema-merge-allof');
const Promise    = require('bluebird');

/**
 * Default options for various functions in this library.
 * Not all functions use all options, but many use some.
 */
const defaultOptions = {
    shouldSymlink: true,
    contentTypes: ['yaml'],
    currentName: 'current.yaml',
    schemaVersionField: '$id',
    shouldDereference: true,
    schemaBaseUris: [process.cwd()],
    dryRun: false,
    gitStaged: true,
    log: pino({ level: 'warn', prettyPrint: true }),
};


/**
 * Map of contentType to serializer function.
 */
const serializers = {
    yaml: yaml.dump,
    json: (obj) => { return JSON.stringify(obj, null, 2); },
};


/**
 * Serializes the object as the given contentType, either yaml or json.
 * @param {Object} object
 * @param {string} contentType
 * @return {string}
 */
function serialize(object, contentType = 'yaml') {
    if (_.isUndefined(serializers[contentType])) {
        throw new Error(
            `No serializer for ${contentType} is defined. ` +
            `contentType must be one of ${_.keys(serializers).join(',')}`
        );
    }
    return serializers[contentType](object);
}


/**
 * Reads in a yaml or json file from file
 * @param {string|int} file string path or int file descriptor to read
 * @return {Promise<Object>} read and parsed object
 */
async function readObject(file) {
    return yaml.safeLoad(await fse.readFile(file, 'utf-8'), {filename: file});
}

/**
 * Serializes object and writes to file.
 * @param {Object} object object to serialize and write to file
 * @param {string|int} file string path or int file descriptor to write
 * @param {string} contentType either 'yaml' or 'json'
 * @return {Promise} result of fse.writeFile
 */
function writeObject(object, file, contentType) {
    return fse.writeFile(file, serialize(object, contentType));
}


/**
 * Runs (and logs) command in cwd.
 * @param {string} command
 * @param {string} cwd path
 * @param {Object} options (with options.log for logging)
 * @return {Promise} result child_process#exec
 */
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

// https://tools.ietf.org/html/rfc3986#section-3.1
const uriProtocolRegex = /^[a-zA-Z0-9+.-]+:\/\//;
/**
 * Returns true if the uri has protocol schema on the front, else false.
 * @param {string} uri
 * @return {boolean}
 */
function uriHasProtocol(uri) {
    return uriProtocolRegex.test(uri);
}

/**
 * Takes a possibly relative uri, and augments it so that it is better suited for use in requests.
 * If the uri is already qualified (e.g. is starts with a protocol scheme), baseUri will
 * not be prepended.
 * If the uri already ends in a file extensions, defaultFileExtension  will not be appended.
 * If the baseUri given does not have a protocol schema, it is assumed to be file://.
 * file:// paths will be resolved with path.resolve to be transformed into absolute file paths.
 * @param {string} uri
 *      uri to resolve with baseUri and defaultFileExtension
 * @param {string} baseUri
 *      If given, uris that don't start with a protocol scheme will be prepended with this.
 * @return {Promise<Object>}
 */
function resolveUri(uri, baseUri) {
    let url = uri;
    // If the uri doesn't have a protocol, then we can use
    // the given baseUri as the default.
    if (baseUri && !uriHasProtocol(url)) {
        url = baseUri + url;
    }

    // If the url still doesn't have a protocol, assume it should be file://.
    if (!uriHasProtocol(url)) {
        url = `file://${path.resolve(url)}`;
    }
    return url;
}

/**
 * Create a schema resolver wrapper for both file and http.
 * We want to be able to prefix any $ref URI in a schema with
 * schema base URIs in order to look up schemas from a configurable
 * local or remote URL.  The returned object should be passed to
 * RefParser.dereference options as the 'resolve' object.
 * It will wrap both the default json-schema-ref-parser http
 * and file resolvers to prefix the $ref URI with each of the
 * configured schemaBaseUris and attempt to resolve them.
 * Whichver resolves first will be used.
 *
 * This resolver handles both file and http because
 * the $refs are not prefixed in the schemas, and as such
 * we don't know if the final URL will be file or http based.
 * You should use the object returned by this function
 * as the value of both resolve.file and resolve.http
 * when you call a json-schema-ref-parser function.
 *
 * Example:
 *
 *  schemaResolver = createSchemaResolver([
 *      'file:///path/to/local/schema/repo/'
 *      'http://remote.schema.repo/path/to/schema/repo/'
 *  ]);
 *
 *  refParserOptions = {
 *      resolve: {
 *          file: schemaResolver,
 *          http: schemaResolver,
 *      }
 *  }
 *  dereferencedSchema = RefParser.dereference('/the/best/schema/1.0.0', refParserOptions);
 *
 * @param {Array<string>} schemaBaseUris
 * @return {Object}
 */
function createSchemaResolver(schemaBaseUris) {
    // We will use the built in resolveers for file and http once
    // we transform the $ref URI prefixed with the schemaBaseUris.
    const fileResolver = require('json-schema-ref-parser/lib/resolvers/file');
    const httpResolver = require('json-schema-ref-parser/lib/resolvers/http');

    return {
        canRead(file) {
            return fileResolver.canRead(file) || httpResolver.canRead(file);
        },

        async read(file) {
            const files = _.map(schemaBaseUris, (baseUri) => {
                const f = _.clone(file);
                f.url = resolveUri(file.url, baseUri);
                return f;
            });
            // This is a 'fold' like operation on the resolved file urls,
            // keeping only the first url to succeed.
            return files.reduce((promise, f) => {
                return promise.catch(async () => {
                    if (fileResolver.canRead(f)) {
                        return await fileResolver.read(f);
                    } else if (httpResolver.canRead(f)) {
                        return await httpResolver.read(f);
                    } else {
                        throw new Error('Should not get here');
                    }
                });
            }, Promise.reject()); // seed the chain with a rejected promise.
        }
    };
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
            throw new Error(
                `File ${symlinkPath} is not writeable. Cannot create extensionless symlink.`, err
            );
        }
    }
    return fse.symlink(targetPath, symlinkPath);
}

/**
 * Stages paths into the git repository at gitRoot via git add.
 * @param {Array<string>} paths
 * @param {string} gitRoot
 * @param {Object} options
 * @return {Object}
 */
function gitAdd(paths, gitRoot, options = {}) {
    _.defaults(options, defaultOptions);
    const command = `git add ${paths.join(' ')}`;
    return execCommand(command, gitRoot, options);
}

/**
 * Finds the git root path relative to the current working directory.
 * @return {string}
 */
async function findGitRoot() {
    return (await execCommand('git rev-parse --show-toplevel')).stdout.trim();
}

/**
 * Finds modified paths in gitRoot.  If options.gitStaged, this will look for
 * modified staged files.  Else this will look ifor modified files in the working directory.
 * @param {string} gitRoot
 * @param {Object} options
 * @return {Array<string>}
 */
async function gitModifiedSchemaPaths(gitRoot, options = {}) {
    _.defaults(options, defaultOptions);
    const command = `git diff ${options.gitStaged ? '--cached' : ''} --name-only --diff-filter=ACM`;
    const modifiedFiles = (await execCommand(command, gitRoot, options)).stdout.trim().split('\n');
    return _.filter(modifiedFiles, file => path.basename(file) === options.currentName);
}

/**
 * Uses the options.schemaBaseUris to create http and file schema resolvers
 * that prefix schema URIs in $refs with with the base URIs.  These
 * resolved URLs are then dereferenced in place.
 * @param {Object} schema
 * @param {Object} options
 * @return {Promise<Object>} dereferenced schema
 */
async function dereferenceSchema(schema, options = {}) {
    _.defaults(options, defaultOptions);
    const schemaResolver = createSchemaResolver(options.schemaBaseUris);

    options.log.info(
        `Dereferencing schema with $id ${schema.$id} using schema base URIs ${options.schemaBaseUris}`
    );
    const refParserOptions = {
        resolve: {
            file: schemaResolver,
            http: schemaResolver,
        }
    };
    return RefParser.dereference(schema, refParserOptions)
        .then((dereferencedSchema) => {
            options.log.debug(
                `Merging any allOf fields in schema with $id ${dereferencedSchema.$id}`
            );
            return mergeAllof(dereferencedSchema, { ignoreAdditionalProperties: true });
        })
        .catch((err) => {
            options.log.error(err, `Failed dereferencing schema with $id ${schema.$id}`, schema);
            throw err;
        });
}

/**
 * Materializes a versioned schema file in the directory.
 *
 * @param {string} schemaDirectory directory in which to materialize schema
 * @param {Object} schema Schema to materialize
 * @param {Object} options
 * @return {Promise<string>} path of newly generated files
 */
async function materializeSchemaVersion(schemaDirectory, schema, options = {}) {
    _.defaults(options, defaultOptions);
    const log = options.log;

    const version = schemaVersion(schema, options.schemaVersionField);

    if (options.shouldDereference) {
        schema = await dereferenceSchema(schema, options);
    }

    // TODO if shouldValidate against meta schema, do so here.

    return _.flatten(await Promise.all(options.contentTypes.map(async (contentType) => {
        let generatedFiles = [];
        const materializedSchemaPath = path.join(
            schemaDirectory, `${version}.${contentType}`
        );

        if (!options.dryRun) {
            await writeObject(schema, materializedSchemaPath, contentType);
            log.info(`Materialized schema at ${materializedSchemaPath}.`);
            generatedFiles.push(materializedSchemaPath);
        } else {
            log.info(`--dry-run: Would have materialized schema at ${materializedSchemaPath}.`);
        }

        // Only create the extensionless symlink to the first listed contentType.
        if (options.shouldSymlink && contentType === options.contentTypes[0]) {
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
    })));

}

/**
 * Finds modified 'current' schema files in gitRoot and materializes them.
 *
 * @param {string} gitRoot If not given, this will be discovered by calling findGitRoot.
 * @param {Object} options
 * @return {Promise<Array<string>>} List of files that were generated
 */
async function materializeModifiedSchemas(gitRoot = undefined, options = {}) {
    _.defaults(options, defaultOptions);

    gitRoot = gitRoot || await findGitRoot();
    options.log.info(`Looking for modified schema files in ${gitRoot}`);
    const schemaPaths = await gitModifiedSchemaPaths(gitRoot, options);

    if (_.isEmpty(schemaPaths)) {
        options.log.info('No modfiied schema paths were found.');
        return [];
    } else {
        // There's no good way to know of $ref dependency order, but a good guess
        // is to render those with a shorter directory hierarchy first.
        const sortedSchemaPaths = schemaPaths.sort((p1, p2) => {
            return p1.split('/').length - p2.split('/').length;
        });

        const generatedFiles = _.flatten(await Promise.mapSeries(sortedSchemaPaths, (async (schemaPath) => {
            const schemaFile = path.resolve(gitRoot, schemaPath);
            const schemaDirectory = path.dirname(schemaFile);
            options.log.info(`Materializing ${schemaFile}...`)
            const schema = await readObject(schemaFile);
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
    serialize,
    gitAdd,
    findGitRoot,
    dereferenceSchema,
    materializeSchemaVersion,
    materializeModifiedSchemas,
};
