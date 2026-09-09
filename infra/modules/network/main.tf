// vnet
resource "azurerm_virtual_network" "main" {
    name                = "paybridge-${var.environment}-vnet"
    address_space       = ["10.0.0.0/16"]
    location            = var.location
    resource_group_name = var.resource_group_name
  }

  //subnet app
  resource "azurerm_subnet" "app" {
    name                 = "snet-app"
    resource_group_name  = var.resource_group_name
    virtual_network_name = azurerm_virtual_network.main.name
    address_prefixes     = ["10.0.0.0/23"]
  }

  // subnet data
  resource "azurerm_subnet" "data" {
    name                 = "snet-data"
    resource_group_name  = var.resource_group_name
    virtual_network_name = azurerm_virtual_network.main.name
    address_prefixes     = ["10.0.2.0/24"]
  }

  // nsg app
  resource "azurerm_network_security_group" "app" {
    name                = "paybridge-${var.environment}-nsg-app"
    location            = var.location
    resource_group_name = var.resource_group_name
  }

  // nsg data
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

  // nsg association app
  resource "azurerm_subnet_network_security_group_association" "app" {
    subnet_id                 = azurerm_subnet.app.id
    network_security_group_id = azurerm_network_security_group.app.id
  } 

  // nsg associate data
  resource "azurerm_subnet_network_security_group_association" "data" {
    subnet_id                 = azurerm_subnet.data.id
    network_security_group_id = azurerm_network_security_group.data.id
  }
