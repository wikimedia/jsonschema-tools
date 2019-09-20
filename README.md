# jsonschema-tools

A library and CLI to work with a repository of versioned JSONSchemas.

jsonschema-tools supports
- dereferencing of JSON Pointers
- merging of `allOf`
- Generation of semanticly versioned files
- Auto file version generation of modified 'current' versions via a git pre-commit hook

# Motivation
In a event stream based architecture, schemas define a contract between
disparate producers and consumers of data.  Thrift, Protocol Buffers, and Avro
are all schema based data formats, but can be difficult to use in different
settings.  These are binary formats, and as such the having schema is requried to
read data.  Distributing up to data schemas to all users of the data can be difficult,
especially when those users are in different organizations.

JSON is a ubiquitous data format, but it can be difficult to work with in strongly
typed systems because of its free form nature. JSONSchemas can define a contract between
producers and consumers of data in the same way that e.g. Avro schemas do.
However, unlike Avro, there is no built in support for evolving JSONSchemas over time.

This library helps with managing a repository of evolving JSONSchemas.  It is intended
to be used in a git repository to materialize staticly versioned schema files as
your schema evolves.  By having all schema versions materialized as static files,
a schema repository could be shared to clients either via git, or via a static
http fileserver. An http fileserver on top of a git repository that contains
predictable schema URLs can act much like Confluent's Avro schema registry,
but with the benifits of decentralization provided by git.

# Usage
```
$ npm install -g jsonschema-tools
$ jsonschema-tools --help

jsonschema-tools [command]

Commands:
  jsonschema-tools dereference              Dereference a JSONSchema and output
  [schema-path...]                          it on stdout.
  jsonschema-tools materialize              Materializes JSONSchemas into
  [schema-path...]                          versioned files.
  jsonschema-tools materialize-modified     Looks for (git) modified current
  [schema-base-path]                        JSONSchema files and materializes
                                            them.
  jsonschema-tools materialize-all          Looks for all current JSONSchema
  [schema-base-path]                        files and materializes them.
  jsonschema-tools install-git-hook         Installs a git pre-commit hook that
  [schema-base-path]                        will materialize (git staged)
                                            modified current schema files before
                                            commit.

Options:
  --version  Show version number                                       [boolean]
  --help     Show help                                                 [boolean]
```

# Schema versions
Schemas should be manually and semantically versioned. The schema version
should be stored in the schema itself. You can use that schema version as you would
any other software dependency. Schemas should be easily findable by software at
runtime in order to do validation or schema conversion to different systems
(e.g. RDBMS, Kafka Connect, etc.).

# Materializing Schemas
Instead of manually keeping copies of each schema version, this library assists
in auto generating schema version files from a single 'current' version file.
This allows you to modify a single schema file, update the version field, and
still keep the previous versions available at a static location path.
It will also (by default) attempt to dereference any JSON `$ref` pointers
so that the full schemas are available staticially in the materialized ones.

The process of generating dereferenced and static schema version files is
called 'materializing'.

`jsonschema-tools materialize-modified` is intended to be used in a checkout
of a git repository to find 'current' schema versions that have been modified.
This allows you to make edits to a single current schema file and change the
version field (default: `$id`). Running `jsonschema-tools materialize-modified`
will detect the change and output a new file named by the new schema version.

