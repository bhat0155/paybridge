# Phase 5 — Core cloud infrastructure (Terraform, applied manually for now)

Source: `phases.md` → Phase 5. Goal: every piece of infrastructure that does **not** need to sit inside a VNet exists in Azure, created entirely by Terraform — network skeleton, container registry, Key Vault, Service Bus (the actual bifurcation), observability, and the runtime identity. Applied from your machine with your own `az login`; CI/CD doesn't take over Terraform applies until Phase 9. SQL, private endpoints, and the Container Apps Environment are deliberately excluded — that's Phase 6, because they depend on the VNet this phase creates.

## Steps

### 1. Broaden `.gitignore`, then relocate `backend.tf`/`providers.tf` into `infra/envs/dev/`

**Why relocate:** Phase 4 put `backend.tf`/`providers.tf` directly in `infra/` — that was only ever meant to prove the remote backend worked at all. `phases.md`'s actual structure wants a separate root module per environment (`infra/envs/dev`, later `infra/envs/prod`, each with its own state key). Terraform's backend and provider config has to live in the exact directory you run `init`/`plan`/`apply` from — it isn't inherited from a parent folder — so they move now, before any real resources exist to complicate the move.

```
mkdir -p infra/envs/dev
git mv infra/backend.tf infra/envs/dev/backend.tf
git mv infra/providers.tf infra/envs/dev/providers.tf
```
The contents of both files stay identical — same storage account, same container, same `dev.terraform.tfstate` key. Only the location changes.

**Why broaden `.gitignore` before running `terraform init` again:** the current line is `infra/.terraform/`, which only covers the exact path from Phase 4. Running `terraform init` in the new `infra/envs/dev/` directory creates a *new* `.terraform/` cache there — and Phase 4 already proved what happens if a Terraform provider binary cache isn't ignored (a 260MB file GitHub rejected). Fix the pattern so it can't happen again in any nested Terraform directory:

```diff
- infra/.terraform/
+ infra/**/.terraform/
```

Then re-initialize in the new location, purely to prove the move didn't break anything (nothing has been applied yet, so there's no state to lose):
```
cd infra/envs/dev
terraform init
```
**What you should see:** the same "Terraform has been successfully initialized!" message as Phase 4 — it's reading the identical remote state blob, just from a new working directory.

### 2. Import the Phase 4 resource group into Terraform state

**Why:** this closes the one deliberate exception Phase 4 opened. `paybridge-dev-rg` was created by hand only because Terraform needed somewhere to point its backend at before it existed — there's no reason to keep managing it by hand forever. Importing it here means every resource in this project, from this point on, genuinely flows through Terraform, per `CLAUDE.md`'s "no click-ops" guardrail — including the resource group itself.

`infra/envs/dev/main.tf` (just the resource group for now — modules come next):
```hcl
resource "azurerm_resource_group" "main" {
  name     = "paybridge-dev-rg"
  location = "canadacentral"
}
```

```
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
terraform import azurerm_resource_group.main /subscriptions/$SUBSCRIPTION_ID/resourceGroups/paybridge-dev-rg
terraform plan
```
**What you should see:** `terraform plan` reports **no changes** for `azurerm_resource_group.main`. If it wants to change or recreate it, the resource block doesn't exactly match live reality (the most common mismatch: `location` — Azure normalizes it to `canadacentral`, no capitals, no space, which is why the block above is written that way).

### 3. `infra/modules/network` — VNet, subnets, NSGs

**Why this shape:** two subnets, tiers separated per `CLAUDE.md`'s "subnets per tier; NSGs restrict traffic" guardrail — `snet-app` will eventually hold the Container Apps Environment (Phase 6), `snet-data` will eventually hold the SQL private endpoint (Phase 6). Sizing `snet-app` as a `/23` now (rather than something smaller) is deliberate: Azure Container Apps VNet integration has real minimum-size requirements, and getting boxed into a too-small subnet is exactly the kind of thing that's cheap to avoid now and annoying to fix in Phase 6.

