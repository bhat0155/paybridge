resource "azurerm_servicebus_namespace" "main" {
    name                = "paybridge-${var.environment}-svcbus"
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