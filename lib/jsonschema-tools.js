'use strict';

const _              = require('lodash');
const yaml           = require('js-yaml');
const path           = require('path');
const semver         = require('semver');
const readdirSync    = require('recursive-readdir-sync');
const fse            = require('fs-extra');
const pino           = require('pino');
const util           = require('util');
const exec           = util.promisify(require('child_process').exec);
const RefParser      = require('json-schema-ref-parser');
const mergeAllOf     = require('json-schema-merge-allof');
const traverseSchema = require('json-schema-traverse');
const Promise        = require('bluebird');

/**
 * Default options for various functions in this library.
 * Not all functions use all options, but many use some.
 */
const defaultOptions = {
    /**
     * If true, materialize functions will symlink an extensionless versioned file
     * to the version.contentTypes[0].  E.g. if contentTypes has 'yaml' as the first
     * entry, then 1.0.0 -> 1.0.0.yaml.
     */
    shouldSymlinkExtensionless: true,
    /**
     * If true, materialize functions will symlink a 'latest' file
     * to the latest version.contentTypes[0].
     */
    shouldSymlinkLatest: true,
    /**
     * List of content types to output when materializing versioned schema files.
     */
    contentTypes: ['yaml', 'json'],
    /**
     * Name of 'current' schema file. Only these files will be considered
     * when materializing modified or 'all' schema files.
     */
    currentName: 'current.yaml',
    /**
     * Field in schema from which to extract the version using semver.coerce.
     * If the value in this field looks like a URI path, only the final
     * basename element of the path will be used to infer the schema version.
     */
    schemaVersionField: '$id',
    /**
     * Field in schema from which to extract the schema title.
     */
    schemaTitleField: 'title',
    /**
     * If true, materialize functions will first dereference schemas before outputting them.
     */
    shouldDereference: true,
    /**
     * Path in which (current) schemas will be looked for.
     */
    schemaBasePath: process.cwd(),
    /**
     * These are the URIs that will be used when resolving schemas.
     * If not set, the readConfig function will set this to [schemaBasePath]
     */
    schemaBaseUris: undefined,
    /**
     * If true, don't actually modify anything, just log what would have been done.
     */
    dryRun: false,
    /**
     * If true, only git staged current schema files will be considered by materializeModified.
     * If false, only unstaged current schema files will be considerd by materializeModified.
     */
    gitStaged: false,
    /**
     * If true, materializeModified will `git add` any versioned schema files it materializes.
     */
    shouldGitAdd: true,
    /**
     * When finding schemas and info, if a schema's $id matches any regex here,
     * it will not be included in results.
     */
    ignoreSchemas: [],
    /**
     * Pino logger.
     */
    log: pino({ level: 'warn', prettyPrint: { translateTime: true, ignore: 'pid,hostname,level' }, }),
    /**
     * special case option to ease setting log level to
     * debug from CLI (where pino is not easily configurable).
     * Pino's log.level will be set to this by the readConfig function.
     */
    logLevel: 'warn',
    /**
     * Array of default config files from which custom
     * options will be read by readConfig.
     * The keys in these config files are the same as these defaultOptions keys.
     */
    configPaths: ['./.jsonschema-tools.yaml'],
    /**
     * Check the existing numeric bounds for a number field, and enforce a number type.
     * For more flexibility and clarity, number types are expressed here as an array of
     * the minimum and maximum numbers allowed.
     * The tool will add inclusive `minimum` and `maximum` properties if they aren't
     * present, and will modify their value if they outside the configured bounds.
     */
    enforcedNumericBounds: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};


/**
 * When serializing YAML, schema keys will be sorted in this order.
 * If a schema key is not specified here, its sort order is undefined.
 */
const schemaKeySortOrder = [
    'title',
    'description',
    '$id',
    '$schema',
    'type',
    'additionalProperties',
    'required',
    'properties',
    'allOf',
    'examples',
];

/**
 * Comparison function for schema keys.
 * @param {string} k1
 * @param {string} k2
 */
function schemaKeyCompare(k1, k2) {
    const sortOrder = _.invert(schemaKeySortOrder);
    if (!(k1 in sortOrder) || !(k2 in sortOrder)) {
        return 0;
    }
    return sortOrder[k1] - sortOrder[k2];
}

/**
 * Map of contentType to serializer function.
 */
