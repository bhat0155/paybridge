# Phase 4 — Cloud bootstrap (one-time, manual)

Source: `phases.md` → Phase 4. Goal: create the small, irreducible set of Azure things that must exist *before* Terraform or GitHub Actions can do anything themselves — because both need something to authenticate as, and that something doesn't exist yet. This is the one deliberate, permanent exception to "everything through Terraform" (per `CLAUDE.md`'s "no click-ops" guardrail) — not a shortcut being taken lazily, but the one true chicken-and-egg step in the whole project.

This is also the first phase that touches **real Azure**, not local Docker. Everything created here is low/near-zero cost (a resource group, a small storage account, an app registration — no compute), but it is real, persistent cloud state for the first time.

## Steps

### 1. Confirm Azure CLI context

**Why first:** every command after this assumes you're logged into the right subscription — get this wrong and everything below lands in the wrong place.
```
az login
az account show
```
If it shows the wrong subscription (multiple tenants/subscriptions on your account):
```
az account set --subscription "<subscription-name-or-id>"
```
Capture two values you'll need repeatedly below:
```
az account show --query id -o tsv        # SUBSCRIPTION_ID
az account show --query tenantId -o tsv  # TENANT_ID
```

### 2. Resource group

**Why:** the resource group is the container every other Azure resource in this project lives inside — pinned to Canada Central per `CLAUDE.md`'s data-residency requirement, on every resource, starting here.
```
az group create --name paybridge-dev-rg --location canadacentral
```

### 3. Storage account + container for Terraform remote state

**Why remote state at all:** Terraform's "state" is its own memory of what it already built — if that lived only on your laptop, it couldn't survive a laptop wipe, and it couldn't ever be shared with GitHub Actions later (Phase 9), which runs on a fresh machine every time. A storage account blob container is the standard place to keep it — durable, and reachable by both you and CI.

**Why this has to happen manually, not via Terraform:** Terraform needs to already know where its remote state lives *before* it runs — you can't use Terraform to create the very storage account that Terraform's own state will be stored in. Chicken, egg.

```
az storage account create \
  --name paybridgetfstatedev \
  --resource-group paybridge-dev-rg \
  --location canadacentral \
  --sku Standard_LRS \
  --kind StorageV2

az storage container create \
  --name tfstate \
  --account-name paybridgetfstatedev \
  --auth-mode login
```
**Note:** storage account names are globally unique across *all* of Azure, not just your subscription — if `paybridgetfstatedev` is taken, add a short random suffix (e.g. `paybridgetfstatedev7x2`) and use that name consistently in Step 5 below.

### 4. The deploy identity — Azure AD app registration + federated credential

**Why an app registration, not a real password:** this is the **deploy identity** referenced in `phases.md`'s intro — the identity GitHub Actions will use, in Phase 9, to run Terraform against Azure. Per `CLAUDE.md`'s guardrail, this must authenticate via short-lived OIDC tokens, never a stored secret. A **federated credential** is what makes that possible: it's a trust relationship — "Azure AD will trust a GitHub Actions run *specifically* from this repo, on this branch, no password required, no secret to ever leak."

```
az ad app create --display-name "paybridge-deploy-dev" --query appId -o tsv
# capture the output as APP_ID

az ad sp create --id <APP_ID>
```
The second command matters and is easy to miss: an App Registration alone can't be granted a role — it needs an associated **Service Principal** in the tenant, which is the thing role assignments actually attach to.

Now the federated credential itself — this is the actual trust relationship, scoped narrowly to pushes on `main` of this specific repo:
```
az ad app federated-credential create \
  --id <APP_ID> \
  --parameters '{
    "name": "paybridge-main-branch",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:bhat0155/paybridge:ref:refs/heads/main",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```
**Deliberately not doing yet:** a second federated credential scoped to `pull_request` events (a different `subject` format: `repo:bhat0155/paybridge:pull_request`). `phases.md`'s Phase 9 is where the PR-triggered `terraform plan` pipeline actually gets built — adding that credential now, before anything uses it, would be exactly the kind of premature setup the phase-ordering rule exists to prevent. Noted here so it isn't a surprise later.

### 5. Grant the deploy identity Contributor — scoped to the resource group only

**Why "scoped to the resource group," specifically:** least privilege, per `CLAUDE.md`. This identity's whole job is managing resources inside `paybridge-dev-rg` — it has no business being able to touch anything else in the subscription, and scoping the role assignment this narrowly means a compromised or misconfigured credential can't reach outside this one project.
```
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
az role assignment create \
  --assignee <APP_ID> \
  --role Contributor \
  --scope /subscriptions/$SUBSCRIPTION_ID/resourceGroups/paybridge-dev-rg
```