# Dereferencing: `$ref` pointers and `allOf` merge
This library supports using anchored schema path URIs for `$ref` pointers.  By configuring
`schema_base_uris` to local (file://) or remote (http://) base URIs for schema repositories,
you can then set `$ref`s in your JSONSchemas to a path into those schema repositories. Also,
this library will merge any `allOf` fields it encounters into an explicit list
of fields.  This will allow for inclusion of 'common' schemas to avoid copy/pasting
common fields throughout your schemas.

For example:

With a common schema at http://schema.repo.org/schemas/common/1.0.0
```yaml
title: common
description: Common schema fields for all WMF schemas
$id: /common/1.0.0
$schema: https://json-schema.org/draft-07/schema#
type: object
properties:

  $schema:
    type: string
    description: >
      The URI identifying the jsonschema for this event. This should be
      a short uri containing only the name and revision at the end of the
      URI path.  e.g. /schema_name/1.0.0 is acceptable. This often will
      (and should) match the schema's $id field.

  dt:
    type: string
    format: date-time
    maxLength: 128
    description: Time stamp of the event, in ISO-8601 format

required:
  - $schema
  - dt
```

And with a specific schema at /path/to/local/schemas/thing/change/current.yaml like
```yaml
title: thing/change
$id: /thing/change/1.1.0
$schema: https://json-schema.org/draft-07/schema#
type: object
additionalProperties: false
# Use allOf so that common schemas are fully merged by
# jsonschema-tools along with their required fields.
allOf:
    ### common fields
  - $ref: /common/1.0.0
    ### thing/change fields
  - properties:
      thing_id:
        type: integer
      thing_name:
        type: string
    required:
      - thing_id
```

NOTE: that the path only based $ref starts with a '/'. This causes the schema
resolver to look outside of the schema itself for the $ref.
If a path $ref does not start with a '/', the resolver will look for an internally
defined ref $id.  See also https://json-schema.org/understanding-json-schema/structuring.html.

Absolute $ref URLs are supported, just prefix them with either file:// or http://


Now, running
```bash
jsonschema-tools dereference --schema-base-uris file:///path/to/local/schemas,http://schema.repo.org/schemas /path/to/local/schemas/thing/change/current.yaml
```
will first search all of the schema base URIs for a the `$ref: /common/1.0.0` URL.   It will be
found at http://schema.repo.org/schemas/common/1.0.0.  Then, the common fields from that schema
will be merged with the specific fields listed in `allOf`, including all `required` fields.
This will result in the following dereferenced schema:

```yaml
title: thing/change
$id: /thing/change/1.1.0
$schema: https://json-schema.org/draft-07/schema#
type: object
additionalProperties: false
# Use allOf so that common schemas are fully merged by
# jsonschema-tools along with their required fields.
properties:
  $schema:
    type: string
    description: >
      The URI identifying the jsonschema for this event. This should be
      a short uri containing only the name and revision at the end of the
      URI path.  e.g. /schema_name/1.0.0 is acceptable. This often will
      (and should) match the schema's $id field.

  dt:
    type: string
    format: date-time
    maxLength: 128
    description: Time stamp of the event, in ISO-8601 format
    ### common fields

  thing_id:
    type: integer
  thing_name:
    type: string
required:
  - $schema
  - dt
  - thing_id
```

# git pre-commit hook
`jsonschema-tools install-git-hook` will install a git pre-commit hook that will
materialize modified current files found during a git commit.

Install jsonschema-tools as a depenendency in your schema repository (or
globally somewhere), then run `jsonschema-tools install-git-hook` from
your git working copy checkout.  This will install .git/hooks/pre-commit.
pre-commit is a NodeJS script, so `require('jsonschema-tools')` must work
from within your git checkout.

## As an NPM dependency
Alternatively, you can make jsonschema-tools an npm dependency in your
schema git repository, and at an npm `postinstall` script to automatically
install the jsonschema-tools pre-commit hook for any user of the repository.
Add the following to your package.json:

```json
  "scripts": {
    ...,
    "postinstall": "$(npm bin)/jsonschema-tools install-git-hook"
  },
  "devDependencies": {
    ...,
    "@wikimedia/jsonschema-tools": "^0.3.0"
  }
```

# jsonschema-tools config files
To ease use as a library or CLI, jsonschema-tools supports reading options from
config files.  The default config file is ./.jsonschema-tools.yaml.  The
available config option overrides are documented below.

Options provided on the CLI will take precedence over those read from config.

```javascript
{
   /**
     * If true, materialize functions will symlink an extensionless versioned file
     * to the version.contentTypes[0].  E.g. if contentTypes has 'yaml' as the first
     * entry, then 1.0.0 -> 1.0.0.yaml.
     */
    shouldSymlink: true,
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
     * special case option to ease setting log level to
     * debug from CLI (where pino is not easily configurable).
     * Pino's log.level will be set to this by the readConfig function.
     */
    logLevel: 'warn',
    /**
     * Array of default config files from which custom
     * options will be read by readConfig.
     * The keys in these config files are the same as these defaultOtions keys.
     */
    configPaths: ['./.jsonschema-tools.yaml'],
}
```

# Schema Repository Tests

jsonschema-tools exports a `tests` module that aides in ensuring that a schema
repository is in a maintainable structure, and that its schema versions are
backwards compatible and robust.

To run all tests in your schema repository, create a file in e.g.
`tests/schema-repository.js` with

```javascript
'use strict';

// Run all jsonschema-tools schema repository tests.
// This assumes schemaBasePath is configured in .jsonschema-tools.yaml,
// or that schemaBasePath is ./
require('@wikimedia/jsonschema-tools').tests.all({ logLevel: 'warn' });
```

The tests are as follows:

## structure
- Schemas are in a hierarchy and layout that matches their schema title's
- All configured content types exist
- All schemas have 'current' versions that are the same as the latest materialized version
- etc.

## robustness
Robustness tests ensure that schemas will be easily useable in strongly typed and/or
SQL based systems.

- All schemas are valid (draft-7) JSONSchemas and are secure (according to AJV, e.g. no unlimited regexes)
- All fields are in snake_case format
- All fields have monomorphic types
- All required properties are defined

## compatibility
- All materialized schemas with the same major version must be backwards compatible
  (they can only add new non-required fields).