const serializers = {
    yaml: (obj) => { return yaml.dump(obj, {sortKeys: schemaKeyCompare}); },
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

let configHasBeenRead = false;
/**
 * Loads jsonschema-tools config file(s) and returns merged options
 * with defaultOptions object.  If config files have already been read
 * once by this process, this will just return options as is.
 * Set force=true to override this to always read config files.
 * If force=false, it is expected that the options passed in here
 * have already been set by a previous call to readConfig.
 * I.e. no global config state is kept, it should just be passed around.
 * @param {Object} options
 *  options.configPaths must be a list of config file
 *  paths from which to read configs.  Default: ['.jsonschema-tools.yaml']
 * @param {boolean} force Force read configPaths even if readConfig has been called once.
 * @return {Object} of read in and merged options.
 */
function readConfig(options = {}, force = false) {
    if (configHasBeenRead && !force) {
        return options;
    }

    // Use defaultOptions.configPaths only if options.configPaths is undefined.
    // This allows users to disable configPath reading it by setting options.configPaths to false.
    const configPaths = _.isUndefined(options.configPaths) ?
        defaultOptions.configPaths : options.configPaths;
    const finalOptions = configPaths.map((p) => {
        if (fse.existsSync(p)) {
            return readObjectSync(p);
        } else {
            return {};
        }
    })
    // append our custom options at the end of the list of
    // config file options so that they take precedence.
    .concat(options)
    .reduce((currentOptions, incomingConfig) => {
        return _.defaults(incomingConfig, currentOptions);
    }, defaultOptions);

    // Set pino's log level from finalOptions.log_level.
    // This helps when setting log level from configs or from CLI
    // where pino object is not itself configurable.
    finalOptions.log.level = finalOptions.logLevel;

    // If schemaBaseUris hasn't been set, then set it to use schemaBasePath
    finalOptions.schemaBaseUris = finalOptions.schemaBaseUris || [finalOptions.schemaBasePath];

    // Don't need to read in config files again if readConfig is called next time.
    configHasBeenRead = true;

    finalOptions.log.debug(`Finished reading jsonschema-tools config from files: ${configPaths.join(',')}`);
    return finalOptions;
}

/**
 * Runs (and logs) command in cwd.
 * @param {string} command
 * @param {string} execOptions options to pass to child_process.exec
 * @param {Object} logger If given, will call logger.debug(command) before executing it.
 * @return {Promise} result child_process#exec
 */
function execCommand(command, execOptions, logger) {
    if (execOptions) {
        if (logger) {
            logger.debug(`Running: \`${command}\` with `, execOptions);
        }
        return exec(command, execOptions);
    } else {
        if (logger) {
            logger.debug(`Running: \`${command}\``);
        }
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
            // seed the chain with a rejected promise.
            // This is only used to start the fold, it should never be thrown up.
            }, Promise.reject());
        }
    };
}

/**
 * Uses options.schemaBaseUris to resolve a schema $id URI
 * and return the first schema found.
 * @param {String} schemaId Schema $id URI.
 * @param {Object} options
 * @return {Promise<Object>} schema at $id in one of the options.schemaBaseUris
 */
async function getSchemaById(schemaId, options) {
    options = readConfig(options);
    const schemaResolver = createSchemaResolver(options.schemaBaseUris);
    return yaml.safeLoad(await schemaResolver.read({ url: schemaId }), { file: schemaId });
}

/**
 * Returns a semantic version from a schema given a field
 * in that schema that contains the version number.
 * This uses semver.coerce to get the version.
 * If the schemaVersionField's value looks like a URI path,
 * only the final basename element will be used to infer the schema.
 * This is exported only for testing.
 * @param {Object} schema
 * @param {string} schemaVersionField
 *  field in schema that contains version,
 *  suitable for passing to lodash#get
 * @return {string} semantic version
 */
function schemaVersion(schema, schemaVersionField) {
    return semver.coerce(
        path.basename(_.get(schema, schemaVersionField))
    ).version;
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
        await fse.unlink(symlinkPath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            // File doesn't exist, no problem! We wanted to unlink anyway.
        } else {
            throw new Error(
                `${symlinkPath} exists but could not be unlinked. ` +
                `Cannot create symlink to ${targetPath}.`, err
            );
        }
    }
    return fse.symlink(targetPath, symlinkPath);
}

/**
 * Finds the git root path relative to options.schemaBasePath
 * @param {Object} options
 * @return {string}
 */
async function findGitRoot(options = {}) {
    options = readConfig(options);
    return (await execCommand(
        // Need to execute the git command in the schemaBasePath for it to find the
        // .git directory somewhere above schemaBasePath
        'git rev-parse --show-toplevel', { cwd: options.schemaBasePath }, options.log
    )).stdout.trim();
}

/**
 * Stages paths into the git repository at gitRoot via git add.
 * @param {Array<string>} paths
 * @param {Object} options
 * @return {Object}
 */
