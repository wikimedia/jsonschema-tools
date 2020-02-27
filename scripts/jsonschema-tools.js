#!/usr/bin/env node
'use strict';

const _     = require('lodash');
const path  = require('path');
const yargs = require('yargs');

const {
    dereferenceSchema,
    materializeSchemaVersion,
    materializeModifiedSchemas,
    materializeAllSchemas,
    readObject,
    serialize,
    installGitHook,
    defaultOptions,
} = require('../index.js');


/**
 * Allows for specifying comma separated array types with yargs.
 * @param {Array} arr
 * @return {Array}
 */
function coerceArrayOption(arr) {
    return _.uniq(_.flatMap(arr, e => e.split(',')));
}

const commonOptions = {
    o: {
        alias: 'output-dir',
        desc: 'Directory in which to write materialized schema files.  If not provided, this defaults to the parent directory of the input schema file.',
        type: 'string',
    },
    V: {
        alias: 'schema-version-field',
        desc: 'Field from which to extract the schema\'s version. This will be extracted using lodash#get.',
        type: 'string',
    },
    u: {
        alias: 'schema-base-uris',
        desc: 'URIs to prefix onto JSON $ref URIs when dereferencing schemas.',
        type: 'array',
        coerce: coerceArrayOption
    },
    c: {
        alias: 'content-types',
        desc: 'Serialization content types.',
        type: 'array',
        choices: ['yaml', 'json'],
        coerce: coerceArrayOption
    },
    N: {
        alias: 'current-name',
        desc: 'Filename of \'current\' schema file.',
        type: 'string',
    },
    D: {
        alias: 'no-dereference',
        desc: 'If given, the materialized schema will not be dereferenced.',
        type: 'boolean',
    },
    S: {
        alias: 'no-symlink',
        desc: 'If given, an extensionless symlink to the materialized schema will not be created.',
        type: 'boolean',
    },
    n: {
        alias: 'dry-run',
        type: 'boolean',
    },
    v: {
        alias: 'verbose',
        type: 'boolean',
        default: false,
    },
    C: {
        alias: 'config-paths',
        desc: 'YAML file paths from which to read configuration. Provided CLI options take precedence. Default: .jsonschema-tools.yaml',
        type: 'array',
        coerce: coerceArrayOption
    }
};

const dereferenceOptions = {
    v: commonOptions.v,
    u: commonOptions.u,
    // For dereference, only a single output content-type is taken, as this command
    // output the dereferenced schema to stdout.
    c: {
        alias: 'content-type',
        desc: 'Serialization content type.',
        type: 'string',
        default: 'yaml',
        choices: ['yaml', 'json'],
    },
    C: commonOptions.C,
};

const gitOptions = {
    s: {
        alias: 'staged',
        desc: 'If given, will look for staged (--cached) modified files instead of unstaged ones. ' +
            'This is usually only used by the git pre-commit hook',
        type: 'boolean',
    },
    G: {
        alias: 'no-git-add',
        desc: 'If given, newly generated files will not be staged to git via git add.',
        type: 'boolean',
        default: false,
    }
};

const schemaPathArg = {
    desc: 'Path to the schema. If not given, the schema will be read from stdin.',
    type: 'string',
    normalize: true,
};

const schemaBasePathArg = {
    desc: 'Path to base directory in which schemas are stored.  Defaults to cwd.',
    type: 'string',
    normalize: true,
};



/**
 * Converts yargs parsed args to jsonschema-tools options.
 * @param {Object} args
 * @return {Object}
 */
function argsToOptions(args) {
    const options = {};
    _.keys(args).forEach((key) => {
        if (key === 'noExtensionlessSymlink') {
            options.shouldSymlinkExtensionless = !args[key];
        } else if (key === 'noLatestSymlink') {
            options.shouldSymlinkLatest = !args[key];
        } else if (key === 'noDereference') {
            options.shouldDereference = !args[key];
        } else if (key === 'noGitAdd') {
            options.shouldGitAdd = !args[key];
        } else if (key === 'staged') {
            options.gitStaged = args[key];
        } else if (_.has(defaultOptions, key)) {
            options[key] = args[key];
        }
    });

    options.log = defaultOptions.log;
    if (args.verbose) {
        options.logLevel = 'debug';
        options.log.level = options.logLevel;
    }

    return options;
}

