#!/usr/bin/env node
'use strict';

const _     = require('lodash');
const fse   = require('fs-extra');
const path  = require('path');
const yargs = require('yargs');

const {
    dereferenceSchema,
    materializeSchemaVersion,
    materializeModifiedSchemas,
    readObject,
    serialize,
    findGitRoot,
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
    'o': {
        alias: 'output-dir',
        desc: 'Directory in which to write materialized schema files.  If not provided, this defaults to the parent directory of the input schema file.',
        type: 'string',
        normalize: true,
    },
    'V': {
        alias: 'schema-version-field',
        desc: 'Field from which to extract the schema\'s version. This will be extracted using lodash#get.',
        type: 'string',
        default: defaultOptions.schemaVersionField,
    },
    'u': {
        alias: 'schema-base-uris',
        desc: 'URIs to prefix onto JSON $ref URIs when dereferencing schemas.',
        type: 'array',
        default: [],
        coerce: coerceArrayOption
    },
    'c': {
        alias: 'content-types',
        desc: 'Serialization content types.',
        type: 'array',
        default: defaultOptions.contentTypes,
        choices: ['yaml', 'json'],
        coerce: coerceArrayOption
    },
    'D': {
        alias: 'no-dereference',
        desc: 'If given, the materialized schema will not be dereferenced.',
        type: 'boolean',
        default: false,
    },
    'S': {
        alias: 'no-symlink',
        desc: 'If given, an extensionless symlink to the materialized schema will not be created.',
        type: 'boolean',
        default: false,
    },
    'n': {
        alias: 'dry-run',
        type: 'boolean',
        default: false,
    },
    'v': {
        alias: 'verbose',
        type: 'boolean',
        default: false,
    },
};

const dereferenceOptions = {
    'v': commonOptions.v,
    'u': commonOptions.u,
    'c': {
        alias: 'content-type',
        desc: 'Serialization content type.',
        type: 'string',
        default: defaultOptions.contentTypes[0],
        choices: ['yaml', 'json'],
    },
};

const gitOptions = {
    'N': {
        alias: 'current-name',
        desc: 'Filename of modified files to look for.',
        type: 'string',
        default: 'current.yaml',
    },
    'U': {
        alias: 'unstaged',
        desc: 'If given, will look for unstaged modified files instead of staged (--cached) ones.',
        type: 'boolean',
        default: false,
    },
    'G': {
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



function argsToOptions(args) {
    const options = {};
    _.keys(args).forEach((key) => {
        if (key === 'noSymlink') {
            options.shouldSymlink = !args[key];
        }
        else if (key === 'noDereference') {
            options.shouldDereference = !args[key];
        }
        else if (key === 'noGitAdd') {
            options.shouldGitAdd = !args[key];
        }
        else if (key === 'unstaged') {
            options.gitStaged = !args[key];
        }
        else {
            options[key] = args[key];
        }
    });

    options.log = defaultOptions.log;
    if (args.verbose) {
        options.log.level = 'debug';
    }

    return options;
}


async function dereference(args) {
    const options = argsToOptions(args);

    if (_.isEmpty(args.schemaPath)) {
        args.schemaPath.push(0);
    }
    if (args.verbose) {
        defaultOptions.log.level = 'debug';
    }
    const schemas = await Promise.all(args.schemaPath.map(async (schemaPath) => {
        try {
            return await dereferenceSchema(await readObject(schemaPath), options);
        } catch (err) {
            options.log.fatal(err, `Failed dereferencing schemas in ${schemaPath}`);
            process.exit(1);
        }
    }));

    if (schemas.length === 1) {
        process.stdout.write(serialize(schemas[0], options.contentType));
    } else {
        process.stdout.write(serialize(schemas, options.contentType));
    }
}


async function materialize(args) {
    const options = argsToOptions(args);

    if (_.isEmpty(args.schemaPath)) {
        args.schemaPath.push(0);
    }

    _.forEach(args.schemaPath, async (schemaFile) => {
        if (!args.outputDir && schemaFile === 0) {
            options.log.fatal('Must provide --output-dir if reading schema from stdin.');
            process.exit(1);
        }

        const schemaDirectory = args.outputDir || path.dirname(schemaFile);

        try {
            options.log.info(`Reading schema from ${schemaFile}`);
            let schema = await readObject(schemaFile);
            if (!args.noDereference)  {
                options.log.info(`Dereferencing schema from ${schemaFile}`);
                schema = await dereferenceSchema(schema);
            }
            await materializeSchemaVersion(schemaDirectory, schema, options);
        } catch (err) {
            options.log.fatal(err, `Failed materializing schema from ${schemaFile} into ${schemaDirectory}.`);
            process.exit(1);
        }
    });
}

async function materializeModified(args) {
    const options = argsToOptions(args);
    await materializeModifiedSchemas(args.gitRoot, options);
}


const preCommitTemplate = _.template(`#!/usr/bin/env node
'use strict';

const {
    materializeModifiedSchemas,
} = require('jsonschema-tools');


const options = {
    contentTypes: <%= JSON.stringify(contentTypes) %>,
    schemaVersionField: '<%= schemaVersionField %>',
    schemaBaseUris: <%= JSON.stringify(schemaBaseUris) %>,
    shouldSymlink: <%= !noSymlink %>,
    shouldDereference: <%= !noDereference %>,
    currentName: '<%= currentName %>',
    gitStaged: <%= !unstaged %>,
    shouldGitAdd: <%= !noGitAdd %>,
    dryRun: <%= dryRun %>,
};

materializeModifiedSchemas(undefined, options);
`);

async function installGitHook(args) {
    const gitRoot = args.gitRoot || await findGitRoot();

    // If schemaBaseUris were not given, then assume we will look
    // for $ref URIs starting at the git root.
    if (_.isEmpty(args.schemaBaseUris)) {
        args.schemaBaseUris = [gitRoot];
    }

    const preCommitPath = path.join(gitRoot, '.git', 'hooks', 'pre-commit');
    const preCommitContent = preCommitTemplate(args);

    const log = defaultOptions.log;
    if (args.verbose) {
        log.level = 'debug';
    }

    log.info(`Saving jsonschema-tools materialize-modified pre-commit hook to ${preCommitPath}`);
    if (!args.dryRun) {
        await fse.writeFile(preCommitPath, preCommitContent);
        await fse.chmod(preCommitPath, 0o755);
    } else {
        log.info('--dry-run: Not installing pre-commit hook.');
    }
}


// Create the yargs parser and call the appropriate
// function for the given subcommand.
const argParser = yargs
    .scriptName('jsonschema-tools')
    .command(
        'dereference [schema-path...]', 'Dereference a JSONSchema.',
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
        'materialize-modified [git-root]', 'Looks for git modified JSONSchema files and materializes them.',
        y => y
            .options(commonOptions)
            .options(gitOptions)
            .positional('git-root', {
                desc: 'Path to git-root in which to look for modified schemas.',
                type: 'string',
                normalize: true,
            }),
        materializeModified
    )
    .command(
        'install-git-hook [git-root]', 'Installs a git pre-commit hook that will materialize modified schema files before commit.',
        y => y
            .options(commonOptions)
            .options(dereferenceOptions)
            .options(gitOptions)
            .positional('git-root', {
                desc: 'Local git repository root in which to install git pre-commit hook.  If not given, this will find the git root starting at the current working directory.',
                type: 'string',
                normalize: true,
            }),
        installGitHook
    )
    .showHelpOnFail(false, 'Specify --help for available options')
    .help();

if (require.main === module) {
    argParser.argv;
}