**Why the NSG rule needs an explicit deny, not just an allow:** Azure NSGs ship a default rule (`AllowVnetInBound`, priority 65000) that lets all intra-VNet traffic through. Adding *only* an "allow 1433 from app subnet" rule wouldn't restrict anything — the default rule would still let every other port through too. `phases.md`'s "allowed on 1433 only, deny otherwise" requires an explicit deny rule at a lower priority number (evaluated first) than the default.

`infra/modules/network/main.tf`:
```hcl
resource "azurerm_virtual_network" "main" {
  name                = "paybridge-${var.environment}-vnet"
  address_space       = ["10.0.0.0/16"]
  location            = var.location
  resource_group_name = var.resource_group_name
}

resource "azurerm_subnet" "app" {
  name                 = "snet-app"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.0.0.0/23"]
}

resource "azurerm_subnet" "data" {
  name                 = "snet-data"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.0.2.0/24"]
}

resource "azurerm_network_security_group" "app" {
  name                = "paybridge-${var.environment}-nsg-app"
  location            = var.location
  resource_group_name = var.resource_group_name
}

resource "azurerm_network_security_group" "data" {
  name                = "paybridge-${var.environment}-nsg-data"
  location            = var.location
  resource_group_name = var.resource_group_name

  security_rule {
    name                       = "AllowAppSubnetSql"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "1433"
    source_address_prefix      = azurerm_subnet.app.address_prefixes[0]
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "DenyOtherVnetInbound"
    priority                   = 200
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "app" {
  subnet_id                 = azurerm_subnet.app.id
  network_security_group_id = azurerm_network_security_group.app.id
}

resource "azurerm_subnet_network_security_group_association" "data" {
  subnet_id                 = azurerm_subnet.data.id
  network_security_group_id = azurerm_network_security_group.data.id
}
```
`nsg-app` is created with no rules of its own for now — a placeholder that gives the app subnet the same defense-in-depth posture, ready for egress rules later if needed. All the actual restriction lives on `nsg-data`, since that's the tier being protected.

`infra/modules/network/variables.tf` — this same three-variable shape (`environment`, `location`, `resource_group_name`) repeats verbatim in every module below, so it's shown once here and not repeated per-module:
```hcl
variable "environment" {
  type = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}
```

`infra/modules/network/outputs.tf`:
```hcl
output "vnet_id"        { value = azurerm_virtual_network.main.id }
output "app_subnet_id"  { value = azurerm_subnet.app.id }
output "data_subnet_id" { value = azurerm_subnet.data.id }
```

### 4. `infra/modules/acr` — Azure Container Registry

**Why `admin_enabled = false`:** the admin account is a shared username/password baked into the registry itself — exactly the kind of standing credential `CLAUDE.md`'s "no secrets in code, no stored passwords" guardrail exists to avoid. Access will come from the runtime identity's `AcrPull` role assignment in Phase 7, not a password. **Basic** SKU is the dev-appropriate choice — this is a single-image-per-service dev registry, not a geo-replicated production one.

`infra/modules/acr/main.tf`:
```hcl
resource "azurerm_container_registry" "main" {
  name                = "paybridge${var.environment}acr"
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = "Basic"
  admin_enabled       = false
}
```
(`variables.tf` — same three-variable block as Step 3.)

`infra/modules/acr/outputs.tf`:
```hcl
output "login_server" { value = azurerm_container_registry.main.login_server }
output "acr_id"        { value = azurerm_container_registry.main.id }
```

### 5. `infra/modules/keyvault` — Key Vault (RBAC mode)

**Why `enable_rbac_authorization = true`, not the older access-policy model:** Phase 7 grants the runtime identity `Key Vault Secrets User` — a standard Azure RBAC role. RBAC-mode Key Vault means that role assignment is the *only* thing needed; access-policy mode is a separate, parallel permission system that `CLAUDE.md`'s least-privilege guardrail would otherwise force you to reason about twice.

**Why `purge_protection_enabled = false` here specifically:** this is a genuine dev-only trade-off, not an oversight — with purge protection on, a deleted Key Vault (and its name) is unusable for 90 days, which would make tearing down and rebuilding this dev environment painful. Production would flip this to `true`.