async function gitAdd(paths, options = {}) {
    options = readConfig(options);
    const command = `git add ${paths.join(' ')}`;
    return execCommand(command, { cwd: options.schemaBasePath }, options.log);
}

/**
 * Finds modified paths in options.schemaBasePath.  If options.gitStaged, this will look for
 * modified staged files.  Else this will look for unstaged modified files.
 * File paths will be returned as absolute paths resolved relative to the
 * discovered git root of options.schemaBasePath.
 * @param {Object} options
 * @return {Array<string>}
 */
async function gitModifiedSchemaPaths(options = {}) {
    options = readConfig(options);
    const gitRoot = await findGitRoot(options);
    const execOptions = { cwd: options.schemaBasePath };

    const command = `git diff ${options.gitStaged ? '--cached' : ''} --name-only --diff-filter=ACM`;

    const modifiedFiles = (await execCommand(command, execOptions, options.log)).stdout.trim().split('\n');
    return _.filter(modifiedFiles, file => path.basename(file) === options.currentName)
        .map(file => path.resolve(gitRoot, file));
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
 *  contentType: 'yaml'
 *  schema; {...}  // The schema (not dereferenced) schema object read from schemaPath.
 * }
 * @param {string} schemaPath path to schema file
 * @param {Object} options
 * @return {Object} {title, uri, version, current<boolean>, schema<Object>}
 */
