'use strict';

const _           = require('lodash');
const yaml        = require('js-yaml');
const path        = require('path');
const semver      = require('semver');
const readdirSync = require('recursive-readdir-sync');
const fse         = require('fs-extra');
const pino        = require('pino');
const util        = require('util');
const exec        = util.promisify(require('child_process').exec);
const RefParser   = require('json-schema-ref-parser');
const mergeAllOf  = require('json-schema-merge-allof');
const Promise     = require('bluebird');

/**
 * Default options for various functions in this library.
 * Not all functions use all options, but many use some.
 */
const defaultOptions = {
    shouldSymlink: true,
    contentTypes: ['yaml'],
    currentName: 'current.yaml',
    schemaVersionField: '$id',
    schemaTitleField: 'title',
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
    return yaml.safeLoad(await fse.readFile(file, 'utf-8'), { filename: file });
}

/**
 * Synchronous version of readObject
 * @param {string|int} file
 * @return {Object}
 */
function readObjectSync(file) {
    return yaml.safeLoad(fse.readFileSync(file, 'utf-8'), { filename: file });
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
    // We will use the built in resolvers for file and http once
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
            return mergeAllOf(dereferencedSchema, { ignoreAdditionalProperties: true });
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
            // If common is in the path, it might/should sort before.
            const p1Common = p1.includes('common');
            const p2Common = p2.includes('common');

            return p1Common === p2Common ? 0 : (p1Common ? -1 : 1) ||
                p1.split('/').length - p2.split('/').length;
        });

        const generatedFiles = _.flatten(
            await Promise.mapSeries(sortedSchemaPaths, (async (schemaPath) => {
                const schemaFile = path.resolve(gitRoot, schemaPath);
                const schemaDirectory = path.dirname(schemaFile);
                options.log.info(`Materializing ${schemaFile}...`);
                const schema = await readObject(schemaFile);
                return materializeSchemaVersion(
                    schemaDirectory,
                    schema,
                    options
                );
            }))
        );

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

/**
 * Given a path to a schema file, this returns an object describing the schema.
 * If the schema at schemaPath does not have a title, assume it is invalid.
 * A schema 'info' is an object like:
 * {
 *  title: 'schema/title',
 *  path: '/path/to/schema/title/1.0.0.yaml',
 *  version: '1.0.0',
 *  current: true, // or false if this file is not the 'current' schema file.
 *  schema; {...}  // The schema (not dereferenced) schema object read from schemaPath.
 * }
 * @param {string} schemaPath path to schema file
 * @param {Object} options
 * @return {Object} {title, uri, version, current<boolean>, schema<Object>}
 */
function schemaPathToInfo(schemaPath, options = {}) {
    _.defaults(options, defaultOptions);
    const schema = readObjectSync(schemaPath);
    return {
        title: _.get(schema, options.schemaTitleField, null),
        path: schemaPath,
        version: schemaVersion(schema, options.schemaVersionField),
        current: path.parse(schemaPath).base === options.currentName,
        schema,
    };
}

/**
 * Looks in schemaBasePath for files that look like schema files.
 * These are either X.Y.Z.<contentType> files or currentName.<contentType>
 * files.
 * @param {string} schemaBasePath
 * @param {Object} options
 * @return {Array}
 */
function findSchemaPaths(schemaBasePath, options = {}) {
    _.defaults(options, defaultOptions);
    options.log.debug(`Finding all schema files in ${schemaBasePath}`);
    // Filter for what look like schema paths.
    return readdirSync(schemaBasePath)
    // Map to parsed path
    .map(schemaPath => path.parse(schemaPath))
    // Must be one of desired output types
    .filter(p => options.contentTypes.includes(p.ext.slice(1)))
    // Must be either currentName or a semver.
    .filter(p => p.base === options.currentName || semver.parse(p.name))
    // Map back into into full path
    .map(p => path.join(p.dir, p.base));
}


/**
 * Compare function for schema info, used for sorting based
 * on 'common' schema, title, semver, and 'current'.
 * There's no good way to know of schema dependency order without
 * building a graph, but we can at least guess with some good heuristics.
 *
 * @param {Object} infoA
 * @param {Objectt} infoB
 * @return {int}
 */
function schemaInfoCompare(infoA, infoB) {
    // titles with 'common' in them should sort earlier.
    // (If common is in the title, assume it is likely a dependency schema.)
    const infoACommon = infoA.title.includes('common');
    const infoBCommon = infoB.title.includes('common');
    return infoACommon === infoBCommon ? 0 : (infoACommon ? -1 : 1) ||
        // Then sort by path hierarchy depth.  Likely shorter hierarchy schemas
        // should be rendered before others.
        infoA.path.split('/').length - infoB.path.split('/').length ||
        // else if they are the same title, then sort by semver
        semver.compare(infoA.version, infoB.version) ||
        // if they are the same version, check current. Current should be later.
        infoA.current === infoB.current ? 0 : (infoB.current ? -1 : 1);
}

/**
 * Looks in schemaBasePath for files that look like schema files and
 * then maps them using schemaPathToInfo, returning an object with
 * info and schema.
 * @param {string} schemaBasePath
 * @param {Object} options
 * @return {Object[]}
 */
function findAllSchemasInfo(schemaBasePath, options = {}) {
    _.defaults(options, defaultOptions);

    const schemaPaths = findSchemaPaths(schemaBasePath, options);
    // Map each schema path to a schema info object, including the schema itself.
    return schemaPaths.map(schemaPath => schemaPathToInfo(schemaPath, options))
    .sort(schemaInfoCompare);
}

/**
 * Given a list of schemaInfo objects, this groups them by title and major version.
 * Schema title is extracted from the schema itself using options.schemaTitleField.
 * @param {Object} schemaInfos
 * @param {Object} options
 * @return {Object}
 */
function groupSchemasByTitleAndMajor(schemaInfos, options = {}) {
    _.defaults(options, defaultOptions);

    const schemaInfosByTitle = _.groupBy(schemaInfos, schemaEntry => schemaEntry.title);

    const schemaByTitleMajor = {};
    _.keys(schemaInfosByTitle).forEach((title) => {
        schemaByTitleMajor[title] = _.groupBy(
            schemaInfosByTitle[title], info => semver.parse(info.version).major
        );
    });
    return schemaByTitleMajor;
}

/**
 * Finds all schemas in schemaBasePath, converts them to schema info objects,
 * and groups them by schema title and major version
 * @param {string} schemaBasePath
 * @param {Object} options
 * @return {Object}
 */
function findSchemasByTitleAndMajor(schemaBasePath, options = {}) {
    _.defaults(options, defaultOptions);
    return groupSchemasByTitleAndMajor(findAllSchemasInfo(schemaBasePath, options));
}

/**
 * Finds all current schema files and materializes them.
 * @param {string} schemaBasePath
 * @param {Object} options
 * @return {Array} generated schema file paths
 */
async function materializeAllSchemas(schemaBasePath, options = {}) {
    _.defaults(options, defaultOptions);
    const currentSchemasInfo = (await findAllSchemasInfo(schemaBasePath, options))
    .filter(e => e.current);

    return _.flatten(await Promise.all(_.map(
        currentSchemasInfo,
        info => materializeSchemaVersion(path.dirname(info.path), info.schema, options)
    )));
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
    materializeAllSchemas,
    schemaPathToInfo,
    findSchemaPaths,
    findAllSchemasInfo,
    groupSchemasByTitleAndMajor,
    findSchemasByTitleAndMajor
};