`infra/modules/keyvault/main.tf`:
```hcl
data "azurerm_client_config" "current" {}

resource "azurerm_key_vault" "main" {
  name                       = "paybridge-${var.environment}-kv"
  location                   = var.location
  resource_group_name        = var.resource_group_name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  enable_rbac_authorization  = true
  purge_protection_enabled   = false
}
```

`infra/modules/keyvault/outputs.tf`:
```hcl
output "key_vault_id"  { value = azurerm_key_vault.main.id }
output "key_vault_uri" { value = azurerm_key_vault.main.vault_uri }
```

### 6. `infra/modules/servicebus` — the actual bifurcation

**Why `Standard` SKU, not `Basic`:** `Basic` only supports queues — topics and subscriptions (the entire mechanism this architecture depends on) require `Standard` or higher. This isn't a dev-cost-cutting knob; it's the minimum tier that has the feature at all.

**The gotcha worth understanding before writing this — the `$Default` rule:** creating an `azurerm_servicebus_subscription` auto-provisions a default rule named `$Default` with a `TrueFilter` — meaning it matches *everything*, with no filter applied. Adding a separate, differently-named filter rule on top doesn't replace that default — Service Bus delivers a message to a subscription if it matches **any** rule, so the subscription would still receive every message via `$Default`, silently defeating the entire bifurcation. The fix: name the filter rule `$Default` itself, so Terraform overwrites the auto-created rule rather than adding a second one alongside it.

`infra/modules/servicebus/main.tf`:
```hcl
resource "azurerm_servicebus_namespace" "main" {
  name                = "paybridge-${var.environment}-sb"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "Standard"
}

resource "azurerm_servicebus_topic" "payments" {
  name         = "payments"
  namespace_id = azurerm_servicebus_namespace.main.id
}

resource "azurerm_servicebus_subscription" "stripe" {
  name               = "stripe"
  topic_id           = azurerm_servicebus_topic.payments.id
  max_delivery_count = 10
}

resource "azurerm_servicebus_subscription_rule" "stripe_filter" {
  name            = "$Default"
  subscription_id = azurerm_servicebus_subscription.stripe.id
  filter_type     = "SqlFilter"
  sql_filter      = "source = 'stripe'"
}

resource "azurerm_servicebus_subscription" "quickbooks" {
  name               = "quickbooks"
  topic_id           = azurerm_servicebus_topic.payments.id
  max_delivery_count = 10
}

resource "azurerm_servicebus_subscription_rule" "quickbooks_filter" {
  name            = "$Default"
  subscription_id = azurerm_servicebus_subscription.quickbooks.id
  filter_type     = "SqlFilter"
  sql_filter      = "source = 'qb'"
}
```
`max_delivery_count = 10` matters for the dead-letter behavior `CLAUDE.md` requires ("failed messages go to a dead-letter queue AND raise an alert") — after 10 failed delivery attempts, Service Bus automatically dead-letters a message rather than retrying forever. The alert on that dead-letter count is Phase 10; this just ensures the mechanism exists.

`infra/modules/servicebus/outputs.tf`:
```hcl
output "namespace_name" { value = azurerm_servicebus_namespace.main.name }
output "namespace_id"   { value = azurerm_servicebus_namespace.main.id }
```

### 7. `infra/modules/monitoring` — Log Analytics + Application Insights

**Why workspace-based App Insights, not the older "classic" standalone mode:** classic Application Insights is deprecated and being phased out by Microsoft; workspace-based is the current model and also what `CLAUDE.md`'s stack table describes ("Log Analytics workspace, KQL"). Tying App Insights to a Log Analytics workspace means traces, logs, and metrics all end up queryable from the one place.

`infra/modules/monitoring/main.tf`:
```hcl
resource "azurerm_log_analytics_workspace" "main" {
  name                = "paybridge-${var.environment}-law"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_application_insights" "main" {
  name                = "paybridge-${var.environment}-appi"
  location            = var.location
  resource_group_name = var.resource_group_name
  workspace_id        = azurerm_log_analytics_workspace.main.id
  application_type    = "web"
}
```
`PerGB2018` is the standard pay-as-you-go pricing tier — appropriate given this is low-volume dev telemetry, not a commitment tier. `application_type = "web"` is Microsoft's current general-purpose recommendation regardless of runtime language; the older per-language values (`Node.JS`, `java`, etc.) are legacy.

