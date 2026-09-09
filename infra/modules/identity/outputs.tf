 output "principal_id" { value = azurerm_user_assigned_identity.runtime.principal_id }
  output "client_id"    { value = azurerm_user_assigned_identity.runtime.client_id }
  output "identity_id"  { value = azurerm_user_assigned_identity.runtime.id }