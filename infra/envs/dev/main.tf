resource "azurerm_resource_group" "main" {
    name     = "paybridge-dev-rg"
    location = "canadacentral"
  }

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