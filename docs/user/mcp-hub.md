# Use T3 Code as an MCP hub

Connect an outside agent to your environment to read projects and threads or run
work through T3 Code. Give each agent its own sign-in or token so you can choose
its access and revoke it separately.

## Choose the URL

The MCP URL is the environment's address followed by `/mcp`. **Settings →
Environments → Copy MCP URL** copies the route your current device uses; choose
a route the agent can reach:

- **On the environment's host:** `http://127.0.0.1:3773/mcp`, using the
  environment's configured port if different.
- **On your LAN:** the host's LAN address and port. Use HTTPS before sending a
  token from another computer.
- **On your tailnet:** [Tailscale HTTPS](remote-access.md#tailscale-https),
  provided by `tailscale serve`, at `https://<environment-address>/mcp`.
- **In the cloud:** the environment's [T3 Connect](remote-access.md#t3-connect)
  HTTPS address. A cloud agent outside your tailnet cannot reach a tailnet-only
  address.

Tokens are credentials. Use HTTPS off-host and keep tokens out of chat, source
control, command arguments, and shared configuration.

## Agents with OAuth

Follow [Outside agents](outside-agents.md) to connect Claude Code, Codex,
ChatGPT, or another OAuth-capable MCP client and approve its access.

For Hermes Agent, add this to its configuration:

```yaml
mcp_servers:
  t3:
    url: https://<environment-address>/mcp
    auth: oauth
```

Then run `hermes mcp login t3` and approve the sign-in.

## Agents that accept a URL and header

On the environment's host, issue a token with a name and an explicit access level:

```sh
t3 mcp token --name "Desktop bot" --access supervised
```

The command prints the token once to standard output. It prints the session id
and revocation instructions to standard error. Use `--json` for JSON output.
It works whether or not the server is running. If the environment uses a custom
data directory, pass the same `--base-dir` or `T3CODE_HOME` used by the server.

Put the token in the agent's private MCP configuration as an
`Authorization: Bearer <token>` header. For clients using `mcpServers`:

```json
{
  "mcpServers": {
    "t3": {
      "type": "http",
      "url": "https://<environment-address>/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

## Stdio-only agents

Have the client launch `t3 mcp stdio` with the issued token in its
`T3_MCP_TOKEN` environment variable, without a `Bearer` prefix. This bridges
stdio to the running environment's HTTP MCP server:

```json
{
  "mcpServers": {
    "t3": {
      "command": "t3",
      "args": ["mcp", "stdio", "--url", "https://<environment-address>/mcp"],
      "env": {
        "T3_MCP_TOKEN": "<token>"
      }
    }
  }
}
```

`--url` must use HTTPS unless it points at `127.0.0.1`, `localhost`, or `[::1]`.

Omit `--url` when the client runs on the environment's host. The bridge then
connects to the address and port the running server recorded for itself, and
refuses to start when that server is no longer running. Use the
same data-directory setting as the server. The bridge prints
only MCP messages to standard output; it never accepts a token as an argument.

## Choose access and revoke it

| `--access` | What the agent may do |
| --- | --- |
| `read-only` | Read projects, threads, providers, and models; make no changes. |
| `supervised` or `approval-required` | Start and steer threads that ask for command and edit approval. |
| `auto-accept-edits` | Allow automatic file edits; other actions can still require approval. |
| `auto` | Use the provider's automatic review where supported. |
| `full-access` | Allow commands and edits without approval prompts. |

These are the same access levels as OAuth approval. A writable grant is a ceiling:
an agent cannot start or steer a thread above it. Provider-specific behavior is
described in [Permission modes](permission-modes.md).

Tokens expire after **30 days** by default. Set a different lifetime with
`--ttl`, for example `--ttl 7d`, up to `365d`. Issue a new token when one expires.

Each token appears as a named client under **Settings → Sharing & access**; an
open page shows it after a refresh.
Revoke it there to cut off its access, or run `t3 auth session revoke <session-id>`
on the host using the same data-directory setting. OAuth-approved agents appear
in the same list.

Outside agents can read and manage threads within their access level, but cannot
use preview or device tools, or `delegate_task`. To start work, send follow-ups,
and wait for results, use `t3_thread_launch`, `t3_thread_send`, and
`t3_thread_wait`.