### 6. `infra/backend.tf` + a minimal provider config

**Why now, minimal, not the full Phase 5 setup:** Phase 5 is where the *real* infrastructure modules and `infra/envs/dev` get built. All Phase 4 needs is enough for `terraform init` to prove the remote backend actually works — nothing about actual Azure resources belongs here yet.

`infra/backend.tf`:
```hcl
terraform {
  backend "azurerm" {
    resource_group_name  = "paybridge-dev-rg"
    storage_account_name = "paybridgetfstatedev"
    container_name       = "tfstate"
    key                  = "dev.terraform.tfstate"
  }
}
```

`infra/providers.tf` — required so `terraform init` has an actual provider to resolve, not just a bare backend block:
```hcl
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.116"
    }
  }
}

provider "azurerm" {
  features {}
}
```

### 7. A throwaway GitHub Actions workflow to prove the whole chain

**Why "throwaway":** this is explicitly not the real CI/CD pipeline (that's Phase 9) — it exists purely to prove the federated credential from Step 4 actually works end-to-end, from GitHub's side. `workflow_dispatch` (a manual button in the GitHub UI) is used instead of triggering on every push, since this isn't meant to run repeatedly or clutter CI history.

`.github/workflows/verify-oidc.yml`:
```yaml
name: Verify OIDC bootstrap

on:
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
      - run: az resource list --resource-group paybridge-dev-rg -o table
```
`AZURE_CLIENT_ID` (the `APP_ID` from Step 4), `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` need to be added as GitHub **repository variables** (Settings → Secrets and variables → Actions → Variables tab) — **not** secrets. This is worth pausing on: with OIDC, none of these three values are actually sensitive — they're identifiers, not credentials. There is no password anywhere in this whole flow, which is the entire point.

After this workflow run succeeds once, delete the file — it did its one job (proving the bootstrap works) and isn't meant to become part of the permanent pipeline.

## Hands-on scenarios — replicate these yourself

### Scenario 1 — Resource group exists, in the right region

```
az group show --name paybridge-dev-rg --query location -o tsv
```
**What you should see:** `canadacentral`.

### Scenario 2 — Terraform can actually reach the remote backend

```
cd infra
terraform init
```
**What you should see:** `Terraform has been successfully initialized!`, and a note that it's using the `azurerm` backend. If this fails with an auth error, re-run `az login` — `terraform init` against an `azurerm` backend uses your current `az` CLI session by default.

### Scenario 3 — The deploy identity's federated credential is real

```
az ad app federated-credential list --id <APP_ID> -o table
```
**What you should see:** one entry, `paybridge-main-branch`, with the issuer and subject exactly as configured in Step 4.

### Scenario 4 — The role assignment is scoped correctly (not subscription-wide)

```
az role assignment list --assignee <APP_ID> -o table
```
**What you should see:** one `Contributor` assignment, with a `Scope` ending in `/resourceGroups/paybridge-dev-rg` — not just `/subscriptions/<id>`. If it shows the bare subscription as the scope, the `--scope` flag in Step 5 was wrong.

### Scenario 5 — The whole chain works from GitHub's side, no stored secret

In the GitHub repo: Actions tab → "Verify OIDC bootstrap" → Run workflow (manual trigger).
**What you should see:** the `azure/login` step succeeds, and the final step prints a table of resources in `paybridge-dev-rg` (likely just the storage account, at this point).
**What this proves:** GitHub Actions authenticated to Azure using a short-lived token exchanged at run-time — check the repo's secrets, and there is no Azure password or client secret stored anywhere. That's the actual point of this entire phase.

## Definition of Done (from `phases.md`)

> `terraform init` succeeds against the remote backend, and a throwaway GitHub Actions run using `azure/login` with this federated credential can successfully list resources in the resource group.

Cross-checked: Scenario 2 satisfies "`terraform init` succeeds against the remote backend." Scenario 5 satisfies "a throwaway GitHub Actions run... can successfully list resources in the resource group." Scope deliberately excludes: any real infrastructure module (VNet, SQL, Service Bus, etc. — all Phase 5+), the runtime managed identity (a *different* identity than this phase's deploy identity — see `phases.md`'s intro on the two-identity distinction, runtime identity arrives Phase 5), and the `pull_request`-scoped federated credential (deferred to Phase 9, when the PR pipeline that would actually use it gets built).