function schemaPathToInfo(schemaPath, options = {}) {
    options = readConfig(options);
    const schema = readObjectSync(schemaPath);
    const parsedPath = path.parse(schemaPath);
    return {
        title: _.get(schema, options.schemaTitleField, null),
        path: schemaPath,
        version: schemaVersion(schema, options.schemaVersionField),
        current: parsedPath.base === options.currentName,
        contentType: parsedPath.ext.slice(1),
        schema,
    };
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
    options = readConfig(options);
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
 * Outputs a given schema with any modifications specified in the options,
 * including but not limited to dereferencing and enforcing numeric bounds.
 *
 * @param {Object} schema Schema to materialize
 * @param {Object} options
 * @return {Object} modified schema
 */
async function materializeSchema (schema, options) {
    if (options.shouldDereference) {
        schema = await dereferenceSchema(schema, options);
    }
    if (options.enforcedNumericBounds) {
        schema = enforceNumericBounds(schema, options.enforcedNumericBounds);
    }
    return schema;
}

/**
 * Materializes a versioned schema file in the directory.
 *
 * @param {string} schemaDirectory directory in which to materialize schema
 * @param {Object} schema Schema to materialize
 * @param {Object} options
 * @return {Promise<string>} path of newly materialized files
 */
async function materializeSchemaToPath(schemaDirectory, schema, options = {}) {
    options = readConfig(options);
    const log = options.log;

    const version = schemaVersion(schema, options.schemaVersionField);

    schema = await materializeSchema(schema, options);

    return _.flatten(await Promise.all(options.contentTypes.map(async (contentType) => {
        let materializedFiles = [];

        const materializedSchemaFileName = `${version}.${contentType}`
        const materializedSchemaPath = path.join(schemaDirectory, materializedSchemaFileName);

        if (!options.dryRun) {
            await writeObject(schema, materializedSchemaPath, contentType);
            log.info(`Materialized schema at ${materializedSchemaPath}.`);
            materializedFiles.push(materializedSchemaPath);
        } else {
            log.info(`--dry-run: Would have materialized schema at ${materializedSchemaPath}.`);
        }


        /**
         * If configured to do so, and if the schema we are materializing
         * has a semver later than whatever schema version latestSymlinkPath
         * currently points to, then updates the latest symlink to point
         * to this schema file we just materialized.
         *
         * This function will not take any action if !shouldSymlinkLatest
         * or if dryRun.
         *
         * Any updated symlink path will be added to the materializedFiles list.
         *
         * This is DRYed out into a function so we can call it for this contentType
         * as well as for an extensionless 'latest' below.
         *
         * NOTE: This does not extract the versions from the path names, it uses the
         *       versions from inside the schema itself.
         *
         * NOTE: This does not attempt to look for all schema versions.  This only
         *       updates the latest symlink if THIS version is later than
         *       whatever the latest symlink currently points to.  If
         *       you do something silly like delete the latest symlink(s),
         *       and then somehow materialize ONLY an OLD version of a schema,
         *       This will set latest to that version. The version comparison
         *       is only done if the latest symlink already exists.
         * @param {string} latestSymlinkPath
         */
        async function updateLatestSymlink(latestSymlinkPath) {
            // if latestSymlinkPath doesn't exist, or the schema we just materialized has a later
            // version than the one that latestSymlinkPath points to, then update
            // latestSymlinkPath to point at this materializedSchemaPath.
            if (options.shouldSymlinkLatest &&
                (!fse.existsSync(latestSymlinkPath) ||
                semver.compare(version, schemaPathToInfo(latestSymlinkPath, options).version) >= 0)
            ) {
                const target = path.basename(materializedSchemaPath);
                if (!options.dryRun) {
                    await createSymlink(materializedSchemaFileName, latestSymlinkPath);
                    log.info(
                        `Created latest symlink ${latestSymlinkPath} -> ${materializedSchemaFileName}.`
                    );
                    materializedFiles.push(latestSymlinkPath);
                } else {
                    log.info(
                        '--dry-run: Would have created latest symlink ' +
                        `${latestSymlinkPath} to ${materializedSchemaFileName}.`
                    );
                }
            }
        }

        // Possibly update the latest symlink to point to this `version.contentType`.
        await updateLatestSymlink(path.join(schemaDirectory, `latest.${contentType}`));

        // Only create the extensionless symlink to the first listed contentType.
        if (options.shouldSymlinkExtensionless && contentType === options.contentTypes[0]) {
            const extensionlessSymlinkPath = extensionlessPath(materializedSchemaPath);
            // const target = path.basename(materializedSchemaPath);
            if (!options.dryRun) {
                await createSymlink(materializedSchemaFileName, extensionlessSymlinkPath);
                log.info(
                    `Created extensionless symlink ${extensionlessSymlinkPath} -> ${materializedSchemaFileName}.`
                );
                materializedFiles.push(extensionlessSymlinkPath);
            } else {
                log.info(
                    '--dry-run: Would have created extensionless symlink ' +
                    `${extensionlessSymlinkPath} to ${materializedSchemaFileName}.`
                );
            }
            // Also poossibly create an extensionless 'latest' symlink to this version.
            await updateLatestSymlink(path.join(schemaDirectory, 'latest'));
        }

        return materializedFiles;
    })));
}

/**
 * @deprecated
 * Materializes a versioned schema file in the directory.
 *
 * @param {string} schemaDirectory directory in which to materialize schema
 * @param {Object} schema Schema to materialize
 * @param {Object} options
 * @return {Promise<string>} path of newly materialized files
 */
async function materializeSchemaVersion(schemaDirectory, schema, options = {}) {
    return materializeSchemaToPath(schemaDirectory, schema, options)
}

/**
 * Finds modified 'current' schema files in options.schemaBasePath and materializes them.
 *
 * @param {Object} options
 * @return {Promise<Array<string>>} List of files that were generated
 */
async function materializeModifiedSchemas(options = {}) {
    options = readConfig(options);

    options.log.info(`Looking for modified ${options.currentName} schema files in ${options.schemaBasePath}`);
    const schemaPaths = await gitModifiedSchemaPaths(options);

    if (_.isEmpty(schemaPaths)) {
        options.log.info(`No modified ${options.currentName} schema files were found.`);
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
                const schemaDirectory = path.dirname(schemaPath);
                options.log.info(`Materializing ${schemaPath}...`);
                const schema = await readObject(schemaPath);
                return materializeSchemaToPath(
                    schemaDirectory,
                    schema,
                    options
                );
            }))
        );

        if (options.shouldGitAdd && !options.dryRun) {
            options.log.info(`New schema files have been materialized. Adding them to git: ${generatedFiles}`);
            try {
                await gitAdd(generatedFiles, options);
            } catch (err) {
                options.log.error(err, 'Failed git add of newly materialized schema files.');
                throw err;
            }
        }
        return generatedFiles;
    }
}

const preCommitContent = `
#!/bin/bash
# unset GIT_DIR so jsonschema-tools can find the git root itself.
unset GIT_DIR

# Run materalize-modified looking for staged current schema files to materialize.
# This will pick up any config options from the .jsonschema-tools.yaml
$(npm bin)/jsonschema-tools materialize-modified --staged
`;

async function installGitHook(options) {
    options = readConfig(options);
    // Find gitRoot if it isn't provided.
    const gitRoot = options.gitRoot || await findGitRoot(options);
    const preCommitPath = path.join(gitRoot, '.git', 'hooks', 'pre-commit');

    options.log.info(`Saving jsonschema-tools materialize-modified pre-commit hook to ${preCommitPath}`);
    if (!options.dryRun) {
        await fse.writeFile(preCommitPath, preCommitContent);
        await fse.chmod(preCommitPath, 0o755);
    } else {
        options.log.info('--dry-run: Not installing pre-commit hook.');
    }
}


