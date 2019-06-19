#!/usr/bin/env node
'use strict';

const path      = require('path');
const yargs = require('yargs');
const _ = require('lodash');

const {
    dereferenceSchema,
    materializeSchemaVersion,
    readObject,
    defaultOptions,
} = require('../index.js');


// const doc = `
// jsonschema-tools

// Tools for working with versioned JSONSchema in a git repository.

// Usage:
//   jsonschema-tools materialize  [-G] [<file>]
//   jsonschema-tools materialize-modified [options] [<working-dir>]
//   jsonschema-tools dereference [<file>]
//   jsonschema-tools install-git-hook [<working-dir>]

// options:
//     -h, --help

//     -o, --output-dir <output-directory>     Directory in which to write versioned schema file.

//     -c, --content-type <content-type>       Format to serialize schemas in. json or yaml.
//                                             [default: ${defaultOptions.contentType}]

//     -V, --version-field <version-field>     Field in schemas from which to extract the
//                                             schema version.
//                                             [default: ${defaultOptions.schemaVersionField}]

//     -G, --no-git-add                        By default, generated files will be added to git.
//                                             This requires that you have git installed and
//                                             you are running this script from within a git
//                                             repository directory.

//     -S, --no-symlink                        By default, extensionless symlinks will be
//                                             generated. E.g 1.0.0 -> 1.0.0.yaml.

//     -v, --verbose

//     -n, --dry-run
// `;
// const parsedUsage = neodoc.parse(usage, { smartOptions: true });



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
        alias: 'version-field',
        desc: 'Field from which to extract the schema\'s version. This will be extracted using lodash#get.',
        type: 'string',
        default: defaultOptions.schemaVersionField,
    },
    'c': {
        alias: 'content-types',
        desc: 'Serialization content types.',
        type: 'array',
        default: [defaultOptions.contentType],
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

const schemaPathArg = {
    desc: 'Path to the schema. If not given, the schema will be read from stdin.',
    type: 'string',
    normalize: true,
};


async function dereference(args) {
    console.log('TODO', args);
}

async function materialize(args) {
    const log = defaultOptions.log;
    if (args.verbose) {
        defaultOptions.log.level = 'debug';
    }

    const options = {
        contentType: args.contentTypes[0],
        schemaVersionField: args.versionField,
        shouldSymlink: !args.noSymlink,
        dryRun: args.dryRyn,
        log,
    };

    if (_.isEmpty(args.schemaPath)) {
        args.schemaPath.push(0);
    }

    _.forEach(args.schemaPath, async (schemaFile) => {
        if (!args.outputDir && schemaFile === 0) {
            log.fatal('Must provide --output-dir if reading schema from stdin.');
            process.exit(1);
        }

        const schemaDirectory = args.outputDir || path.dirname(schemaFile);

        try {
            log.info(`Reading schema from ${schemaFile}`);
            let schema = await readObject(schemaFile);
            if (!args.noDereference)  {
                log.info(`Dereferencing schema from ${schemaFile}`);
                schema = await dereferenceSchema(schema);
            }
            await materializeSchemaVersion(schemaDirectory, schema, options);
        } catch (err) {
            log.fatal(err, `Failed materializing schema from ${schemaFile} into ${schemaDirectory}.`);
            process.exit(1);
        }
    });
}

async function materializeModified(args) {
    console.log('TODO', args);
}

const argParser = yargs
    .scriptName('jsonschema-tools')
    .command(
        'dereference [schema-path]', 'Dereference a JSONSchema.',
        y => y.positional('schema-path', schemaPathArg),
        dereference
    )
    .command(
        'materialize [schema-path...]', 'Materialize a JSONSchema into a versioned file.',
        y => y
            .options(commonOptions)
            .positional('schema-path', schemaPathArg),
        materialize
    )
    .command(
        'materialize-modified [git-root]', 'Materialize a JSONSchema into a versioned file.',
        y => y
            .options(commonOptions)
            .options({
                'U': {
                    alias: 'unstaged',
                    desc: 'If given, will look for unstaged modified files instead of staged (--cached) ones.',
                    type: 'boolean',
                    default: false,
                },
                'N': {
                    alias: 'current-name',
                    desc: 'Filename of modified files to look for.',
                    type: 'string',
                    default: 'current.yaml',
                }
            })
            .positional('git-root', {
                desc: 'Path to git-root in which to look for modified schemas.',
                type: 'string',
                normalize: true,
                default: './',
            }),
        materializeModified
    )
    .help();





// async function main() {
//     const args =  argParser.argv;
 

//     console.log(args);
//     console.log(options);



    // switch (command) {
    //     case 'dereference':
    //         console.log('TODO');
    //         break;

    //     case 'materialize':


            
    //         break;
    // }

    // const args = neodoc.run(parsedUsage, argv);
    // console.log(args);

    // const args =  docopt(doc);
    // const args =  argParser.argv;
    // console.log('args are ', args);
    // console.log('o is ', args.o);
    // process.exit(0);

//     const options = {
//         contentType: args['--content-type'],
//         schemaVersionField: args['--version-field'],
//         shouldGitAdd: !args['--no-git-add'],
//         shouldSymlink: !args['--no-symlink'],
//         dryRun: args['--dry-run'],
//         log: defaultOptions.log,
//     };

//     if (args['--verbose']) {
//         options.log.level = 'debug';
//     }

//     const log = options.log;

//     const schemaFile = args['<schema-file>'];
//     // schemaFile will not be stdin if no --output-dir.
//     const schemaDirectory = args['--output-dir'] || path.dirname(schemaFile);

//     try {
//         log.info(`Reading schema from ${schemaFile}`);
//         const schema = await readObject(schemaFile);
//         await materializeSchemaVersion(schemaDirectory, schema, options);
//     } catch (err) {
//         log.fatal(err, `Failed materializing schema from ${schemaFile} into ${schemaDirectory}.`);
//         // TODO: why is this not working?!
//         process.exit(1);
//     }
// }

if (require.main === module) {
    argParser.argv;
}