/**
 * Given yargs args, reads schemas from files and writes them to stdout.
 * @param {Object} args
 */
async function dereference(args) {
    const options = argsToOptions(args);

    let schemaPaths = args.schemaPath;
    // If not given any schema paths, read from stdin.
    if (_.isEmpty(schemaPaths)) {
        schemaPaths = [0];
    }

    const schemas = await Promise.all(schemaPaths.map(async (schemaPath) => {
        try {
            return await dereferenceSchema(await readObject(schemaPath), options);
        } catch (err) {
            options.log.fatal(err, `Failed dereferencing schema at ${schemaPath}`);
            process.exit(1);
        }
    }));

    if (schemas.length === 1) {
        // If only one schema path, just write it out it as schema object
        process.stdout.write(serialize(schemas[0], options.contentType));
    } else {
        // Else write it out as array of schema objects.
        process.stdout.write(serialize(schemas, options.contentType));
    }
}

/**
 * Given yargs args, reads schemas from files and materializes them to version files.
 * @param {Object} args
 */
async function materialize(args) {
    const options = argsToOptions(args);

    let schemaPaths = args.schemaPath;
    // Read from stdin if no schema-path was given.
    if (_.isEmpty(args.schemaPaths)) {
        schemaPaths = [0];
    }

    _.forEach(schemaPaths, async (schemaPath) => {
        if (!args.outputDir && schemaPath === 0) {
            options.log.fatal('Must provide --output-dir if reading schema from stdin.');
            process.exit(1);
        }

        const schemaDirectory = args.outputDir || path.dirname(schemaPath);

        try {
            options.log.info(`Reading schema from ${schemaPath}`);
            let schema = await readObject(schemaPath);
            await materializeSchemaVersion(schemaDirectory, schema, options);
        } catch (err) {
            options.log.fatal(err, `Failed materializing schema from ${schemaPath} into ${schemaDirectory}.`);
            process.exit(1);
        }
    });
}

/**
 * Looks for git modified files that match currentName and materializes them.
 * @param {Object} args
 */
async function materializeModified(args) {
    const options = argsToOptions(args);
    await materializeModifiedSchemas(options);
}

async function materializeAll(args) {
    const options = argsToOptions(args);
    await materializeAllSchemas(args.schemaBasePath, options);
}

/**
 * Installs a git pre-commit hook in gitRoot that will
 * materialize any staged modified files currentName schema files.
 * @param {Object} args
 */
function installGitPreCommitHook(args) {
    const options = argsToOptions(args);
    installGitHook(options);
}


// Create the yargs parser and call the appropriate
// function for the given subcommand.
const argParser = yargs
    .scriptName('jsonschema-tools')
    .command(
        'dereference [schema-path...]', 'Dereference a JSONSchema and output it on stdout.',
        y => y
            .options(dereferenceOptions)
            .positional('schema-path', schemaPathArg),
        dereference
    )
    .command(
        'materialize [schema-path...]', 'Materializes JSONSchemas into versioned files.',
        y => y
            .options(commonOptions)
            .positional('schema-path', schemaPathArg),
        materialize
    )
    .command(
        'materialize-modified [schema-base-path]', 'Looks for (git) modified current JSONSchema files and materializes them.',
        y => y
            .options(commonOptions)
            .options(gitOptions)
            .positional('schema-base-path', schemaBasePathArg),
        materializeModified
    )
    .command(
        'materialize-all [schema-base-path]', 'Looks for all current JSONSchema files and materializes them.',
        y => y
            .options(commonOptions)
            .positional('schema-base-path', schemaBasePathArg),
        materializeAll
    )
    .command(
        'install-git-hook [schema-base-path]', 'Installs a git pre-commit hook that will materialize (git staged) modified current schema files before commit.',
        y => y.positional('schema-base-path', schemaBasePathArg),
        installGitPreCommitHook
    )
    .showHelpOnFail(false, 'Specify --help for available options')
    .help();

if (require.main === module) {
    argParser.argv;
}
