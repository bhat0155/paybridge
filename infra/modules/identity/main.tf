resource "azurerm_user_assigned_identity" "runtime" {
    name                = "paybridge-${var.environment}-runtime-identity"
    location            = var.location
    resource_group_name = var.resource_group_name
  }