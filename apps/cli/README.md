# Ensemble CLI

`ensemble` is the command-line companion for Ensemble. It can connect editors to Ensemble over MCP and, when installed with the packaged sidecar, run tasks assigned to this computer.

## Install

Install from [ensemblework.com/download](https://ensemblework.com/download): Homebrew (`brew install ensemblework/tap/ensemble`), Scoop, the install scripts (`curl -fsSL https://ensemblework.com/install.sh | sh`, `irm https://ensemblework.com/install.ps1 | iex`), or the `.deb`/`.rpm` packages. winget and npm (`ensemblework`) are coming. The npm package covers login and MCP; runner commands need the full CLI with the bundled sidecar.

## Commands

```bash
ensemble login [--api URL] [--name NAME] [--mcp-only] [--no-browser]
ensemble logout
ensemble status [--json]
ensemble mcp
ensemble mcp setup [editor...] [--all] [--print] [--hosted]
ensemble mcp remove <editor>
ensemble mcp editors
ensemble runner [start] [--foreground] | stop | restart | status | logs [-f] | install | uninstall
ensemble folders [list] | add <path> [--label L] [--read-only] | remove <label>
ensemble keys [list] | set <provider> | remove <provider>
ensemble doctor
ensemble update
ensemble version
```

`ensemble mcp` speaks stdio JSON-RPC; editors should not expect ordinary stdout logging from that command.

## License

[FSL-1.1-MIT](LICENSE.md): free to use, including at work, except to offer a competing product or service. Each release becomes MIT two years after publication.
