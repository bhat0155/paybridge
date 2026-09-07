terraform {
  backend "azurerm" {
    resource_group_name  = "paybridge-dev-rg"
    storage_account_name = "paybridgetfstatedev"
    container_name       = "tfstate"
    key                  = "dev.terraform.tfstate"
  }
}
