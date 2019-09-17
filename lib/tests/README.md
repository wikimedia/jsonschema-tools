Files in this directory are expected to export a test function
that declares tests for schema repository quality.  Schemas will be discovered
by looking in `options.schemaBasePath`.

This allows schema repositories to import jsonschema-tools repository tests
and run them as part of their own testing process.