`infra/modules/monitoring/outputs.tf`:
```hcl
output "log_analytics_workspace_id" { value = azurerm_log_analytics_workspace.main.id }
output "app_insights_connection_string" {
  value     = azurerm_application_insights.main.connection_string
  sensitive = true
}
```

### 8. `infra/modules/identity` — the runtime identity

**Why this identity, and why it's empty for now:** this is the **runtime identity** from `phases.md`'s intro — a completely different identity than Phase 4's deploy identity. The deploy identity is what GitHub Actions uses to run Terraform; this is what the *application itself* will authenticate as via `DefaultAzureCredential` once it's running (Phase 8). Creating it now with zero role assignments is deliberate — Phase 7's whole job is turning "exists" into "usable" by attaching exactly the roles it needs (`Key Vault Secrets User`, `AcrPull`, Service Bus data roles), and not before.

`infra/modules/identity/main.tf`:
```hcl
resource "azurerm_user_assigned_identity" "runtime" {
  name                = "paybridge-${var.environment}-runtime-identity"
  location            = var.location
  resource_group_name = var.resource_group_name
}
```

`infra/modules/identity/outputs.tf`:
```hcl
output "principal_id" { value = azurerm_user_assigned_identity.runtime.principal_id }
output "client_id"    { value = azurerm_user_assigned_identity.runtime.client_id }
output "identity_id"  { value = azurerm_user_assigned_identity.runtime.id }
```

### 9. Wire everything together in `infra/envs/dev/main.tf`

Append the module calls to the file from Step 2 (which already has the imported `azurerm_resource_group.main`):
```hcl
module "network" {
  source              = "../../modules/network"
  environment         = var.environment
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}

module "acr" {
  source              = "../../modules/acr"
  environment         = var.environment
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}

module "keyvault" {
  source              = "../../modules/keyvault"
  environment         = var.environment
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}

module "servicebus" {
  source              = "../../modules/servicebus"
  environment         = var.environment
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}

module "monitoring" {
  source              = "../../modules/monitoring"
  environment         = var.environment
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}

module "identity" {
  source              = "../../modules/identity"
  environment         = var.environment
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}
```
`azurerm_resource_group.main.location` (not a separate variable) is passed to every module — the resource group is the single source of truth for region, which is what actually enforces "pinned to Canada Central on every resource" rather than relying on six modules each remembering to hardcode it correctly.

`infra/envs/dev/variables.tf`:
```hcl
variable "environment" {
  description = "Environment name, used to prefix/suffix every resource name in this root module"
  type        = string
  default     = "dev"
}
```

`infra/envs/dev/outputs.tf` — surfaces what Phase 6/7/8 will actually need next:
```hcl
output "app_subnet_id"                  { value = module.network.app_subnet_id }
output "data_subnet_id"                 { value = module.network.data_subnet_id }
output "acr_login_server"               { value = module.acr.login_server }
output "key_vault_uri"                  { value = module.keyvault.key_vault_uri }
output "servicebus_namespace_name"      { value = module.servicebus.namespace_name }
output "runtime_identity_principal_id"  { value = module.identity.principal_id }
output "runtime_identity_client_id"     { value = module.identity.client_id }
```

### 10. Plan, then apply

```
terraform plan
```
Read the plan output carefully — it should show only **new** resources being added (VNet, subnets, NSGs, ACR, Key Vault, Service Bus namespace/topic/subscriptions/rules, Log Analytics, App Insights, the identity) and **no changes** to `azurerm_resource_group.main`, confirming Step 2's import is still solid.

```
terraform apply
```
Type `yes` when prompted. This is a real, billable (though small — no compute, no SQL yet) change to your Azure subscription.

## Hands-on scenarios — replicate these yourself

### Scenario 1 — The resource group is genuinely Terraform-managed now

