# Docker Compose Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add copyable Windows and Ubuntu Docker Compose installation guidance to README prerequisites.

**Architecture:** Keep platform setup in the existing README Prerequisites section so contributors see it before Quick start. Add documentation only; do not change launch scripts, dependencies, runtime configuration, or Garage behavior.

**Tech Stack:** GitHub-flavored Markdown, PowerShell, WinGet, WSL 2, Docker Desktop, Ubuntu APT.

## Global Constraints

- Cover Windows and Ubuntu only.
- Use `Docker.DockerDesktop` as the WinGet package identifier.
- Use `docker-compose-plugin` for Ubuntu systems already configured with Docker's package repository and Docker Engine.
- State that Windows must restart after `wsl --install`.
- State that Ubuntu does not require WSL.
- Verify both platforms with `docker compose version`.
- Keep existing `npm run dev:sh` quick-start guidance unchanged.

---

### Task 1: Document Docker Compose Installation

**Files:**
- Modify: `README.md:72-81`
- Reference: `docs/superpowers/specs/2026-07-16-docker-compose-prerequisites-design.md`

**Interfaces:**
- Consumes: Existing README Prerequisites and Quick start sections.
- Produces: Copyable Windows and Ubuntu prerequisite commands for contributors.

- [ ] **Step 1: Confirm installation guidance is absent**

Run:

```bash
git grep -n "wsl --install" -- README.md
```

Expected: no output and exit status 1.

- [ ] **Step 2: Add platform-specific prerequisite guidance**

Add `Docker Compose` to the prerequisite list, then insert this content after the existing `.nvmrc` note and before `## Quick start`:

````markdown
### Install Docker Compose

Chekku's local launcher uses Docker Compose to run Garage object storage.

**Windows 10/11**

Run PowerShell as Administrator:

```powershell
wsl --install
```

Restart Windows after WSL installation, then install and start Docker Desktop:

```powershell
winget install --exact --id Docker.DockerDesktop
```

Verify Docker Compose is available:

```powershell
docker compose version
```

Docker Desktop uses the WSL 2 backend by default. Ubuntu hosts do not need WSL.

**Ubuntu with Docker Engine installed**

If Docker Engine was installed from Docker's official APT repository, install the Compose plugin:

```bash
sudo apt-get update && sudo apt-get install -y docker-compose-plugin
docker compose version
```

If Docker Engine is not installed, follow Docker's official Ubuntu installation guide first.
````

- [ ] **Step 3: Verify required commands and unchanged launcher guidance**

Run:

```bash
git grep -n -e "wsl --install" -e "Docker.DockerDesktop" -e "docker-compose-plugin" -e "docker compose version" -e "npm run dev:sh" -- README.md
```

Expected: all five patterns appear. `docker compose version` appears in both Windows and Ubuntu instructions, and existing `npm run dev:sh` Quick start remains present.

- [ ] **Step 4: Check Markdown diff and whitespace**

Run:

```bash
git diff -- README.md
git diff --check
```

Expected: only README prerequisite documentation changes; no whitespace errors.

- [ ] **Step 5: Commit README guidance**

```bash
git add README.md
git commit -m "docs: add Docker Compose setup"
```
