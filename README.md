# jsonschema-tools

A library and CLI to work with a repository of versioned JSONSchemas.

jsonschema-tools supports
- dereferencing of JSON Pointers
- Generation of semanticly versioned files
- Auto file version generation of modified 'current' versions via a git pre-commit hook

# Motivation
In a event stream based architecture, schemas define a contract between
disparate producers and consumers of data.  Thrift, Protocol Buffers, and Avro
are all schema based data formats, but can be difficult to use in different
settings.  These are binary formats, and as such the having schema is requried to
read data.  Distributing up to data schemas to all users of the data can be difficult,
especially when those users are in different organizations.

JSON is a ubiquitous data format, but it can be difficult to work with in strongly typed systems because of its free form nature. JSONSchemas can define a contract between
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
  jsonschema-tools dereference              Dereference a JSONSchema.
  [schema-path]
  jsonschema-tools materialize              Materializes JSONSchemas into
  [schema-path...]                          versioned files.
  jsonschema-tools materialize-modified     Looks for git modified JSONSchema
  [git-root]                                files and materializes them.
  jsonschema-tools install-git-hook         Installs a git pre-commit hook that
  [git-root]                                will materialize modified schema
                                            files before commit.

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

# git pre-commit hook
`jsonschema-tools install-git-hook` will install a git pre-commit hook that will materialize modified files found during a git commit.

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
    "postinstall": "$(npm bin)/jsonschema-tools install-git-hook -v -c yaml,json -u <relative-path-to-schemas-in-repo>"
  },
  "devDependencies": {
    ...,
    "@wikimedia/jsonschema-tools": "^0.0.7"
  }
```


# TODO:
- Schema validation given a meta schema.