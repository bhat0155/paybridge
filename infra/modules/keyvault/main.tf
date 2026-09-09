data "azurerm_client_config" "current" {}
  
  resource "azurerm_key_vault" "main" {
    name                       = "paybridge-ekb-${var.environment}-kv"
    location                   = var.location
    resource_group_name        = var.resource_group_name
    tenant_id                  = data.azurerm_client_config.current.tenant_id
    sku_name                   = "standard"
    enable_rbac_authorization  = true
    purge_protection_enabled   = false
  }