 output "app_subnet_id"                  { value = module.network.app_subnet_id }
  output "data_subnet_id"                 { value = module.network.data_subnet_id }
  output "acr_login_server"               { value = module.acr.login_server }
  output "key_vault_uri"                  { value = module.keyvault.key_vault_uri }
  output "servicebus_namespace_name"      { value = module.servicebus.namespace_name }
  output "runtime_identity_principal_id"  { value = module.identity.principal_id }
  output "runtime_identity_client_id"     { value = module.identity.client_id }