```
terraform state list | grep azurerm_resource_group
```
**What you should see:** `azurerm_resource_group.main` listed — proof the Phase 4 manual resource is now inside Terraform's state, not just sitting in Azure unmanaged.

### Scenario 2 — VNet and subnets exist with the right shape, NSG actually restricts

```
az network vnet subnet list --resource-group paybridge-dev-rg --vnet-name paybridge-dev-vnet -o table
az network nsg rule list --resource-group paybridge-dev-rg --nsg-name paybridge-dev-nsg-data -o table
```
**What you should see:** `snet-app` (`10.0.0.0/23`) and `snet-data` (`10.0.2.0/24`); the NSG rule list shows `AllowAppSubnetSql` (priority 100, port 1433, allow) and `DenyOtherVnetInbound` (priority 200, deny) — in that priority order.

### Scenario 3 — ACR has no admin credentials

```
az acr show --name paybridgedevacr --query adminUserEnabled -o tsv
```
**What you should see:** `false`.

### Scenario 4 — Key Vault is RBAC-mode

```
az keyvault show --name paybridge-dev-kv --query properties.enableRbacAuthorization -o tsv
```
**What you should see:** `true`.

### Scenario 5 — The bifurcation is real: each subscription filters, not just the default

```
az servicebus topic subscription rule list \
  --resource-group paybridge-dev-rg \
  --namespace-name paybridge-dev-sb \
  --topic-name payments \
  --subscription-name stripe -o table

az servicebus topic subscription rule list \
  --resource-group paybridge-dev-rg \
  --namespace-name paybridge-dev-sb \
  --topic-name payments \
  --subscription-name quickbooks -o table
```
**What you should see:** each lists exactly one rule, named `$Default`, of filter type `SqlFilter` — `stripe`'s expression is `source = 'stripe'`, `quickbooks`'s is `source = 'qb'`. If either still showed `TrueFilter`, the override from Step 6 didn't take, and both subscriptions would silently receive every message. No actual message is published yet — that requires a producer, which is Phase 8 — this only proves the routing rule itself is correctly configured.

### Scenario 6 — App Insights is linked to the Log Analytics workspace

```
az monitor app-insights component show \
  --app paybridge-dev-appi \
  --resource-group paybridge-dev-rg \
  --query workspaceResourceId -o tsv
```
**What you should see:** the full resource ID of `paybridge-dev-law` — a non-empty value confirms it's workspace-based, not classic.

### Scenario 7 — The runtime identity exists, with no roles yet

```
az identity show --name paybridge-dev-runtime-identity --resource-group paybridge-dev-rg -o table
az role assignment list --assignee $(az identity show --name paybridge-dev-runtime-identity --resource-group paybridge-dev-rg --query principalId -o tsv) -o table
```
**What you should see:** the identity itself exists; the role assignment list is **empty**. That's correct for this phase — Phase 7 is where it earns permissions.

### Scenario 8 — Everything, in one view (the literal Definition of Done)

```
az resource list --resource-group paybridge-dev-rg -o table
```
**What you should see:** the resource group, the Phase 4 storage account, the VNet (with its subnets nested, not listed separately here), both NSGs, the ACR, the Key Vault, the Service Bus namespace, the Log Analytics workspace, the Application Insights component, and the user-assigned identity — roughly 9-10 top-level resources.

## Definition of Done (from `phases.md`)

> Every resource above exists and is visible via `az resource list` — no application connectivity is expected or tested yet.

Cross-checked: Steps 2 through 9 create every resource `phases.md`'s Phase 5 bullet lists (network/subnets/NSGs, ACR, Key Vault, Service Bus topic + 2 filtered subscriptions, Log Analytics + App Insights, runtime identity). Scenario 8 satisfies "visible via `az resource list`" directly. Scenario 5 deliberately stops at confirming the filter *rule* exists correctly — it does not publish or consume an actual message, matching "no application connectivity is expected or tested yet" precisely. Scope deliberately excludes: Azure SQL, the private endpoint, the private DNS zone, and the Container Apps Environment (all Phase 6, since they depend on the VNet this phase only just created); any role assignment on the runtime identity beyond its own existence (Phase 7); any real payment flowing anywhere (Phase 8).
