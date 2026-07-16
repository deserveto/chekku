# Docker Compose Prerequisites Design

## Goal

Help Windows and Ubuntu contributors install Docker Compose before running Chekku's Garage-backed local development launcher.

## README Changes

Expand `README.md`'s existing Prerequisites section with:

- Docker Compose as a required local-development dependency;
- Windows commands to install WSL 2 and Docker Desktop;
- a restart reminder after `wsl --install`;
- an Ubuntu command to install the Compose plugin when Docker Engine is already installed;
- `docker compose version` as the verification command for both platforms.

Keep installation guidance next to other prerequisites so contributors discover it before `npm ci` and `npm run dev:sh`. Do not duplicate Garage runtime or troubleshooting details already documented in `docs/OPERATIONS.md`.

## Constraints

- Use official package identifiers: `Docker.DockerDesktop` for WinGet and `docker-compose-plugin` for Ubuntu installations configured with Docker's package repository.
- State that WSL 2 applies to Windows; Ubuntu does not require WSL.
- Avoid claiming that the Ubuntu Compose plugin installs Docker Engine itself.
- Keep existing quick-start commands and runtime architecture unchanged.

## Verification

- Confirm Markdown commands are copyable and platform labels are explicit.
- Confirm README still directs local development through `npm run dev:sh`.
- Run `git diff --check`.