/**
 * Looks in options.schemaBasePath for files that look like schema files.
 * These are either X.Y.Z.<contentType> files or currentName.<contentType>
 * files. Note: This function does not respect options.ignoreSchemas,
 * since it does not read the discovered schema files.
 * @param {Object} options
 * @return {Array}
 */
function findSchemaPaths(options = {}) {
    options = readConfig(options);

    options.log.debug(`Finding all schema files in ${options.schemaBasePath}`);
    // Filter for what look like schema paths.
    return readdirSync(options.schemaBasePath)
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
 * Looks in options.schemaBasePath for files that look like schema files and
 * then maps them using schemaPathToInfo, returning an object with
 * info and schema.
 * If any schema $id matches a regex in options.ignoreSchemas, it will
 * not be included in returned values.
 * @param {Object} options
 * @return {Object[]}
 */
function findAllSchemasInfo(options = {}) {
    options = readConfig(options);

    const schemaPaths = findSchemaPaths(options);
    // Map each schema path to a schema info object, including the schema itself.
    return schemaPaths
    .map(schemaPath => schemaPathToInfo(schemaPath, options))
    .filter((schemaInfo) => {
        const schemaId = _.get(schemaInfo.schema, '$id', '');
        return !options.ignoreSchemas.find(pattern => schemaId.match(pattern));
    })
    .sort(schemaInfoCompare);
}

/**
 * Given a list of schemaInfo objects, this groups them by title.
 * @param {Object} schemaInfos
 * @param {Object} options
 * @return {Object}
 */
function groupSchemasByTitle(schemaInfos) {
    return  _.groupBy(schemaInfos, schemaInfo => schemaInfo.title);
}

/**
 * Finds all schemas in options.schemaBasePath, converts them to schema info objects,
 * and groups them by schema title
 * @param {string} schemaBasePath
 * @param {Object} options
 * @return {Object}
 */
function findSchemasByTitle(options = {}) {
    options = readConfig(options);
    return groupSchemasByTitle(findAllSchemasInfo(options));
}

/**
 * Given a list of schemaInfo objects, this groups them by title and major version.
 *
 * @param {Object} schemaInfos
 * @return {Object}
 */
function groupSchemasByTitleAndMajor(schemaInfos) {
    const schemaInfosByTitle = groupSchemasByTitle(schemaInfos);

    const schemaByTitleMajor = {};
    _.keys(schemaInfosByTitle).forEach((title) => {
        schemaByTitleMajor[title] = _.groupBy(
            schemaInfosByTitle[title], info => semver.parse(info.version).major
        );
    });
    return schemaByTitleMajor;
}

/**
 * Finds all schemas in options.schemaBasePath, converts them to schema info objects,
 * and groups them by schema title and major version
 * @param {Object} options
 * @return {Object}
 */
function findSchemasByTitleAndMajor(options = {}) {
    options = readConfig(options);
    return groupSchemasByTitleAndMajor(findAllSchemasInfo(options));
}

/**
 * Finds all current schema files in options.schemasBasePath and materializes them.
 * @param {Object} options
 * @return {Array} generated schema file paths
 */
async function materializeAllSchemas(options = {}) {
    options = readConfig(options);
    const currentSchemasInfo = (await findAllSchemasInfo(options))
    .filter(e => e.current);

    return _.flatten(await Promise.all(_.map(
        currentSchemasInfo,
        info => materializeSchemaToPath(path.dirname(info.path), info.schema, options)
    )));
}

/**
 * Traverses through all the fields in the schema, including nested properties, and
 * sets the numeric bounds specified in options when the object type is number.
 * @param {Object} schema
 * @param {Array} bounds as specified in options
 * @return {Object} schema with bounded numeric fields
 */
function enforceNumericBounds(schema, bounds) {
    const schemaCopy = _.cloneDeep(schema);
    const enforcedMin = bounds[0];
    const enforcedMax = bounds[1];
    traverseSchema(schemaCopy, (obj) => {
        if (['number', 'integer'].includes(obj.type)) {
            obj.minimum = obj.minimum || enforcedMin;
            obj.maximum = obj.maximum || enforcedMax;
        }
    })
    return schemaCopy;
}


module.exports = {
    defaultOptions,
    readObject,
    serialize,
    readConfig,
    gitAdd,
    installGitHook,
    getSchemaById,
    materializeSchema,
    materializeSchemaToPath,
    materializeSchemaVersion,
    materializeModifiedSchemas,
    materializeAllSchemas,
    schemaPathToInfo,
    findSchemaPaths,
    findAllSchemasInfo,
    findSchemasByTitle,
    findSchemasByTitleAndMajor,
    schemaVersion,
};
