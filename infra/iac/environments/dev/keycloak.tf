# Keycloak: the xitter-demo realm and its clients. Mirrors the logic in
# packages/scripts/src/keycloak.ts (which stays local/reset-only), so the
# local bootstrap and the deployed realm converge on the same contract.
# Demo users are NOT keycloak_user resources - the nightly reset/seeder
# owns wipe+reseed (docs/specs/operations/02-data-reset.md) and the deploy
# path guarantees they exist via the ensure-demo-users Job (reset.tf),
# which runs the same idempotent initDemoRealm.

locals {
  demo_realm = "xitter-demo"

  # Machine clients and the audiences their service-account tokens carry
  # (receivers validate aud = their own client id):
  #   - each API service may call any other API service (mirrors local
  #     SERVICE_CLIENTS), so svc-* tokens carry all five audiences;
  #   - workers carry only the audiences of the services they call;
  #   - svc-reset (nightly reset job) calls all of them.
  service_audiences = ["svc-social", "svc-posts", "svc-media", "svc-feed", "svc-search"]

  machine_clients = merge(
    { for c in local.service_audiences : c => local.service_audiences },
    {
      "svc-worker-fanout"        = ["svc-social", "svc-posts", "svc-feed"],
      "svc-worker-media-process" = ["svc-media"],
      "svc-worker-search-index"  = ["svc-search"],
      "svc-reset"                = local.service_audiences,
    },
  )

  # client_id => audience pairs for one mapper per (client, audience).
  client_audiences = merge(
    {
      for pair in flatten([
        for client, audiences in local.machine_clients : [
          for aud in audiences : { client = client, aud = aud }
        ]
      ]) : "${pair.client}__${pair.aud}" => pair
    },
    # Browser tokens (PKCE login on the `web` client) pass through the edge's
    # oidc-api audience check on every /api/{service} route, so the web client
    # must mint tokens carrying each service's audience too.
    {
      for aud in local.service_audiences : "web__${aud}" => { client = "web", aud = aud }
    },
  )
}

resource "keycloak_realm" "demo" {
  realm   = local.demo_realm
  enabled = true

  # Login defence (T14): the realm is globally reachable (edge geo-open),
  # so brute-force protection replaces the geo restriction as the login
  # defence. The provider enables bruteForceProtected by rendering this
  # brute_force_detection block (there is no top-level flag in 5.9);
  # temporary lockout only (permanent_lockout = false) is friendlier for a
  # demo - all other timings are Keycloak's own defaults, spelled out so
  # the posture is explicit: after 30 failures the account locks for 60s,
  # ramping to a 15m max, and the counter resets after 12h. The nightly
  # reset would clear permanent locks anyway. The quick-login check is
  # DISABLED (0): Keycloak 25.0.3+ treats any two login attempts for the
  # same user within the window as an attack signal and temporarily
  # disables the account even when both succeed - legitimate automated
  # bursts (the e2e suite's parallel demo logins, the seeder's password
  # grants) tripped it constantly. Failure-count lockouts and concurrent
  # request handling remain active; keycloak.ts must recreate exactly
  # this posture when the reset rebuilds the realm.
  security_defenses {
    brute_force_detection {
      permanent_lockout                = false
      max_login_failures               = 30
      wait_increment_seconds           = 60
      quick_login_check_milli_seconds  = 0
      minimum_quick_login_wait_seconds = 60
      max_failure_wait_seconds         = 900
      failure_reset_time_seconds       = 43200
    }
  }

  # Demo system: users cannot change their own credentials (mirrors keycloak.ts).
  edit_username_allowed    = false
  reset_password_allowed   = false
  registration_allowed     = false
  login_with_email_allowed = false

  access_token_lifespan    = "15m"
  sso_session_idle_timeout = "1h"
  sso_session_max_lifespan = "12h"
}

resource "keycloak_role" "demo_user" {
  realm_id = keycloak_realm.demo.id
  name     = "demo-user"

  description = "Demo users (demo1..demo10), guaranteed by the ensure-demo-users deploy job and reseeded nightly."
}

# Browser client for the web app (PKCE, public). direct grants stay enabled
# for the deterministic seeder only - same as local.
resource "keycloak_openid_client" "web" {
  realm_id  = keycloak_realm.demo.id
  client_id = "web"

  name    = "xitter web"
  enabled = true

  access_type = "PUBLIC"

  standard_flow_enabled        = true
  direct_access_grants_enabled = true

  valid_redirect_uris = ["https://${var.domain}/*"]
  web_origins         = ["https://${var.domain}"]
}

resource "random_password" "machine_client_secret" {
  for_each = local.machine_clients

  length  = 50
  numeric = true
  special = false
  upper   = true
}

# Confidential clients with service accounts (client-credentials grant) for
# machine-to-machine auth.
resource "keycloak_openid_client" "machine" {
  for_each = local.machine_clients

  realm_id  = keycloak_realm.demo.id
  client_id = each.key

  name    = "xitter ${each.key}"
  enabled = true

  access_type = "CONFIDENTIAL"

  service_accounts_enabled     = true
  standard_flow_enabled        = false
  direct_access_grants_enabled = false

  client_authenticator_type = "client-secret"
  client_secret             = random_password.machine_client_secret[each.key].result

  valid_redirect_uris = []
  web_origins         = []
}

# One audience mapper per (client, audience): tokens minted by the client
# carry the receiving service's client id in `aud`.
resource "keycloak_openid_audience_protocol_mapper" "audience" {
  for_each = local.client_audiences

  realm_id  = keycloak_realm.demo.id
  client_id = each.value.client == "web" ? keycloak_openid_client.web.id : keycloak_openid_client.machine[each.value.client].id

  name = "audience-${replace(each.key, "__", "-to-")}"

  included_client_audience = each.value.aud
  add_to_access_token      = true
  add_to_id_token          = false
}

# Client credentials materialised as Kubernetes Secrets, consumed by the
# workloads via secret_env (KEYCLOAK_CLIENT_SECRET). Key names equal the env
# var names so the Knative workers can inject them with envFrom.
# No depends_on on the Keycloak clients: both consume the same random_password
# value (the Keycloak client is created with this secret, not the other way
# round), so the Secrets apply even when the Keycloak API is unreachable -
# workloads then start with correct creds as soon as the realm converges.
resource "kubernetes_secret" "keycloak_client" {
  for_each = local.machine_clients

  metadata {
    name      = "keycloak-client-${each.key}"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  data = {
    "KEYCLOAK_CLIENT_ID"     = each.key
    "KEYCLOAK_CLIENT_SECRET" = random_password.machine_client_secret[each.key].result
  }
}
