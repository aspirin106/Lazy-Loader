# Configuration reference

The root JSON object contains `version: 1` and a `servers` object. Its keys are backend aliases. Configuration version 1 is independent of the gateway's software version.

## Backend fields

| Field | Default | Meaning |
| --- | --- | --- |
| `command` | Required | Executable name or path. `.cmd` and `.bat` wrappers are rejected. No shell is started. |
| `args` | `[]` | Array of strings. Environment-variable expressions are not expanded. |
| `cwd` | Configuration directory | Fixed backend working directory. Relative paths are resolved against the configuration directory. Must exist. |
| `inheritCwd` | `false` | Use the gateway's actual working directory. Cannot be combined with `cwd`. |
| `env` | `{}` | Literal string-valued environment overrides for this backend. |
| `envVars` | `[]` | Host-supplied variable names assigned to this backend within the managed environment group. |
| `catalog` | Required | Backend metadata cache path. Relative paths use the configuration directory. Must be unique and cannot overwrite the configuration file. |
| `idleSeconds` | `0` | Zero preserves the running session. A positive value stops the backend after its active work and queue finish and this idle interval expires. |
| `stateless` | Not asserted | Must be explicitly `true` for any positive idle timeout. This is a policy assertion by the operator. |
| `startupSeconds` | `30` | Timeout for each initialize or discovery request, including individual pagination requests. Must be positive. |
| `timeoutSeconds` | `120` | Timeout for a forwarded request after startup. Must be positive. |
| `dynamicTools` | `false` | Adopt live tools after startup and refresh tools following list-change notifications. |
| `deferredDiscovery` | `false` | Expose a virtual `connect` tool when the catalog file does not exist yet. Intended for external applications that are not ready. |

Time values must be finite numbers between 0 and 86400 seconds. Unknown configuration keys are rejected. Aliases match `^[a-z][a-z0-9_-]{0,31}$` and must not contain `__`. Combined public tool names cannot exceed 128 characters.

`command`, arguments, working-directory behavior, literal environment overrides, and managed variable names contribute to a launch hash. A catalog with another launch hash is rejected. The hash is not a signature of the backend executable and does not include the runtime values of inherited environment variables.

## Create catalogs

```sh
node gateway.mjs snapshot servers.json files
node gateway.mjs check servers.json
```

Create parent directories before snapshotting. A snapshot initializes the selected backend, discovers tool metadata and advertised prompt/resource metadata, then closes it. It does not call a tool. Initialization itself can still start watchers or other backend-specific services.

The catalog is replaced through a temporary file and rename only after discovery succeeds. All configured directories are validated before a snapshot starts, so remove unused placeholder entries first.

Catalogs contain backend-provided descriptions, schemas, instructions, and resource metadata. Treat generated catalogs as machine-specific data and review them before sharing.

## Strict and dynamic tools

Strict mode compares live tools, backend identity, and instructions with the catalog before dispatch. A negotiated protocol version can differ from the snapshot's version as long as it is supported. Version 0.2.1 fixes a false catalog mismatch caused by comparing those versions across sessions.

With `dynamicTools: true`, live metadata replaces the in-memory catalog and the gateway notifies the client. If the selected tool's schema changed, the call is rejected until the client refreshes its tool list. Dynamic updates are not automatically written to disk. Snapshot again after backend updates so later connections start with current metadata.

## Deferred editor discovery

When `deferredDiscovery: true` is set and no catalog file exists, the gateway initially exposes `<alias>__connect`. Calling it initializes the backend and discovers its real tools without invoking a backend tool. It does not launch the external editor or application for you.

Use `dynamicTools: true` for clients that refresh the tool list after connecting. Missing files trigger this fallback; malformed catalogs and launch-hash mismatches still fail validation.

## Environment forwarding

The client supplies the gateway's environment. Declare backend-specific host variables by name.

```json
{
	"envVars": ["MCP_API_TOKEN"],
	"env": {
		"LOG_LEVEL": "warning"
	}
}
```

For Codex, explicitly forward the host variable to the gateway with the client-side `env_vars` key.

```toml
[mcp_servers.lazy_gateway]
env_vars = ["MCP_API_TOKEN"]
```

Merge that field into the full gateway entry; it is not a complete installation example.

The union of all backend `envVars` names is managed. A backend does not inherit a managed variable unless it declares that name. Other environment variables continue to be inherited. Literal `env` values override inherited values, including managed names. Avoid committing literals that contain credentials.

Backend `envVars` accepts strings only. Convert richer client-side environment declarations to names before using this configuration format.

## Client timeout budget

The client's tool timeout must include cold startup and the actual backend request. Startup has several discovery requests, each with its own timeout. `timeoutSeconds` starts after startup. A single client timeout copied from another installation is not a guarantee for your workload.

If a command times out after writing external state, increasing a timeout does not make retrying that command safe. Check the outcome first.

## Protocol coverage

Supported versions are `2025-11-25`, `2025-06-18`, and `2024-11-05`.

The implementation includes cached tool/prompt/resource discovery, tool calls, prompt retrieval and completion, resource reads and URI mapping, logging, progress notifications, and callbacks for roots, elicitation, and sampling when the upstream client advertises the corresponding capability. Callback IDs are translated so backends cannot collide.

Resource URIs are namespaced as `mcp-lazy://<alias>/<original-uri>`. Resource links returned by tools are rewritten as well.

Experimental capability metadata is aggregated, but arbitrary experimental RPC methods are not automatically proxied. Host-specific extensions need end-to-end testing.

## Known limits

- Task-augmented calls are unsupported. Task-only tools are rejected.
- Dynamic prompt and resource list-change handling is incomplete.
- The gateway does not aggregate `resources.subscribe` into its client-facing capability declaration. Subscription RPC paths have mock coverage, but clients requiring the capability flag may not enable subscriptions.
- The gateway enforces a 16 MiB limit per JSON line.
- Idle policies do not inspect background jobs, external applications, or state durability.
- Fatal request failures may stop the backend. Requests are not automatically replayed.
- Force-killed gateways and detached descendants are outside normal owned-tree cleanup guarantees. Windows is the tested platform.
- The gateway does not import old client-side tool restrictions or approval settings.

## Source map

| Symbol | Responsibility |
| --- | --- |
| `loadConfig` | Validate configuration, resolve paths, compute launch hashes, and group environment names. |
| `readCatalog` | Validate cached metadata or provide a deferred connect tool. |
| `Client` | Own a stdio child, negotiate initialization, track RPCs, and discover backend metadata. |
| `snapshot` | Save successfully discovered metadata through temporary-file replacement. |
| `Backend` | Manage lazy startup, request queue, live catalog, session reuse, and idle shutdown. |
| `serve` | Route client requests, namespace metadata, relay supported callbacks, and shut down backends. |

See [the main README](../README.md) for installation, verification, and troubleshooting.
