# Phase 0 — Prerequisites & tooling

Source: `phases.md` → Phase 0. Goal: every tool the rest of the project depends on is installed, on PATH, and authenticated where relevant. No code, no cloud resources yet.

## Steps

1. **Node.js + npm**
   ```
   brew install node
   ```
   Node's installer bundles npm — no separate install needed.

2. **Docker** (Docker Desktop, since this is macOS)
   ```
   brew install --cask docker
   ```
   Then launch Docker Desktop once from Applications so the daemon is running (CLI commands fail silently otherwise).

3. **Azure CLI**
   ```
   brew install azure-cli
   ```

4. **Terraform CLI**
   ```
   brew tap hashicorp/tap
   brew install hashicorp/tap/terraform
   ```
   (Use the HashiCorp tap, not the plain `brew install terraform`, which is deprecated/unpinned.)

5. **Stripe CLI**
   ```
   brew install stripe/stripe-cli/stripe
   ```

6. **git**
   ```
   brew install git
   ```
   (macOS often already has a system git via Xcode Command Line Tools — either is fine as long as `git --version` works.)

7. **Azure login**
   ```
   az login
   ```
   Opens a browser to authenticate. Confirm it lands on the correct subscription:
   ```
   az account show
   ```
   If it's the wrong subscription (e.g. multiple tenants), run `az account set --subscription "<name-or-id>"`.

## Verification (run all of these — every one must succeed)

```
node -v
npm -v
docker ps
az account show
terraform version
stripe --version
git --version
```

- `docker ps` must return an empty table (not a "cannot connect to the Docker daemon" error) — this confirms Docker Desktop is actually running, not just installed.
- `az account show` must print subscription details, not an authentication error.

## Definition of Done (from `phases.md`)

> `node -v`, `docker ps`, `az account show`, `terraform version`, `stripe --version` all succeed.

Cross-checked: the verification block above covers exactly this set (plus `npm -v` and `git --version`, which are implied by "install Node.js/npm... and git" in the phase but not explicitly re-listed in the original one-line Done criterion — harmless additions, not scope drift). Phase 0 is complete once all seven commands run clean on your machine.
