# jsonschema-tools

This is a library and CLI to work with a 'repository' of versioned JSONSchemas.
It supports

- dereferencing of JSON Pointers (TODO)
- Generation of semanticly named version files
- Auto version file generation of modified 'current' versions via a git pre-commit hook

# Usage
```
$ npm install jsonschema-tools
$ PATH=$PATH:$(pwd)/node_modules/.bin
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
Schemas should be manually and semantically versioned.  By storing the schema version
in the schema itself, you can use that schema version as you would any other
software dependency. Schemas should be easily findable by software at runtime
in order to do validation or schema conversion to different systems (e.g. RDBMS,
Kafka Connect, etc.). All versions should to be available.

# Materializing Schemas
Instead of manually keeping copies of each schema version, this library assists
in auto generating schema version files from a single 'current' version file.
This allows you to modify a single schema file, update the version field, and
still keep the previous versions available at a static location path.

The process of generating dereferenced and static schema version files is
called 'materializing'.

`jsonschema-tools materialize-modified` is intended to be used in a checkout
of a git repository to find 'current' schema versions that have been modified.
This allows you to make edits to a single current schema file and change the
version field (default: $id). Running `jsonschema-tools materialize-modified`
will detect the change and output a new file named by the new schema version.

# git pre-commit hook
`jsonschema-tools install-git-hook` will a git pre-commit hook that will
materialize modified files found during a git commit.

Install jsonschema-tools as a depenendency in your schema repository (or
globally somewhere), then run `jsonschema-tools install-git-hook` from
your git working copy checkout.  This will install .git/hooks/pre-commit.
pre-commit is a NodeJS script, so `require('jsonschema-tools')` must work
from within your git checkout.
